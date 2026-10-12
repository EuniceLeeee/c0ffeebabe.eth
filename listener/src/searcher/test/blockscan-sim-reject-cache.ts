import assert from "node:assert/strict";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { blockScanRouteId } from "../blockscan-route-identity.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { SimulationResult } from "../simulator/botvm-simulator.js";

const edge = (pool: string, tokenIn: string, tokenOut: string): TokenEdge => ({
  adapterId: "univ2-swap", target: pool, tokenIn, tokenOut, slotKind: "swap",
  edgeKind: "swap", leavesStandingPosition: false,
});
const a = "0x" + "11".repeat(20), b = "0x" + "22".repeat(20);
const pool1 = "0x" + "33".repeat(20), pool2 = "0x" + "44".repeat(20);
const route = blockScanRouteId([edge(pool1, a, b), edge(pool2, b, a)]);
const other = blockScanRouteId([edge(pool2, a, b), edge(pool1, b, a)]);
const result: SimulationResult = {
  success: false, profitToken: a, grossProfit: 0n, netProfit: 0n,
  gasUsed: 0n, calldata: "0x", revertReason: "execution reverted",
};
const p = { amount: 100n, p: 100n };
const cache = new BlockScanSimRejectCache();
assert.equal(cache.has(route), false);
for (const failure of [undefined,
  { cause: new Error("timeout"), kind: "timeout", code: "TIMEOUT" },
  { cause: new Error("429"), kind: "rpc", code: 429 },
  { cause: new Error("aborted"), kind: "aborted", code: null },
  { cause: new Error("balanceOf reverted"), kind: null, code: "CALL_EXCEPTION" },
]) {
  assert.equal(cache.record(route, { ...result, failure }, p), false);
  assert.equal(cache.has(route), false, "prose, non-positive profit and infrastructure never poison a route");
}
const revert = { cause: new Error("pool revert"), kind: "revert", code: "TRANSACTION_REVERTED" };
assert.equal(cache.record(route, { ...result, failure: revert }, { amount: 99n, p: 100n }), false,
  "non-P failures cannot poison a route");
assert.equal(cache.record(route, { ...result, failure: revert }, p), true);
assert.equal(cache.has(route), true);
assert.equal(cache.has(other), false, "same tokens, different pool directions remain eligible");
assert.equal(new BlockScanSimRejectCache().has(route), false, "next live starts fresh");
assert.equal(cache.recordPool(edge(pool1, a, b), { ...result, failure: revert }, p), true);
assert.equal(cache.hasPool(edge(pool1, b, a)), true, "pool identity is shared across directions");
assert.equal(cache.hasPool(edge(pool2, a, b)), false, "only the attributed instance is filtered");
assert.equal(cache.recordPool(edge(pool2, a, b), { ...result, failure: revert }, { amount: 99n, p: 100n }), false);
cache.clear();
assert.equal(cache.has(route), false, "independent replay starts fresh");
assert.equal(cache.hasPool(edge(pool1, a, b)), false, "clear also resets the pool set");
assert.equal(cache.record(route, { ...result, failure: revert }, p), true);
assert.equal(cache.record(other, { ...result, success: true, failure: revert }, p), false);
console.log("blockscan-sim-reject-cache PASS (P-only typed reverts, exact routes and pools, fresh restart)");
