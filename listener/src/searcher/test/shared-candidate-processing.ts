import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  UniverseRebuildCheckpointStore,
  activeReadyMemos,
  canonicalJson,
  durableVerifiedMemoFingerprint,
  type DurableSourceReceipt,
  type DurableVerifiedMemo,
} from "../universe-rebuild-checkpoint.js";
import {
  rebuildUniverse,
  refreshReadyInstances,
  restrictReadyFamilies,
  updateReadyFamilies,
  type RebuildUniverseInput,
} from "../universe-rebuild-runner.js";
import { createCandidateRevalidation } from "../ready-candidate-processing.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});
const FAMILIES = ["fixture:x", "fixture:y", "fixture:z", "fixture:d", "fixture:w"];
const digest = (value: unknown): string => createHash("sha256")
  .update(canonicalJson(value)).digest("hex");

interface Candidate {
  readonly id: string;
  readonly familyId: string;
  readonly address: string;
  readonly capability: string;
  readonly evidence: string;
}

function candidate(id: string, address = "pool-p", capability = "swap", evidence = "v1"): Candidate {
  return Object.freeze({ id, familyId: "fixture:" + id.toLowerCase(), address, capability, evidence });
}
const key = (value: unknown): string => {
  const c = value as Candidate;
  return c.familyId + "|" + c.address + "|" + c.capability;
};
const fingerprint = (value: unknown): string => digest(["candidate", value]);

