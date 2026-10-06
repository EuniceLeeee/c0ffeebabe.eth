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
  assert.equal(v.valueInEth(BTC, 6423n, 0), 6423n * 2000119143355107n / 6422n);
  assert.equal(v.valueInEth(BTC, 642200n, 0), 100n * 2000119143355107n, "profit can exceed sampled P");
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
test("reference rates extrapolate past per-hop samples with conservative integer rounding", () => {
  const v = createScannedProfitTokenValuation(snapshot([["a", "b", 100n, 1000n], ["b", W, 100n, 1n]]), source);
  assert.equal(v.valueInEth("a", 10n, 0), 1n);
  assert.equal(v.valueInEth("a", 11n, 0), 1n);
  assert.equal(v.valueInEth("a", 1000n, 0), 100n, "exceeds both hops' sampled inputs");
  const rounding = createScannedProfitTokenValuation(snapshot([["a", "b", 2n, 3n], ["b", W, 2n, 3n]]), source);
  assert.equal(rounding.valueInEth("a", 1n, 0), 1n, "floor at each hop, not 2 from rational product");
  assert.equal(rounding.valueInEth("a", -1n, 0), -3n);
  assert.equal(rounding.valueInEth("a", 101n, 0), 226n);
  assert.equal(rounding.valueInEth("a", -101n, 0), -228n, "loss rounds away from zero above P");
  assert.equal(rounding.valueInEth("a", 0n, 0), 0n);
});
test("missing, partial and mismatched publications have no raw/default fallback", () => {
  const p = snapshot([[BTC, W, 100n, 200n]]);
  const variants: (Pricing | null)[] = [null, { ...p, effectiveMids: undefined },
    { ...p, effectiveMids: { ...p.effectiveMids!, complete: false } },
    { ...p, sourceBlock: source.number - 1 }, { ...p, sourceBlockHash: hash(1) },
    { ...p, generation: source.generation + 1 },
    { ...p, effectiveMids: { ...p.effectiveMids!, source: { ...source, generation: 0 } } },
    { ...p, effectiveMids: { ...p.effectiveMids!, source: { ...source, hash: hash(1) } } },
    { ...p, coverage: { ...p.coverage, resolvedEdgeKeys: [] } },
  ];
  for (const changed of variants) {
    const v = createScannedProfitTokenValuation(changed, source);
    assert.equal(v.canValue(BTC), false);
    assert.equal(v.valueInEth(W, 1n, 0), 1n);
  }
});
test("small downstream samples do not erase a reference path; equal-rate tie-break stays unchanged", () => {
  const smallSample = createScannedProfitTokenValuation(snapshot([["a", "b", 1n, 1000n], ["b", W, 100n, 1n]]), source);
  assert.equal(smallSample.valueInEth("a", 1n, 0), 10n, "propagated sample rounds to zero but rate is valid");
  const equalRate = createScannedProfitTokenValuation(snapshot([["a", "b", 2n, 3n], ["b", W, 2n, 3n],
    ["a", "c", 4n, 9n], ["c", W, 100n, 100n]]), source);
  assert.equal(equalRate.valueInEth("a", 5n, 0), 11n, "same rate still prefers the larger sampled path");
});
test("current effective profit marks are independent of frozen raw membership and metadata", () => {
  const p = snapshot([[BTC, W, 100n, 200n]]);
  const noRaw = { ...p, mids: new Map() };
  assert.equal(createScannedProfitTokenValuation(noRaw, source).valueInEth(BTC, 50n, 0), 100n);
  const poisoned = { ...p, get mids(): Pricing["mids"] { throw new Error("profit valuation read raw mids"); } };
  assert.equal(createScannedProfitTokenValuation(poisoned, source).valueInEth(BTC, 50n, 0), 100n);
  const missingCoverage = { ...noRaw, coverage: { ...noRaw.coverage, resolvedEdgeKeys: [] } };
  assert.equal(createScannedProfitTokenValuation(missingCoverage, source).canValue(BTC), false);
});
test("reject invalid rows, future/fork observations and standing positions", () => {
  const p = snapshot([[BTC, W, 100n, 200n]]);
  for (const patch of [{ status: "quote-failed" as const }, { amountOut: 0n }, { amountIn: null },
    { edgeId: "wrong" }, { instanceKey: "wrong" }, { tokenIn: "wrong" }, { tokenOut: "wrong" }, { quotedAt: undefined },
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
  const base = snapshot([[W, BTC, 200n, 100n], [BTC, W, 100n, 200n]]);
  const effectiveMids = await buildEffectiveMids({ pricing: base, weth: W,
    gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
    quote: async ({edge, amountIn}) => ({source, amountIn, amountOut: edge.tokenIn === W ? amountIn / 2n : amountIn * 2n}),
  });
  const p = {...base, effectiveMids}, next = { number: 43, hash: hash(43), generation: 8 };
  const current = { ...p, sourceBlock: next.number, sourceBlockHash: next.hash, generation: next.generation };
  let calls = 0;
  const build = (touched: ReadonlySet<string>) => buildEffectiveMids({ pricing: current, previous: p.effectiveMids,
    touchedStateKeys: touched, weth: W, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
    quote: async () => { calls++; throw new Error("fixture quote failure"); } });
  const carried = await build(new Set());
  assert.equal(calls, 0);
  assert.strictEqual(carried.rows, effectiveMids.rows);
  assert.equal(carried.rows.get("edge-1")!.quotedAt!.number, 42);
  assert.equal(createScannedProfitTokenValuation({ ...current, effectiveMids: carried }, next).valueInEth(BTC, 50n, 0), 100n);
  const refreshed = await build(new Set(["edge-1"]));
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

test("EV prices profit above P from effective rates without an additional price RPC", async () => {
  const amountIn = 4237037n, amountOut = 1999999701923617n, profit = 167645544n;
  const v = createScannedProfitTokenValuation(snapshot([[ADDR.USDT, W, amountIn, amountOut]]), source);
  let calls = 0, headers = 0;
  const header = { number: source.number, hash: source.hash, baseFeePerGas: 2213147948n, gasUsed: 100n, gasLimit: 200n };
  const ev = await evaluateEv({ getBlock: async () => { headers++; return header; },
    call: async () => { calls++; throw new Error("unexpected price RPC"); } },
    ADDR.USDT, profit, 904211n, { evGate: true, profitHaircutBps: 0, bribeBps: 5000, bribeAllAboveGas: false },
    v, source.number, { mode: "source-block", sourceBlockHash: source.hash });
  assert.equal(ev.valuationAvailable, true);
  assert.equal(ev.rawProfitEth, 79133375051674700n);
  assert.equal(ev.gasCostEth, 2001152719209028n);
  assert.equal(ev.bidEth, 38566111166232836n);
  assert.equal(ev.netEvWei, 38566111166232836n);
  assert.equal(calls, 0);
  assert.equal(headers, 2, "existing source checks remain, no new requests");
});

for (const [name, run] of tests) { await run(); console.log(`[scanned-profit-token-valuation] PASS ${name}`); }
console.log(`scanned-profit-token-valuation PASS (${tests.length}/${tests.length})`);
