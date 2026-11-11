import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  UniverseRebuildCheckpointStore,
  activeReadyMemos,
  buildReadyCatalogSnapshot,
  canonicalJsonFingerprint,
  durableCandidateSnapshotFingerprint,
  durableVerifiedMemoFingerprint,
  envelopeFingerprint,
  isCoveredCandidateOutcomeValid,
  prepareReadyFamilyUpdate,
  readyPartitionAccounting,
  validateReadyFamilyGraph,
  type CoveredCandidateOutcome,
  type DurableSourceReceipt,
  type DurableVerifiedMemo,
  type InProgressUniverseRun,
  type ReadyFamilyPartition,
  type ReadyUniverseGeneration,
  type RunOutcome,
  type StartupCheckpointEnvelope,
} from "../universe-rebuild-checkpoint.js";

const fp = (value: unknown) => canonicalJsonFingerprint(value);
const SOURCE = Object.freeze({ number: 100, hash: "0x" + "a1".repeat(32), generation: 1 });
const GRAPH = Object.freeze({ edges: Object.freeze([]) });
const CANDIDATES = Object.freeze({
  a: Object.freeze({ familyId: "alpha", address: "pool-p", id: "a" }),
  b: Object.freeze({ familyId: "beta", address: "pool-p", id: "b" }),
  c: Object.freeze({ familyId: "gamma", address: "pool-q", id: "c" }),
});
const PAIR = Object.freeze({ a: CANDIDATES.a, b: CANDIDATES.b });
type CandidateSet = Readonly<Record<string, { readonly familyId: string }>>;

function receipts(candidates: CandidateSet): readonly DurableSourceReceipt[] {
  return [Object.freeze({
    sourceKey: fp("source"), sourceKind: "startup-candidate-union", providerIdentity: "fixture",
    queryFingerprint: fp("query"), fromBlock: 90, toBlock: SOURCE.number,
    cutoffNumber: SOURCE.number, cutoffHash: SOURCE.hash,
    coverageKeys: [...new Set(Object.values(candidates).map(row => row.familyId + "|startup-universe"))].sort(),
    completedChunks: [{ fromBlock: 90, toBlock: SOURCE.number, resultCount: Object.keys(candidates).length,
      resultHash: fp(candidates) }],
    observationSetHash: fp(candidates), observedThrough: SOURCE, appliedThrough: SOURCE,
    retryableCount: 0, status: "complete",
  })];
}

function memoFor(key: keyof typeof CANDIDATES, version = "v1"): DurableVerifiedMemo {
  const candidate = CANDIDATES[key];
  const unsigned = {
    familyCandidateKey: key, familyInstanceKey: candidate.familyId + ":" + key,
    familyId: candidate.familyId, candidateKey: key, instanceKey: candidate.familyId + ":" + key,
    candidateFingerprint: fp(candidate), familyDefinitionHash: fp(candidate.familyId + ":" + version),
    validity: { policy: "immutable-code" as const, authorityFingerprint: fp("authority"), proofSource: SOURCE },
    verifiedIdentity: { key }, compiledDescriptor: { key, version }, staticProjection: { key },
    evidenceFingerprint: fp("evidence:" + key), candidateSnapshot: candidate, memoFingerprint: "",
  };
  return Object.freeze({ ...unsigned, memoFingerprint: durableVerifiedMemoFingerprint(unsigned) });
}

function verified(memo: DurableVerifiedMemo): RunOutcome {
  return { status: "verified", familyCandidateKey: memo.familyCandidateKey,
    familyInstanceKey: memo.familyInstanceKey, memoFingerprint: memo.memoFingerprint };
}

function covered(memo: DurableVerifiedMemo, key: "b" | "c" = "b"): CoveredCandidateOutcome {
  return {
    status: "covered", familyCandidateKey: key, familyId: CANDIDATES[key].familyId,
    candidateFingerprint: fp(CANDIDATES[key]),
    candidateSnapshotFingerprint: durableCandidateSnapshotFingerprint(CANDIDATES[key]),
    familyDefinitionHash: fp(CANDIDATES[key].familyId + ":v1"), coverageKey: "competing-pool-p",
    coverageFingerprint: fp([key, "coverage"]), winnerFamilyCandidateKey: memo.familyCandidateKey,
    winnerMemoFingerprint: memo.memoFingerprint,
    winnerCoverageFingerprint: fp([memo.familyDefinitionHash, "coverage"]), cutoff: SOURCE,
  };
}

