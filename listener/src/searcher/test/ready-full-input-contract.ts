import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
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
  type ReadyUniverseGeneration,
  type RunOutcome,
} from "../universe-rebuild-checkpoint.js";
import { probeOneFailure, rebuildUniverse, refreshReadyInstances, updateReadyFamilies, type RebuildUniverseInput } from "../universe-rebuild-runner.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";

/** These tests execute the real runner, checkpoint journal and promotion. The
 * injected lifecycle is deterministic and records its physical-work boundary;
 * passing this suite is not an on-chain identity or live latency claim. */
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_750_000, hash: "0x" + "a1".repeat(32), generation: 1,
});
const digest = (value: unknown): string => createHash("sha256")
  .update(canonicalJson(value)).digest("hex");

interface Candidate {
  readonly familyId: string;
  readonly pool: string;
  readonly capability: string;
  readonly binding: string;
}

function candidate(familyId: string, pool: string, binding = "original", capability = "swap"): Candidate {
  return Object.freeze({ familyId, pool, capability, binding });
}
const key = (value: unknown): string => {
  const c = value as Candidate;
  return [c.familyId, c.pool, c.capability].join("|");
};
const candidateHash = (value: unknown): string => digest(["candidate", value]);

function seal(input: Omit<DurableVerifiedMemo, "memoFingerprint">): DurableVerifiedMemo {
  const unsigned = { ...input, memoFingerprint: "" };
  return { ...unsigned, memoFingerprint: durableVerifiedMemoFingerprint(unsigned) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type ForceStatus = "verified" | "terminal-rejected" | "retryable";
interface RunOptions {
  readonly forceStatuses?: readonly ForceStatus[];
  readonly overrides?: Partial<RebuildUniverseInput>;
}

async function fixture(initial: readonly Candidate[], initialFamilies = [...new Set(initial.map(c => c.familyId))]) {
  const directory = await mkdtemp(join(tmpdir(), "ready-full-input-contract-"));
  const checkpointPath = join(directory, "checkpoint.json");
  const store = new UniverseRebuildCheckpointStore({ path: checkpointPath });
  let currentCandidates = [...initial];
  let currentFamilies = [...initialFamilies];
  let currentSource = SOURCE;
  const definitions = new Map<string, string>();
  const definition = (id: string) => definitions.get(id) ?? digest(["definition", id, 1]);
  const rejected = new Set<string>();
  const retryable = new Set<string>();
  const calls: string[] = [];
  const memoLookups: string[] = [];
  const memoDefinitionChecks: string[] = [];
  const events: string[] = [];
  const definitionCalls = new Map<string, number>();
  let scans = 0, reverseReads = 0;
  let beforeAttest: ((c: Candidate) => Promise<void>) | undefined;
  const plan = () => ({ startup: digest(["startup", [...currentFamilies].sort()]), activity: digest("activity") });
  const receipt = (fromBlock: number): DurableSourceReceipt => ({
    sourceKey: digest(["source", fromBlock, currentSource]),
    sourceKind: "startup-candidate-union",
    providerIdentity: "offline-full-input-contract",
    queryFingerprint: plan().startup,
    fromBlock, toBlock: currentSource.number,
    cutoffNumber: currentSource.number, cutoffHash: currentSource.hash,
    coverageKeys: currentFamilies.map(id => id + "|startup-universe"),
    completedChunks: [{ fromBlock, toBlock: currentSource.number,
      resultCount: currentCandidates.length, resultHash: digest(currentCandidates) }],
    observationSetHash: digest(currentCandidates),
    observedThrough: { number: currentSource.number, hash: currentSource.hash },
    appliedThrough: { number: currentSource.number, hash: currentSource.hash },
    retryableCount: 0, status: "complete",
  });
  const dependencies: Omit<RebuildUniverseInput, "runId"> = {
    store,
    hasExplicitStartupCandidates: true,
    attestationConcurrency: 4,
    freezeCanonicalHead: async requested => {
      if (requested !== undefined) assert.equal(requested, currentSource.number);
      return currentSource;
    },
    scanSwapWindow: async ({ fromBlock }) => {
      scans++;
      return { observations: currentCandidates, sourceReceipts: currentFamilies.length ? [receipt(fromBlock)] : [] };
    },
    reverseBindOpaqueCandidates: async () => { reverseReads++; return []; },
    // Discovery identity is independent of the review attempt/force policy.
    // The source anchor is separately checked by the runner's original gates.
    readyReviewInputFingerprint: () => digest({ sourcePlan: plan(),
      families: [...currentFamilies].sort(), candidates: currentCandidates }),
    familyCandidateKey: key,
    candidateFamilyId: value => (value as Candidate).familyId,
    familyDefinitionHash: id => {
      definitionCalls.set(id, (definitionCalls.get(id) ?? 0) + 1);
      return definition(id);
    },
    familyDiscoveryDefinitionHash: id => digest(["discovery", id]),
    candidateCoverage: value => {
      const c = value as Candidate;
      return { key: [c.pool, c.capability].join("|"),
        fingerprint: digest(["coverage", c, definition(c.familyId)]), candidateFingerprint: candidateHash(c) };
    },
    dedupeFamilyCandidates: (observations, selected) => {
      const result = new Map<string, Candidate>();
      for (const value of observations) {
        const c = ((value as { candidate?: unknown }).candidate ?? value) as Candidate;
        if (!currentFamilies.includes(c.familyId) || (selected && !selected.has(key(c)))) continue;
        result.set(key(c), c);
      }
      return [...result.values()];
    },
    encodeCandidateSnapshot: value => value,
    decodeCandidateSnapshot: value => value,
    isFamilyEnabled: id => currentFamilies.includes(id),
    requiredSourceCoverageKeys: () => currentFamilies.map(id => id + "|startup-universe"),
    expectedSourcePlanFingerprints: plan,
    isReadyMemoDefinitionCurrent: memo => {
      memoDefinitionChecks.push(memo.familyCandidateKey);
      return memo.familyDefinitionHash === definition(memo.familyId);
    },
    findReusableMemo: async ({ candidate: value, checkpoint, cutoff }) => {
      const c = value as Candidate;
      memoLookups.push(key(c));
      const memo = checkpoint.verifiedMemos[key(c)];
      return memo && memo.familyDefinitionHash === definition(c.familyId) &&
        memo.candidateFingerprint === candidateHash(c) &&
        memo.validity.proofSource.number === cutoff.number && memo.validity.proofSource.hash === cutoff.hash
        ? memo : null;
    },
    attestFamilyInstanceOnce: async ({ candidate: value, cutoff }) => {
      const c = value as Candidate;
      const id = key(c);
      calls.push(id);
      events.push("start:" + id);
      await beforeAttest?.(c);
      events.push("end:" + id);
      if (rejected.has(id)) return {
        status: "terminal-rejected", reasonCode: "identity_rejected:fixture",
        binding: { familyDefinitionHash: definition(c.familyId),
          requestFingerprint: digest(["request", c]), trustedResultsFingerprint: digest(["result", c]),
          authorityFingerprint: digest(["authority", c.pool]), candidateFingerprint: candidateHash(c),
          cutoff: { number: cutoff.number, hash: cutoff.hash } },
      };
      if (retryable.has(id)) return {
        status: "retryable", stage: "identity", failureCode: "rpc",
        reasonCode: "fixture-temporary-unavailable", candidateSnapshot: c,
      };
      return { status: "verified", result: c };
    },
    sealDurableVerifiedMemo: ({ candidate: value, familyCandidateKey, proofSource }) => {
      const c = value as Candidate;
      return seal({ familyCandidateKey, familyInstanceKey: "instance:" + key(c),
        familyId: c.familyId, candidateKey: key(c), instanceKey: "instance:" + key(c),
        candidateFingerprint: candidateHash(c), familyDefinitionHash: definition(c.familyId),
        validity: { policy: "immutable-code", authorityFingerprint: digest(["authority", c.pool]),
          proofSource: { number: proofSource.number, hash: proofSource.hash } },
        verifiedIdentity: { pool: c.pool }, compiledDescriptor: { pool: c.pool, capability: c.capability },
        staticProjection: { pool: c.pool, capability: c.capability },
        evidenceFingerprint: digest(["evidence", c]), candidateSnapshot: c });
    },
    rehydrateVerifiedInstance: ({ memo }) => ({ familyId: memo.familyId, instanceKey: memo.instanceKey }),
    aggregateOnceByFamily: instances => currentFamilies.flatMap(familyId => {
      const owned = instances.filter(value => (value as { familyId: string }).familyId === familyId);
      return owned.length ? [{ familyId, instances: owned }] : [];
    }),
    buildGraphSnapshot: publications => ({ edges: publications.flatMap(publication =>
      publication.instances.map(value => ({ familyId: publication.familyId,
        instanceKey: (value as { instanceKey: string }).instanceKey }))) }),
    buildCoverage: ({ sourceReceipts }) => sourceReceipts.flatMap(item => item.coverageKeys.map(value => {
      const split = value.indexOf("|");
      return { familyId: value.slice(0, split), sourceId: value.slice(split + 1),
        completeThroughBlock: item.appliedThrough.number, completeThroughHash: item.appliedThrough.hash };
    })),
    assertCanonicalHead: async cutoff => { assert.deepEqual(cutoff, currentSource); },
  };
  return {
    store, checkpointPath, input: dependencies, calls, memoLookups, memoDefinitionChecks, events, definitionCalls, rejected, retryable,
    definition,
    scans: () => scans,
    reverseReads: () => reverseReads,
    setCandidates(values: readonly Candidate[]) { currentCandidates = [...values]; },
    setFamilies(ids: readonly string[]) { currentFamilies = [...ids]; },
    changeDefinition(id: string) { definitions.set(id, digest(["changed", definition(id)])); },
    setDefinition(id: string, hash: string) { definitions.set(id, hash); },
    setSource(source: CanonicalSource) { currentSource = source; },
    onAttest(callback?: (c: Candidate) => Promise<void>) { beforeAttest = callback; },
    clearCalls() {
      calls.length = 0; memoLookups.length = 0; memoDefinitionChecks.length = 0; events.length = 0;
      definitionCalls.clear();
    },
    async probe(c: Candidate) {
      const checkpoint = (await store.load())!;
      const queued = checkpoint.retryableAttemptsByCandidateKey[key(c)]!;
      return probeOneFailure({ store, runId: queued.runId, familyCandidateKey: key(c),
        attestFamilyInstanceOnce: dependencies.attestFamilyInstanceOnce,
        sealDurableVerifiedMemo: dependencies.sealDurableVerifiedMemo,
        assertCanonicalHead: dependencies.assertCanonicalHead,
        decodeCandidateSnapshot: dependencies.decodeCandidateSnapshot! });
    },
    async run(options: RunOptions = {}) {
      const checkpoint = await store.load();
      const inputFingerprint = digest({
        parentGeneration: checkpoint?.readyGeneration?.generation ?? 0,
        source: currentSource, candidates: currentCandidates,
        definitions: currentFamilies.map(id => [id, definition(id)]),
        forceStatuses: options.forceStatuses ?? [],
      });
      const review = checkpoint?.readyGeneration ? {
        inputFingerprint, candidateKeys: new Set(currentCandidates.map(key)),
        ...(options.forceStatuses && { forceStatuses: options.forceStatuses }),
      } : undefined;
      return rebuildUniverse({ ...dependencies,
        runId: checkpoint?.inProgressRun?.runId ?? "full-input-" + inputFingerprint,
        currentCandidateKeys: new Set(currentCandidates.map(key)),
        observationRange: { fromBlock: currentSource.number, toBlock: currentSource.number },
        ...(review && { previousReadyReview: review }),
        ...(checkpoint?.inProgressRun && { resumeCompletedOutcomes: true }),
        ...options.overrides });
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

function outcome(ready: ReadyUniverseGeneration, c: Candidate): RunOutcome | undefined {
  return ready.familyPartitions?.[c.familyId]?.outcomesByCandidateKey[key(c)];
}

test("A: unchanged completed partitions inherit all statuses with zero per-memo checks", async t => {
  const v = candidate("family:a", "verified"), r = candidate("family:a", "rejected"),
    q = candidate("family:a", "retryable"), other = candidate("family:b", "another");
  const f = await fixture([v, r, q, other]); t.after(f.dispose);
  f.rejected.add(key(r)); f.retryable.add(key(q));
  const before = await f.run();
  const saved = (await f.store.load())!;
  f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [], "unchanged results do not enter attestation");
  assert.deepEqual(f.memoLookups, [], "batch inheritance must not disguise a per-instance memo lookup loop");
  assert.deepEqual(f.memoDefinitionChecks, [], "a matching family definition is checked at partition level");
  assert.deepEqual(after.candidateAccounting, before.candidateAccounting);
  for (const c of [v, r, q, other]) assert.deepEqual(outcome(after, c), outcome(before, c));
  assert.deepEqual((await f.store.load())!.verifiedMemos, saved.verifiedMemos);
});

test("the same complete input and source reuse sealed discovery even for an explicit retryable refresh", async t => {
  const x = candidate("family:x", "verified"), q = candidate("family:q", "retryable");
  const f = await fixture([x, q]); t.after(f.dispose);
  f.retryable.add(key(q)); await f.run();
  assert.equal(f.scans(), 1); assert.equal(f.reverseReads(), 1);
  f.clearCalls(); await f.run();
  assert.equal(f.scans(), 1, "matching input/source restores the already sealed discovery partition");
  assert.equal(f.reverseReads(), 1);
  assert.deepEqual(f.calls, []);
  f.clearCalls(); await f.run({ forceStatuses: ["retryable"] });
  assert.equal(f.scans(), 1, "an explicit outcome retry does not change discovery input");
  assert.equal(f.reverseReads(), 1);
  assert.deepEqual(f.calls, [key(q)]);
  f.changeDefinition(x.familyId); f.clearCalls(); await f.run();
  assert.equal(f.scans(), 1, "a changed validation rule with unchanged discovery input still uses the sealed nominations");
  assert.equal(f.reverseReads(), 1);
  assert.deepEqual(f.calls, [key(x)]);
});

test("candidate membership, candidate binding, family scope and source changes invalidate discovery reuse", async t => {
  const x = candidate("family:x", "pool"), fresh = candidate("family:x", "new-pool"),
    changed = candidate("family:x", "new-pool", "changed-binding"), other = candidate("family:y", "other-pool");
  const f = await fixture([x]); t.after(f.dispose);
  await f.run(); assert.equal(f.scans(), 1);
  f.setCandidates([x, fresh]); await f.run(); assert.equal(f.scans(), 2);
  f.setCandidates([x, changed]); await f.run(); assert.equal(f.scans(), 3);
  f.setFamilies([x.familyId, other.familyId]); f.setCandidates([x, changed, other]);
  await f.run(); assert.equal(f.scans(), 4);
  f.setSource({ number: SOURCE.number + 1, hash: "0x" + "b2".repeat(32), generation: 2 });
  await f.run();
  assert.equal(f.scans(), 5, "a matching raw discovery fingerprint does not authorize moving its source anchor");
  assert.equal(f.reverseReads(), 5);
});

test("discovery reuse binds exact selection independently of the raw input fingerprint", async t => {
  const x = candidate("family:x", "pool-x"), y = candidate("family:y", "pool-y");
  const f = await fixture([x, y]); t.after(f.dispose);
  await f.run({ overrides: { previousReadyReview: undefined, currentCandidateKeys: new Set([key(x)]) } });
  assert.equal(f.scans(), 1);
  const full = await f.run({ overrides: { previousReadyReview: undefined,
    currentCandidateKeys: new Set([key(x), key(y)]),
  } });
  assert.equal(f.scans(), 2, "widening a prior selection must discover the previously excluded member");
  assert.equal(full.candidateAccounting.verified, 2);
  await f.run({ overrides: { previousReadyReview: undefined, currentCandidateKeys: undefined } });
  assert.equal(f.scans(), 3, "explicit full selection and unselected discovery have different input contracts");
  await f.run({ overrides: { previousReadyReview: undefined, currentCandidateKeys: undefined } });
  assert.equal(f.scans(), 3);
  assert.equal(f.reverseReads(), 3);
});

test("legacy Ready without a discovery binding scans once before future complete-input reuse", async t => {
  const x = candidate("family:x", "pool");
  const f = await fixture([x]); t.after(f.dispose);
  const legacy = await f.run({ overrides: { readyReviewInputFingerprint: undefined } });
  assert.equal(legacy.discoveryInputBinding, undefined);
  assert.equal(f.scans(), 1);
  const bound = await f.run();
  assert.equal(f.scans(), 2, "old source receipts alone do not prove which complete input produced them");
  assert(bound.discoveryInputBinding);
  await f.run();
  assert.equal(f.scans(), 2); assert.equal(f.reverseReads(), 2);
});

test("discovery reuse retains the original fromBlock constraint even with an unchanged cutoff and raw input", async t => {
  const x = candidate("family:x", "pool");
  const f = await fixture([x]); t.after(f.dispose);
  await f.run(); assert.equal(f.scans(), 1);
  const observationRange = { fromBlock: SOURCE.number - 1, toBlock: SOURCE.number };
  const wider = await f.run({ overrides: { observationRange } });
  assert.equal(f.scans(), 2);
  assert.deepEqual(wider.universeRange, observationRange);
  await f.run({ overrides: { observationRange } });
  assert.equal(f.scans(), 2); assert.equal(f.reverseReads(), 2);
});

for (const mode of ["inherit", "force-retryable", "changed-definition"] as const) {
  test(`nomination retryable: ${mode} preserves the correct discovery and validation boundary`, async t => {
    const x = candidate("family:x", "verified"), q = candidate("family:q", "unresolved-pool");
    const f = await fixture([x, q]); t.after(f.dispose);
    let resolved = false;
    const markerChecks: string[] = [];
    const overrides: Partial<RebuildUniverseInput> = {
      reverseBindOpaqueCandidates: async args => {
        await f.input.reverseBindOpaqueCandidates!(args);
        return [resolved ? q : { ...q, unresolvedNomination: true }];
      },
      preAttestationRetryable: value => {
        markerChecks.push(key(value));
        return (value as Candidate & { readonly unresolvedNomination?: boolean }).unresolvedNomination
          ? { status: "retryable", stage: "nomination", failureCode: "rpc",
              reasonCode: "fixture-reverse-binding-unavailable", candidateSnapshot: value }
          : null;
      },
    };
    const rawInput = f.input.readyReviewInputFingerprint!();
    const before = await f.run({ overrides });
    assert.equal(outcome(before, q)?.status, "retryable");
    assert.deepEqual(f.calls, [key(x)], "the unresolved nomination never enters the family lifecycle");
    assert.equal(f.scans(), 1); assert.equal(f.reverseReads(), 1);
    resolved = true;
    if (mode === "changed-definition") f.changeDefinition(q.familyId);
    f.clearCalls(); markerChecks.length = 0;
    const after = await f.run({ overrides,
      ...(mode === "force-retryable" ? { forceStatuses: ["retryable"] as const } : {}),
    });
    assert.equal(f.input.readyReviewInputFingerprint!(), rawInput,
      "this case must not pass by changing the raw candidates, selection or source plan");
    assert.deepEqual(after.cutoff, before.cutoff);
    assert.deepEqual(outcome(after, x), outcome(before, x));
    if (mode === "inherit") {
      assert.equal(f.scans(), 1); assert.equal(f.reverseReads(), 1);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(markerChecks, [], "matching family definitions inherit without checking each nomination marker");
      assert.deepEqual(outcome(after, q), outcome(before, q));
    } else {
      assert.equal(f.scans(), 2, "a required nomination retry must re-enter discovery instead of freezing the old marker");
      assert.equal(f.reverseReads(), 2, "reverse binding must actually execute again to produce the resolved candidate");
      assert.deepEqual(f.calls, [key(q)]);
      assert.equal(outcome(after, q)?.status, "verified");
      assert.equal(after.candidateAccounting.verified, 2); assert.equal(after.candidateAccounting.retryable, 0);
      assert.equal((await f.store.load())!.retryableAttemptsByCandidateKey[key(q)], undefined);
    }
  });
}

test("B: adding a family keeps old negatives and covers its same-pool candidate", async t => {
  const v = candidate("family:a", "shared"), r = candidate("family:a", "rejected"),
    q = candidate("family:a", "retryable"), covered = candidate("family:new", "shared"),
    fresh = candidate("family:new", "new-pool");
  const f = await fixture([v, r, q]); t.after(f.dispose);
  f.rejected.add(key(r)); f.retryable.add(key(q));
  const before = await f.run();
  f.setFamilies(["family:a", "family:new"]); f.setCandidates([covered, r, fresh, q, v]); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [key(fresh)]);
  assert(!f.memoLookups.some(id => [v, r, q].some(c => key(c) === id)));
  assert(!f.memoDefinitionChecks.some(id => [v, r, q].some(c => key(c) === id)));
  for (const c of [v, r, q]) assert.deepEqual(outcome(after, c), outcome(before, c));
  assert.equal(outcome(after, covered)?.status, "covered");
  assert.equal((await f.store.load())!.verifiedMemos[key(covered)], undefined);
});

test("B: candidate additions and removals preserve unchanged outcomes in the same family", async t => {
  const kept = candidate("family:a", "kept"), removed = candidate("family:a", "removed"),
    r = candidate("family:a", "rejected"), q = candidate("family:a", "retryable"),
    fresh = candidate("family:a", "fresh");
  const f = await fixture([kept, removed, r, q]); t.after(f.dispose);
  f.rejected.add(key(r)); f.retryable.add(key(q));
  const before = await f.run();
  f.setCandidates([q, fresh, kept, r]); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [key(fresh)]);
  assert(!f.memoLookups.some(id => [kept, r, q].some(c => key(c) === id)));
  for (const c of [kept, r, q]) assert.deepEqual(outcome(after, c), outcome(before, c));
  assert.equal(outcome(after, removed), undefined);
  assert(!after.activeInstanceKeys.includes("instance:" + key(removed)));
  assert((await f.store.load())!.verifiedMemos[key(removed)], "removal from the output does not erase retained proof history");
});

test("B: removing a family changes activation without revalidating surviving families", async t => {
  const a = candidate("family:a", "a"), b = candidate("family:b", "b");
  const f = await fixture([a, b]); t.after(f.dispose);
  const before = await f.run();
  f.setFamilies(["family:a"]); f.setCandidates([a]); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.memoLookups, []); assert.deepEqual(f.memoDefinitionChecks, []);
  assert.deepEqual(outcome(after, a), outcome(before, a));
  assert.deepEqual(after.activeInstanceKeys, ["instance:" + key(a)]);
  assert((await f.store.load())!.verifiedMemos[key(b)]);
});

test("B: an empty explicit candidate set removes all active candidates without RPC", async t => {
  const a = candidate("family:a", "a"), b = candidate("family:a", "b");
  const f = await fixture([a, b]); t.after(f.dispose);
  await f.run(); f.setCandidates([]); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(after.activeInstanceKeys, []);
  assert.equal(after.candidateAccounting.total, 0);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.memoLookups, []);
});