function reseal(input: Omit<DurableVerifiedMemo, "memoFingerprint">): DurableVerifiedMemo {
  const unsigned = { ...input, memoFingerprint: "" };
  return Object.freeze({ ...unsigned, memoFingerprint: durableVerifiedMemoFingerprint(unsigned) });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real runner/store, synthetic family lifecycles: no RPC, forks, or live state. */
async function fixture(initial: readonly Candidate[]) {
  const directory = await mkdtemp(join(tmpdir(), "shared-candidate-processing-"));
  const store = new UniverseRebuildCheckpointStore({ path: join(directory, "checkpoint.json") });
  const definitions = new Map(FAMILIES.map(id => [id, digest(["definition", id, 1])]));
  const rejected = new Set<string>();
  const retryable = new Set<string>();
  const calls: string[] = [];
  const revalidationCalls: string[] = [];
  const events: string[] = [];
  let nominations = [...initial];
  let sequence = 0;
  let scans = 0;
  let beforeAttest: ((candidate: Candidate) => Promise<void>) | undefined;
  const sourceReceipt = (fromBlock: number): DurableSourceReceipt => ({
    sourceKey: digest(["source", fromBlock, SOURCE]),
    sourceKind: "startup-candidate-union",
    providerIdentity: "offline-shared-candidate-fixture",
    queryFingerprint: digest("startup-plan"),
    fromBlock,
    toBlock: SOURCE.number,
    cutoffNumber: SOURCE.number,
    cutoffHash: SOURCE.hash,
    coverageKeys: FAMILIES.map(id => id + "|startup-universe"),
    completedChunks: [{ fromBlock, toBlock: SOURCE.number,
      resultCount: nominations.length, resultHash: digest(nominations) }],
    observationSetHash: digest(nominations),
    observedThrough: { number: SOURCE.number, hash: SOURCE.hash },
    appliedThrough: { number: SOURCE.number, hash: SOURCE.hash },
    retryableCount: 0,
    status: "complete",
  });
  const input: RebuildUniverseInput = {
    store,
    runId: "seed",
    observationRange: { fromBlock: SOURCE.number, toBlock: SOURCE.number },
    attestationConcurrency: 4,
    freezeCanonicalHead: async () => SOURCE,
    scanSwapWindow: async ({ fromBlock }) => {
      scans++;
      return { observations: nominations, sourceReceipts: [sourceReceipt(fromBlock)] };
    },
    familyCandidateKey: key,
    candidateFamilyId: value => (value as Candidate).familyId,
    familyDefinitionHash: familyId => definitions.get(familyId)!,
    familyDiscoveryDefinitionHash: familyId => digest(["discovery", familyId]),
    candidateCoverage: value => {
      const c = value as Candidate;
      return { key: c.address + "|" + c.capability,
        fingerprint: digest(["coverage-rule", c.familyId, c.address, c.capability, c.evidence, definitions.get(c.familyId)]),
        candidateFingerprint: fingerprint(c) };
    },
    dedupeFamilyCandidates: observations => {
      const byKey = new Map<string, Candidate>();
      for (const raw of observations) {
        const c = ((raw as { candidate?: Candidate }).candidate ?? raw) as Candidate;
        if (!byKey.has(key(c))) byKey.set(key(c), c);
      }
      return [...byKey.values()];
    },
    encodeCandidateSnapshot: value => value,
    decodeCandidateSnapshot: value => value,
    isFamilyEnabled: () => true,
    requiredSourceCoverageKeys: () => FAMILIES.map(id => id + "|startup-universe"),
    expectedSourcePlanFingerprints: () => ({ startup: digest("startup-plan"), activity: digest("activity-plan") }),
    isReadyMemoDefinitionCurrent: memo => memo.familyDefinitionHash === definitions.get(memo.familyId),
    findReusableMemo: async ({ candidate: value, checkpoint }) => {
      const c = value as Candidate;
      revalidationCalls.push(c.id);
      const memo = checkpoint.verifiedMemos[key(c)];
      return memo && memo.familyDefinitionHash === definitions.get(c.familyId) &&
        memo.candidateFingerprint === fingerprint(c) ? memo : null;
    },
    attestFamilyInstanceOnce: async ({ candidate: value, cutoff }) => {
      const c = value as Candidate;
      calls.push(c.id);
      events.push("start:" + c.id);
      await beforeAttest?.(c);
      events.push("end:" + c.id);
      if (rejected.has(c.id)) return {
        status: "terminal-rejected",
        reasonCode: "identity_rejected:fixture",
        binding: { familyDefinitionHash: definitions.get(c.familyId)!,
          requestFingerprint: digest(["request", c]), trustedResultsFingerprint: digest(["result", c]),
          authorityFingerprint: digest(["authority", c.address]), candidateFingerprint: fingerprint(c),
          cutoff: { number: cutoff.number, hash: cutoff.hash } },
      };
      if (retryable.has(c.id)) return {
        status: "retryable", stage: "identity", failureCode: "rpc",
        reasonCode: "fixture-temporary-unavailable", candidateSnapshot: c,
      };
      return { status: "verified", result: { candidate: c } };
    },
    sealDurableVerifiedMemo: ({ candidate: value, proofSource, familyCandidateKey }) => {
      const c = value as Candidate;
      return reseal({
        familyCandidateKey, familyInstanceKey: "instance:" + key(c), familyId: c.familyId,
        candidateKey: key(c), instanceKey: "instance:" + key(c), candidateFingerprint: fingerprint(c),
        familyDefinitionHash: definitions.get(c.familyId)!,
        validity: { policy: "immutable-code", authorityFingerprint: digest(["authority", c.address]),
          proofSource: { number: proofSource.number, hash: proofSource.hash } },
        verifiedIdentity: { address: c.address, capability: c.capability },
        compiledDescriptor: { address: c.address, capability: c.capability },
        staticProjection: { address: c.address, capability: c.capability },
        evidenceFingerprint: digest(["evidence", c]), candidateSnapshot: c,
      });
    },
    rehydrateVerifiedInstance: ({ memo }) => ({ familyId: memo.familyId, instanceKey: memo.instanceKey }),
    aggregateOnceByFamily: instances => FAMILIES.flatMap(familyId => {
      const owned = instances.filter(value => (value as { familyId: string }).familyId === familyId);
      return owned.length ? [{ familyId, instances: owned }] : [];
    }),
    buildGraphSnapshot: publications => ({ edges: publications.flatMap(publication =>
      publication.instances.map(value => ({ familyId: publication.familyId,
        instanceKey: (value as { instanceKey: string }).instanceKey }))) }),
    buildCoverage: ({ sourceReceipts }) => sourceReceipts.flatMap(receipt => receipt.coverageKeys.map(value => {
      const split = value.indexOf("|");
      return { familyId: value.slice(0, split), sourceId: value.slice(split + 1),
        completeThroughBlock: receipt.appliedThrough.number, completeThroughHash: receipt.appliedThrough.hash };
    })),
    assertCanonicalHead: async cutoff => { assert.deepEqual(cutoff, SOURCE); },
  };
  return {
    input, store, calls, events, rejected, retryable, revalidationCalls,
    setCandidates(values: readonly Candidate[]) { nominations = [...values]; },
    changeDefinition(familyId: string) { definitions.set(familyId, digest(["changed", familyId, definitions.get(familyId)])); },
    onAttest(callback: (candidate: Candidate) => Promise<void>) { beforeAttest = callback; },
    scans: () => scans,
    clearCalls() { calls.length = 0; events.length = 0; revalidationCalls.length = 0; },
    run(overrides: Partial<RebuildUniverseInput> = {}) {
      return rebuildUniverse({ ...input, runId: "run-" + sequence++, ...overrides });
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

for (const mode of ["ordinary", "review"] as const) {
  test(`${mode}: reattest the historical winner before covering other families`, async () => {
    const x = candidate("X"), y = candidate("Y"), z = candidate("Z");
    const f = await fixture([x]);
    try {
      await f.run();
      f.changeDefinition(x.familyId);
      f.setCandidates([y, z, x]);
      f.clearCalls();
      const ready = await f.run(mode === "review"
        ? { previousReadyReview: { inputFingerprint: digest("review-priority") } } : {});
      assert.deepEqual(f.calls, ["X"], "stale historical X is reattested; Y and Z never enter a lifecycle");
      assert.deepEqual(f.revalidationCalls, ["X"],
        "only the changed historical winner has an old memo to reconsider; new same-pool nominations await its result");
      assert.equal(ready.candidateAccounting.verified, 1);
      assert.equal(ready.candidateAccounting.covered, 2);
      assert.equal(ready.candidateAccounting.terminalRejected, 0, "coverage is not a chain-proven rejection");
      const saved = (await f.store.load())!;
      for (const c of [y, z]) {
        const outcome = ready.familyPartitions![c.familyId]!.outcomesByCandidateKey[key(c)]!;
        assert.equal(outcome.status, "covered");
        if (outcome.status !== "covered") throw new Error("expected coverage outcome");
        assert.equal(outcome.winnerFamilyCandidateKey, key(x));
        assert.equal(outcome.winnerMemoFingerprint, saved.verifiedMemos[key(x)]!.memoFingerprint);
        assert.equal(saved.verifiedMemos[key(c)], undefined, "coverage never invents another family's verified memo");
      }
      assert.deepEqual(activeReadyMemos(saved).map(memo => memo.familyId), [x.familyId]);
    } finally { await f.dispose(); }
  });
}

test("the revalidation hook only schedules strict candidates and requires an accepted winner", async () => {
  const x = candidate("X"), y = candidate("Y"), d = candidate("D", "pool-d");
  const f = await fixture([x]);
  try {
    await f.run();
    const checkpoint = (await f.store.load())!;
    f.clearCalls();
    const hook = createCandidateRevalidation({ dependencies: f.input, candidates: [y, d, x],
      cutoff: SOURCE, historicalVerifiedKeys: new Set([key(x)]) });
    assert.deepEqual(hook.batches([y, d, x]).map(batch => batch.map(value => (value as Candidate).id)),
      [["X"], ["Y", "D"]]);
    assert.equal(hook.coveredOutcome(y), null, "historical membership alone does not authorize coverage");
    hook.confirmVerified(x, checkpoint.verifiedMemos[key(x)]!);
    const covered = hook.coveredOutcome(y);
    assert.equal(covered?.status, "covered");
    assert.equal(covered?.winnerFamilyCandidateKey, key(x));
    assert.equal(covered?.winnerMemoFingerprint, checkpoint.verifiedMemos[key(x)]!.memoFingerprint);
    assert.equal(hook.coveredOutcome(d), null);
    assert.equal(hook.coveredOutcome(x), null, "a historical verified candidate retains its own proof");
    assert.deepEqual(f.calls, [], "the hook has no lifecycle execution authority");
    assert.deepEqual(f.revalidationCalls, [], "the hook has no memo lookup authority");
    assert.deepEqual(await f.store.load(), checkpoint, "the hook has no persistence authority");
  } finally { await f.dispose(); }
});

test("a failed historical strict callback cannot authorize coverage or start the remaining batch", async () => {
  const x = candidate("X"), y = candidate("Y"), d = candidate("D", "pool-d");
  const f = await fixture([x]);
  try {
    await f.run();
    const checkpoint = (await f.store.load())!;
    f.setCandidates([y, d, x]);
    f.changeDefinition(x.familyId);
    f.onAttest(async c => { if (c.id === "X") throw new Error("historical strict callback failed"); });
    f.clearCalls();
    await assert.rejects(f.run({ attestationConcurrency: 1 }), /historical strict callback failed/);
    assert.deepEqual(f.calls, ["X"]);
    const after = (await f.store.load())!;
    assert.deepEqual(after.readyGeneration, checkpoint.readyGeneration);
    assert.deepEqual(after.verifiedMemos, checkpoint.verifiedMemos);
    assert.equal(after.inProgressRun!.outcomesByCandidateKey[key(y)], undefined);
    assert.equal(after.inProgressRun!.outcomesByCandidateKey[key(d)], undefined);
  } finally { await f.dispose(); }
});

for (const mode of ["ordinary", "review"] as const) test(`${mode}: a same-cutoff winner is inherited by family without per-memo checks`, async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([y, x]);
    f.clearCalls();
    const localChecks: string[] = [];
    const ready = await f.run({
      ...(mode === "review" ? { previousReadyReview: { inputFingerprint: digest("same-cutoff-review") } } : {}),
      findReusableMemo: async args => {
      localChecks.push((args.candidate as Candidate).id);
      assert.deepEqual(args.cutoff, SOURCE);
      return f.input.findReusableMemo(args);
    } });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(localChecks, [], "the matching sealed family partition supplies the winner without per-memo lookup");
    assert.deepEqual(f.revalidationCalls, localChecks);
    assert.equal(ready.candidateAccounting.covered, 1);
  } finally { await f.dispose(); }
});

test("failed historical X and a new pool use the remaining normal processing stage", async () => {
  const x = candidate("X"), y = candidate("Y"), d = candidate("D", "pool-d");
  const f = await fixture([x]);
  try {
    await f.run();
    f.changeDefinition(x.familyId);
    f.rejected.add("X");
    f.setCandidates([y, d, x]);
    f.clearCalls();
    const ready = await f.run({ attestationConcurrency: 1,
      previousReadyReview: { inputFingerprint: digest("failed-winner") } });
    assert.deepEqual(f.calls, ["X", "Y", "D"], "historical X is not appended for a second full attempt");
    assert.equal(ready.candidateAccounting.verified, 2);
    assert.equal(ready.candidateAccounting.terminalRejected, 1);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
    assert.deepEqual(activeReadyMemos((await f.store.load())!).map(memo => memo.familyId).sort(),
      [y.familyId, d.familyId].sort());
  } finally { await f.dispose(); }
});

test("an unavailable historical winner does not cover or erase its alternate candidate", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.changeDefinition(x.familyId);
    f.retryable.add("X");
    f.setCandidates([y, x]);
    f.clearCalls();
    const ready = await f.run({ attestationConcurrency: 1 });
    assert.deepEqual(f.calls, ["X", "Y"]);
    assert.equal(ready.candidateAccounting.verified, 1);
    assert.equal(ready.candidateAccounting.retryable, 1);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
    const saved = (await f.store.load())!;
    assert(saved.retryableAttemptsByCandidateKey[key(x)], "X remains eligible for its existing retry path");
    assert.equal(ready.familyPartitions![x.familyId]!.outcomesByCandidateKey[key(x)]!.status, "retryable",
      "retained historical proof bytes do not count as a current verified outcome");
    assert.deepEqual(activeReadyMemos(saved).map(memo => memo.familyId), [y.familyId]);
  } finally { await f.dispose(); }
});

