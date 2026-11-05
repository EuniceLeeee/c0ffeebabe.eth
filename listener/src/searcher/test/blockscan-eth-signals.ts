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

test("seed pruning retains exact values and ordered top-K, including ties and one dominant row", () => {
  for (const mode of ["varied", "ties", "dominant"] as const) {
    const { edges, mids } = fixture(160, false, 29);
    for (const [i, key] of [...mids.keys()].entries()) {
      const q = mids.get(key)!;
      if (mode === "ties") mids.set(key, { ...q, quoteAmountIn: 100n, quoteAmountOut: 101n });
      if (mode === "dominant" && i === 0) mids.set(key, { ...q, quoteAmountOut: q.quoteAmountOut * 1000n });
    }
    for (const limit of [1, 2, 7, 50, 200]) for (const allowRepeatedPools of [true, false]) {
      const view = buildBlockScanEthView(edges, mids, limit, allowRepeatedPools);
      const expected = oracle(view, limit).map(s => ({ token: s.token, buy: s.buy, sell: s.sell, num: s.num, den: s.den }))
        .sort((a, b) => cmp(b, a) || a.token.localeCompare(b.token));
      assert.deepEqual(view.signals, expected, `${mode}/${limit}/${allowRepeatedPools}`);
    }
  }
});

