import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface } from "ethers";
import { readySelectorCensusFromTransaction, type ReadySelectorCensusTransaction } from "../ready-selector-census.js";
import { assertReadySelectorCoverage, buildReadySelectorCoverage, normalizeReadySelectorCensus,
  readySelectorCensusFingerprint, type ReadySelectorCoverage } from "../ready-selector-coverage.js";
import { UniverseRebuildCheckpointStore, type RunOutcome } from "../universe-rebuild-checkpoint.js";
import { rebuildUniverse, type RebuildUniverseInput } from "../universe-rebuild-runner.js";

const a = (n: number) => "0x" + n.toString(16).padStart(40, "0"), h = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const A = a(101), P = a(102), P2 = a(103), T = a(104), U = a(105), NFT = a(106), SELECTOR = "0x12345678";
const SOURCE = { number: 100, hash: h(100), generation: 100 }, FAMILY = "execution:coverage-fixture";
const WORD = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
function tx(input: { hash?: string; target?: string; selector?: string; pool?: number; nft?: boolean; chainId?: number } = {}) {
  const target = input.target ?? P;
  const logs = [
    { log_address: T, log_index: 0, ...transfer.encodeEventLog(transfer.getEvent("Transfer")!, [A, target, 17n]) },
    { log_address: U, log_index: 1, ...transfer.encodeEventLog(transfer.getEvent("Transfer")!, [target, A, 31n]) },
  ];
  if (input.nft) logs.push({ log_address: NFT, log_index: 2,
    topics: [transfer.getEvent("Transfer")!.topicHash, "0x" + WORD(BigInt(target)), "0x" + WORD(BigInt(A)), h(999)], data: "0x" });
  const selector = input.selector ?? SELECTOR, data = selector + (input.pool === undefined ? "" : WORD(input.pool)) + WORD(17);
  return readySelectorCensusFromTransaction({ chain_id: input.chainId ?? 1, tx_hash: input.hash ?? h(1),
    block_number: SOURCE.number, block_hash: SOURCE.hash, transaction_index: 0, receipt_status: 1,
    input: data, from_address: A, to_address: target, value: "0", logs, traces: [] },
  input.pool === undefined ? {} : { poolIdLayouts: [{ selector, wordCount: 2, poolIdWord: 0, namespace: "coverage-pool" }] });
}
function candidate(transaction: ReadySelectorCensusTransaction) {
  const call = transaction.calls[0]!;
  return { familyId: FAMILY, target: call.target, scope: { chainId: transaction.chainId, target: call.target,
    poolId: call.poolId, poolNamespace: call.poolNamespace }, census: transaction, callId: call.id };
}
const verified = (key: string): RunOutcome => ({ status: "verified", familyCandidateKey: key, familyInstanceKey: "instance:" + key, memoFingerprint: "memo:" + key });
const coverage = (transactions: readonly ReadySelectorCensusTransaction[], registeredSelectors: Record<string, readonly string[]> = {},
  candidatesByKey: Record<string, unknown> = {}, outcomesByCandidateKey: Record<string, RunOutcome> = {}) =>
  buildReadySelectorCoverage({ transactions, registeredSelectors, candidatesByKey, outcomesByCandidateKey });

test("unknown selectors and NFT token IDs survive canonical input normalization without granting candidate authority", () => {
  const original = tx({ nft: true }), normalized = normalizeReadySelectorCensus({ selectorCensus: [original, original] });
  assert.equal(normalized.length, 1); assert.notEqual(normalized[0], original); assert(Object.isFrozen(normalized[0]!.logs));
  const result = coverage(normalized), entry = result.entries.find(row => row.address === P)!;
  assert.equal(entry.status, "unverified"); assert.deepEqual(entry.candidateKeys, []);
  assert(entry.reasons.includes("selector-not-adapted")); assert.equal(result.allInternalCallsEnumerated, false);
  assert.equal(result.transactions[0]!.tokenFlows.find(flow => flow.standard === "erc721")?.tokenId, "999");
  assert.deepEqual(result.transactions[0]!.logs, original.logs); assertReadySelectorCoverage(result);
});

