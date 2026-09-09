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
const cache = new BlockScanSimRejectCache();
assert.equal(cache.has(route), false);
for (const failure of [undefined,
  { cause: new Error("timeout"), kind: "timeout", code: "TIMEOUT" },
  { cause: new Error("429"), kind: "rpc", code: 429 },
  { cause: new Error("aborted"), kind: "aborted", code: null },
  { cause: new Error("balanceOf reverted"), kind: null, code: "CALL_EXCEPTION" },
]) {
  assert.equal(cache.record(route, { ...result, failure }), false);
  assert.equal(cache.has(route), false, "prose, non-positive profit and infrastructure never poison a route");
}
const revert = { cause: new Error("pool revert"), kind: "revert", code: "TRANSACTION_REVERTED" };
assert.equal(cache.record(route, { ...result, failure: revert }), true);
assert.equal(cache.has(route), true);
assert.equal(cache.has(other), false, "same tokens, different pool directions remain eligible");
assert.equal(new BlockScanSimRejectCache().has(route), false, "next live starts fresh");
cache.clear();
assert.equal(cache.has(route), false, "independent replay starts fresh");
assert.equal(cache.record(route, { ...result, failure: revert }), true);
assert.equal(cache.record(other, { ...result, success: true, failure: revert }), false);
console.log("blockscan-sim-reject-cache PASS (run lifetime, exact routes, typed reverts, fresh restart)");
