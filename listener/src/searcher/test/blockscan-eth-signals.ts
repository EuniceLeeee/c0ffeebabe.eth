import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildBlockScanEthView, effectiveEthPricing, resolveEthSignalPairsPerToken, ethViewStatistics } from "../blockscan-eth-view.js";
import type { BlockScanEthView } from "../blockscan-eth-view.js";
import type { DirectedPriceSignal } from "../detector/blockscan-paired-dfs.js";
import type { ResolvedBlockScanQuote } from "../detector/blockscan-scanner-core.js";
import { effectiveEnumerationMids, type EffectiveMidRow } from "../blockscan-effective-mid.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const weth = ADDR.WETH.toLowerCase(), usdc = ADDR.USDC.toLowerCase();
const cmp = (a: {num: bigint; den: bigint}, b: {num: bigint; den: bigint}) => {
  const d = a.num * b.den - b.num * a.den; return d < 0n ? -1 : d > 0n ? 1 : 0;
};
function fixture(count: number, samePool = false, seed = 1, token = usdc) {
  const edges: TokenEdge[] = [], mids = new Map<string, ResolvedBlockScanQuote>();
  let random = seed;
  for (let i = 0; i < count; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const edge: TokenEdge = { adapterId: `test-${i}`, target: address(samePool ? 100 : 100 + (i % 7)),
      tokenIn: i % 2 ? token : weth, tokenOut: i % 2 ? weth : token,
      slotKind: "swap", ...deriveEdgeTaxonomy("swap") };
    const amountIn = 1_000n, amountOut = BigInt(980 + random % 90);
    edges.push(edge); mids.set(blockScanEdgeKey(edge), { kind: "test", pool: edge.target,
      edges: [edge], mid: Number(amountOut) / Number(amountIn), feeBps: 0,
      quoteAmountIn: amountIn, quoteAmountOut: amountOut, depthProxy: 1e20 });
  }
  return { edges, mids };
}
function publication({ edges, mids }: ReturnType<typeof fixture>): BlockScanStateSnapshot {
  const source = { number: 1, hash: `0x${"ab".repeat(32)}`, generation: 1 };
  const rows = new Map<string, EffectiveMidRow>([...mids].map(([key, mid]) => {
    const edge = mid.edges[0]!;
    return [key, { edgeId: key, status: "quoted", effectiveMid: mid.mid,
      amountIn: mid.quoteAmountIn, amountOut: mid.quoteAmountOut,
      instanceKey: edgeInstanceKey(edge), tokenIn: edge.tokenIn, tokenOut: edge.tokenOut }];
  }));
  return { graph: { edges }, mids, sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
    effectiveMids: { source, reference: "default", referenceWethInput: 1n, complete: true, wallMs: 0, rows } } as unknown as BlockScanStateSnapshot;
}

// Independent full Cartesian oracle used only on small fixtures. It ranks by
// reference prices (integer ratios) and rejects the same logical pool.
function oracle(view: BlockScanEthView, limit: number, legacy = false) {
  const result: DirectedPriceSignal[] = [];
  for (const token of new Set(view.quotes.map(q => q.tokenOut))) {
    const buys = view.quotes.filter(q => q.tokenOut === token).map(q => {
      const mark = view.referenceEthPerRaw.get(q.tokenIn)!;
      return { q, num: q.den * mark.num, den: q.num * mark.den };
    }).sort((a, b) => cmp(a, b) || a.q.id.localeCompare(b.q.id));
    const sells = view.quotes.filter(q => q.tokenIn === token).map(q => {
      const mark = view.referenceEthPerRaw.get(q.tokenOut)!;
      return { q, num: q.num * mark.num, den: q.den * mark.den };
    }).sort((a, b) => cmp(b, a) || a.q.id.localeCompare(b.q.id));
    const topTwo = <T extends {q: {instance: string}}>(offers: T[]) =>
      offers.length ? [offers[0]!, offers.find(o => o.q.instance !== offers[0]!.q.instance)].filter((o): o is T => o !== undefined) : [];
    const pairs = (legacy ? topTwo(buys) : buys).flatMap((b, bi) =>
      (legacy ? topTwo(sells) : sells).flatMap((s, si) => !view.allowRepeatedPools && b.q.instance === s.q.instance ? [] : [{
        token, buy: b.q.id, sell: s.q.id, num: s.num * b.den, den: s.den * b.num, bi, si,
      }]));
    pairs.sort((a, b) => cmp(b, a) || a.bi - b.bi || a.si - b.si);
    result.push(...pairs.filter(p => p.num > p.den).slice(0, limit));
  }
  return result;
}
const identities = (signals: readonly DirectedPriceSignal[]) => signals.map(s => `${s.token}|${s.buy}|${s.sell}`).sort();