test("parallel workers cannot start the remaining stage before historical verification finishes", { timeout: 10_000 }, async () => {
  const x = candidate("X"), y = candidate("Y"), d = candidate("D", "pool-d");
  const f = await fixture([x]);
  const started = deferred(), release = deferred();
  let run: ReturnType<typeof f.run> | undefined;
  try {
    await f.run();
    f.changeDefinition(x.familyId);
    f.setCandidates([y, d, x]);
    f.clearCalls();
    f.onAttest(async c => { if (c.id === "X") { started.resolve(); await release.promise; } });
    run = f.run({ attestationConcurrency: 4 });
    await started.promise;
    await new Promise<void>(done => setImmediate(done));
    assert.deepEqual(f.calls, ["X"], "even unrelated new D waits behind the historical stage barrier");
    release.resolve();
    const ready = await run;
    assert.deepEqual(f.calls, ["X", "D"]);
    assert(f.events.indexOf("end:X") < f.events.indexOf("start:D"));
    assert.equal(ready.candidateAccounting.covered, 1);
  } finally {
    release.resolve();
    await run?.catch(() => undefined);
    await f.dispose();
  }
});

test("a covered candidate returns to strict when its winner is removed from the exact selection", async () => {
  const x = candidate("X"), y = candidate("Y"), d = candidate("D", "pool-d");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([y, x]);
    const covered = await f.run({ previousReadyReview: { inputFingerprint: digest("initial-cover") } });
    assert.equal(covered.candidateAccounting.covered, 1);
    f.setCandidates([x, y, d]);
    f.clearCalls();
    const ready = await f.run({ previousReadyReview: { inputFingerprint: digest("remove-winner"),
      candidateKeys: new Set([key(y), key(d)]) } });
    assert.deepEqual([...f.calls].sort(), ["D", "Y"]);
    assert.equal(ready.candidateAccounting.verified, 2);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
    assert.equal(activeReadyMemos((await f.store.load())!).some(memo => memo.familyId === x.familyId), false);
  } finally { await f.dispose(); }
});

