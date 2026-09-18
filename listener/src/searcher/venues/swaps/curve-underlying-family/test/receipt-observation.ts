import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import type { ReceiptSwapObservationContext } from "../../../swap-observation.js";
import { curveUnderlyingSwap } from "../swap.js";
import { curveUnderlyingDiscovery } from "../discovery.js";
import {
  CURVE_UNDERLYING_I128_CALL_PATTERN_ID,
  CURVE_UNDERLYING_UINT_CALL_PATTERN_ID,
} from "../discovery.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE,
  CURVE_UNDERLYING_POOL_INTERFACE, CURVE_UNDERLYING_UINT_INTERFACE } from "../codec.js";
import { ARCHIVED_EDGES, COINS, POOL, SOURCE, coinData, context, swapLog } from "./receipt-fixture.js";

const observation = curveUnderlyingSwap.receiptObservation;
async function unresolved(ctx: ReceiptSwapObservationContext) {
  const result = await observation.decodeReceiptImpacts(ctx);
  assert.equal(result.status, "unresolved");
  assert(!("impacts" in result), "no partial impacts may escape");
}

test("archived strict Graph: signed/uint indices bind both directions with pinned underlying reads", async () => {
  const before = JSON.stringify(ARCHIVED_EDGES);
  assert(ARCHIVED_EDGES.every(edge => edge.curveI === undefined && edge.curveJ === undefined));
  for (const type of ["int128", "uint256"] as const) for (const [i, j] of [[2n, 0n], [0n, 2n]]) {
    const ctx = context([swapLog(type, i, j)]);
    let reads = 0;
    const result = await observation.decodeReceiptImpacts({ ...ctx, tokenQuery: { async call(req, control) {
      reads++;
      assert.equal(req.to, CURVE_METAREGISTRY);
      assert.equal(req.blockTag, SOURCE.number);
      assert.equal(req.data, CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData("get_underlying_coins", [POOL]));
      assert.equal(control, ctx.control);
      return coinData();
    } } });
    assert.equal(reads, 1); assert.equal(result.status, "resolved");
    if (result.status !== "resolved") throw new Error("expected impact");
    assert.deepEqual(result.consumedTriggerIds, ["trigger:0"]);
    assert.equal(result.impacts.length, 1);
    assert.equal(result.impacts[0].impact.tokenIn, COINS[Number(i)]);
    assert.equal(result.impacts[0].impact.tokenOut, COINS[Number(j)]);
    assert.equal(result.impacts[0].impact.amountIn, 123n);
    assert.equal(result.impacts[0].impact.amountOut, 120n);
    assert.equal(result.impacts[0].impact.sourceGeneration, ctx.sourceGeneration);
  }
  assert.equal(JSON.stringify(ARCHIVED_EDGES), before, "Graph must not acquire protocol fields");
});

test("no owned trigger is no-match without source or query", async () => {
  assert.deepEqual(await observation.decodeReceiptImpacts({ ...context([]), tokenQuery: null }), { status: "no-match" });
});

test("missing query or invalid source fails closed before reads", async () => {
  const ctx = context(); let reads = 0;
  const tokenQuery = { async call() { reads++; return coinData(); } };
  await unresolved({ ...ctx, tokenQuery: null });
  await unresolved({ ...ctx, tokenQuery: undefined });
  for (const sourceBlock of [null, -1, NaN, Infinity, 0.5]) {
    await unresolved({ ...ctx, tokenQuery, sourceGeneration: { ...ctx.sourceGeneration, sourceBlock } });
  }
  for (const sourceBlockHash of [null, "0x", "0xzz", "0x12"]) {
    await unresolved({ ...ctx, tokenQuery, sourceGeneration: { ...ctx.sourceGeneration, sourceBlockHash } });
  }
  assert.equal(reads, 0);
});

test("duplicate, fractional, missing and mismatched triggers fail before reads", async () => {
  const ctx = context([swapLog(), swapLog()]), a = ctx.matchedOwnedTriggers[0], b = ctx.matchedOwnedTriggers[1];
  let reads = 0;
  const tokenQuery = { async call() { reads++; return coinData(); } };
  for (const matchedOwnedTriggers of [[a, a], [a, { ...b, triggerId: a.triggerId }],
    [a, { ...b, logIndex: a.logIndex }], [{ ...a, logIndex: -1 }], [{ ...a, logIndex: 2 }],
    [{ ...a, logIndex: 0.5 }], [{ ...a, logIndex: NaN }], [{ ...a, emitter: COINS[0] }],
    [{ ...a, topic0: ethers.ZeroHash }]]) {
    await unresolved({ ...ctx, tokenQuery, matchedOwnedTriggers });
  }
  assert.equal(reads, 0);
});