test("default 20, selectable positive integer, rejects malformed limits", () => {
  assert.equal(resolveEthSignalPairsPerToken(), 20);
  for (const raw of ["1", "20", "100"]) assert.equal(resolveEthSignalPairsPerToken(raw), Number(raw));
  for (const raw of ["", "0", "-1", "1.2", "Infinity", "01", "9007199254740992"])
    assert.throws(() => resolveEthSignalPairsPerToken(raw), /positive safe integer/);
});

test("top-K matches exhaustive ranking, K=1 matches old best pair, stable ties/order", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const {edges, mids} = fixture(36, false, seed);
    for (const allowRepeatedPools of [false, true]) for (const limit of [1, 2, 20, 1000]) {
      const view = buildBlockScanEthView(edges, mids, limit, allowRepeatedPools);
      assert.deepEqual(identities(view.signals), identities(oracle(view, limit)));
      if (limit === 1 && !allowRepeatedPools) assert.deepEqual(identities(view.signals), identities(oracle(view, 1, true)));
      assert.deepEqual(identities(view.signals), identities(buildBlockScanEthView([...edges].reverse(), mids, limit, allowRepeatedPools).signals));
      for (const token of new Set(view.signals.map(s => s.token)))
        assert(view.signals.filter(s => s.token === token).length <= limit);
      assert.equal(new Set(identities(view.signals)).size, view.signals.length);
    }
  }
});

test("counts tokens separately from signal pairs; no same-pool or zero-spread signal", () => {
  const {edges, mids} = fixture(36);
  const view = buildBlockScanEthView(edges, mids, 20), stats = ethViewStatistics(view, 0);
  assert.equal(view.signals.length, 40); assert.equal(stats.tokensAboveThreshold, 2);
  assert.equal(stats.signalPairsAboveThreshold, 40); assert.equal(stats.signalPairsPerToken, 20);
  const single = fixture(36, true);
  const samePool = buildBlockScanEthView(single.edges, single.mids, 20, false);
  assert.equal(samePool.signals.length, 0); assert.equal(samePool.comparableTokens, 0);
  const reused = buildBlockScanEthView(single.edges, single.mids, 20);
  assert.equal(reused.allowRepeatedPools, true); assert.equal(reused.signals.length, 40);
  assert.deepEqual(identities(reused.signals), identities(oracle(reused, 20)));
  const flat = new Map([...mids].map(([k, m]) => [k, {...m, mid: 1, quoteAmountOut: m.quoteAmountIn}]));
  const noSpread = buildBlockScanEthView(edges, flat, 20);
  assert.equal(noSpread.signals.length, 0); assert.equal(noSpread.comparableTokens, 2);
});

test("publication cache distinguishes cap, retains mids and supports switching back", () => {
  const {edges, mids} = fixture(36);
  const pricing = publication({ edges, mids });
  const one = effectiveEthPricing(pricing, 1);
  assert.equal(effectiveEthPricing(pricing, 1), one);
  const twenty = effectiveEthPricing(pricing, 20);
  assert.equal(twenty.mids, one.mids); assert(twenty.view.signals.length > one.view.signals.length);
  assert.equal(effectiveEthPricing(pricing), twenty);
  assert.deepEqual(identities(effectiveEthPricing(pricing, 1).view.signals), identities(one.view.signals));
  assert.throws(() => effectiveEthPricing(pricing, 0), /positive safe integer/);
  const on = effectiveEthPricing(pricing, 20, true);
  const off = effectiveEthPricing(pricing, 20, false);
  assert.notEqual(on, off); assert.equal(on.mids, off.mids);
  assert.equal(off.view.allowRepeatedPools, false);
  assert.deepEqual(identities(off.view.signals), identities(buildBlockScanEthView(edges, mids, 20, false).signals));
  assert.equal(effectiveEthPricing(pricing, 20, false), off);
  assert.deepEqual(identities(effectiveEthPricing(pricing, 20, true).view.signals), identities(on.view.signals));
  const independent = { ...pricing, get mids(): BlockScanStateSnapshot["mids"] {
    throw new Error("effective ETH view read the frozen raw table");
  } };
  const noRaw = effectiveEthPricing(independent, 20, true);
  assert.deepEqual(noRaw.mids, on.mids);
  assert.deepEqual(identities(noRaw.view.signals), identities(on.view.signals));
  assert.throws(() => effectiveEthPricing({ ...pricing, effectiveMids: undefined }), /effective pricing missing/);
});