test("B: a full empty family set can be published and unchanged historical families can return", async t => {
  const v = candidate("family:a", "verified"), r = candidate("family:a", "rejected"),
    q = candidate("family:a", "retryable"), b = candidate("family:b", "other");
  const f = await fixture([v, r, q, b]); t.after(f.dispose);
  f.rejected.add(key(r)); f.retryable.add(key(q));
  const before = await f.run();
  f.setFamilies([]); f.setCandidates([]); f.clearCalls();
  const empty = await f.run();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(empty.activeInstanceKeys, []); assert.equal(empty.candidateAccounting.total, 0);
  assert.notEqual(empty.familyPartitions?.[v.familyId]?.enabled, true);
  f.setFamilies([v.familyId]); f.setCandidates([v, r, q]); f.clearCalls();
  const returned = await f.run();
  assert.deepEqual(f.calls, [], "returning unchanged history is not treated as never-before-seen input");
  for (const c of [v, r, q]) assert.deepEqual(outcome(returned, c), outcome(before, c));
  assert.deepEqual(returned.activeInstanceKeys, ["instance:" + key(v)]);
});

test("B: changing one candidate binding does not revalidate other candidates in its family", async t => {
  const a = candidate("family:a", "a"), b = candidate("family:a", "b"), changed = candidate("family:a", "a", "new-binding");
  const f = await fixture([a, b]); t.after(f.dispose);
  const before = await f.run();
  f.setCandidates([changed, b]); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [key(changed)]);
  assert.deepEqual(outcome(after, b), outcome(before, b));
  assert.equal((await f.store.load())!.verifiedMemos[key(changed)]!.candidateFingerprint, candidateHash(changed));
});