test("a prior covered outcome is released when the winner no longer verifies", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([y, x]);
    assert.equal((await f.run()).candidateAccounting.covered, 1);
    f.changeDefinition(x.familyId);
    f.rejected.add("X");
    f.clearCalls();
    const ready = await f.run({ previousReadyReview: { inputFingerprint: digest("invalidate-cover") } });
    assert.deepEqual(f.calls, ["X", "Y"]);
    assert.equal(ready.candidateAccounting.verified, 1);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
    assert.equal(ready.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)]!.status, "verified");
  } finally { await f.dispose(); }
});

test("the same address with independent capabilities keeps both legitimate instances", async () => {
  const x = candidate("X"), w = candidate("W", x.address, "deposit");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([w, x]);
    f.clearCalls();
    const ready = await f.run();
    assert.deepEqual(f.calls, ["W"]);
    assert.equal(ready.candidateAccounting.verified, 2);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
    assert.equal(activeReadyMemos((await f.store.load())!).length, 2);
  } finally { await f.dispose(); }
});

test("missing coverage declarations never collapse same-address families", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run({ candidateCoverage: () => null });
    f.setCandidates([y, x]);
    f.clearCalls();
    const ready = await f.run({ candidateCoverage: () => null });
    assert.deepEqual(f.calls, ["Y"]);
    assert.equal(ready.candidateAccounting.verified, 2);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
  } finally { await f.dispose(); }
});