test("effective ETH references and signals never read raw mid or fee", () => {
  const { edges, mids } = fixture(36);
  const expected = buildBlockScanEthView(edges, mids);
  const changed = new Map([...mids].map(([key, mid]) => [key, { ...mid,
    get mid(): number { throw new Error("raw mid must not be read"); },
    get feeBps(): number { throw new Error("raw fee must not be read"); },
  }]));
  assert.deepEqual(buildBlockScanEthView(edges, changed), expected);
  const pricing = publication({ edges, mids });
  const changedRaw = new Map([...pricing.mids].map(([key, mid]) => [key, { ...mid, mid: -123, feeBps: 50_000 }]));
  const rows = new Map([...pricing.effectiveMids!.rows].map(([key, row]) => [key, { ...row, effectiveMid: 987_654 }]));
  assert.deepEqual(effectiveEthPricing({ ...pricing, mids: changedRaw,
    effectiveMids: { ...pricing.effectiveMids!, rows } }).view, expected,
  "effectiveMid's Number projection is not a valuation input either");
});

test("missing and failed effective directions are not filled from raw mids", () => {
  const pricing = publication(fixture(8));
  const effective = pricing.effectiveMids!;
  const rows = new Map(effective.rows);
  const keys = [...rows.keys()];
  rows.delete(keys[0]!);
  rows.set(keys[1]!, { ...rows.get(keys[1]!)!, status: "quote-failed", amountOut: null, effectiveMid: null });
  rows.set(keys[2]!, { ...rows.get(keys[2]!)!, status: "no-output", amountOut: 0n, effectiveMid: null });
  const result = effectiveEthPricing({ ...pricing, effectiveMids: { ...effective, rows } });
  assert.equal(result.mids.size, 5);
  assert.equal(result.view.quotes.length, 5);
  for (const key of keys.slice(0, 3)) {
    assert.equal(result.mids.has(key), false);
    assert.equal(result.view.quotes.some(q => q.id === key), false);
  }
  const empty = effectiveEthPricing({ ...pricing, effectiveMids: { ...effective, rows: new Map() } });
  assert.equal(empty.view.quotes.length, 0);
  assert.equal(empty.view.signals.length, 0);
  assert.deepEqual([...empty.view.referenceEthPerRaw], [[weth, { num: 1n, den: 1n }]]);
});

test("raw-only inputs cannot satisfy the quote contract at compile time", () => {
  const { mids } = fixture(8);
  const rawOnly = new Map([...mids].map(([key, mid]) => {
    const { quoteAmountIn, quoteAmountOut, ...raw } = mid;
    return [key, raw] as const;
  }));
  // @ts-expect-error Exact enumeration requires both integer quote amounts.
  const quoteInput: Parameters<typeof buildBlockScanEthView>[1] = rawOnly;
  void quoteInput;
});