test("C: only a changed family's outcomes are retried; unchanged family statuses are inherited", async t => {
  const x = candidate("family:x", "x-verified"), xr = candidate("family:x", "x-rejected"),
    xq = candidate("family:x", "x-retryable"), a = candidate("family:a", "a-verified"),
    ar = candidate("family:a", "a-rejected"), aq = candidate("family:a", "a-retryable");
  const f = await fixture([xr, ar, xq, aq, a, x]); t.after(f.dispose);
  f.rejected.add(key(xr)); f.rejected.add(key(ar)); f.retryable.add(key(xq)); f.retryable.add(key(aq));
  const before = await f.run();
  f.changeDefinition(x.familyId); f.rejected.delete(key(xr)); f.retryable.delete(key(xq)); f.clearCalls();
  const after = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.equal(f.calls[0], key(x), "the prior success is tried before the changed family's prior negatives");
  assert.deepEqual([...f.calls].sort(), [key(x), key(xr), key(xq)].sort());
  for (const c of [a, ar, aq]) assert.deepEqual(outcome(after, c), outcome(before, c));
  assert(!f.memoLookups.some(id => id.startsWith("family:a|")));
  assert(!f.memoDefinitionChecks.some(id => id.startsWith("family:a|")));
});

test("C/D: a held historical RPC blocks competing starts and its success removes same-pool work", { timeout: 5_000 }, async t => {
  const x = candidate("family:x", "shared"), r = candidate("family:x", "rejected"),
    y = candidate("family:y", "shared"), z = candidate("family:z", "shared"), fresh = candidate("family:y", "fresh");
  const f = await fixture([x, r]); t.after(f.dispose);
  f.rejected.add(key(r)); await f.run();
  f.changeDefinition(x.familyId); f.setFamilies(["family:x", "family:y", "family:z"]);
  f.setCandidates([y, fresh, r, z, x]); f.rejected.delete(key(r)); f.clearCalls();
  const entered = deferred(), release = deferred();
  f.onAttest(async c => { if (key(c) === key(x)) { entered.resolve(); await release.promise; } });
  const running = f.run({ overrides: { attestationConcurrency: 8 } });
  let after: ReadyUniverseGeneration | undefined;
  try {
    await Promise.race([entered.promise, running.then(() => {
      throw new Error("review completed without invoking the historical RPC");
    })]);
    await new Promise<void>(done => setImmediate(done));
    assert.deepEqual(f.calls, [key(x)], "queue sorting alone must not let ordinary candidates start while the historical RPC is pending");
  } finally {
    release.resolve();
    after = await running;
  }
  assert.deepEqual([...f.calls].sort(), [key(x), key(r), key(fresh)].sort());
  assert(after);
  assert.equal(outcome(after, y)?.status, "covered"); assert.equal(outcome(after, z)?.status, "covered");
  assert(f.events.indexOf("end:" + key(x)) < f.events.indexOf("start:" + key(fresh)));
});