async function begin(store: UniverseRebuildCheckpointStore, candidates: CandidateSet = PAIR) {
  return store.beginOrResumeRun({ expectedRevision: 0, runId: "coverage-run", cutoff: SOURCE,
    fromBlock: 90, universeHash: fp(candidates), candidateSetHash: fp(Object.keys(candidates)),
    candidateCount: Object.keys(candidates).length, candidatesByKey: candidates,
    observedThrough: SOURCE, sourceReceipts: receipts(candidates) });
}

function readyFor(run: InProgressUniverseRun, memos: Readonly<Record<string, DurableVerifiedMemo>>): ReadyUniverseGeneration {
  const partitions: Record<string, ReadyFamilyPartition> = {};
  for (const [key, snapshot] of Object.entries(run.candidatesByKey)) {
    const familyId = (snapshot as { familyId: string }).familyId;
    const previous = partitions[familyId];
    const candidates = { ...previous?.candidatesByKey, [key]: snapshot };
    partitions[familyId] = {
      enabled: true, familyDefinitionHash: fp(familyId + ":v1"),
      candidatesByKey: candidates, candidateSetHash: canonicalJsonFingerprint(candidates, "universe-candidate-partition-v1:"),
      discoveryDefinitionHash: fp("discovery:" + familyId),
      outcomesByCandidateKey: { ...previous?.outcomesByCandidateKey, [key]: run.outcomesByCandidateKey[key]! },
      sourceReceipts: run.sourceReceipts,
    };
  }
  const active = Object.values(run.outcomesByCandidateKey)
    .filter(row => row.status === "verified").map(row => memos[row.familyCandidateKey]!);
  const catalog = buildReadyCatalogSnapshot(active);
  return {
    ...(run.familyUpdateScope === undefined ? {} : { familyUpdateScope: run.familyUpdateScope }),
    generation: 1, cutoff: SOURCE, universeRange: { fromBlock: 90, toBlock: SOURCE.number },
    universeHash: run.universeHash, activeInstanceKeys: active.map(memo => memo.familyInstanceKey).sort(),
    catalogHash: canonicalJsonFingerprint(catalog, "catalog-v1:"),
    publicationSetHash: canonicalJsonFingerprint(catalog, "publications-v2:"),
    candidateAccounting: readyPartitionAccounting(partitions), observedThrough: SOURCE, appliedThrough: SOURCE,
    sourceCoverage: run.sourceReceipts.flatMap(receipt => receipt.coverageKeys.map(key => {
      const [familyId, sourceId] = key.split("|");
      return { familyId: familyId!, sourceId: sourceId!, completeThroughBlock: SOURCE.number, completeThroughHash: SOURCE.hash };
    })),
    graphSnapshot: GRAPH, graphHash: canonicalJsonFingerprint(GRAPH, "graph-v2:"),
    catalogSnapshot: catalog, familyPartitions: partitions,
  };
}

async function sealReady(store: UniverseRebuildCheckpointStore) {
  const state = (await store.load())!;
  return store.casCommitReadyGeneration({ expectedRevision: state.revision, runId: "coverage-run",
    ready: readyFor(state.inProgressRun!, state.verifiedMemos) });
}