test("a withdrawn candidate coverage declaration invalidates its earlier covered outcome", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([y, x]);
    assert.equal((await f.run()).candidateAccounting.covered, 1);
    f.clearCalls();
    const ready = await f.run({ previousReadyReview: { inputFingerprint: digest("withdraw-coverage") },
      candidateCoverage: value => (value as Candidate).id === "Y" ? null : f.input.candidateCoverage!(value) });
    assert.deepEqual(f.calls, ["Y"]);
    assert.equal(ready.candidateAccounting.verified, 2);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
  } finally { await f.dispose(); }
});

test("same-run resume recomputes covered dependencies instead of retaining them as completed negatives", async () => {
  const x = candidate("X"), y = candidate("Y"), d = candidate("D", "pool-d");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([y, x, d]);
    f.onAttest(async c => { if (c.id === "D") throw new Error("interrupt after coverage"); });
    await assert.rejects(f.run({ runId: "interrupted-coverage", attestationConcurrency: 1 }), /interrupt after coverage/);
    const interrupted = (await f.store.load())!;
    assert.equal(interrupted.inProgressRun!.outcomesByCandidateKey[key(y)]!.status, "covered");
    const scans = f.scans();
    f.onAttest(async () => {});
    f.clearCalls();
    const ready = await f.run({ runId: "interrupted-coverage", attestationConcurrency: 1,
      resumeCompletedOutcomes: true,
      candidateCoverage: value => (value as Candidate).id === "Y" ? null : f.input.candidateCoverage!(value) });
    assert.deepEqual([...f.calls].sort(), ["D", "Y"]);
    assert.equal(f.scans(), scans, "the fixed run restores its sealed candidates without rediscovery");
    assert.equal(ready.candidateAccounting.verified, 3);
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
  } finally { await f.dispose(); }
});

test("a fresh proof context cannot resurrect a historical memo behind a previous retryable outcome", async () => {
  const x = candidate("X"), y = candidate("Y"), d = candidate("D", "pool-d");
  const f = await fixture([x, d]);
  try {
    await f.run();
    f.retryable.add("X");
    await f.run({ previousReadyReview: { inputFingerprint: digest("setup-retryable-before-proof-context"),
      forceStatuses: ["verified"] } });
    const parent = (await f.store.load())!;
    assert(parent.verifiedMemos[key(x)], "historical proof bytes survive a retryable outcome for later checking");
    assert.equal(parent.readyGeneration!.familyPartitions![x.familyId]!.outcomesByCandidateKey[key(x)]!.status,
      "retryable");
    f.retryable.clear();
    f.rejected.add("X");
    f.setCandidates([y, x, d]);
    f.clearCalls();
    const ready = await f.run({ previousReadyReview: { inputFingerprint: digest("new-executor-context"),
      revalidateParentProofs: true } });
    assert.deepEqual(f.revalidationCalls, [], "the original fresh-context strict path never looks up parent memos");
    assert.deepEqual([...f.calls].sort(), ["D", "X", "Y"],
      "the old X memo belongs to the old proof context and cannot suppress Y");
    assert.equal(ready.familyPartitions![x.familyId]!.outcomesByCandidateKey[key(x)]!.status, "terminal-rejected");
    assert.equal(ready.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)]!.status, "verified");
  } finally { await f.dispose(); }
});

test("force retry of prior negative outcomes performs the requested retry instead of reviving an older memo", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.retryable.add("X");
    await f.run({ previousReadyReview: { inputFingerprint: digest("setup-retryable-before-force-negative"),
      forceStatuses: ["verified"] } });
    f.retryable.clear();
    f.rejected.add("X");
    f.setCandidates([y, x]);
    f.clearCalls();
    const ready = await f.run({ previousReadyReview: { inputFingerprint: digest("force-retry-negative"),
      retryNegativeOutcomes: true } });
    assert.deepEqual(f.revalidationCalls, [], "the original negative-retry strict path never revives old memos");
    assert.deepEqual([...f.calls].sort(), ["X", "Y"], "force-update must not shortcut the explicitly requested X retry");
    assert.equal(ready.familyPartitions![x.familyId]!.outcomesByCandidateKey[key(x)]!.status, "terminal-rejected");
    assert.equal(ready.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)]!.status, "verified");
  } finally { await f.dispose(); }
});