test("C/D: a rejected historical family is attempted once and alternatives use the normal flow", async t => {
  const x = candidate("family:x", "shared"), y = candidate("family:y", "shared"), fresh = candidate("family:y", "fresh");
  const f = await fixture([x]); t.after(f.dispose);
  await f.run(); f.changeDefinition(x.familyId); f.setFamilies(["family:x", "family:y"]);
  f.setCandidates([y, fresh, x]); f.rejected.add(key(x)); f.clearCalls();
  const after = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.equal(f.calls[0], key(x));
  assert.deepEqual([...f.calls].sort(), [key(x), key(y), key(fresh)].sort());
  assert.equal(outcome(after, x)?.status, "terminal-rejected");
  assert.equal(outcome(after, y)?.status, "verified");
  assert.equal(after.candidateAccounting.covered ?? 0, 0);
});

test("C/D: a temporary RPC failure cannot cover the other family's candidate", async t => {
  const x = candidate("family:x", "shared"), y = candidate("family:y", "shared");
  const f = await fixture([x]); t.after(f.dispose);
  await f.run(); f.changeDefinition(x.familyId); f.setFamilies(["family:x", "family:y"]);
  f.setCandidates([y, x]); f.retryable.add(key(x)); f.clearCalls();
  const after = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.deepEqual(f.calls, [key(x), key(y)]);
  assert.equal(outcome(after, x)?.status, "retryable");
  assert.equal(outcome(after, y)?.status, "verified");
  assert.equal(after.candidateAccounting.covered ?? 0, 0);
});