test("duplicate transaction identity with conflicting raw calldata or token flows is rejected", () => {
  const first = tx();
  for (const change of [tx({ selector: "0x87654321" }), tx({ nft: true })])
    assert.throws(() => normalizeReadySelectorCensus([first, change]), /conflicting/);
  assert.throws(() => normalizeReadySelectorCensus([{ ...first, status: "verified" }]), /cannot grant authority/);
});

test("coverage deduplicates equal selector/address/pool resources while preserving distinct addresses, pools and selectors", () => {
  const inputs = [tx({ pool: 1 }), tx({ pool: 1, hash: h(2) }), tx({ pool: 2, hash: h(3) }),
    tx({ target: P2, pool: 1, hash: h(4) }), tx({ selector: "0x87654321", pool: 1, hash: h(5) })];
  const result = coverage(inputs), entries = result.entries.filter(row => row.selector !== null);
  assert.equal(entries.length, 4); assert.equal(new Set(entries.map(row => row.key)).size, 4);
  assert.equal(entries.find(row => row.address === P && row.selector === SELECTOR && row.poolId === h(1))!.transactionHashes.length, 2);
});

test("router selector never migrates to an address that appears only in token transfer evidence", () => {
  const input = tx(), router = a(999);
  const census = readySelectorCensusFromTransaction({ chain_id: 1, tx_hash: h(9), block_number: 100, block_hash: SOURCE.hash,
    transaction_index: 0, receipt_status: 1, input: SELECTOR + WORD(17), to_address: router, from_address: A, value: "0", logs: input.logs, traces: [] });
  const pool = coverage([census]).entries.find(row => row.address === P)!;
  assert.equal(pool.selector, null); assert.deepEqual(pool.familyIds, []); assert.equal(pool.status, "unverified");
});

test("registered selector becomes verified only through its matching candidate outcome and keeps other invocations partial", () => {
  const first = tx(), second = tx({ hash: h(2) }), candidates = { first: candidate(first) };
  const unknown = coverage([first]); assert.equal(unknown.entries.find(row => row.address === P)!.status, "unverified");
  const registered = coverage([first], { [SELECTOR]: [FAMILY] });
  assert(registered.entries.find(row => row.address === P)!.reasons.includes("declared-selector-without-unambiguous-candidate"));
  const ready = coverage([first], { [SELECTOR]: [FAMILY] }, candidates, { first: verified("first") });
  assert.equal(ready.entries.find(row => row.address === P)!.status, "verified");
  const partial = coverage([first, second], { [SELECTOR]: [FAMILY] }, candidates, { first: verified("first") });
  assert.equal(partial.entries.find(row => row.address === P)!.status, "partially-verified");
});

test("a changed unknown observation changes the complete input fingerprint even with no candidate changes", () => {
  assert.notEqual(readySelectorCensusFingerprint(normalizeReadySelectorCensus([tx()])),
    readySelectorCensusFingerprint(normalizeReadySelectorCensus([tx({ nft: true })])));
});

test("Ready binding success stays execution-unverified until the startup price table simulates it", () => {
  const transaction = tx(), candidates = { first: candidate(transaction) };
  const outcomes = { first: { ...verified("first"), executionVerification: "startup-simulation" as const } };
  const result = coverage([transaction], { [SELECTOR]: [FAMILY] }, candidates, outcomes);
  const row = result.entries.find(entry => entry.address === P)!;
  assert.equal(row.status, "unverified");
  assert.deepEqual(row.candidateKeys, ["first"]);
  assert.deepEqual(row.verifiedCandidateKeys, []);
  assert.deepEqual(row.reasons, ["awaiting-startup-simulation"]);
  assert.equal(result.counts.verified, 0);
  assertReadySelectorCoverage(result, { candidatesByKey: candidates, outcomesByCandidateKey: outcomes });
  const forged = coverage([transaction], { [SELECTOR]: [FAMILY] }, candidates, { first: verified("first") });
  assert.throws(() => assertReadySelectorCoverage(forged, { candidatesByKey: candidates, outcomesByCandidateKey: outcomes }),
    /authoritative candidate outcomes/);
});

test("coverage validator rejects deleting ledger entries while keeping transactions and recomputing superficial counts", () => {
  const result = coverage([tx()]);
  const lost = { ...result, entries: [], counts: { transactions: 1, resources: 0, verified: 0, partiallyVerified: 0, unverified: 0 } };
  assert.throws(() => assertReadySelectorCoverage(lost), /coverage|inventory|entry|ledger/i);
});

