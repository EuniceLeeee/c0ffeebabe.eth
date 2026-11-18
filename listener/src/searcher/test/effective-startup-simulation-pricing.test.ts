import assert from "node:assert/strict";
import test from "node:test";
import { buildEffectiveMids, effectiveRowAmountReference,
  type EffectiveMidQuote, type EffectivePricingInput } from "../blockscan-effective-mid.js";
import type { TokenEdge } from "../planner/token-graph.js";

// Orchestration tests: these deterministic callbacks are not node/EVM evidence.
const source = { number: 100, hash: `0x${"a".repeat(64)}`, generation: 3 };
const edge = (id: string, tokenIn: string, tokenOut: string): TokenEdge => ({
  tokenIn, tokenOut, adapterId: "fixture", target: id, instanceKey: id,
  executionVariantKey: id, canonicalEdgeId: id as TokenEdge["canonicalEdgeId"],
  slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
});
function build(edges: readonly TokenEdge[], quote: EffectiveMidQuote) {
  const pricing: EffectivePricingInput = {
    sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
    graph: { edges }, mids: new Map(), coverage: { resolvedEdgeKeys: edges.map(e => String(e.canonicalEdgeId)) },
    pricingStateKeyByEdgeKey: new Map(edges.map(e => [String(e.canonicalEdgeId), e.instanceKey!])),
  };
  return buildEffectiveMids({ pricing, weth: "weth", maxInputPathHops: 6,
    fixedWethInput: 100n, gasCostWei: null, enumerationSpreadBps: 0,
    control: {}, concurrency: 2, quote });
}

test("startup receipt supplies the price and actual debit without a second quotation", async () => {
  const edges = [edge("a", "weth", "token-a"), edge("b", "token-a", "token-b")];
  const calls: string[] = [];
  const result = await build(edges, async request => {
    calls.push(request.edge.target);
    assert.deepEqual(request.source, source);
    assert.equal(request.maxInputPathHops, 6);
    assert.equal(request.reference.path.length, request.edge.target === "a" ? 0 : 1);
    assert.equal(request.amountIn, request.reference.amountIn);
    return { source, amountIn: request.amountIn, amountOut: request.amountIn * 2n,
      amountSpent: request.amountIn - 1n, inputReference: request.reference,
      pricingMethod: "startup-simulation" };
  });
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(result.rows.get("a")!.amountOut, 200n);
  assert.equal(result.rows.get("b")!.amountIn, 200n);
  assert.equal(result.rows.get("b")!.amountOut, 400n);
  assert.equal(result.rows.get("b")!.amountSpent, 199n);
  assert.equal(result.rows.get("b")!.effectiveMid, 2, "the existing input-budget pricing convention is retained");
  assert.equal(result.rows.get("b")!.pricingMethod, "startup-simulation");
});

test("one execution may refresh prefix quantities while preserving its source, seed and route", async () => {
  const edges = [edge("a", "weth", "token-a"), edge("b", "token-a", "token-b"),
    edge("c", "token-b", "token-c")];
  const result = await build(edges, async request => {
    if (request.edge.target === "b") {
      const prefix = { ...request.reference.path[0]!, amountOut: 300n, effectiveMid: 3 };
      return { source, amountIn: 300n, amountOut: 600n, amountSpent: 299n,
        pricingMethod: "startup-simulation", inputReference: { amountIn: 300n, path: [prefix] } };
    }
    return { source, amountIn: request.amountIn, amountOut: request.amountIn * 2n,
      pricingMethod: "startup-simulation", inputReference: request.reference };
  });
  const target = result.rows.get("b")!;
  assert.equal(target.status, "quoted");
  assert.equal(target.amountIn, 300n);
  assert.equal(target.amountOut, 600n);
  assert.equal(effectiveRowAmountReference(target)!.path[0]!.amountOut, 300n);
  assert.equal(result.rows.get("c")!.amountIn, 600n);
  assert.deepEqual(effectiveRowAmountReference(result.rows.get("c")!)!.path.map(r => r.amountIn), [100n, 300n]);
  assert.equal(result.rows.get("a")!.amountOut, 200n, "independent earlier samples remain immutable");
});

for (const fault of ["route", "source", "seed"] as const) {
  test(`a simulated price cannot replace the requested prefix ${fault}`, async () => {
    const edges = [edge("a", "weth", "token-a"), edge("b", "token-a", "token-b")];
    const result = await build(edges, async request => {
      const path = request.reference.path.map(row => ({ ...row,
        ...(fault === "route" ? { edgeId: "other" } : {}),
        ...(fault === "source" ? { quotedAt: { ...source, generation: 2 } } : {}),
        ...(fault === "seed" ? { amountIn: 50n, effectiveMid: 4 } : {}),
      }));
      return { source, amountIn: request.amountIn, amountOut: request.amountIn * 2n,
        pricingMethod: "startup-simulation", inputReference: { ...request.reference, path } };
    });
    assert.equal(result.rows.get("a")!.status, "quoted");
    assert.equal(result.rows.get("b")!.status, "quote-failed");
    assert.equal(result.rows.get("b")!.amountOut, null);
  });
}

test("an observed execution revert cannot become a price or seed later routes", async () => {
  const edges = [edge("a", "weth", "token-a"), edge("b", "token-a", "token-b")];
  let calls = 0;
  const result = await build(edges, async () => {
    calls++;
    throw Object.assign(new Error("observed startup target revert"), { code: "STARTUP_EXECUTION_REVERT" });
  });
  assert.equal(calls, 1);
  assert.equal(result.rows.get("a")!.status, "quote-failed");
  assert.equal(result.rows.get("a")!.failureEvidence, "evm-revert-observed");
  assert.equal(result.rows.get("b")!.status, "missing-valuation");
});