test("a retained negative does not seed coverage from a historical memo that the original checks did not accept", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.retryable.add("X");
    await f.run({ previousReadyReview: { inputFingerprint: digest("setup-retryable-before-negative-retention"),
      forceStatuses: ["verified"] } });
    const parent = (await f.store.load())!;
    const negative = parent.readyGeneration!.familyPartitions![x.familyId]!.outcomesByCandidateKey[key(x)]!;
    assert.equal(negative.status, "retryable");
    assert(parent.verifiedMemos[key(x)], "the old success remains stored independently of its current negative outcome");
    f.retryable.clear();
    f.setCandidates([y, x]);
    f.clearCalls();
    const ready = await f.run({ previousReadyReview: { inputFingerprint: digest("retain-negative-with-historical-memo") } });
    assert.deepEqual(f.revalidationCalls, [], "neither a retained negative nor a new review candidate gains a memo lookup");
    assert.deepEqual(f.calls, ["Y"], "only the new candidate reaches the original strict callback");
    assert.deepEqual(ready.familyPartitions![x.familyId]!.outcomesByCandidateKey[key(x)], negative);
    assert.equal(ready.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)]!.status, "verified");
    assert.equal(ready.candidateAccounting.covered ?? 0, 0);
    assert.deepEqual(activeReadyMemos((await f.store.load())!).map(memo => memo.familyId), [y.familyId]);
  } finally { await f.dispose(); }
});

test("scope-only edits retain valid old positive and negative outcomes before covering new competitors", async () => {
  const x = candidate("X"), y = candidate("Y"), z = candidate("Z"), d = candidate("D", "pool-d");
  const f = await fixture([y]);
  try {
    f.rejected.add("Y");
    await f.run();
    f.setCandidates([y, x]);
    await f.run({ previousReadyReview: { inputFingerprint: digest("add-first-positive") } });
    const before = (await f.store.load())!;
    const oldNegative = before.readyGeneration!.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)]!;
    assert.equal(oldNegative.status, "terminal-rejected");
    f.setCandidates([z, y, x, d]);
    f.clearCalls();
    const ready = await f.run({ previousReadyReview: { inputFingerprint: digest("add-candidates-only") } });
    assert.deepEqual(f.revalidationCalls, [], "unchanged positive and negative family partitions inherit without per-memo checks");
    assert.deepEqual(f.calls, ["D"], "unchanged X/Y reuse their valid conclusions; new Z is covered; only new D attests");
    assert.deepEqual(ready.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)], oldNegative,
      "coverage must not overwrite an unchanged chain-proven rejection");
    assert.equal(ready.familyPartitions![z.familyId]!.outcomesByCandidateKey[key(z)]!.status, "covered");
    assert.equal(ready.candidateAccounting.verified, 2);
    assert.equal(ready.candidateAccounting.terminalRejected, 1);
    assert.equal(ready.candidateAccounting.covered, 1);
    f.setCandidates([y, x, z, d]);
    f.clearCalls();
    const reduced = await f.run({ previousReadyReview: { inputFingerprint: digest("remove-candidates-only"),
      candidateKeys: new Set([key(x), key(y)]) } });
    assert.deepEqual(f.revalidationCalls, []);
    assert.deepEqual(f.calls, [], "removing candidates does not reattest unchanged survivors");
    assert.deepEqual(reduced.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)], oldNegative);
    assert.deepEqual(activeReadyMemos((await f.store.load())!).map(memo => memo.familyId), [x.familyId]);
  } finally { await f.dispose(); }
});

test("refresh retains the exact Ready set, cutoff and atomic CAS publication", async () => {
  const x = candidate("X"), w = candidate("W", "pool-w", "deposit");
  const f = await fixture([x, w]);
  try {
    const oldReady = await f.run();
    const old = (await f.store.load())!;
    const scans = f.scans();
    const noScan = async (): Promise<never> => { throw new Error("refresh cannot discover or move the cutoff"); };
    f.changeDefinition(x.familyId);
    f.clearCalls();
    const input = { ...f.input, freezeCanonicalHead: noScan, scanSwapWindow: noScan,
      findReusableMemo: async (): Promise<never> => { throw new Error("refresh current check is local"); } };
    const refreshed = await refreshReadyInstances(input);
    assert.deepEqual(f.calls, ["X"]);
    assert.equal(f.scans(), scans);
    for (const field of ["cutoff", "universeRange", "universeHash", "sourceCoverage", "activeInstanceKeys", "candidateAccounting"] as const) {
      assert.deepEqual(refreshed[field], oldReady[field], field + " remains exact");
    }
    const after = (await f.store.load())!;
    assert.notEqual(after.verifiedMemos[key(x)]!.memoFingerprint, old.verifiedMemos[key(x)]!.memoFingerprint);
    assert.equal(after.verifiedMemos[key(w)]!.memoFingerprint, old.verifiedMemos[key(w)]!.memoFingerprint);
    await assert.rejects(f.store.casRefreshReadyInstances({ expectedRevision: after.revision - 1,
      memos: activeReadyMemos(after), graphSnapshot: refreshed.graphSnapshot }), /CAS conflict/);
    await assert.rejects(f.store.casRefreshReadyInstances({ expectedRevision: after.revision,
      memos: activeReadyMemos(after).slice(1), graphSnapshot: refreshed.graphSnapshot }), /cannot add or remove/);
    assert.deepEqual(await f.store.load(), after);
    f.changeDefinition(x.familyId);
    f.rejected.add("X");
    await assert.rejects(refreshReadyInstances(input), /incumbent unchanged/);
    assert.deepEqual(await f.store.load(), after, "failed refresh never publishes a reduced Ready or partial memo writes");
  } finally { await f.dispose(); }
});

