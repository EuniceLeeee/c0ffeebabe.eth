import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildBlockScanUsdView, effectiveUsdPricing, resolveUsdSignalPairsPerToken, usdViewStatistics } from "../blockscan-usd-view.js";
import type { BlockScanUsdView } from "../blockscan-usd-view.js";
import type { DirectedPriceSignal } from "../detector/blockscan-paired-dfs.js";
import type { ResolvedBlockScanMid } from "../detector/blockscan-scanner-core.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const weth = ADDR.WETH.toLowerCase(), usdc = ADDR.USDC.toLowerCase();
const cmp = (a: {num: bigint; den: bigint}, b: {num: bigint; den: bigint}) => {
  const d = a.num * b.den - b.num * a.den; return d < 0n ? -1 : d > 0n ? 1 : 0;
};
function fixture(count: number, samePool = false, seed = 1) {
  const edges: TokenEdge[] = [], mids = new Map<string, ResolvedBlockScanMid>();
  let random = seed;
  for (let i = 0; i < count; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const edge: TokenEdge = { adapterId: `test-${i}`, target: address(samePool ? 100 : 100 + (i % 7)),
      tokenIn: i % 2 ? usdc : weth, tokenOut: i % 2 ? weth : usdc,
      slotKind: "swap", ...deriveEdgeTaxonomy("swap") };
    const amountIn = 1_000n, amountOut = BigInt(980 + random % 90);
    edges.push(edge); mids.set(blockScanEdgeKey(edge), { kind: "test", pool: edge.target,
      edges: [edge], mid: Number(amountOut) / Number(amountIn), feeBps: 0,
      quoteAmountIn: amountIn, quoteAmountOut: amountOut, depthProxy: 1e20 });
  }
  return { edges, mids };
}

// Independent full Cartesian oracle used only on small fixtures. It ranks by
// reference prices (integer ratios) and rejects the same logical pool.
function oracle(view: BlockScanUsdView, limit: number, legacy = false) {
  const result: DirectedPriceSignal[] = [];
  for (const token of new Set(view.quotes.map(q => q.tokenOut))) {
    const buys = view.quotes.filter(q => q.tokenOut === token).map(q => {
      const mark = view.referenceUsdPerRaw.get(q.tokenIn)!;
      return { q, num: q.den * mark.num, den: q.num * mark.den };
    }).sort((a, b) => cmp(a, b) || a.q.id.localeCompare(b.q.id));
    const sells = view.quotes.filter(q => q.tokenIn === token).map(q => {
      const mark = view.referenceUsdPerRaw.get(q.tokenOut)!;
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
  assert.equal(resolveUsdSignalPairsPerToken(), 20);
  for (const raw of ["1", "20", "100"]) assert.equal(resolveUsdSignalPairsPerToken(raw), Number(raw));
  for (const raw of ["", "0", "-1", "1.2", "Infinity", "01", "9007199254740992"])
    assert.throws(() => resolveUsdSignalPairsPerToken(raw), /positive safe integer/);
});

test("top-K matches exhaustive ranking, K=1 matches old best pair, stable ties/order", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const {edges, mids} = fixture(36, false, seed);
    for (const allowRepeatedPools of [false, true]) for (const limit of [1, 2, 20, 1000]) {
      const view = buildBlockScanUsdView(edges, mids, limit, allowRepeatedPools);
      assert.deepEqual(identities(view.signals), identities(oracle(view, limit)));
      if (limit === 1 && !allowRepeatedPools) assert.deepEqual(identities(view.signals), identities(oracle(view, 1, true)));
      assert.deepEqual(identities(view.signals), identities(buildBlockScanUsdView([...edges].reverse(), mids, limit, allowRepeatedPools).signals));
      for (const token of new Set(view.signals.map(s => s.token)))
        assert(view.signals.filter(s => s.token === token).length <= limit);
      assert.equal(new Set(identities(view.signals)).size, view.signals.length);
    }
  }
});