test("C: concurrent historical successes at the same pool share one new RPC after both definitions change", { timeout: 5_000 }, async t => {
  const x = candidate("family:x", "shared"), y = candidate("family:y", "shared");
  const f = await fixture([x, y]); t.after(f.dispose);
  const before = await f.run({ overrides: { candidateCoverage: () => null } });
  assert.equal(before.candidateAccounting.verified, 2);
  f.changeDefinition(x.familyId); f.changeDefinition(y.familyId); f.clearCalls();
  const entered = deferred(), release = deferred();
  f.onAttest(async c => { if (key(c) === key(x)) { entered.resolve(); await release.promise; } });
  const running = f.run({ overrides: { attestationConcurrency: 8 } });
  let after: ReadyUniverseGeneration | undefined;
  try {
    await Promise.race([entered.promise, running.then(() => {
      throw new Error("review completed without invoking the first historical RPC");
    })]);
    await new Promise<void>(done => setImmediate(done));
    assert.deepEqual(f.calls, [key(x)], "the other historical candidate must wait for this pool's current verdict");
  } finally {
    release.resolve();
    after = await running;
  }
  assert(after);
  assert.deepEqual(f.calls, [key(x)], "the second candidate observes the first success before starting RPC");
  assert.equal(outcome(after, x)?.status, "verified"); assert.equal(outcome(after, y)?.status, "covered");
  assert.equal(after.candidateAccounting.verified, 1); assert.equal(after.candidateAccounting.covered, 1);
  assert.deepEqual(after.activeInstanceKeys, ["instance:" + key(x)]);
});

test("force retryable bypasses inheritance and same-pool coverage without retrying other statuses", async t => {
  const x = candidate("family:x", "shared"), q = candidate("family:q", "shared"), r = candidate("family:r", "rejected");
  const f = await fixture([x, q, r]); t.after(f.dispose);
  f.retryable.add(key(q)); f.rejected.add(key(r));
  const before = await f.run({ overrides: { candidateCoverage: () => null } });
  f.retryable.delete(key(q)); f.clearCalls();
  const after = await f.run({ forceStatuses: ["retryable"] });
  assert.deepEqual(f.calls, [key(q)], "a forced retry must run even though X already covers this physical pool");
  assert(!f.memoLookups.some(id => [x, r].some(c => key(c) === id)));
  assert(!f.memoDefinitionChecks.some(id => [x, r].some(c => key(c) === id)));
  assert.deepEqual(outcome(after, x), outcome(before, x));
  assert.deepEqual(outcome(after, r), outcome(before, r));
  assert.equal(outcome(after, q)?.status, "verified");
});

test("force terminal-rejected retries only that status despite an inherited same-pool winner", async t => {
  const x = candidate("family:x", "shared"), r = candidate("family:r", "shared"), q = candidate("family:q", "retryable");
  const f = await fixture([x, r, q]); t.after(f.dispose);
  f.rejected.add(key(r)); f.retryable.add(key(q));
  const before = await f.run({ overrides: { candidateCoverage: () => null } });
  f.rejected.delete(key(r)); f.clearCalls();
  const after = await f.run({ forceStatuses: ["terminal-rejected"] });
  assert.deepEqual(f.calls, [key(r)]);
  assert(!f.memoLookups.some(id => [x, q].some(c => key(c) === id)));
  assert(!f.memoDefinitionChecks.some(id => [x, q].some(c => key(c) === id)));
  assert.deepEqual(outcome(after, x), outcome(before, x));
  assert.deepEqual(outcome(after, q), outcome(before, q));
  assert.equal(outcome(after, r)?.status, "verified");
});