test("pool exclusions must not prune rows by the unconstrained buy ordering", () => {
  const token = address(700);
  const specs = [
    ["x", weth, token, 1n, 1n], ["y", weth, token, 2n, 1n], ["z", weth, token, 3n, 1n],
    ["x", token, weth, 1n, 100n], ["w", token, weth, 1n, 2n],
  ] as const;
  const edges: TokenEdge[] = specs.map(([instanceKey, tokenIn, tokenOut], i) => ({
    instanceKey, executionVariantKey: `seed-${i}`, adapterId: `test-${i}`, target: address(900),
    tokenIn, tokenOut, slotKind: "swap", ...deriveEdgeTaxonomy("swap"),
  }));
  const mids = new Map<string, ResolvedBlockScanQuote>(edges.map((edge, i) => [blockScanEdgeKey(edge), {
    kind: "test", pool: edge.target, edges: [edge], mid: Number(specs[i]![4]) / Number(specs[i]![3]),
    feeBps: 0, quoteAmountIn: specs[i]![3], quoteAmountOut: specs[i]![4], depthProxy: 1e20,
  }]));
  const view = buildBlockScanEthView(edges, mids, 2, false);
  const pairs = view.signals.filter(s => s.token === token);
  assert.deepEqual(pairs.map(s => s.buy), [blockScanEdgeKey(edges[1]!), blockScanEdgeKey(edges[2]!)]);
  assert.deepEqual(pairs.map(s => [s.num, s.den]), [[100n, 2n], [100n, 3n]]);
  assert.deepEqual(identities(view.signals), identities(oracle(view, 2)));
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

test("cross-publication view equals a fresh build through updates, removal, reorg and configuration changes", () => {
  const inputs = fixture(64);
  // Include multi-hop references: an unchanged quote can acquire a new value
  // because a DIFFERENT pair changed its best path to WETH.
  const branch = fixture(20, false, 37, address(701));
  inputs.edges.push(...branch.edges.map((edge, i) => ({ ...edge,
    adapterId: `branch-${i}`, tokenIn: edge.tokenIn === weth ? usdc : edge.tokenIn,
    tokenOut: edge.tokenOut === weth ? usdc : edge.tokenOut })));
  for (let i = 0; i < branch.edges.length; i++) {
    const edge = inputs.edges[64 + i]!, mid = [...branch.mids.values()][i]!;
    inputs.mids.set(blockScanEdgeKey(edge), { ...mid, edges: [edge] });
  }
  const base = publication(inputs);
  let rows = new Map(base.effectiveMids!.rows), random = 7;
  const keys = [...rows.keys()];
  for (let round = 0; round < 80; round++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const key = keys[random % keys.length]!, original = base.effectiveMids!.rows.get(key)!;
    rows = new Map(rows);
    if (round % 11 === 0) rows.delete(key);
    else if (round % 7 === 0) rows.set(key, { ...original, status: "quote-failed", amountOut: null, effectiveMid: null });
    else rows.set(key, { ...original, amountOut: original.amountOut! + BigInt(random % 100) });
    const source = { number: 1 + round % 9, generation: round + 2, hash: `0x${String(round).padStart(64, "0")}` };
    const current = { ...base, graph: { ...base.graph, edges: inputs.edges.map(edge => ({ ...edge })) },
      sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
      effectiveMids: { ...base.effectiveMids!, source, rows } };
    for (const [cap, repeats] of [[20, true], [1, false], [20, true]] as const) {
      const actual = effectiveEthPricing(current, cap, repeats);
      assert.deepEqual(actual.view, buildBlockScanEthView(inputs.edges, effectiveEnumerationMids(current), cap, repeats));
    }
  }
  // The same array may be mutable in a diagnostic; removals/reorders are not
  // inferred from its identity, and a retained old result is not overwritten.
  const old = effectiveEthPricing(base), saved = structuredClone(old.view);
  inputs.edges.reverse();
  inputs.edges.pop();
  const changed = { ...base, effectiveMids: { ...base.effectiveMids!, rows: new Map(
    inputs.edges.map(edge => [blockScanEdgeKey(edge), base.effectiveMids!.rows.get(blockScanEdgeKey(edge))!]),
  ) } };
  assert.deepEqual(effectiveEthPricing(changed).view, buildBlockScanEthView(inputs.edges, effectiveEnumerationMids(changed)));
  assert.deepEqual(old.view, saved);
});

test("unchanged offers are reused but changed upstream marks invalidate dependent offers", () => {
  const inputs = fixture(8), base = publication(inputs);
  const first = effectiveEthPricing(base);
  const next = { ...base, effectiveMids: { ...base.effectiveMids!, rows: new Map(base.effectiveMids!.rows) } };
  const second = effectiveEthPricing(next);
  assert(second.view.quotes.every((quote, i) => quote === first.view.quotes[i]));
  assert(second.view.signals.every((signal, i) => signal === first.view.signals[i]));
  assert([...second.mids].every(([key, mid]) => mid === first.mids.get(key)));
  const [key, old] = [...next.effectiveMids.rows][1]!; // USDC -> WETH
  next.effectiveMids.rows.set(key, { ...old, amountOut: old.amountOut! * 100n });
  const changed = effectiveEthPricing({ ...next });
  assert.deepEqual(changed.view, buildBlockScanEthView(inputs.edges, effectiveEnumerationMids(next)));
  assert.notDeepEqual(changed.view.referenceEthPerRaw, first.view.referenceEthPerRaw);
  assert.notEqual(changed.view.quotes[0], first.view.quotes[0], "clean WETH -> USDC edge has a changed reference value");
});

test("copied production topology reuses unchanged offers without retaining removed prices or old authority", () => {
  const inputs = fixture(40), base = publication(inputs);
  const first = effectiveEthPricing(base, 7, false), saved = structuredClone(first.view);
  const source = { number: 2, hash: `0x${"cd".repeat(32)}`, generation: 2 };
  const edges = inputs.edges.map(edge => ({ ...edge }));
  const next = { ...base, graph: { ...base.graph, edges }, sourceBlock: source.number,
    sourceBlockHash: source.hash, generation: source.generation,
    effectiveMids: { ...base.effectiveMids!, source, rows: new Map(base.effectiveMids!.rows) } };
  const second = effectiveEthPricing(next, 7, false);
  assert.notEqual(second, first);
  assert(second.view.quotes.every((quote, i) => quote === first.view.quotes[i]));
  assert(second.view.signals.length > 0);
  assert(second.view.signals.every((signal, i) => signal === first.view.signals[i]));
  assert.deepEqual(second.view, buildBlockScanEthView(edges, effectiveEnumerationMids(next), 7, false));
  const removed = blockScanEdgeKey(edges[0]!);
  const rows = new Map(next.effectiveMids.rows);
  rows.set(removed, { ...rows.get(removed)!, status: "quote-failed", amountOut: null, effectiveMid: null });
  const reduced = { ...next, graph: { ...next.graph, edges: [...edges].reverse() },
    effectiveMids: { ...next.effectiveMids, rows } };
  const third = effectiveEthPricing(reduced, 7, false);
  assert(!third.view.quotes.some(quote => quote.id === removed));
  assert(!third.view.signals.some(signal => signal.buy === removed || signal.sell === removed));
  assert.deepEqual(third.view, buildBlockScanEthView(reduced.graph.edges, effectiveEnumerationMids(reduced), 7, false));
  effectiveEthPricing(publication(fixture(16, false, 3, address(970))), 7, false);
  assert.deepEqual(effectiveEthPricing({ ...next }, 7, false).view, second.view,
    "an unrelated topology can replace the private work slot without contaminating either result");
  assert.throws(() => effectiveEthPricing({ ...next, sourceBlock: 3 }, 7, false), /mismatched source/);
  assert.deepEqual(first.view, saved);
});

test("projection reuse still validates source, changed amounts, mutable rows and edge identity", () => {
  const base = publication(fixture(4)), first = effectiveEnumerationMids(base);
  const [key, row] = [...base.effectiveMids!.rows][0]!;
  Object.assign(row, { amountOut: row.amountOut! + 1n });
  assert.notEqual(effectiveEnumerationMids(base).get(key), first.get(key));
  assert.equal(effectiveEnumerationMids(base).get(key)!.quoteAmountOut, row.amountOut);
  Object.assign(row, { instanceKey: "wrong" });
  assert.throws(() => effectiveEnumerationMids(base), /invalid effective enumeration row/);
  assert.throws(() => effectiveEnumerationMids({ ...base, sourceBlock: 2 }), /mismatched source/);
});
