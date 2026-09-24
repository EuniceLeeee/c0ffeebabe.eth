import assert from "node:assert/strict";
import { ADDR } from "../../shared/constants/addresses.js";
import { createScannedProfitTokenValuation } from "../scanned-profit-token-valuation.js";
import { evaluateEv } from "../ev-evaluator.js";
import { buildEffectiveMids, type EffectiveMidRow } from "../blockscan-effective-mid.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const source = { number: 42, hash: hash(42), generation: 7 };
const W = ADDR.WETH.toLowerCase(), BTC = ADDR.WBTC.toLowerCase();
type Leg = readonly [string, string, bigint, bigint];
type Pricing = NonNullable<Parameters<typeof createScannedProfitTokenValuation>[0]>;
function snapshot(legs: readonly Leg[]): Pricing {
  const edges: TokenEdge[] = legs.map(([tokenIn, tokenOut], i) => ({
    tokenIn, tokenOut, adapterId: "fixture", target: `edge-${i}`, instanceKey: `edge-${i}`,
    canonicalEdgeId: `edge-${i}` as TokenEdge["canonicalEdgeId"], executionVariantKey: "fixture",
    slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
  }));
  const rows = new Map<string, EffectiveMidRow>(edges.map((edge, i) => [blockScanEdgeKey(edge), {
    edgeId: blockScanEdgeKey(edge), instanceKey: edge.instanceKey!, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
    amountIn: legs[i]![2], amountOut: legs[i]![3], effectiveMid: Number(legs[i]![3]) / Number(legs[i]![2]),
    status: "quoted", quotedAt: { ...source },
  }]));
  // Only consumed fields are fixtures; no Family/chain authority is fabricated.
  return {
    sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
    graph: { edges }, coverage: { resolvedEdgeKeys: [...rows.keys()] },
    mids: new Map(edges.map(e => [blockScanEdgeKey(e), { edges: [e], kind: "external-swap",
      pool: e.target, mid: 1, feeBps: 0, depthProxy: 1 }])),
    effectiveMids: { source: { ...source }, rows, complete: true, reference: "default", referenceWethInput: 1n, wallMs: 0 },
  };
}
function withRow(p: Pricing, patch: Partial<EffectiveMidRow>): Pricing {
  const rows = new Map(p.effectiveMids!.rows), [id, r] = [...rows][0]!;
  rows.set(id, { ...r, ...patch });
  return { ...p, effectiveMids: { ...p.effectiveMids!, rows } };
}
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

