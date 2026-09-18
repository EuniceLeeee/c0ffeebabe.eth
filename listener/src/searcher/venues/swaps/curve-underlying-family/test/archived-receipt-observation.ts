// Offline regression over an existing production-issued Graph. Synthetic
// events + cached descriptor coin mapping; not a receipt replay or acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TokenEdge } from "../../../../planner/token-graph.js";
import { curveUnderlyingSwap } from "../swap.js";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_META_INTERFACE } from "../codec.js";
import { ARCHIVED_EDGES, COINS, POOL, SOURCE, coinData, context, swapLog } from "./receipt-fixture.js";

const path = process.argv[process.argv.indexOf("--checkpoint") + 1];
assert(process.argv.includes("--checkpoint") && path,
  "Explicit archived checkpoint required; no synthetic Graph fallback");
const bytes = readFileSync(path);
assert.equal(createHash("sha256").update(bytes).digest("hex"),
  "71bfc3126ec2575578ede7849f68db2aad76d1ab27da79b7bd32ff78dd877183");
const checkpoint = JSON.parse(bytes.toString("utf8")) as {
  readyGeneration: { cutoff: typeof SOURCE; graphSnapshot: { edges: TokenEdge[] } };
  verifiedMemos: Record<string, {
    familyId: string;
    compiledDescriptor: { coins: string[] };
    staticProjection: { routes: { i: number; j: number; tokenIn: string; tokenOut: string }[] };
  }>;
};
assert.deepEqual(checkpoint.readyGeneration.cutoff, SOURCE);
const memos = Object.values(checkpoint.verifiedMemos).filter(m => m.familyId === "curve-underlying");
assert.equal(memos.length, 1);
assert.deepEqual(memos[0].compiledDescriptor.coins, COINS);
const graph = checkpoint.readyGeneration.graphSnapshot.edges.filter(e =>
  e.adapterId === "curve-exchange-underlying" && e.instanceKey === POOL.toLowerCase());
assert.equal(graph.length, 12);
assert(graph.every(e => e.curveI === undefined && e.curveJ === undefined));
for (const fixture of ARCHIVED_EDGES) {
  assert.deepEqual(graph.find(e => e.canonicalEdgeId === fixture.canonicalEdgeId), fixture,
    "permanent fixture must exactly match the cached production-issued edge");
}
let cases = 0;
for (const type of ["int128", "uint256"] as const) for (const route of memos[0].staticProjection.routes) {
  const ctx = context([swapLog(type, BigInt(route.i), BigInt(route.j))]);
  const result = await curveUnderlyingSwap.receiptObservation.decodeReceiptImpacts({ ...ctx, graph,
    tokenQuery: { async call(req, control) {
      assert.equal(req.blockTag, SOURCE.number);
      assert.equal(req.to, CURVE_METAREGISTRY);
      assert.equal(req.data, CURVE_UNDERLYING_META_INTERFACE.encodeFunctionData("get_underlying_coins", [POOL]));
      assert.equal(control, ctx.control);
      return coinData(memos[0].compiledDescriptor.coins);
    } },
  });
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") throw new Error("archived direction unresolved");
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].impact.tokenIn, route.tokenIn);
  assert.equal(result.impacts[0].impact.tokenOut, route.tokenOut);
  assert.equal(result.impacts[0].impact.amountIn, 123n);
  assert.equal(result.impacts[0].impact.amountOut, 120n);
  cases++;
}
assert.equal(cases, 24);
assert(graph.every(e => e.curveI === undefined && e.curveJ === undefined));
console.log(`curve-underlying archived Graph regression PASS (${cases} synthetic events / ${graph.length} actual directions; no RPC or replay)`);
