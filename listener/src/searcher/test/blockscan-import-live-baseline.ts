import assert from "node:assert/strict";
import test from "node:test";
import { serialize, deserialize } from "node:v8";
import { buildEffectiveMids, exportEffectiveMidReplayState, type EffectivePricingInput } from "../blockscan-effective-mid.js";
import { recoverBootstrapLineage } from "../blockscan-import-live-baseline.js";
import type { TokenEdge } from "../planner/token-graph.js";

const source = { number: 42, hash: "0x" + "aa".repeat(32), generation: 1 };
const edge = (tokenIn: string, tokenOut: string, id: string): TokenEdge => ({ tokenIn, tokenOut,
  target: id, instanceKey: id, executionVariantKey: id, adapterId: "test-swap", canonicalEdgeId: id as TokenEdge["canonicalEdgeId"],
  slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false });
const edges = [edge("weth", "usd", "first"), edge("usd", "weth", "back"), edge("weth", "missing", "failed"),
  edge("missing", "weth", "unreachable"), edge("weth", "zero", "zero")];
const pricing: EffectivePricingInput = { sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
  graph: { edges }, mids: new Map(), coverage: { resolvedEdgeKeys: [] } };
const build = (p: EffectivePricingInput, previous?: Awaited<ReturnType<typeof buildEffectiveMids>>) => buildEffectiveMids({
  pricing: p, weth: "weth", fixedWethInput: 10n, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 4, control: {},
  ...(previous ? { previous, touchedStateKeys: new Set(["first"]) } : {}),
  quote: async ({ edge, amountIn }) => {
    if (edge.target === "failed") throw new Error("observed failure");
    return { source: { number: p.sourceBlock, hash: p.sourceBlockHash, generation: p.generation }, amountIn,
      amountOut: edge.target === "zero" ? 0n : amountIn * BigInt(p.generation + 1) };
  } });

test("existing tuples restore the real forward lineage and repeatable next-block results without RPC", async () => {
  const original = await build(pricing);
  const saved = deserialize(serialize(original));
  const recovered = await recoverBootstrapLineage(pricing, saved, "weth");
  assert.equal(recovered.quoteRpcCalls, 0);
  assert.equal(recovered.savedTupleLookups, 4);
  assert.equal(recovered.comparedRows, 5);
  assert.deepEqual(exportEffectiveMidReplayState(saved), exportEffectiveMidReplayState(original));
  const next = { ...pricing, sourceBlock: 43, sourceBlockHash: "0x" + "bb".repeat(32), generation: 2 };
  const expected = await build(next, original);
  for (let trial = 0; trial < 2; trial++) {
    const fresh = deserialize(serialize(original));
    await recoverBootstrapLineage(pricing, fresh, "weth");
    assert.deepEqual([...(await build(next, fresh)).rows], [...expected.rows]);
  }
});

test("missing tuples, changed amounts and carried sources cannot silently trigger repricing", async () => {
  const original = await build(pricing);
  const changed = deserialize(serialize(original));
  changed.rows.get("back").amountIn += 1n;
  await assert.rejects(recoverBootstrapLineage(pricing, changed, "weth"), /lookup mismatch/);
  const missing = deserialize(serialize(original)); missing.rows.delete("unreachable");
  await assert.rejects(recoverBootstrapLineage(pricing, missing, "weth"), /complete graph/);
  const carried = deserialize(serialize(original)); carried.rows.get("first").carried = true;
  await assert.rejects(recoverBootstrapLineage(pricing, carried, "weth"), /carried/);
});