test("refresh rebinds covered outcomes to the refreshed winner without admitting the covered family", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([y, x]);
    const before = await f.run();
    assert.equal(before.candidateAccounting.covered, 1);
    const oldOutcome = before.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)]!;
    assert.equal(oldOutcome.status, "covered");
    f.changeDefinition(x.familyId);
    f.clearCalls();
    const ready = await refreshReadyInstances({ ...f.input,
      scanSwapWindow: async () => { throw new Error("covered refresh cannot rediscover"); },
      freezeCanonicalHead: async () => { throw new Error("covered refresh cannot move cutoff"); } });
    assert.deepEqual(f.calls, ["X"]);
    assert.deepEqual(ready.candidateAccounting, before.candidateAccounting);
    assert.deepEqual(ready.activeInstanceKeys, before.activeInstanceKeys);
    const after = (await f.store.load())!;
    const outcome = ready.familyPartitions![y.familyId]!.outcomesByCandidateKey[key(y)]!;
    assert.equal(outcome.status, "covered");
    if (outcome.status !== "covered" || oldOutcome.status !== "covered") throw new Error("expected coverage outcome");
    assert.equal(outcome.winnerMemoFingerprint, after.verifiedMemos[key(x)]!.memoFingerprint);
    assert.notEqual(outcome.winnerMemoFingerprint, oldOutcome.winnerMemoFingerprint);
    assert.equal(after.verifiedMemos[key(y)], undefined);
  } finally { await f.dispose(); }
});

test("refresh with a changed definition propagates an original memo lookup error without a fallback attestation", async () => {
  const f = await fixture([candidate("X")]);
  try {
    await f.run();
    const before = (await f.store.load())!;
    const scans = f.scans();
    const failure = new Error("memo lookup transport failed");
    let lookups = 0;
    f.changeDefinition("fixture:x");
    f.clearCalls();
    await assert.rejects(refreshReadyInstances({ ...f.input,
      isReadyMemoDefinitionCurrent: undefined,
      findReusableMemo: async () => { lookups++; throw failure; },
    }), error => error === failure);
    assert.equal(lookups, 1);
    assert.deepEqual(f.calls, [], "the refresh entry point must not catch and convert lookup failure into strict work");
    assert.equal(f.scans(), scans);
    assert.deepEqual(await f.store.load(), before);
  } finally { await f.dispose(); }
});

test("refresh with a matching sealed family skips per-memo decoding and attestation", async () => {
  const f = await fixture([candidate("X")]);
  try {
    await f.run();
    const before = (await f.store.load())!;
    assert.equal(before.readyGeneration!.candidateAccounting.covered ?? 0, 0);
    let decodes = 0;
    f.clearCalls();
    const ready = await refreshReadyInstances({ ...f.input,
      decodeCandidateSnapshot: snapshot => { decodes++; return f.input.decodeCandidateSnapshot!(snapshot); },
    });
    assert.equal(decodes, 0, "the matching family partition is inherited without decoding each candidate");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.revalidationCalls, []);
    assert.deepEqual(ready, before.readyGeneration);
    assert.deepEqual(await f.store.load(), before);
  } finally { await f.dispose(); }
});

test("legacy refresh without batch definition metadata still decodes once through its original worker", async () => {
  const f = await fixture([candidate("X")]);
  try {
    await f.run();
    const before = (await f.store.load())!;
    let decodes = 0;
    f.clearCalls();
    const ready = await refreshReadyInstances({ ...f.input,
      familyDefinitionHash: undefined,
      decodeCandidateSnapshot: snapshot => { decodes++; return f.input.decodeCandidateSnapshot!(snapshot); },
    });
    assert.equal(decodes, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.revalidationCalls, []);
    assert.deepEqual(ready, before.readyGeneration);
    assert.deepEqual(await f.store.load(), before);
  } finally { await f.dispose(); }
});

function activationInput(f: Awaited<ReturnType<typeof fixture>>): RebuildUniverseInput {
  const noWork = async (): Promise<never> => { throw new Error("activation must only validate local evidence"); };
  return { ...f.input,
    freezeCanonicalHead: noWork, scanSwapWindow: noWork,
    attestFamilyInstanceOnce: noWork, findReusableMemo: noWork,
    assertReadyGraphSnapshot: ({ publications, graphSnapshot, cutoff }) => {
      assert.deepEqual(graphSnapshot, f.input.buildGraphSnapshot(publications, cutoff), "complete graph parity");
    },
  };
}

