import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import type { CaptureNominationProvider } from "../../../adapter-family-plugin.js";
import type { ReceiptSwapObservationContext, SwapEventLog } from "../../../swap-observation.js";
import type { TokenEdge } from "../../../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../../../strategy-taxonomy.js";
import { plugin } from "../../../production-families/ekubo.production.js";
import { EKUBO_CORE, EKUBO_CORE_DEPLOY_BLOCK, EKUBO_POOL_INITIALIZED_TOPIC, EKUBO_ROUTER } from "../../ekubo/abi.js";
import { candidate } from "../codec.js";
import { ekuboNomination, reverseBindEkubo } from "../nomination.js";
import { EKUBO_ACTION_ID } from "../manifest.js";
import { CALL_ID, INIT_ID } from "../discovery.js";
import { descriptor, EXECUTOR, ID, initialized, KEY, SOURCE, swapCall, update, word } from "./fixtures.js";

const nomination = { address: ID, opaque: { adapter: "ekubo-core-pool-v1", poolId: ID } };
function provider(overrides: Partial<CaptureNominationProvider> = {}): CaptureNominationProvider {
  return { call: async () => { throw new Error("unexpected call"); }, getCode: async () => { throw new Error("unexpected code"); },
    getStorage: async () => { throw new Error("unexpected storage"); }, getLogs: async () => [],
    getTransactionReceipt: async () => null, ...overrides };
}
test("reverse re-derives key from real-shaped Core logs, caches by provider AND exact source", async () => {
  const source = { ...SOURCE, number: EKUBO_CORE_DEPLOY_BLOCK + 1 };
  let reads = 0;
  const p = provider({ getLogs: async filter => {
    reads++;
    assert.equal(filter.address, EKUBO_CORE); assert.deepEqual(filter.topics, [EKUBO_POOL_INITIALIZED_TOPIC]);
    assert.equal(filter.fromBlock, EKUBO_CORE_DEPLOY_BLOCK); assert.equal(filter.toBlock, source.number);
    return [initialized(), initialized({ ...KEY, config: word(1234n) })];
  } });
  const input = { nominations: [nomination], source, provider: p };
  const [a, b] = await Promise.all([reverseBindEkubo(input), reverseBindEkubo(input)]);
  assert.equal(reads, 1); assert.deepEqual(a, b); assert.equal(a[0].status, "verified");
  if (a[0].status === "verified") assert.equal(plugin.discovery.decodeCandidate({ observation: a[0].observation, matchedPatternId: INIT_ID })?.poolId, ID);
  await reverseBindEkubo({ ...input, source: { ...source, hash: word(5n) } }); assert.equal(reads, 2);
  const fresh = await reverseBindEkubo({ ...input, provider: provider() }); assert.equal(fresh[0].status, "failed");
});
test("reverse never trusts a retained forged key, foreign Core log, or unsupported nomination", async () => {
  let reads = 0;
  const source = { ...SOURCE, number: EKUBO_CORE_DEPLOY_BLOCK };
  const p = provider({ getLogs: async () => { reads++; return [{ ...initialized(), address: EXECUTOR }]; } });
  const outcomes = await reverseBindEkubo({ source, provider: p, nominations: [
    { ...nomination, opaque: { adapter: "foreign", poolId: ID } }, { address: EXECUTOR, opaque: nomination.opaque },
    { ...nomination, opaque: { ...nomination.opaque, poolKey: { ...KEY } } },
  ] });
  assert.deepEqual(outcomes.map(o => o.status), ["unsupported", "failed", "failed"]);
  assert.equal(reads, 1);
});
test("failed reverse reads are not cached; old pre-deployment source cannot nominate a pool", async () => {
  let reads = 0;
  const p = provider({ getLogs: async () => { reads++; if (reads === 1) throw new Error("transient RPC"); return [initialized()]; } });
  const input = { nominations: [nomination], source: { ...SOURCE, number: EKUBO_CORE_DEPLOY_BLOCK }, provider: p };
  assert.equal((await reverseBindEkubo(input))[0].status, "failed");
  assert.equal((await reverseBindEkubo(input))[0].status, "verified");
  assert.equal(reads, 2);
  assert.equal((await reverseBindEkubo({ ...input, source: { ...input.source, number: EKUBO_CORE_DEPLOY_BLOCK - 1 } }))[0].status, "failed");
  assert.equal(reads, 2);
});
test("duplicate initialization and incomplete transport cannot fabricate reverse proof", async () => {
  const input = { nominations: [nomination], source: { ...SOURCE, number: EKUBO_CORE_DEPLOY_BLOCK },
    provider: provider({ getLogs: async () => [initialized(), initialized()] }) };
  assert.equal((await reverseBindEkubo(input))[0].status, "failed");
});
test("tx nomination matches requested key, successful CALL frames and receipt source cutoff", async () => {
  const txHash = word(33n), different = { ...KEY, config: word(123n) };
  const input = { nominations: [{ ...nomination, evidence: { transactionHash: txHash } }], source: SOURCE,
    provider: provider({ getTransactionReceipt: async hash => { assert.equal(hash, txHash); return { blockNumber: SOURCE.number, logs: [] }; },
      traceTransaction: async () => ({ result: { type: "CALL", to: EXECUTOR, input: "0x", calls: [
        { type: "CALL", to: EKUBO_ROUTER, input: swapCall(different).data },
        { type: "DELEGATECALL", to: EKUBO_ROUTER, input: swapCall().data },
        { type: "CALL", to: EKUBO_ROUTER, input: swapCall().data, error: "execution reverted" },
        { type: "CALL", to: EKUBO_ROUTER, input: swapCall().data },
      ] } }) }) };
  const observations = await ekuboNomination.nominate(input);
  assert.equal(observations.length, 1);
  assert.equal(plugin.discovery.decodeCandidate({ observation: observations[0], matchedPatternId: CALL_ID })?.poolId, ID);
  assert.equal((await ekuboNomination.nominate({ ...input, provider: { ...input.provider,
    getTransactionReceipt: async () => ({ blockNumber: SOURCE.number + 1, logs: [initialized()] }) } })).length, 0);
  assert.equal((await ekuboNomination.nominate({ ...input, provider: provider() })).length, 0);
});
test("tx nomination can use an actual initialization log without trace support", async () => {
  const observations = await ekuboNomination.nominate({ nominations: [{ ...nomination, opaque: { ...nomination.opaque, txHash: word(1n) } }], source: SOURCE,
    provider: provider({ getTransactionReceipt: async () => ({ blockNumber: SOURCE.number, logs: [initialized()] }) }) });
  assert.equal(observations.length, 1);
  assert.equal(plugin.discovery.decodeCandidate({ observation: observations[0], matchedPatternId: INIT_ID })?.poolId, ID);
});