test("raw amounts, best same-distance quote, no token whitelist/extra fees", () => {
  const p = snapshot([[BTC, W, 6422n, 2000119143355107n], [BTC, W, 6422n, 1962534248594328n],
    ["new-token", W, 10n ** 18n, 3n * 10n ** 18n]]);
  const v = createScannedProfitTokenValuation(p, source);
  assert.equal(v.valueInEth(BTC.toUpperCase(), 333n, 0), 333n * 2000119143355107n / 6422n);
  assert.equal(v.valueInEth("new-token", 100n, 0), 300n);
  assert.equal(v.valueInEth(W, 123n, 0), 123n);
  assert.equal(v.valueInEth(ADDR.USDC, 100n, 3000), null, "no assumed USD peg");
  assert.equal(v.valueInEth(BTC, 6422n, 0), 2000119143355107n);
  assert.equal(v.valueInEth(BTC, 6423n, 0), null, "no extrapolation above reference amount");
});
test("shortest directed path, <=3 hops, not inverse edges or cycles", () => {
  const p = snapshot([["a", W, 100n, 100n], ["a", "b", 100n, 200n], ["b", W, 1000n, 3000n],
    [W, "reverse-only", 100n, 100n], ["c", "a", 100n, 100n], ["d", "c", 100n, 100n],
    ["four", "d", 100n, 100n], ["cycle1", "cycle2", 100n, 100n], ["cycle2", "cycle1", 100n, 100n]]);
  const v = createScannedProfitTokenValuation(p, source);
  assert.equal(v.valueInEth("a", 10n, 0), 10n);
  assert.equal(v.valueInEth("d", 10n, 0), 10n);
  for (const token of ["four", "reverse-only", "cycle1"]) assert.equal(v.canValue(token), false);
});
test("per-hop capacity and integer rounding, conservative loss rounding", () => {
  const v = createScannedProfitTokenValuation(snapshot([["a", "b", 100n, 1000n], ["b", W, 100n, 1n]]), source);
  assert.equal(v.valueInEth("a", 10n, 0), 1n);
  assert.equal(v.valueInEth("a", 11n, 0), null);
  const rounding = createScannedProfitTokenValuation(snapshot([["a", "b", 2n, 3n], ["b", W, 2n, 3n]]), source);
  assert.equal(rounding.valueInEth("a", 1n, 0), 1n, "floor at each hop, not 2 from rational product");
  assert.equal(rounding.valueInEth("a", -1n, 0), -3n);
});
test("missing, partial and mismatched publications have no raw/default fallback", () => {
  const p = snapshot([[BTC, W, 100n, 200n]]);
  const variants: (Pricing | null)[] = [null, { ...p, effectiveMids: undefined },
    { ...p, effectiveMids: { ...p.effectiveMids!, complete: false } },
    { ...p, sourceBlock: source.number - 1 }, { ...p, sourceBlockHash: hash(1) },
    { ...p, generation: source.generation + 1 },
    { ...p, effectiveMids: { ...p.effectiveMids!, source: { ...source, generation: 0 } } },
    { ...p, effectiveMids: { ...p.effectiveMids!, source: { ...source, hash: hash(1) } } },
    { ...p, coverage: { ...p.coverage, resolvedEdgeKeys: [] } }, { ...p, mids: new Map() },
  ];
  for (const changed of variants) {
    const v = createScannedProfitTokenValuation(changed, source);
    assert.equal(v.canValue(BTC), false);
    assert.equal(v.valueInEth(W, 1n, 0), 1n);
  }
});
test("reject invalid rows, future/fork observations and standing positions", () => {
  const p = snapshot([[BTC, W, 100n, 200n]]);
  for (const patch of [{ status: "quote-failed" as const }, { amountOut: 0n }, { amountIn: null },
    { edgeId: "wrong" }, { tokenIn: "wrong" }, { tokenOut: "wrong" }, { quotedAt: undefined },
    { quotedAt: { ...source, number: 43 } }, { quotedAt: { ...source, hash: hash(9) } },
    { quotedAt: { ...source, generation: 8 } }]) {
    assert.equal(createScannedProfitTokenValuation(withRow(p, patch), source).canValue(BTC), false);
  }
  const edge = p.graph.edges[0]!;
  for (const changed of [{ ...edge, leavesStandingPosition: true }, { ...edge, slotKind: "lend" as const }]) {
    assert.equal(createScannedProfitTokenValuation({ ...p, graph: { ...p.graph, edges: [changed] } }, source).canValue(BTC), false);
  }
});
test("normal producer clean carry is reusable; a touched failure removes the mark", async () => {
  const p = snapshot([[BTC, W, 100n, 200n]]), next = { number: 43, hash: hash(43), generation: 8 };
  const current = { ...p, sourceBlock: next.number, sourceBlockHash: next.hash, generation: next.generation };
  let calls = 0;
  const build = (touched: ReadonlySet<string>) => buildEffectiveMids({ pricing: current, previous: p.effectiveMids,
    touchedStateKeys: touched, weth: W, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
    quote: async () => { calls++; throw new Error("fixture quote failure"); } });
  const carried = await build(new Set());
  assert.equal(calls, 0);
  assert.equal(carried.rows.get("edge-0")!.quotedAt!.number, 42);
  assert.equal(createScannedProfitTokenValuation({ ...current, effectiveMids: carried }, next).valueInEth(BTC, 50n, 0), 100n);
  const refreshed = await build(new Set(["edge-0"]));
  assert(calls > 0);
  assert.equal(createScannedProfitTokenValuation({ ...current, effectiveMids: refreshed }, next).canValue(BTC), false);
});
test("in-flight valuation is immutable across publication changes", () => {
  const p = snapshot([[BTC, W, 100n, 200n]]), anchor = { ...source };
  const v = createScannedProfitTokenValuation(p, anchor);
  (p.effectiveMids!.rows as Map<string, EffectiveMidRow>).clear();
  anchor.hash = hash(99);
  assert.equal(v.valueInEth(BTC, 50n, 0), 100n);
  assert.equal(v.source!.hash, source.hash);
  const next = snapshot([[BTC, W, 100n, 300n]]);
  assert.equal(createScannedProfitTokenValuation(next, source).valueInEth(BTC, 50n, 0), 150n);
});
test("shared EV uses scanned mark, no oracle read, same gas/bid policy", async () => {
  const v = createScannedProfitTokenValuation(snapshot([[BTC, W, 6422n, 2000119143355107n]]), source);
  let headers = 0;
  const header = { number: 42, hash: source.hash, baseFeePerGas: 90200347n, gasUsed: 100n, gasLimit: 200n };
  const provider = { async getBlock() { headers++; return header; }, async call() { throw new Error("unexpected extra RPC"); } };
  const policy = { evGate: true, profitHaircutBps: 0, bribeBps: 5000, bribeAllAboveGas: false };
  const ev = await evaluateEv(provider, BTC, 333n, 552405n, policy, v, 42, { mode: "source-block", sourceBlockHash: source.hash });
  assert.equal(ev.valuationAvailable, true);
  assert.equal(ev.rawProfitEth, 333n * 2000119143355107n / 6422n);
  assert.equal(ev.gasCostEth, 552405n * 90200347n);
  assert.equal(ev.bidEth, (ev.rawProfitEth - ev.gasCostEth) / 2n);
  assert(ev.netEvWei > 0n);
  assert.equal(headers, 2);
  assert.equal(ev.ethUsd, null);
  const missing = await evaluateEv(provider, ADDR.USDC, 1n, 10n, policy, v, 42);
  assert.equal(missing.valuationAvailable, false);
});
test("source mismatch and reorg fail closed even with EV gate disabled", async () => {
  const v = createScannedProfitTokenValuation(snapshot([[BTC, W, 100n, 200n]]), source);
  const header = { number: 42, hash: source.hash, baseFeePerGas: 1n, gasUsed: 1n, gasLimit: 2n };
  const policy = { evGate: false, profitHaircutBps: 0, bribeBps: 0, bribeAllAboveGas: false };
  for (const h of [{ ...header, number: 43 }, { ...header, hash: hash(99) }]) {
    const ev = await evaluateEv({ async getBlock() { return h; } }, BTC, 10n, 10n, policy, v, 42);
    assert.equal(ev.valuationAvailable, false);
  }
  let reads = 0;
  const reorged = await evaluateEv({ async getBlock() { return { ...header, hash: ++reads === 1 ? source.hash : hash(99) }; } },
    BTC, 10n, 10n, policy, v, 42);
  assert.equal(reads, 2);
  assert.equal(reorged.valuationAvailable, false);
  assert.equal(reorged.feeStateAvailable, false);
});

for (const [name, run] of tests) { await run(); console.log(`[scanned-profit-token-valuation] PASS ${name}`); }
console.log(`scanned-profit-token-valuation PASS (${tests.length}/${tests.length})`);