test("coverage validator rejects a forged verified status and mismatched status counts", () => {
  const result = coverage([tx()]), entry = result.entries.find(row => row.address === P)!;
  const forged = { ...result, entries: result.entries.map(row => row === entry ? { ...row, status: "verified" as const } : row) };
  assert.throws(() => assertReadySelectorCoverage(forged), /coverage|status|entry/i);
});

test("a candidate from a different source or logical pool cannot lend its verified outcome to a census row", () => {
  const transaction = tx({ pool: 1 }), base = candidate(transaction);
  for (const changed of [
    { ...base, census: { ...base.census, blockHash: h(999) } },
    { ...base, scope: { ...base.scope, chainId: 2 } },
    { ...base, scope: { ...base.scope, poolId: h(2) } },
    { ...base, callId: "absent-call" },
    { ...base, census: { ...base.census, tokenFlows: [] } },
  ]) {
    const result = coverage([transaction], { [SELECTOR]: [FAMILY] }, { wrong: changed }, { wrong: verified("wrong") });
    assert.equal(result.entries.find(row => row.address === P)!.status, "unverified");
    assert.deepEqual(result.entries.find(row => row.address === P)!.verifiedCandidateKeys, []);
  }
});

test("native execution and funding census witnesses share coverage without old observation mirrors", () => {
  const transaction = tx({pool:1}), base = candidate(transaction);
  const candidates = {
    route:{...base,candidateKind:"selector-native-execution",scope:{...base.scope,tokenInId:"42",tokenOutId:"43"}},
    funding:{...base,candidateKind:"selector-funding",fundingBindings:[{provider:P,asset:T}]},
    sibling:{...base,candidateKind:"selector-native-execution",scope:{...base.scope,tokenInId:"44",tokenOutId:"43"}},
  };
  const outcomes = {route:verified("route"),funding:verified("funding"),sibling:{...verified("sibling"),executionVerification:"startup-simulation" as const}};
  const result = coverage([transaction],{[SELECTOR]:[FAMILY]},candidates,outcomes);
  const entry = result.entries.find(row=>row.address===P)!;
  assert.deepEqual(entry.candidateKeys,["funding","route","sibling"]);
  assert.deepEqual(entry.verifiedCandidateKeys,["funding","route"]);
  assert.equal(entry.status,"partially-verified");
  assert.deepEqual(entry.reasons,["awaiting-startup-simulation"]);
  assertReadySelectorCoverage(result,{candidatesByKey:candidates,outcomesByCandidateKey:outcomes});
});

test("a transaction and identical trace-root witness share binding but a child call does not", () => {
  const original=tx(),call=original.calls[0]!;
  const root={...call,kind:"trace" as const,id:"trace:0:",traceAddress:[]};
  const transaction={...original,calls:[call,root]};
  const result=coverage([transaction],{[SELECTOR]:[FAMILY]},{first:candidate(transaction)},{first:verified("first")});
  assert.equal(result.entries.find(row=>row.address===P)!.status,"verified");
  const child={...call,kind:"trace" as const,id:"trace:1:0",traceAddress:[0]};
  const nested={...original,calls:[call,root,child]};
  const partial=coverage([nested],{[SELECTOR]:[FAMILY]},{first:candidate(nested)},{first:verified("first")});
  const entry=partial.entries.find(row=>row.address===P)!;
  assert.equal(entry.status,"partially-verified");
  assert(entry.reasons.includes("declared-selector-without-unambiguous-candidate"));
});

/** Synthetic discovery and no lifecycle candidates; real runner, on-disk
 * checkpoint, promotion and reload. This is not EVM admission evidence. */