test("counts tokens separately from signal pairs; no same-pool or zero-spread signal", () => {
  const {edges, mids} = fixture(36);
  const view = buildBlockScanUsdView(edges, mids, 20), stats = usdViewStatistics(view, 0);
  assert.equal(view.signals.length, 40); assert.equal(stats.tokensAboveThreshold, 2);
  assert.equal(stats.signalPairsAboveThreshold, 40); assert.equal(stats.signalPairsPerToken, 20);
  const single = fixture(36, true);
  const samePool = buildBlockScanUsdView(single.edges, single.mids, 20, false);
  assert.equal(samePool.signals.length, 0); assert.equal(samePool.comparableTokens, 0);
  const reused = buildBlockScanUsdView(single.edges, single.mids, 20);
  assert.equal(reused.allowRepeatedPools, true); assert.equal(reused.signals.length, 40);
  assert.deepEqual(identities(reused.signals), identities(oracle(reused, 20)));
  const flat = new Map([...mids].map(([k, m]) => [k, {...m, mid: 1, quoteAmountOut: m.quoteAmountIn}]));
  const noSpread = buildBlockScanUsdView(edges, flat, 20);
  assert.equal(noSpread.signals.length, 0); assert.equal(noSpread.comparableTokens, 2);
});

test("publication cache distinguishes cap, retains mids and supports switching back", () => {
  const {edges, mids} = fixture(36);
  const source = {number: 1, hash: `0x${"ab".repeat(32)}`, generation: 1};
  const pricing = {graph: {edges}, mids, sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
    effectiveMids: {source, complete: true, rows: new Map([...mids].map(([k, m]) => [k, {
    edgeId: k, status: "quoted", effectiveMid: m.mid, amountIn: m.quoteAmountIn, amountOut: m.quoteAmountOut,
  }]))}} as unknown as BlockScanStateSnapshot;
  const one = effectiveUsdPricing(pricing, 1);
  assert.equal(effectiveUsdPricing(pricing, 1), one);
  const twenty = effectiveUsdPricing(pricing, 20);
  assert.equal(twenty.mids, one.mids); assert(twenty.view.signals.length > one.view.signals.length);
  assert.equal(effectiveUsdPricing(pricing), twenty);
  assert.deepEqual(identities(effectiveUsdPricing(pricing, 1).view.signals), identities(one.view.signals));
  assert.throws(() => effectiveUsdPricing(pricing, 0), /positive safe integer/);
  const on = effectiveUsdPricing(pricing, 20, true);
  const off = effectiveUsdPricing(pricing, 20, false);
  assert.notEqual(on, off); assert.equal(on.mids, off.mids);
  assert.equal(off.view.allowRepeatedPools, false);
  assert.deepEqual(identities(off.view.signals), identities(buildBlockScanUsdView(edges, mids, 20, false).signals));
  assert.equal(effectiveUsdPricing(pricing, 20, false), off);
  assert.deepEqual(identities(effectiveUsdPricing(pricing, 20, true).view.signals), identities(on.view.signals));
});

test("USD hop value uses the best equal-hop reference without changing effective amounts", () => {
  const input = address(701), output = address(702), other = address(703);
  const edges: TokenEdge[] = [], mids = new Map<string, ResolvedBlockScanMid>();
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
  const view = buildBlockScanUsdView(edges, mids);
  const quote = view.quotes.find(q => q.id === id)!;
  assert.equal(quote.num, 900n); assert.equal(quote.den, 1000n);
  assert(quote.value);
  assert.equal(quote.value.num * 100n, quote.value.den * 99n,
    "0.9 × 1.1 = 0.99; the weaker 1.05 reference must not manufacture a 5.5% loss");
});

test("large many-pool input returns only top 20 pairs per token", () => {
  const {edges, mids} = fixture(4000);
  const view = buildBlockScanUsdView(edges, mids, 20);
  assert.equal(view.quotes.length, 4000); assert.equal(view.signals.length, 40);
});