test("malformed bytes, signed padding, oversized uint indices and zero amounts fail closed", async () => {
  const log = swapLog();
  for (const bad of [
    { ...log, data: "0x" }, { ...log, data: `${log.data}00` }, { ...log, data: `0x${"0".repeat(63)}2` },
    { ...log, data: `0x01${log.data.slice(4)}` },
    { ...log, address: "0x1234" }, { ...log, topics: [] }, { ...log, topics: [log.topics[0]] },
    { ...log, topics: [...log.topics, ethers.ZeroHash] }, { ...log, topics: [ethers.ZeroHash, log.topics[1]] },
    { ...log, topics: [log.topics[0], `0x01${log.topics[1].slice(4)}`] },
    swapLog("int128", -1n), swapLog("int128", 8n), swapLog("int128", 2n, 2n),
    swapLog("uint256", 1n << 200n), swapLog("uint256", 2n, 1n << 200n),
    swapLog("int128", 2n, 0n, 0n), swapLog("int128", 2n, 0n, 123n, 0n),
  ]) await unresolved(context([bad]));
});

test("registry bytes must retain exact, unique, contiguous coin indices", async () => {
  const data = coinData();
  for (const bad of ["0x", `${data}00`, data.slice(0, -2), `0x01${data.slice(4)}`,
    coinData([]), coinData([COINS[0]]), coinData([COINS[0], COINS[0], COINS[2]]),
    coinData([COINS[0], ethers.ZeroAddress, COINS[2]])]) {
    await unresolved({ ...context(), tokenQuery: { call: async () => bad } });
  }
  await unresolved(context([swapLog("uint256", 7n, 0n)]));
});

test("missing, foreign or duplicate admitted directions cannot be inferred", async () => {
  const ctx = context(), edge = ARCHIVED_EDGES[1];
  for (const graph of [[], [ARCHIVED_EDGES[0]], [edge, edge],
    [{ ...edge, adapterId: "curve-exchange" }], [{ ...edge, instanceKey: COINS[0] }],
    [{ ...edge, target: COINS[0] }], [{ ...edge, tokenOut: COINS[1] }]]) {
    await unresolved({ ...ctx, graph, edgesByTarget: new Map([[POOL.toLowerCase(), ARCHIVED_EDGES]]) });
  }
});

test("legacy indices and Graph ordering have no authority", async () => {
  const ctx = context();
  const result = await observation.decodeReceiptImpacts({ ...ctx,
    graph: [...ARCHIVED_EDGES].reverse().map(edge => ({ ...edge, curveI: 7, curveJ: 6 })) });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.impacts[0].impact.tokenIn, COINS[2]);
});

test("multiple swaps share only invocation-local reads and consume every trigger", async () => {
  const ctx = context([swapLog(), swapLog("uint256", 0n, 2n)]); let reads = 0;
  const tokenQuery = { async call() { reads++; return coinData(); } };
  for (let run = 0; run < 2; run++) {
    const result = await observation.decodeReceiptImpacts({ ...ctx, tokenQuery });
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.equal(result.impacts.length, 2); assert.deepEqual(result.consumedTriggerIds, ["trigger:0", "trigger:1"]);
    }
  }
  assert.equal(reads, 2, "coin mapping cannot leak across invocations/sources");
  await unresolved(context([swapLog(), swapLog("uint256", 2n, 1n)]));
});

test("cancelled, expired and rejected reads never publish impacts", async () => {
  const ctx = context(); let reads = 0;
  const tokenQuery = { async call() { reads++; return coinData(); } };
  const aborted = new AbortController(); aborted.abort();
  await unresolved({ ...ctx, tokenQuery, control: { ...ctx.control, signal: aborted.signal } });
  for (const deadlineAtMs of [0, NaN, Infinity]) await unresolved({ ...ctx, tokenQuery, control: { ...ctx.control, deadlineAtMs } });
  assert.equal(reads, 0);
  const cancelled = new AbortController();
  await unresolved({ ...ctx, control: { ...ctx.control, signal: cancelled.signal },
    tokenQuery: { async call() { cancelled.abort(); return coinData(); } } });
  const control = { ...ctx.control };
  await unresolved({ ...ctx, control, tokenQuery: { async call() { control.deadlineAtMs = 0; return coinData(); } } });
  await unresolved({ ...ctx, tokenQuery: { async call() { throw new Error("offline read failure"); } } });
});

test("detect-only retained; calldata nominates but cannot invent a direct impact without read authority", () => {
  assert.equal(curveUnderlyingSwap.victimSupport, "detect-only");
  assert.equal(observation.decodeDirectCallImpacts, undefined);
  assert.equal(observation.directCallSelectors, undefined);
  for (const [iface, matchedPatternId] of [[CURVE_UNDERLYING_POOL_INTERFACE, CURVE_UNDERLYING_I128_CALL_PATTERN_ID],
    [CURVE_UNDERLYING_UINT_INTERFACE, CURVE_UNDERLYING_UINT_CALL_PATTERN_ID]] as const) {
    const candidate = curveUnderlyingDiscovery.decodeCandidate({ matchedPatternId, observation: {
      kind: "call", source: SOURCE, target: POOL, data: iface.encodeFunctionData("exchange_underlying", [2n, 0n, 123n, 0n]),
    } });
    assert.equal(candidate?.hintedI, 2); assert.equal(candidate?.hintedJ, 0);
    assert.equal(candidate?.pool.toLowerCase(), POOL.toLowerCase());
  }
});