function emptyCatalogRun(store: UniverseRebuildCheckpointStore, transactions: readonly ReadySelectorCensusTransaction[]): RebuildUniverseInput {
  const normalized = normalizeReadySelectorCensus(transactions), fingerprint = readySelectorCensusFingerprint(normalized);
  return { store, runId: "selector-unknown-run", observationRange: { fromBlock: 100, toBlock: 100 },
    selectorCensus: normalized, readyReviewInputFingerprint: () => fingerprint,
    readyDiscoveryInputFingerprint: () => fingerprint, familyDefinitionHash: () => "f".repeat(64),
    familyDiscoveryDefinitionHash: () => "e".repeat(64), candidateFamilyId: () => assert.fail("no catalog candidate"),
    freezeCanonicalHead: async () => SOURCE, scanSwapWindow: async () => ({ observations: [], sourceReceipts: [] }),
    familyCandidateKey: () => assert.fail("no candidate"), requiredSourceCoverageKeys: () => [],
    expectedSourcePlanFingerprints: () => ({ startup: "1".repeat(64), activity: "2".repeat(64) }),
    dedupeFamilyCandidates: () => [], findReusableMemo: async () => null,
    attestFamilyInstanceOnce: async () => assert.fail("unknown selector has no lifecycle"),
    sealDurableVerifiedMemo: () => assert.fail("unknown selector has no memo"),
    rehydrateVerifiedInstance: () => assert.fail("unknown selector has no instance"), aggregateOnceByFamily: () => [],
    buildGraphSnapshot: () => ({ edges: [] }), buildCoverage: () => [], assertCanonicalHead: async () => {},
    buildSelectorCoverage: state => buildReadySelectorCoverage({ ...state, transactions: normalized, registeredSelectors: {} }),
    log: () => {},
  };
}

test("ordinary runner persists unknown-only census in the same Ready checkpoint while Graph remains empty", async t => {
  const directory = await mkdtemp(join(tmpdir(), "selector-coverage-ready-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ready.json"), store = new UniverseRebuildCheckpointStore({ path });
  const input = emptyCatalogRun(store, [tx({ nft: true })]), ready = await rebuildUniverse(input);
  assert.deepEqual(ready.graphSnapshot, { edges: [] }); assert.equal(ready.candidateAccounting.total, 0);
  assert.equal(ready.selectorCoverage?.counts.transactions, 1); assert.equal(ready.selectorCoverage?.counts.verified, 0);
  const loaded = await new UniverseRebuildCheckpointStore({ path }).load();
  assert(loaded?.readyGeneration); assert.equal(loaded.inProgressRun, null);
  assert.deepEqual(loaded.readyGeneration.selectorCoverage, ready.selectorCoverage);
  assert.equal(loaded.readyGeneration.selectorCoverage!.transactions[0]!.tokenFlows.at(-1)!.tokenId, "999");
});

test("Ready promotion cannot omit or replace the complete census even when candidate and Graph sets are both empty", async t => {
  const directory = await mkdtemp(join(tmpdir(), "selector-coverage-promotion-")); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const replace of [false, true]) {
    const store = new UniverseRebuildCheckpointStore({ path: join(directory, `${replace}.json`) });
    const input = emptyCatalogRun(store, [tx()]);
    await assert.rejects(rebuildUniverse({ ...input, buildSelectorCoverage: replace ? () => coverage([]) : undefined }), /lost its complete selector inventory/);
    const loaded = await store.load(); assert.equal(loaded?.readyGeneration, null); assert.equal(loaded?.inProgressRun?.selectorCensus?.length, 1);
  }
});

test("fixed-run resume binds unknown census as well as the empty candidate partition", async t => {
  const directory = await mkdtemp(join(tmpdir(), "selector-coverage-resume-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UniverseRebuildCheckpointStore({ path: join(directory, "ready.json") });
  const input = { expectedRevision: 0, runId: "selector-resume", cutoff: SOURCE, fromBlock: 100,
    universeHash: "universe", candidateSetHash: "candidates", candidateCount: 0, candidatesByKey: {}, familyDefinitionHashes: {},
    observedThrough: { number: 100, hash: SOURCE.hash }, sourceReceipts: [], selectorCensus: normalizeReadySelectorCensus([tx()]) };
  const begun = await store.beginOrResumeRun(input);
  assert.equal((await store.beginOrResumeRun({ ...input, expectedRevision: begun.revision })).revision, begun.revision);
  await assert.rejects(store.beginOrResumeRun({ ...input, expectedRevision: begun.revision,
    selectorCensus: normalizeReadySelectorCensus([tx({ nft: true })]) }), /different fixed input/);
});