function anonymous(delta0 = 15809n, delta1 = -11938083n, poolId = ID): SwapEventLog {
  return { address: EKUBO_CORE, topics: [], data: `${EKUBO_ROUTER}${poolId.slice(2)}${update(delta0, delta1).slice(2)}${word(1n).slice(2)}` };
}
const d = descriptor();
const graph: TokenEdge[] = plugin.routes.project({ descriptor: d }).map(route => ({ instanceKey: route.instanceKey,
  adapterId: EKUBO_ACTION_ID, target: EKUBO_ROUTER, tokenIn: route.tokenIn, tokenOut: route.tokenOut, slotKind: "swap", ...deriveEdgeTaxonomy("swap") }));
function context(logs: SwapEventLog[], edges = graph): ReceiptSwapObservationContext {
  return { logs, graph: edges, edgesByTarget: new Map([[EKUBO_ROUTER, edges]]),
    matchedOwnedTriggers: logs.map((log, index) => ({ logIndex: index, triggerId: `trigger:${index}`, emitter: log.address, topic0: log.topics[0] ?? "" })),
    control: { deadlineAtMs: Date.now() + 10000, signal: new AbortController().signal },
    sourceGeneration: { id: "synthetic-receipt", sourceBlock: SOURCE.number, sourceBlockHash: SOURCE.hash, receiptId: "fixture",
      receiptBlockNumber: SOURCE.number + 1, receiptBlockHash: word(1n), receiptParentBlockHash: SOURCE.hash,
      receiptTransactionHash: word(2n), logsCompleteness: "complete-receipt" } };
}
test("anonymous receipt selector binds Core, exact byte length and pool id, never topic parity", () => {
  const observer = plugin.swap.receiptObservation;
  assert(observer);
  assert.deepEqual(observer.anonymousLogs, [{ address: ethers.getAddress(EKUBO_CORE), dataLengthBytes: 116, identityOffsetBytes: 20 }]);
  assert.equal(observer.observedPoolIdentity(anonymous()), ID);
  for (const log of [{ ...anonymous(), address: EXECUTOR }, { ...anonymous(), topics: [word(1n)] },
    { ...anonymous(), data: `${anonymous().data}00` }]) assert.equal(observer.observedPoolIdentity(log), null);
});
test("receipt effects use strict instanceKey and token ordering, not legacy metadata", async () => {
  assert(plugin.swap.receiptObservation);
  assert(graph.every(edge => edge.poolId === undefined && edge.poolToken0 === undefined));
  const result = await plugin.swap.receiptObservation.decodeReceiptImpacts(context([anonymous(), anonymous(-100n, 1000000n)]));
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.impacts.length, 2); assert.equal(result.mutations.length, 0);
    assert.equal(result.impacts[0].impact.amountIn, 15809n); assert.equal(result.impacts[0].impact.amountOut, 11938083n);
    assert.equal(result.impacts[1].impact.tokenIn.toLowerCase(), KEY.token1.toLowerCase());
    assert.deepEqual(result.consumedTriggerIds, ["trigger:0", "trigger:1"]);
  }
});
test("missing graph routes and zero flow are explicit mutations, bad deltas are unresolved", async () => {
  assert(plugin.swap.receiptObservation);
  for (const ctx of [context([anonymous()], []), context([anonymous(0n, 0n)]), context([anonymous(1n, -1n, candidate({ ...KEY, config: word(2n) }).poolId)])]) {
    const result = await plugin.swap.receiptObservation.decodeReceiptImpacts(ctx);
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") { assert.equal(result.impacts.length, 0); assert.equal(result.mutations.length, 1); }
  }
  assert.equal((await plugin.swap.receiptObservation.decodeReceiptImpacts(context([anonymous(1n, 1n)]))).status, "unresolved");
  const init = initialized();
  const initializedResult = await plugin.swap.receiptObservation.decodeReceiptImpacts(context([{ ...init, topics: [...init.topics] }]));
  assert.equal(initializedResult.status, "resolved");
  if (initializedResult.status === "resolved") assert.equal(initializedResult.mutations.length, 1);
});