test("force verified retries each selected historical success even when they share a pool", async t => {
  const x = candidate("family:x", "shared"), y = candidate("family:y", "shared"),
    r = candidate("family:r", "rejected"), q = candidate("family:q", "retryable");
  const f = await fixture([x, y, r, q]); t.after(f.dispose);
  f.rejected.add(key(r)); f.retryable.add(key(q));
  const before = await f.run({ overrides: { candidateCoverage: () => null } });
  f.clearCalls();
  const after = await f.run({ forceStatuses: ["verified"], overrides: { attestationConcurrency: 1 } });
  assert.deepEqual([...f.calls].sort(), [key(x), key(y)].sort());
  assert.equal(outcome(after, x)?.status, "verified"); assert.equal(outcome(after, y)?.status, "verified");
  assert.deepEqual(outcome(after, r), outcome(before, r));
  assert.deepEqual(outcome(after, q), outcome(before, q));
});

test("A: existing successful independent capabilities at one pool are all retained", async t => {
  const ordinary = candidate("family:swap", "shared"), independent = candidate("family:lp", "shared", "original", "liquidity");
  const f = await fixture([ordinary, independent]); t.after(f.dispose);
  const before = await f.run(); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.memoLookups, []); assert.deepEqual(f.memoDefinitionChecks, []);
  assert.equal(after.candidateAccounting.verified, 2); assert.equal(after.candidateAccounting.covered ?? 0, 0);
  assert.deepEqual(after.activeInstanceKeys, before.activeInstanceKeys);
  for (const c of [ordinary, independent]) assert.deepEqual(outcome(after, c), outcome(before, c));
});

test("B: removing a successful winner causes its formerly covered candidate to enter normal validation", async t => {
  const x = candidate("family:x", "shared"), y = candidate("family:y", "shared");
  const f = await fixture([x, y]); t.after(f.dispose);
  const before = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.equal(outcome(before, x)?.status, "verified"); assert.equal(outcome(before, y)?.status, "covered");
  f.setFamilies([y.familyId]); f.setCandidates([y]); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [key(y)], "a derived covered result cannot outlive its active winner");
  assert.equal(outcome(after, y)?.status, "verified");
  assert.equal(after.candidateAccounting.covered ?? 0, 0);
  assert.deepEqual(after.activeInstanceKeys, ["instance:" + key(y)]);
});

test("C: an unchanged covered family must re-enter validation when its winner's new definition rejects", async t => {
  const x = candidate("family:x", "shared"), y = candidate("family:y", "shared");
  const f = await fixture([x, y]); t.after(f.dispose);
  const before = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.equal(outcome(before, y)?.status, "covered");
  f.changeDefinition(x.familyId); f.rejected.add(key(x)); f.clearCalls();
  const after = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.deepEqual(f.calls, [key(x), key(y)]);
  assert.equal(outcome(after, x)?.status, "terminal-rejected"); assert.equal(outcome(after, y)?.status, "verified");
  assert.equal(after.candidateAccounting.covered ?? 0, 0);
});

test("force retryable resume keeps completed retryable work and runs only the interrupted remainder", async t => {
  const q = candidate("family:a", "a-retryable"), r = candidate("family:a", "b-retryable");
  const f = await fixture([q, r]); t.after(f.dispose);
  f.retryable.add(key(q)); f.retryable.add(key(r)); await f.run(); f.clearCalls();
  let interrupted = false;
  f.onAttest(async c => { if (key(c) === key(r) && !interrupted) { interrupted = true; throw new Error("interrupted force refresh"); } });
  await assert.rejects(f.run({ forceStatuses: ["retryable"], overrides: { attestationConcurrency: 1 } }), /interrupted force refresh/);
  const checkpoint = (await f.store.load())!;
  assert.equal(checkpoint.inProgressRun!.outcomesByCandidateKey[key(q)]?.status, "retryable");
  f.onAttest(); f.retryable.delete(key(r));
  const after = await f.run({ forceStatuses: ["retryable"], overrides: { attestationConcurrency: 1 } });
  assert.equal(f.calls.filter(id => id === key(q)).length, 1);
  assert.equal(f.calls.filter(id => id === key(r)).length, 2, "one interrupted call plus one resumed call");
  assert.equal(outcome(after, q)?.status, "retryable");
  assert.equal(outcome(after, r)?.status, "verified");
});