test("refresh keeps the current partition snapshot when an unchanged static memo has older observation metadata", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  const candidateCoverage = (value: unknown) => {
    const c = value as Candidate;
    const binding = f.input.candidateCoverage!(value)!;
    return { ...binding,
      candidateFingerprint: fingerprint(c.id === "X" ? x : c),
      fingerprint: digest(["coverage-with-observation-metadata", value, binding.fingerprint]),
    };
  };
  try {
    await f.run({ candidateCoverage });
    const oldMemo = (await f.store.load())!.verifiedMemos[key(x)]!;
    const updatedX = { ...x, observationMetadata: "later-nomination-at-the-same-fixed-cutoff" };
    f.setCandidates([y, updatedX]);
    f.clearCalls();
    const ready = await f.run({ candidateCoverage,
      previousReadyReview: { inputFingerprint: digest("observation-metadata-only") },
      findReusableMemo: async args => {
        assert.equal((args.candidate as Candidate).id, "X");
        return args.checkpoint.verifiedMemos[key(x)]!;
      },
    });
    assert.equal(ready.candidateAccounting.covered, 1);
    const before = (await f.store.load())!;
    assert.deepEqual(before.verifiedMemos[key(x)], oldMemo, "the original static memo is still valid without a new proof");
    assert.deepEqual(ready.familyPartitions![x.familyId]!.candidatesByKey[key(x)], updatedX,
      "the Ready partition retains the current observation input independently of the old static proof");
    const input = { ...activationInput(f), candidateCoverage };
    assert.deepEqual(await refreshReadyInstances(input), ready,
      "refresh must use the sealed current candidate binding for coverage");
    assert.deepEqual(await updateReadyFamilies(input), ready);
    assert.deepEqual(await f.store.load(), before, "unchanged proof and coverage inputs remain a complete no-op");
    assert.deepEqual(f.calls, []);
  } finally { await f.dispose(); }
});

test("activation and restriction retain current coverage and close a covered-only family without work", async () => {
  const x = candidate("X"), y = candidate("Y");
  const f = await fixture([x]);
  try {
    await f.run();
    f.setCandidates([y, x]);
    await f.run();
    const before = (await f.store.load())!;
    assert.equal(before.readyGeneration!.candidateAccounting.covered, 1);
    const scans = f.scans();
    f.clearCalls();
    for (const apply of [updateReadyFamilies, restrictReadyFamilies]) {
      const ready = await apply(activationInput(f));
      assert.deepEqual(ready, before.readyGeneration);
      assert.deepEqual(await f.store.load(), before, "current coverage does not require a new generation");
    }
    const restrictedInput = { ...activationInput(f),
      isFamilyEnabled: (id: string) => id !== y.familyId,
      requiredSourceCoverageKeys: () => FAMILIES.filter(id => id !== y.familyId).map(id => id + "|startup-universe"),
    };
    const restricted = await restrictReadyFamilies(restrictedInput);
    assert.equal(restricted.familyPartitions![y.familyId]!.enabled, false);
    assert.deepEqual(restricted.activeInstanceKeys, before.readyGeneration!.activeInstanceKeys);
    assert.deepEqual(restricted.graphSnapshot, before.readyGeneration!.graphSnapshot);
    const afterRestriction = (await f.store.load())!;
    assert.deepEqual(await refreshReadyInstances(restrictedInput), restricted,
      "the activation refresh accepts the existing winner after its covered-only competitor is disabled");
    assert.deepEqual(await f.store.load(), afterRestriction, "refresh of the restricted set is a no-op");
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.revalidationCalls, []);
    assert.equal(f.scans(), scans);
  } finally { await f.dispose(); }
});

test("activation and restriction reject stale coverage before publishing any change", async t => {
  for (const variant of ["covered-definition", "covered-declaration-withdrawn", "covered-binding-changed",
    "winner-binding-changed", "coverage-unavailable"] as const) {
    await t.test(variant, async () => {
      const x = candidate("X"), y = candidate("Y");
      const f = await fixture([x]);
      try {
        await f.run();
        f.setCandidates([y, x]);
        await f.run();
        const before = (await f.store.load())!;
        const scans = f.scans();
        f.clearCalls();
        if (variant === "covered-definition") f.changeDefinition(y.familyId);
        const pure = activationInput(f);
        const input: RebuildUniverseInput = variant === "coverage-unavailable"
          ? { ...pure, candidateCoverage: undefined }
          : { ...pure, candidateCoverage: value => {
            const c = value as Candidate;
            const binding = f.input.candidateCoverage!(value);
            if (variant === "covered-declaration-withdrawn" && c.id === "Y") return null;
            if ((variant === "covered-binding-changed" && c.id === "Y") ||
                (variant === "winner-binding-changed" && c.id === "X")) {
              return binding && { ...binding, fingerprint: digest([variant, binding.fingerprint]) };
            }
            return binding;
          } };
        for (const apply of [updateReadyFamilies, restrictReadyFamilies]) {
          await assert.rejects(apply(input), /coverage|covered/i, variant + " requires review");
          assert.deepEqual(await f.store.load(), before, "invalid coverage never mutates the incumbent");
        }
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.revalidationCalls, []);
        assert.equal(f.scans(), scans);
      } finally { await f.dispose(); }
    });
  }
});