async function withStore(work: (store: UniverseRebuildCheckpointStore, path: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ready-coverage-checkpoint-"));
  const path = join(dir, "checkpoint.json");
  try { await work(new UniverseRebuildCheckpointStore({ path }), path, dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function seedReady(store: UniverseRebuildCheckpointStore) {
  await begin(store);
  const memo = memoFor("a");
  await store.casMergeAttestationWrites("coverage-run", [{ outcome: verified(memo), memo }, { outcome: covered(memo) }]);
  return sealReady(store);
}

test("covered tasks keep exact candidate accounting and survive journal/Ready reload", async () => withStore(async (store, path) => {
  await begin(store);
  const memo = memoFor("a");
  await store.casUpsertMemo(memoFor("b"));
  await store.casUpsertMemo(memoFor("c"));
  await store.casMergeAttestationWrites("coverage-run", [{ outcome: verified(memo), memo }, { outcome: covered(memo) }]);
  const resumed = (await new UniverseRebuildCheckpointStore({ path }).load())!;
  assert.equal(resumed.inProgressRun!.outcomesByCandidateKey.b!.status, "covered");
  assert.equal(resumed.verifiedMemos.b!.memoFingerprint, memoFor("b").memoFingerprint, "coverage never deletes a retained memo");
  assert.equal(resumed.verifiedMemos.c!.memoFingerprint, memoFor("c").memoFingerprint);
  const ready = await sealReady(store);
  assert.deepEqual(ready.readyGeneration!.candidateAccounting,
    { total: 2, verified: 1, terminalRejected: 0, retryable: 0, covered: 1, remainingUnaccounted: 0 });
  assert.deepEqual(activeReadyMemos(ready).map(row => row.familyCandidateKey), ["a"]);
  assert.deepEqual(Object.keys(ready.readyGeneration!.familyPartitions!.beta!.candidatesByKey), ["b"]);
  assert.equal((await new UniverseRebuildCheckpointStore({ path }).load())!.checkpointFingerprint, ready.checkpointFingerprint);
}));

test("covered requires an earlier verified winner and cannot carry a fabricated memo", async () => withStore(async store => {
  await begin(store, CANDIDATES);
  const memo = memoFor("a");
  await assert.rejects(store.casMergeAttestationWrites("coverage-run",
    [{ outcome: covered(memo) }, { outcome: verified(memo), memo }]), /verified winner/);
  const state = await store.casMergeAttestationWrites("coverage-run", [{ outcome: verified(memo), memo }]);
  const invalid = [
    { ...covered(memo), winnerFamilyCandidateKey: "missing" },
    { ...covered(memo), winnerFamilyCandidateKey: "b" },
    { ...covered(memo), winnerMemoFingerprint: fp("wrong") },
    { ...covered(memo), familyId: "wrong" },
    { ...covered(memo), candidateSnapshotFingerprint: fp("different-candidate") },
    { ...covered(memo), cutoff: { ...SOURCE, number: SOURCE.number + 1 } },
    { ...covered(memo), cutoff: { ...SOURCE, hash: "0x" + "b2".repeat(32) } },
  ];
  for (const outcome of invalid) {
    assert.equal(isCoveredCandidateOutcomeValid({ outcome, candidatesByKey: CANDIDATES,
      outcomesByCandidateKey: state.inProgressRun!.outcomesByCandidateKey, verifiedMemos: state.verifiedMemos, cutoff: SOURCE }), false);
    await assert.rejects(store.casMergeRunOutcomes("coverage-run", [outcome]), /candidate coverage/);
    assert.equal((await store.load())!.revision, state.revision, "invalid writes do not commit");
  }
  await assert.rejects(store.casMergeAttestationWrites("coverage-run",
    [{ outcome: covered(memo), memo: memoFor("b") }]), /memo\/outcome|non-verified/);
  await store.casMergeRunOutcomes("coverage-run", [covered(memo)]);
  await assert.rejects(store.casMergeRunOutcomes("coverage-run",
    [{ ...covered(memo, "c"), winnerFamilyCandidateKey: "b" }]), /verified winner/, "covered cannot refer to covered");
}));

test("changing or rejecting a winner invalidates only its derived task skips", async () => withStore(async (store, path) => {
  await begin(store, CANDIDATES);
  const first = memoFor("a"), independent = memoFor("c");
  const complete = await store.casMergeAttestationWrites("coverage-run", [
    { outcome: verified(first), memo: first }, { outcome: covered(first) },
    { outcome: verified(independent), memo: independent },
  ]);
  const stalePublication = readyFor(complete.inProgressRun!, complete.verifiedMemos);
  const next = memoFor("a", "v2");
  let state = await store.casMergeAttestationWrites("coverage-run", [{ outcome: verified(next), memo: next }]);
  assert.equal(state.inProgressRun!.outcomesByCandidateKey.b, undefined);
  assert.deepEqual(state.inProgressRun!.candidatesByKey.b, CANDIDATES.b);
  assert.equal(state.inProgressRun!.outcomesByCandidateKey.c!.status, "verified");
  assert.equal((await new UniverseRebuildCheckpointStore({ path }).load())!.inProgressRun!.outcomesByCandidateKey.b, undefined);
  await assert.rejects(store.casCommitReadyGeneration({ expectedRevision: state.revision,
    runId: "coverage-run", ready: stalePublication }), /valid candidate partition/,
  "a withdrawn covered outcome must be processed again before Ready publication");
  await store.casMergeRunOutcomes("coverage-run", [covered(next)]);
  state = await store.casMergeRunOutcomes("coverage-run", [{ status: "terminal-rejected", familyCandidateKey: "a",
    reasonCode: "identity-rejected", familyDefinitionHash: next.familyDefinitionHash, requestFingerprint: fp("request"),
    trustedResultsFingerprint: fp("results"), authorityFingerprint: fp("authority"), candidateFingerprint: next.candidateFingerprint,
    cutoff: SOURCE }]);
  assert.equal(state.inProgressRun!.outcomesByCandidateKey.b, undefined);
  assert.equal(state.inProgressRun!.outcomesByCandidateKey.c!.status, "verified");
}));

test("discovery reconciliation removes covered authority while retaining the candidates", async () => withStore(async store => {
  await begin(store);
  const memo = memoFor("a");
  let state = await store.casMergeAttestationWrites("coverage-run", [{ outcome: verified(memo), memo }, { outcome: covered(memo) }]);
  const candidates = { b: CANDIDATES.b, c: CANDIDATES.c };
  state = await store.reconcileFixedRunPlan({ expectedRevision: state.revision, runId: "coverage-run", cutoff: SOURCE,
    fromBlock: 90, universeHash: fp(candidates), candidateSetHash: fp(Object.keys(candidates)), candidateCount: 2,
    candidatesByKey: candidates, observedThrough: SOURCE, sourceReceipts: receipts(candidates) });
  assert.equal(state.inProgressRun!.outcomesByCandidateKey.b, undefined);
  assert.deepEqual(state.inProgressRun!.candidatesByKey.b, CANDIDATES.b);
}));

test("activation cannot leave an enabled candidate covered by a disabled winner", async () => withStore(async store => {
  const base = await seedReady(store);
  assert.throws(() => prepareReadyFamilyUpdate(base, { enabledFamilyIds: ["beta"], supplements: [] }), /active winner.*review required/);
  const mutation = { kind: "restrict" as const, disabledFamilyIds: ["alpha"] };
  const validation = validateReadyFamilyGraph({ checkpoint: base, mutation, graphSnapshot: GRAPH, assertGraph() {} });
  await assert.rejects(store.casRestrictReadyFamilies({ expectedRevision: base.revision,
    disabledFamilyIds: mutation.disabledFamilyIds, graphSnapshot: GRAPH, graphValidation: validation }), /active winner.*review required/);
  assert.equal((await store.load())!.revision, base.revision);
  const both = { kind: "restrict" as const, disabledFamilyIds: ["alpha", "beta"] };
  const disabled = await store.casRestrictReadyFamilies({ expectedRevision: base.revision,
    disabledFamilyIds: both.disabledFamilyIds, graphSnapshot: GRAPH,
    graphValidation: validateReadyFamilyGraph({ checkpoint: base, mutation: both, graphSnapshot: GRAPH, assertGraph() {} }) });
  assert.deepEqual(activeReadyMemos(disabled), []);
  assert.throws(() => prepareReadyFamilyUpdate(disabled, { enabledFamilyIds: ["beta"], supplements: [] }), /active winner/);
}));

test("exact refresh requires explicit complete recomputed coverage when a winner changes", async () => withStore(async (store, path) => {
  const base = await seedReady(store);
  const memo = memoFor("a", "v2");
  const refresh = { expectedRevision: base.revision, memos: [memo], graphSnapshot: GRAPH };
  await assert.rejects(store.casRefreshReadyInstances(refresh), /verified winner.*review required/);
  await assert.rejects(store.casRefreshReadyInstances({ ...refresh, coveredOutcomes: [] }), /lost candidate coverage/);
  await assert.rejects(store.casRefreshReadyInstances({ ...refresh, coveredOutcomes: [covered(memo), covered(memo)] }), /membership differs/);
  await assert.rejects(store.casRefreshReadyInstances({ ...refresh, coveredOutcomes: [covered(memo), covered(memo, "c")] }), /membership differs/);
  await assert.rejects(store.casRefreshReadyInstances({ ...refresh,
    coveredOutcomes: [{ ...covered(memo), candidateSnapshotFingerprint: fp("wrong") }] }), /candidate\/source binding/);
  const next = await store.casRefreshReadyInstances({ ...refresh, coveredOutcomes: [covered(memo)] });
  assert.deepEqual(next.readyGeneration!.candidateAccounting, base.readyGeneration!.candidateAccounting);
  assert.deepEqual(next.readyGeneration!.activeInstanceKeys, base.readyGeneration!.activeInstanceKeys);
  assert.equal(activeReadyMemos(next)[0]!.memoFingerprint, memo.memoFingerprint);
  assert.equal((next.readyGeneration!.familyPartitions!.beta!.outcomesByCandidateKey.b as CoveredCandidateOutcome).winnerMemoFingerprint,
    memo.memoFingerprint);
  assert.equal((await new UniverseRebuildCheckpointStore({ path }).load())!.checkpointFingerprint, next.checkpointFingerprint);
}));

test("inactive coverage remains history during winner refresh and cannot reactivate stale authority", async () => withStore(async (store, path, dir) => {
  const base = await seedReady(store);
  const mutation = { kind: "restrict" as const, disabledFamilyIds: ["beta"] };
  const disabled = await store.casRestrictReadyFamilies({ expectedRevision: base.revision,
    disabledFamilyIds: mutation.disabledFamilyIds, graphSnapshot: GRAPH,
    graphValidation: validateReadyFamilyGraph({ checkpoint: base, mutation, graphSnapshot: GRAPH, assertGraph() {} }) });
  const historical = disabled.readyGeneration!.familyPartitions!.beta!.outcomesByCandidateKey.b;
  const memo = memoFor("a", "v2");
  const refreshed = await store.casRefreshReadyInstances({ expectedRevision: disabled.revision,
    memos: [memo], graphSnapshot: GRAPH });
  assert.equal(refreshed.readyGeneration!.familyPartitions!.beta!.enabled, false);
  assert.deepEqual(refreshed.readyGeneration!.familyPartitions!.beta!.outcomesByCandidateKey.b, historical,
    "inactive history keeps its original binding; refresh must not pretend to revalidate it");
  assert.deepEqual(activeReadyMemos(refreshed).map(row => row.memoFingerprint), [memo.memoFingerprint]);
  const resumed = (await new UniverseRebuildCheckpointStore({ path }).load())!;
  assert.equal(resumed.checkpointFingerprint, refreshed.checkpointFingerprint);
  assert.deepEqual(resumed.readyGeneration!.familyPartitions!.beta!.outcomesByCandidateKey.b, historical);

  const update = { enabledFamilyIds: ["alpha", "beta"], supplements: [] };
  assert.throws(() => prepareReadyFamilyUpdate(resumed, update), /verified winner.*review required/);
  await assert.rejects(store.casUpdateReadyFamilies({ expectedRevision: resumed.revision, ...update,
    graphSnapshot: GRAPH, graphValidation: validateReadyFamilyGraph({ checkpoint: resumed,
      mutation: { kind: "update", ...update }, graphSnapshot: GRAPH, assertGraph() {} }) }), /verified winner.*review required/);
  assert.equal((await store.load())!.revision, refreshed.revision, "stale history cannot become active through CAS");

  const partition = resumed.readyGeneration!.familyPartitions!.beta!;
  const altered = { ...(historical as CoveredCandidateOutcome), candidateSnapshotFingerprint: fp("wrong-snapshot") };
  const ready = { ...resumed.readyGeneration!, familyPartitions: { ...resumed.readyGeneration!.familyPartitions,
    beta: { ...partition, outcomesByCandidateKey: { b: altered } } } };
  const { checkpointFingerprint: _old, ...unsigned } = { ...resumed, readyGeneration: ready };
  const tamperedPath = join(dir, "inactive-tampered.json");
  await writeFile(tamperedPath, JSON.stringify({ ...unsigned, checkpointFingerprint: envelopeFingerprint(unsigned) }));
  await assert.rejects(new UniverseRebuildCheckpointStore({ path: tamperedPath }).load(), /candidate\/source binding/,
    "inactive history still binds its own exact candidate and source");
}));

test("replacing a winner partition cannot silently retain another partition's stale coverage", async () => withStore(async store => {
  const base = await seedReady(store);
  const memo = memoFor("a", "v2");
  const candidates = { a: CANDIDATES.a };
  const run: InProgressUniverseRun = {
    runId: "supplement", cutoff: SOURCE, fromBlock: 90, universeHash: fp(candidates),
    candidateSetHash: fp(["a"]), candidateCount: 1, candidatesByKey: candidates,
    observedThrough: SOURCE, sourceReceipts: receipts(candidates), appliedThrough: null,
    outcomesByCandidateKey: { a: verified(memo) },
    familyUpdateScope: { parentCheckpointFingerprint: base.checkpointFingerprint, familyIds: ["alpha"] },
  };
  const unsigned = { revision: 1, verifiedMemos: { a: memo }, inProgressRun: null,
    retryableAttemptsByCandidateKey: {}, readyGeneration: readyFor(run, { a: memo }) };
  const supplement: StartupCheckpointEnvelope = { ...unsigned, checkpointFingerprint: envelopeFingerprint(unsigned) };
  assert.throws(() => prepareReadyFamilyUpdate(base, { enabledFamilyIds: ["alpha", "beta"],
    supplements: [{ familyIds: ["alpha"], checkpoint: supplement }] }), /verified winner.*review required/);
}));

test("covered bindings are checked on disk load even after the envelope is rehashed", async () => withStore(async (store, _path, dir) => {
  const base = await seedReady(store);
  const corrupt = structuredClone(base);
  const row = corrupt.readyGeneration!.familyPartitions!.beta!.outcomesByCandidateKey.b as CoveredCandidateOutcome;
  const altered = { ...row, winnerMemoFingerprint: fp("nonexistent-memo") };
  const partition = corrupt.readyGeneration!.familyPartitions!.beta!;
  const ready = { ...corrupt.readyGeneration!, familyPartitions: { ...corrupt.readyGeneration!.familyPartitions,
    beta: { ...partition, outcomesByCandidateKey: { b: altered } } } };
  const { checkpointFingerprint: _old, ...unsigned } = { ...corrupt, readyGeneration: ready };
  const path = join(dir, "tampered.json");
  await writeFile(path, JSON.stringify({ ...unsigned, checkpointFingerprint: envelopeFingerprint(unsigned) }));
  await assert.rejects(new UniverseRebuildCheckpointStore({ path }).load(), /verified winner/);
}));

test("zero covered outcomes preserve the old accounting shape and round-trip fingerprint", async () => withStore(async (store, path) => {
  await begin(store, { a: CANDIDATES.a });
  const memo = memoFor("a");
  await store.casMergeAttestationWrites("coverage-run", [{ outcome: verified(memo), memo }]);
  const base = await sealReady(store);
  assert.equal(Object.prototype.hasOwnProperty.call(base.readyGeneration!.candidateAccounting, "covered"), false);
  assert.deepEqual(base.readyGeneration!.candidateAccounting,
    { total: 1, verified: 1, terminalRejected: 0, retryable: 0, remainingUnaccounted: 0 });
  assert.equal((await new UniverseRebuildCheckpointStore({ path }).load())!.checkpointFingerprint, base.checkpointFingerprint);
}));