test("resume rejects changed force statuses even if the caller reuses the old review fingerprint", async t => {
  const q = candidate("family:a", "a-retryable"), r = candidate("family:a", "b-retryable");
  const f = await fixture([q, r]); t.after(f.dispose);
  f.retryable.add(key(q)); f.retryable.add(key(r)); await f.run();
  f.onAttest(async c => { if (key(c) === key(r)) throw new Error("interrupted force metadata test"); });
  await assert.rejects(f.run({ forceStatuses: ["retryable"], overrides: { attestationConcurrency: 1 } }), /interrupted force metadata test/);
  const before = (await f.store.load())!;
  f.onAttest(); f.clearCalls();
  await assert.rejects(f.run({ overrides: { previousReadyReview: {
    inputFingerprint: before.inProgressRun!.reviewInputFingerprint!,
    candidateKeys: new Set([key(q), key(r)]), forceStatuses: ["terminal-rejected"],
  } } }), /different fixed input/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual((await f.store.load())!.inProgressRun, before.inProgressRun);
});

for (const legacyFlag of ["retryNegativeOutcomes", "revalidateParentProofs"] as const) {
  test(`resume binds the effective force policy supplied by ${legacyFlag}`, async t => {
    const q = candidate("family:a", "a-retryable"), r = candidate("family:a", "b-retryable");
    const f = await fixture([q, r]); t.after(f.dispose);
    f.retryable.add(key(q)); f.retryable.add(key(r)); await f.run();
    f.onAttest(async c => { if (key(c) === key(r)) throw new Error("interrupted legacy force"); });
    const inputFingerprint = digest(["bound-legacy-force", legacyFlag]);
    await assert.rejects(f.run({ overrides: { attestationConcurrency: 1,
      previousReadyReview: { inputFingerprint, [legacyFlag]: true },
    } }), /interrupted legacy force/);
    const before = (await f.store.load())!;
    f.onAttest(); f.clearCalls();
    await assert.rejects(f.run({ overrides: { previousReadyReview: { inputFingerprint } } }), /different fixed input/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual((await f.store.load())!.inProgressRun, before.inProgressRun);
  });
}

test("A resume: completed inherited and newly verified outcomes are not checked per memo again", async t => {
  const old = candidate("family:a", "old"), first = candidate("family:a", "a-new"), pending = candidate("family:a", "b-new");
  const f = await fixture([old]); t.after(f.dispose);
  await f.run(); f.setCandidates([old, first, pending]);
  f.onAttest(async c => { if (key(c) === key(pending)) throw new Error("interrupted full input"); });
  await assert.rejects(f.run({ overrides: { attestationConcurrency: 1 } }), /interrupted full input/);
  const checkpoint = (await f.store.load())!;
  assert.equal(checkpoint.inProgressRun!.outcomesByCandidateKey[key(first)]?.status, "verified");
  f.onAttest(); f.clearCalls();
  const after = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.deepEqual(f.calls, [key(pending)]);
  assert(!f.memoLookups.some(id => [old, first].some(c => key(c) === id)));
  assert(!f.memoDefinitionChecks.some(id => [old, first].some(c => key(c) === id)));
  assert.equal(after.candidateAccounting.verified, 3);
});

test("A resume: the first build can continue without rechecking its already completed verified item", async t => {
  const first = candidate("family:a", "a-first"), pending = candidate("family:a", "b-pending");
  const f = await fixture([first, pending]); t.after(f.dispose);
  f.onAttest(async c => { if (key(c) === key(pending)) throw new Error("interrupted initial build"); });
  await assert.rejects(f.run({ overrides: { attestationConcurrency: 1 } }), /interrupted initial build/);
  assert.equal((await f.store.load())!.readyGeneration, null);
  f.onAttest(); f.clearCalls();
  const after = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.deepEqual(f.calls, [key(pending)]);
  assert(!f.memoLookups.includes(key(first)), "already completed work must inherit without a memo lookup");
  assert(!f.memoDefinitionChecks.includes(key(first)));
  assert.equal(after.candidateAccounting.verified, 2);
});

test("an interrupted first build revalidates completed work when its final family hash changes", async t => {
  const first = candidate("family:a", "a-first"), pending = candidate("family:a", "b-pending");
  const f = await fixture([first, pending]); t.after(f.dispose);
  f.onAttest(async c => { if (key(c) === key(pending)) throw new Error("interrupted initial definition test"); });
  await assert.rejects(f.run({ overrides: { attestationConcurrency: 1 } }), /interrupted initial definition test/);
  const oldMemo = (await f.store.load())!.verifiedMemos[key(first)]!;
  f.changeDefinition(first.familyId); f.onAttest(); f.clearCalls();
  const after = await f.run({ overrides: { attestationConcurrency: 1 } });
  assert.deepEqual(f.calls, [key(first), key(pending)], "completed work under the old hash is no longer an A inheritance");
  assert.equal(after.candidateAccounting.verified, 2);
  const newMemo = (await f.store.load())!.verifiedMemos[key(first)]!;
  assert.notEqual(newMemo.familyDefinitionHash, oldMemo.familyDefinitionHash);
  assert.notEqual(newMemo.memoFingerprint, oldMemo.memoFingerprint);
});

test("an interrupted first build rejects changed complete input before any definition reconciliation", async t => {
  const first = candidate("family:a", "a-first"), pending = candidate("family:a", "b-pending");
  const f = await fixture([first, pending]); t.after(f.dispose);
  f.onAttest(async c => { if (key(c) === key(pending)) throw new Error("interrupted bound complete input"); });
  await assert.rejects(f.run({ overrides: { attestationConcurrency: 1,
    currentInputFingerprint: digest([first, pending]),
  } }), /interrupted bound complete input/);
  const before = (await f.store.load())!;
  const changed = candidate(pending.familyId, pending.pool, "changed-input");
  f.setCandidates([first, changed]); f.changeDefinition(first.familyId); f.onAttest(); f.clearCalls();
  await assert.rejects(f.run({ overrides: { currentInputFingerprint: digest([first, changed]) } }),
    /complete candidate input differs|different fixed input/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual((await f.store.load())!.inProgressRun, before.inProgressRun);
});

for (const forceRetryable of [false, true]) {
test(`a successful independent probe supersedes a sealed retryable row${forceRetryable ? " even when refreshing retryables" : " without resurrecting its queue"}`, async t => {
  const x = candidate("family:x", "verified"), q = candidate("family:q", "retryable");
  const f = await fixture([x, q]); t.after(f.dispose);
  f.retryable.add(key(q)); await f.run();
  f.retryable.delete(key(q));
  assert.equal((await f.probe(q)).status, "verified");
  const probed = (await f.store.load())!;
  assert.equal(probed.retryableAttemptsByCandidateKey[key(q)], undefined);
  const proof = probed.verifiedMemos[key(q)]!;
  f.clearCalls();
  const after = await f.run(forceRetryable ? { forceStatuses: ["retryable"] } : {});
  assert.equal(outcome(after, q)?.status, "verified");
  assert.deepEqual(f.calls, [], "the successful probe already supplied reusable verification evidence");
  assert(!f.memoLookups.includes(key(x)), "unrelated sealed successes retain partition inheritance");
  assert.equal((await f.store.load())!.retryableAttemptsByCandidateKey[key(q)], undefined);
  assert.deepEqual((await f.store.load())!.verifiedMemos[key(q)], proof);
});
}

test("an independent retryable probe keeps its latest attempt instead of restoring an older sealed row", async t => {
  const q = candidate("family:q", "retryable");
  const f = await fixture([q]); t.after(f.dispose);
  f.retryable.add(key(q)); await f.run();
  const attempted = await f.probe(q);
  assert.equal(attempted.status, "retryable");
  if (attempted.status !== "retryable") throw new Error("expected retryable probe");
  assert.equal(attempted.attemptCount, 2);
  f.clearCalls();
  const after = await f.run();
  assert.deepEqual(outcome(after, q), attempted);
  assert.deepEqual(f.calls, [], "an unchanged hash does not force another attempt after an independent probe");
  assert.equal((await f.store.load())!.retryableAttemptsByCandidateKey[key(q)]?.attemptCount, 2);
});

test("an independent probe's changed candidate binding cannot replace the current input's inherited retryable", async t => {
  const q = candidate("family:q", "retryable"), different = candidate("family:q", "retryable", "probe-changed-binding");
  const f = await fixture([q]); t.after(f.dispose);
  f.retryable.add(key(q)); await f.run();
  const queued = (await f.store.load())!.retryableAttemptsByCandidateKey[key(q)]!;
  await probeOneFailure({ ...f.input, runId: queued.runId, familyCandidateKey: key(q),
    decodeCandidateSnapshot: f.input.decodeCandidateSnapshot!,
    attestFamilyInstanceOnce: async args => {
      const result = await f.input.attestFamilyInstanceOnce(args);
      assert.equal(result.status, "retryable");
      if (result.status !== "retryable") throw new Error("expected retryable probe");
      return { ...result, candidateSnapshot: different };
    },
  });
  f.retryable.delete(key(q)); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [key(q)], "a source match alone does not bind the queue's changed candidate snapshot");
  assert.equal(outcome(after, q)?.status, "verified");
  assert.equal((await f.store.load())!.verifiedMemos[key(q)]!.candidateFingerprint, candidateHash(q));
});

test("legacy exact refresh cannot make a new-definition memo inheritable under the old family hash", async t => {
  const x = candidate("family:x", "pool");
  const f = await fixture([x]); t.after(f.dispose);
  await f.run(); const originalHash = f.definition(x.familyId);
  f.changeDefinition(x.familyId);
  await refreshReadyInstances({ ...f.input, store: f.store });
  assert.notEqual((await f.store.load())!.verifiedMemos[key(x)]!.familyDefinitionHash, originalHash);
  f.setDefinition(x.familyId, originalHash); f.clearCalls();
  await f.run();
  assert.deepEqual(f.calls, [key(x)], "an exact refresh's newer proof is not an old-hash partition result");
  assert.equal((await f.store.load())!.verifiedMemos[key(x)]!.familyDefinitionHash, originalHash);
});

test("legacy exact refresh does not stamp a new family definition onto untouched negative results", async t => {
  const x = candidate("family:x", "verified"), r = candidate("family:x", "rejected");
  const f = await fixture([x, r]); t.after(f.dispose);
  f.rejected.add(key(r)); await f.run();
  f.changeDefinition(x.familyId); f.rejected.delete(key(r));
  await refreshReadyInstances({ ...f.input, store: f.store });
  f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [key(r)], "only the old negative still needs verification under the new definition");
  assert.equal(outcome(after, r)?.status, "verified");
  assert.equal(after.candidateAccounting.verified, 2);
});

test("a legacy family supplement cannot leave inheritable history pointing at a deleted memo", async t => {
  const old = candidate("family:x", "old-pool"), fresh = candidate("family:x", "new-pool");
  const f = await fixture([old]); t.after(f.dispose);
  await f.run();
  f.setFamilies([]); f.setCandidates([]); await f.run();
  const parent = (await f.store.load())!;
  assert(parent.verifiedMemos[key(old)]);
  const delta = await fixture([fresh]); t.after(delta.dispose);
  await copyFile(f.checkpointPath, delta.checkpointPath);
  await delta.run({ overrides: { previousReadyReview: undefined,
    familyUpdateScope: { parentCheckpointFingerprint: parent.checkpointFingerprint, familyIds: [fresh.familyId] },
  } });
  const supplement = (await delta.store.load())!;
  f.setFamilies([fresh.familyId]); f.setCandidates([fresh]);
  await updateReadyFamilies({ ...f.input,
    supplements: [{ checkpoint: supplement, familyIds: [fresh.familyId] }],
    assertReadyGraphSnapshot: ({ publications, graphSnapshot, cutoff }) => {
      assert.deepEqual(graphSnapshot, f.input.buildGraphSnapshot(publications, cutoff));
    },
  });
  assert.equal((await f.store.load())!.verifiedMemos[key(old)], undefined,
    "the legacy supplement deliberately removes obsolete out-of-scope proof bytes");
  f.setCandidates([old, fresh]); f.clearCalls();
  const after = await f.run();
  assert.deepEqual(f.calls, [key(old)], "unavailable historical proof returns to normal verification");
  assert.equal(after.candidateAccounting.verified, 2);
});

test("changed source retains original authority checks instead of treating equal family hashes as a proof", async t => {
  const x = candidate("family:x", "pool");
  const f = await fixture([x]); t.after(f.dispose);
  await f.run();
  const next = { number: SOURCE.number + 1, hash: "0x" + "b2".repeat(32), generation: 2 };
  f.setSource(next); f.clearCalls();
  const after = await f.run();
  assert(f.memoLookups.includes(key(x)), "cross-source authority goes through the existing memo check");
  assert.deepEqual(f.calls, [key(x)], "the fixture's authority checker rejects evidence from the old source");
  assert.equal(after.cutoff.hash, next.hash);
  const memo = activeReadyMemos((await f.store.load())!)[0]!;
  assert.deepEqual(memo.validity.proofSource, { number: next.number, hash: next.hash });
});

test("changed source can still inherit a memo accepted by the original authority check without rewriting its proof", async t => {
  const x = candidate("family:x", "pool");
  const f = await fixture([x]); t.after(f.dispose);
  await f.run();
  const original = (await f.store.load())!.verifiedMemos[key(x)]!;
  const next = { number: SOURCE.number + 1, hash: "0x" + "b2".repeat(32), generation: 2 };
  f.setSource(next); f.clearCalls();
  const after = await f.run({ overrides: {
    findReusableMemo: async ({ candidate: c, checkpoint }) => {
      f.memoLookups.push(key(c));
      return checkpoint.verifiedMemos[key(c)] ?? null;
    },
  } });
  assert.deepEqual(f.memoLookups, [key(x)]);
  assert.deepEqual(f.calls, [], "the unified flow must retain an affirmative result from the existing authority checker");
  assert.equal(after.candidateAccounting.verified, 1);
  assert.equal(outcome(after, x)?.status, "verified");
  assert.deepEqual(activeReadyMemos((await f.store.load())!)[0], original);
});

test("reappearing disabled history keeps its original proof source after an empty generation moves the cutoff", async t => {
  const x = candidate("family:x", "verified"), r = candidate("family:x", "rejected");
  const f = await fixture([x, r]); t.after(f.dispose);
  f.rejected.add(key(r)); await f.run();
  f.setFamilies([]); f.setCandidates([]); await f.run();
  const next = { number: SOURCE.number + 1, hash: "0x" + "b2".repeat(32), generation: 2 };
  f.setSource(next); await f.run();
  f.setFamilies([x.familyId]); f.setCandidates([x, r]); f.rejected.delete(key(r)); f.clearCalls();
  const after = await f.run();
  assert(f.memoLookups.includes(key(x)), "a newer empty Ready cutoff cannot rewrite a removed member's proof source");
  assert.deepEqual([...f.calls].sort(), [key(x), key(r)].sort());
  assert.equal(after.candidateAccounting.verified, 2);
  for (const memo of activeReadyMemos((await f.store.load())!)) {
    assert.deepEqual(memo.validity.proofSource, { number: next.number, hash: next.hash });
  }
});