test("effective projection retains source, identity and positive-amount boundaries", () => {
  const pricing = publication(fixture(2)), effective = pricing.effectiveMids!;
  for (const replacement of [
    { ...effective, complete: false },
    { ...effective, source: { ...effective.source, generation: 2 } },
    { ...effective, source: { ...effective.source, number: 2 } },
    { ...effective, source: { ...effective.source, hash: `0x${"cd".repeat(32)}` } },
  ]) assert.throws(() => effectiveEnumerationMids({ ...pricing, effectiveMids: replacement }), /incomplete or mismatched source/);
  const [key, row] = [...effective.rows][0]!;
  for (const change of [
    { edgeId: "wrong" }, { instanceKey: "wrong" }, { tokenIn: address(998) }, { tokenOut: address(999) },
    { amountIn: null }, { amountIn: undefined }, { amountIn: 0n }, { amountIn: -1n },
    { amountOut: null }, { amountOut: undefined }, { amountOut: 0n }, { amountOut: -1n },
    { amountIn: 1 }, { amountOut: "1" },
  ]) {
    const rows = new Map(effective.rows);
    rows.set(key, { ...row, ...change } as EffectiveMidRow);
    assert.throws(() => effectiveEnumerationMids({ ...pricing, effectiveMids: { ...effective, rows } }), /invalid effective enumeration row/);
  }
});

test("ETH marks and signal statistics remain available with no USDC edge", () => {
  const token = address(700), { edges, mids } = fixture(36, false, 1, token);
  const view = buildBlockScanEthView(edges, mids), stats = ethViewStatistics(view, 0);
  assert.equal(view.referenceEthPerRaw.has(usdc), false);
  assert.deepEqual(view.referenceEthPerRaw.get(weth), { num: 1n, den: 1n });
  assert(view.referenceEthPerRaw.has(token));
  assert.equal(stats.referenceEthTokens, 2);
  assert.equal(view.signals.length, 40);
  assert(view.quotes.every(quote => quote.value !== null));
});

test("ETH marks select and preserve exact amounts beyond Number precision", () => {
  const { edges, mids } = fixture(4);
  const amount = 2n ** 80n;
  const exact = new Map([...mids].map(([key, mid], index) => [key, { ...mid, mid: 1, feeBps: 9999,
    quoteAmountIn: amount, quoteAmountOut: amount + BigInt(index % 2 ? index : 0) }]));
  assert.equal(Number(amount + 3n), Number(amount));
  const view = buildBlockScanEthView(edges, exact);
  assert.deepEqual(view.referenceEthPerRaw.get(usdc), { num: amount + 3n, den: amount });
  assert(view.signals.length > 0, "integer-size profits are not rounded to a flat Number rate");
  for (const quote of view.quotes) {
    const mid = exact.get(quote.id)!;
    assert.equal(quote.num, mid.quoteAmountOut);
    assert.equal(quote.den, mid.quoteAmountIn);
  }
});

test("ETH hop value uses the best equal-hop reference without changing effective amounts", () => {
  const input = address(701), output = address(702), other = address(703);
  const edges: TokenEdge[] = [], mids = new Map<string, ResolvedBlockScanQuote>();
  const add = (tokenIn: string, tokenOut: string, amountOut: bigint) => {
    const edge: TokenEdge = { adapterId: "test", target: address(800 + edges.length),
      tokenIn, tokenOut, slotKind: "swap", ...deriveEdgeTaxonomy("swap") };
    edges.push(edge);
    mids.set(blockScanEdgeKey(edge), { kind: "test", pool: edge.target, edges: [edge],
      mid: Number(amountOut) / 1000, feeBps: 0, depthProxy: 1,
      quoteAmountIn: 1000n, quoteAmountOut: amountOut });
    return blockScanEdgeKey(edge);
  };
  add(usdc, weth, 1000n); add(input, weth, 1000n); add(other, weth, 1000n);
  add(output, input, 1100n); add(output, other, 1050n);
  const id = add(input, output, 900n);
  const view = buildBlockScanEthView(edges, mids);
  const quote = view.quotes.find(q => q.id === id)!;
  assert.equal(quote.num, 900n); assert.equal(quote.den, 1000n);
  assert(quote.value);
  assert.equal(quote.value.num * 100n, quote.value.den * 99n,
    "0.9 × 1.1 = 0.99; the weaker 1.05 reference must not manufacture a 5.5% loss");
});

test("large many-pool input returns only top 20 pairs per token", () => {
  const {edges, mids} = fixture(4000);
  const view = buildBlockScanEthView(edges, mids, 20);
  assert.equal(view.quotes.length, 4000); assert.equal(view.signals.length, 40);
});
