import assert from "node:assert/strict";
import { test } from "node:test";
import { manualFourHopInput } from "./manual-forward-input.js";
import { blockScanEdgeKey } from "../../venues/blockscan-state-capability.js";

function fixture() {
  const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const tokens = ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", address(1), address(2), address(3), address(4)];
  const source = { number: 100, hash: "0x" + "1".repeat(64), generation: 1 };
  const edges: any[] = tokens.slice(0, 4).map((tokenIn, i) => ({ tokenIn, tokenOut: tokens[i + 1],
    target: address(10 + i), instanceKey: address(10 + i), adapterId: "fixture", canonicalEdgeId: "edge" + i,
    executionVariantKey: "fixture", leavesStandingPosition: false }));
  const rows = edges.map((e, i) => ({ edgeId: blockScanEdgeKey(e), instanceKey: e.instanceKey,
    tokenIn: e.tokenIn, tokenOut: e.tokenOut, amountIn: 100n + BigInt(i), amountOut: 101n + BigInt(i),
    status: "quoted", effectiveMid: Number(101 + i) / (100 + i), quotedAt: { ...source } }));
  const saved: any = { runtime: { sourceBlock: source.number, sourceBlockHash: source.hash, generation: 1,
    graph: { edges }, pricing: { sourceBlock: source.number, sourceBlockHash: source.hash, generation: 1,
      mids: new Map(rows.map(r => [r.edgeId, { mid: r.effectiveMid }])),
      effectiveMids: { complete: true, source, referenceWethInput: 100n, rows: new Map(rows.map(r => [r.edgeId, r])) } } } };
  const manifest: any = { schemaVersion: 1, kind: "manual-four-hop-output-input", pricesSha256: "a".repeat(64),
    tokenIn: tokens[4], amountIn: "104", edgeIds: rows.map(r => r.edgeId) };
  return { saved, manifest, rows, edges };
}
test("manual fourth output is an input-only diagnostic and never mutates saved prices", () => {
  const { saved, manifest } = fixture(), before = structuredClone(saved);
  const result = manualFourHopInput(manifest, saved, "a".repeat(64));
  assert.equal(result.amountIn, 104n); assert.equal(result.path.length, 4);
  assert.equal(result.freshness, "fresh"); assert.match(result.naturalTargetValuation, /not supplied/);
  assert.deepEqual(saved, before);
});
test("manual input rejects altered amounts, identities, lineage and unsuccessful observations", () => {
  const corruptions: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.manifest.pricesSha256 = "b".repeat(64); },
    f => { f.manifest.amountIn = "103"; }, f => { f.manifest.amountIn = "0"; },
    f => { f.manifest.tokenIn = f.rows[0]!.tokenIn; },
    f => { f.manifest.edgeIds.reverse(); }, f => { f.manifest.edgeIds.pop(); },
    f => { f.rows[1]!.amountIn += 1n; }, f => { f.rows[0]!.amountIn += 1n; },
    f => { f.rows[3]!.status = "quote-failed"; },
    f => { f.rows[2]!.quotedAt.number--; }, f => { f.rows[2]!.quotedAt.generation++; },
    f => { f.rows[2]!.quotedAt.hash = "0x" + "2".repeat(64); },
    f => { f.edges[2]!.leavesStandingPosition = true; },
    f => { f.edges.pop(); }, f => { f.edges.push(f.edges[0]); },
    f => { f.rows[1]!.instanceKey = f.rows[0]!.instanceKey; },
    f => { f.saved.runtime.pricing.effectiveMids.complete = false; },
    f => { f.rows[3]!.tokenOut = f.rows[0]!.tokenIn; f.edges[3]!.tokenOut = f.rows[0]!.tokenIn; },
  ];
  for (const corrupt of corruptions) {
    const f = fixture(); corrupt(f);
    assert.throws(() => manualFourHopInput(f.manifest, f.saved, "a".repeat(64)), corrupt.toString());
  }
});
