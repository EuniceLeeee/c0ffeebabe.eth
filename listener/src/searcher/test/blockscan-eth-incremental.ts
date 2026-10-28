import assert from "node:assert/strict";
import { test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { ADDR } from "../../shared/constants/addresses.js";
import { DirectedRateReferenceIndex, tokenToWethReferencesFromRates, type RawTokenRate } from "../blockscan-amount-reference.js";
import { buildBlockScanEthView, effectiveEthPricing, organizeEffectiveTable, organizeEffectivePricing,
  ethViewStatistics, publishedEffectiveIncrementalStatistics, resolveEthReferenceTouchedMode } from "../blockscan-eth-view.js";
import { buildEffectiveMids, effectiveAmountReferences, effectiveRowAmountReference,
  exportEffectiveMidReplayState, restoreEffectiveMidReplayState,
  effectiveEnumerationMids, visitEffectiveEnumerationQuotes, type EffectiveEnumerationPricing, type EffectiveMidRow } from "../blockscan-effective-mid.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { blockScanEdgeKey, canonicalEdgeId } from "../venues/blockscan-state-capability.js";
import { StrictReadyGraphViewCoordinator } from "../strict-ready-graph-view.js";
import type { ReadyUniverseGeneration } from "../universe-rebuild-checkpoint.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";
import { scanBlockStateFromResolvedMids } from "../detector/blockscan-scanner-core.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const weth = ADDR.WETH.toLowerCase(), a = address(1), b = address(2), c = address(3);
function edge(from: string, to: string, n: number, instance = n): TokenEdge {
  return Object.freeze({ tokenIn: from, tokenOut: to, adapterId: `test-${n}`, target: address(100 + instance),
    instanceKey: `instance-${instance}`, executionVariantKey: `variant-${n}`,
    slotKind: "swap", ...deriveEdgeTaxonomy("swap") });
}
const chain = () => [edge(a, weth, 1), edge(b, a, 2), edge(c, b, 3), edge(weth, c, 4), edge(a, weth, 5)];
function pricing(edges: readonly TokenEdge[], rates: ReadonlyMap<string, RawTokenRate>, n: number): EffectiveEnumerationPricing {
  const source = { number: n, generation: n, hash: address(n) };
  const rows = new Map<string, EffectiveMidRow>();
  for (const edge of edges) {
    const id = blockScanEdgeKey(edge), rate = rates.get(id);
    rows.set(id, Object.freeze({ edgeId: id, instanceKey: edgeInstanceKey(edge), tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut, status: rate ? "quoted" : "disabled-for-run", amountIn: rate?.den ?? null,
      amountOut: rate?.num ?? null, effectiveMid: rate ? Number(rate.num) / Number(rate.den) : null }));
  }
  return { graph: { edges: Object.freeze([...edges]) }, sourceBlock: n, sourceBlockHash: source.hash, generation: n,
    effectiveMids: { source, rows, complete: true, reference: "default", referenceWethInput: 1n, wallMs: 0 } };
}
function marksEqual(actual: ReadonlyMap<string, RawTokenRate>, expected: ReadonlyMap<string, RawTokenRate>) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

test("ETH touched mode parser preserves default and rejects misspellings", () => {
  assert.equal(resolveEthReferenceTouchedMode(), "dependencies");
  for (const mode of ["direct", "dependencies"] as const) assert.equal(resolveEthReferenceTouchedMode(mode), mode);
  for (const raw of ["", "0", "DIRECT", "dependency"]) assert.throws(() => resolveEthReferenceTouchedMode(raw));
});

test("one effective table owns ETH columns; enumeration indexes reference the published rows", () => {
  const edges = chain(), rates = new Map(edges.map(e => [blockScanEdgeKey(e), { num: 2n, den: 1n }]));
  const input = pricing(edges, rates, 10), original = structuredClone(input.effectiveMids);
  const published = organizeEffectivePricing(input, 7, false);
  const organized = { effective: published.effectiveMids!, view: effectiveEthPricing(published, 7, false).view };
  const read = effectiveEthPricing(published, 7, false, "dependencies");
  assert.equal(read.view, organized.view, "publication/scanner reuse the same indexes");
  for (const quote of read.view.quotes)
    assert.equal(quote, published.effectiveMids!.rows.get(quote.id)?.eth?.quote);
  for (const [id, quote] of read.mids) assert.equal(quote, published.effectiveMids!.rows.get(id)?.enumeration);
  assert.deepEqual(structuredClone(published.effectiveMids), original,
    "history worker transfer keeps native prices and does not duplicate derived indexes");
  assert.deepEqual(input.effectiveMids, original, "organizing cannot mutate an older snapshot");
  const priorRows = [...organized.effective.rows];
  rates.set(blockScanEdgeKey(edges[0]!), { num: 3n, den: 1n });
  const nextInput = pricing(edges, rates, 11);
  const next = organizeEffectiveTable(nextInput, 7, false, "dependencies");
  assert.deepEqual([...organized.effective.rows], priorRows);
  assert.deepEqual(next.view, buildBlockScanEthView(edges, effectiveEnumerationMids(nextInput), 7, false));
  const failed = pricing(edges, rates, 12), failedRows = new Map(next.effective.rows);
  const id = blockScanEdgeKey(edges[0]!);
  failedRows.set(id, Object.freeze({ ...failedRows.get(id)!, status: "disabled-for-run", amountIn: null,
    amountOut: null, effectiveMid: null }));
  const filtered = organizeEffectiveTable({ ...failed, effectiveMids: { ...failed.effectiveMids!, rows: failedRows } },
    7, false, "dependencies");
  assert.equal(filtered.effective.rows.get(id)?.eth, undefined);
  assert.equal(filtered.effective.rows.get(id)?.enumeration, undefined);
  assert(!filtered.view.quotes.some(q => q.id === id));
});

test("a new pricing wrapper cannot reuse validation after mutable graph identity changes", () => {
  const mutable = { ...edge(a, weth, 84) };
  const edges = [mutable], rates = new Map([[blockScanEdgeKey(mutable), { num: 2n, den: 1n }]]);
  const input = pricing(edges, rates, 20);
  const published = organizeEffectivePricing(input, 7, false);
  mutable.tokenIn = b;
  assert.throws(() => effectiveEnumerationMids({ ...published }), /invalid effective enumeration row/);
  assert.throws(() => effectiveEthPricing({ ...published }, 7, false), /invalid effective enumeration row/);
});

test("incremental references equal independent full policy across additions/removals/ties/variants", () => {
  const tokens = [weth, a, b, c, address(4), address(5)];
  const edges: TokenEdge[] = [];
  for (let i = 0; i < tokens.length; i++) for (let j = 0; j < tokens.length; j++) if (i !== j)
    for (let v = 0; v < 3; v++) edges.push(edge(tokens[i]!, tokens[j]!, edges.length + 10, i * 20 + j * 3 + (v % 2)));
  const rates = new Map<string, RawTokenRate>();
  const index = new DirectedRateReferenceIndex(edges, key => rates.get(key), weth);
  let seed = 873;
  const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let step = 0; step < 150; step++) {
    const changes = new Map<string, RawTokenRate | undefined>();
    for (let n = 0; n < 5; n++) {
      const key = blockScanEdgeKey(edges[random() % edges.length]!);
      const rate = random() % 7 ? { num: BigInt(1 + random() % 4), den: BigInt(1 + random() % 4) } : undefined;
      if (rate) rates.set(key, rate); else rates.delete(key);
      changes.set(key, rate);
    }
    const before = [...index.marks];
    const oldView = index.marks;
    index.update(changes, "dependencies");
    assert.deepEqual([...oldView], before, "published marks remain unchanged");
    marksEqual(index.marks, tokenToWethReferencesFromRates(edges, key => rates.get(key), weth));
  }
});

test("direct retains indirect marks; dependencies propagates; removal forces both modes", () => {
  for (const mode of ["direct", "dependencies"] as const) {
    const edges = chain(), rates = new Map(edges.map(e => [blockScanEdgeKey(e), { num: 1n, den: 1n }]));
    const index = new DirectedRateReferenceIndex(edges, key => rates.get(key), weth);
    const key = blockScanEdgeKey(edges[0]!);
    rates.set(key, { num: 2n, den: 1n });
    index.update(new Map([[key, rates.get(key)]]), mode);
    assert.deepEqual(index.marks.get(a), { num: 2n, den: 1n });
    assert.deepEqual(index.marks.get(b), { num: mode === "direct" ? 1n : 2n, den: 1n });
    index.update(new Map([[key, undefined]]), mode);
    assert.deepEqual(index.marks.get(c), { num: 1n, den: 1n }, "alternate path used after best edge removal");
    index.update(new Map([[blockScanEdgeKey(edges[4]!), undefined]]), mode);
    assert.equal(index.marks.has(a), false); assert.equal(index.marks.has(b), false); assert.equal(index.marks.has(c), false);
  }
});

test("production view updates dirty groups across copied arrays and preserves old outputs", () => {
  const edges = chain(), rates = new Map(edges.map(e => [blockScanEdgeKey(e), { num: 1n, den: 1n }]));
  let prior = effectiveEthPricing(pricing(edges, rates, 100), 7, false, "dependencies");
  for (let i = 1; i <= 12; i++) {
    const old = structuredClone(prior.view), key = blockScanEdgeKey(edges[i % edges.length]!);
    if (i % 4 === 0) rates.delete(key); else rates.set(key, { num: BigInt(i + 2), den: 3n });
    const current = pricing(edges, rates, 100 + i);
    const next = effectiveEthPricing(current, 7, false, "dependencies");
    assert.deepEqual(next.view, buildBlockScanEthView(edges, effectiveEnumerationMids(current), 7, false));
    assert.deepEqual(prior.view, old);
    assert.equal(ethViewStatistics(next.view, 0).incremental?.fullBuild, false);
    prior = next;
  }
  const unchanged = effectiveEthPricing(pricing(edges, rates, 113), 7, false, "dependencies");
  assert.equal(ethViewStatistics(unchanged.view, 0).incremental?.updatedQuotes, 0);
  assert.equal(ethViewStatistics(unchanged.view, 0).incremental?.rankedTokens, 0);
});

test("mode, topology, backwards source and reorg switches rebuild, never reuse mixed marks", () => {
  const edges = chain(), rates = new Map(edges.map(e => [blockScanEdgeKey(e), { num: 1n, den: 1n }]));
  effectiveEthPricing(pricing(edges, rates, 200), 7, false, "direct");
  rates.set(blockScanEdgeKey(edges[0]!), { num: 2n, den: 1n });
  const p = pricing(edges, rates, 201), direct = effectiveEthPricing(p, 7, false, "direct");
  assert.deepEqual(direct.view.referenceEthPerRaw.get(b), { num: 1n, den: 1n });
  const propagated = effectiveEthPricing(p, 7, false, "dependencies");
  assert.deepEqual(propagated.view.referenceEthPerRaw.get(b), { num: 2n, den: 1n });
  assert.equal(ethViewStatistics(propagated.view, 0).incremental?.fullBuild, true);
  for (const changed of [pricing(edges.slice(1), rates, 202), pricing(edges, rates, 199), pricing(edges, rates, 199)]) {
    if (changed.sourceBlock === 199) {
      const hash = address(999);
      const reorg = { ...changed, sourceBlockHash: hash, effectiveMids: { ...changed.effectiveMids!, source: { ...changed.effectiveMids!.source, hash } } };
      const view = effectiveEthPricing(reorg, 7, false, "dependencies").view;
      assert.deepEqual(view, buildBlockScanEthView(changed.graph.edges, effectiveEnumerationMids(reorg), 7, false));
    } else assert.equal(ethViewStatistics(effectiveEthPricing(changed, 7, false, "dependencies").view, 0).incremental?.fullBuild, true);
  }
});

test("scanner reuses already-filtered view; new priced exclusion rebuilds and keeps policy", () => {
  const edges = chain(), rates = new Map(edges.map(e => [blockScanEdgeKey(e), { num: 2n, den: 1n }]));
  effectiveEthPricing(pricing(edges, rates, 300), 7, false, "direct");
  rates.delete(blockScanEdgeKey(edges[0]!));
  const p = pricing(edges, rates, 301), current = effectiveEthPricing(p, 7, false, "direct");
  const input = { edges, mids: current.mids, ethView: current.view, sourceBlock: 301, swapTouched: null,
    cfg: { maxHops: 6, maxCandidates: 10, minSpreadBps: 0, budgetMs: 1000, ethSignalPairsPerToken: 7,
      allowRepeatedPools: false, pricedTokens: new Map([[weth, { maxBorrow: 100n }]]) } };
  const reused = scanBlockStateFromResolvedMids({ ...input, poolRevertExcludedEdge: edge => edge === edges[0] });
  assert.equal(reused.enumeration?.incremental?.fullBuild, false);
  assert.equal(reused.enumeration?.incremental?.touchedMode, "direct");
  const narrowed = scanBlockStateFromResolvedMids({ ...input,
    poolRevertExcludedEdge: edge => edge === edges[0] || edge === edges[4] });
  assert.equal(narrowed.enumeration?.incremental?.fullBuild, true);
  assert.equal(narrowed.enumeration?.incremental?.touchedMode, "direct");
  assert.equal(narrowed.enumeration?.quotedDirections, 3);
  assert.equal(narrowed.enumeration?.referenceEthTokens, 1);
  assert.equal(narrowed.opportunities.length, 0);
});

test("old-source reads cannot replace direct mode's current working history", () => {
  const edges = chain(), rates = new Map(edges.map(e => [blockScanEdgeKey(e), { num: 1n, den: 1n }]));
  effectiveEthPricing(pricing(edges, rates, 400), 7, false, "direct");
  rates.set(blockScanEdgeKey(edges[0]!), { num: 2n, den: 1n });
  const current = effectiveEthPricing(pricing(edges, rates, 401), 7, false, "direct");
  assert.deepEqual(current.view.referenceEthPerRaw.get(b), { num: 1n, den: 1n });
  const historic = new Map(rates);
  historic.set(blockScanEdgeKey(edges[0]!), { num: 3n, den: 1n });
  assert.deepEqual(effectiveEthPricing(pricing(edges, historic, 350), 7, false, "direct").view.referenceEthPerRaw.get(b),
    { num: 3n, den: 1n });
  const next = effectiveEthPricing(pricing(edges, rates, 402), 7, false, "direct");
  assert.deepEqual(next.view.referenceEthPerRaw.get(b), { num: 1n, den: 1n });
  assert.equal(ethViewStatistics(next.view, 0).incremental?.updatedQuotes, 0);
});

test("fused publication shares validated quotes and rejects a bad late row atomically", () => {
  const edges = chain(), rates = new Map(edges.map(e => [blockScanEdgeKey(e), { num: 1n, den: 1n }]));
  const first = pricing(edges, rates, 500);
  const validated = new Map();
  visitEffectiveEnumerationQuotes(first, (id, quote) => validated.set(id, quote));
  const firstPublication = effectiveEthPricing(first, 7, false, "direct");
  assert.deepEqual(firstPublication.mids, validated);
  for (const [id, quote] of firstPublication.mids) assert.equal(quote, validated.get(id), "projection shares original amounts");
  const oldOutput = structuredClone(firstPublication);
  rates.set(blockScanEdgeKey(edges[0]!), { num: 2n, den: 1n });
  const broken = pricing(edges, rates, 501), badRows = new Map(broken.effectiveMids!.rows);
  const last = blockScanEdgeKey(edges.at(-1)!);
  badRows.set(last, { ...badRows.get(last)!, instanceKey: "wrong-instance" });
  assert.throws(() => effectiveEthPricing({ ...broken, effectiveMids: { ...broken.effectiveMids!, rows: badRows } },
    7, false, "direct"), /invalid effective enumeration row/);
  assert.deepEqual(firstPublication, oldOutput, "rejected publication cannot mutate old outputs");
  const next = effectiveEthPricing(pricing(edges, rates, 502), 7, false, "direct");
  assert.deepEqual(next.view.referenceEthPerRaw.get(b), { num: 1n, den: 1n }, "failed draft cannot advance direct-mode history");
  const removed = pricing(edges, rates, 503), fewer = new Map(removed.effectiveMids!.rows);
  fewer.delete(blockScanEdgeKey(edges[0]!)); fewer.delete(last);
  const afterRemoval = effectiveEthPricing({ ...removed, effectiveMids: { ...removed.effectiveMids!, rows: fewer } }, 7, false, "direct");
  assert(!afterRemoval.view.referenceEthPerRaw.has(a));
  assert(!afterRemoval.view.referenceEthPerRaw.has(b));
  assert(!afterRemoval.mids.has(last));
});

test("merged ETH columns retain forward-input lineage and next-block quote reuse", async () => {
  const edges = [edge(weth, a, 91), edge(a, b, 92), edge(b, weth, 93)];
  const input = pricing(edges, new Map(edges.map(e => [blockScanEdgeKey(e), { num: 2n, den: 1n }])), 600);
  const source = input.effectiveMids!.source;
  const prices = { ...input, mids: new Map(), coverage: { resolvedEdgeKeys: edges.map(blockScanEdgeKey) },
    pricingStateKeyByEdgeKey: new Map(edges.map(e => [blockScanEdgeKey(e), edgeInstanceKey(e)])) };
  const common = { weth, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 2 };
  const raw = await buildEffectiveMids({ ...common, pricing: prices,
    quote: async ({ amountIn }) => ({ source, amountIn, amountOut: amountIn * 2n }) });
  const organized = organizeEffectiveTable({ ...input, effectiveMids: raw }, 7, false, "dependencies");
  assert.equal(effectiveAmountReferences(organized.effective), effectiveAmountReferences(raw));
  for (const [id, old] of raw.rows) {
    const next = organized.effective.rows.get(id)!;
    assert.equal(next.amountIn, old.amountIn); assert.equal(next.amountOut, old.amountOut);
    assert.equal(next.quotedAt, old.quotedAt);
    assert.equal(effectiveRowAmountReference(next), effectiveRowAmountReference(old));
    assert(next.eth);
  }
  let calls = 0;
  const next = await buildEffectiveMids({ ...common, pricing: { ...prices,
    sourceBlock: 601, generation: 601, sourceBlockHash: address(601) },
    previous: organized.effective, touchedStateKeys: new Set(),
    quote: async () => { calls++; throw new Error("clean rows must carry"); } });
  assert.equal(calls, 0);
  for (const [id, old] of organized.effective.rows) assert.equal(next.rows.get(id), old);
});

test("native effective deltas co-update ETH without rescanning unchanged rows; exact order and old outputs survive", async () => {
  const rawEdges = [edge(weth, a, 201), edge(a, b, 202), edge(b, weth, 203),
    edge(weth, b, 204), edge(b, a, 205), edge(a, weth, 206)];
  let edges = Object.freeze(rawEdges.map(e => Object.freeze({ ...e, canonicalEdgeId: blockScanEdgeKey(e) })));
  const keys = edges.map(blockScanEdgeKey);
  for (const mode of ["dependencies", "direct"] as const) {
    let previous: ReturnType<typeof organizeEffectivePricing> | undefined;
    let previousResult: ReturnType<typeof effectiveEthPricing> | undefined;
    const ratios = new Map(keys.map(key => [key, 2n]));
    for (let step = 0; step < 29; step++) {
      if (step === 10) edges = Object.freeze([...edges]);
      const n = (mode === "dependencies" ? 1000 : 2000) + step;
      const input = { ...pricing(edges, new Map(), n), graph: { edges }, mids: new Map(),
        coverage: { resolvedEdgeKeys: keys },
        pricingStateKeyByEdgeKey: new Map(edges.map(e => [blockScanEdgeKey(e), edgeInstanceKey(e)])) };
      const chosen = step % keys.length;
      if (step % 3 === 0) ratios.set(keys[chosen]!, BigInt(2 + step % 5));
      const disabled = step % 7 === 1 ? new Set([keys[1]!]) : new Set<string>();
      const touched = new Set([edgeInstanceKey(edges[chosen]!), edgeInstanceKey(edges[1]!)]);
      const oldOutput = previousResult && structuredClone(previousResult);
      const raw = await buildEffectiveMids({ pricing: input, weth, gasCostWei: null, enumerationSpreadBps: 0,
        previous: previous?.effectiveMids, touchedStateKeys: touched, disabledEdgeIds: disabled,
        control: {}, concurrency: 2,
        quote: async ({ edge: e, amountIn }) => ({ source: input.effectiveMids!.source, amountIn,
          amountOut: amountIn * ratios.get(blockScanEdgeKey(e))! }) });
      const current = organizeEffectivePricing({ ...input, effectiveMids: raw }, 7, false, mode);
      const actual = effectiveEthPricing(current, 7, false, mode);
      const stats = ethViewStatistics(actual.view, 0).incremental!;
      assert.equal(stats.nativeDelta, step > 0 && step !== 10,
        "a copied immutable graph gets one full check, then native deltas resume");
      if (stats.nativeDelta) assert(stats.projectionRowsVisited < edges.length, "only native changes are validated");
      const fullMids = effectiveEnumerationMids(current);
      assert.deepEqual([...actual.mids], [...fullMids], "raw Map iteration order, including recovered keys");
      if (mode === "dependencies") assert.deepEqual(actual.view, buildBlockScanEthView(edges, fullMids, 7, false));
      for (const quote of actual.view.quotes) assert.equal(quote, current.effectiveMids!.rows.get(quote.id)?.eth?.quote);
      for (const [key, quote] of actual.mids) assert.equal(quote, current.effectiveMids!.rows.get(key)?.enumeration);
      if (previousResult) assert.deepEqual(previousResult, oldOutput, "previous publication unchanged");
      if (disabled.has(keys[1]!)) {
        assert(!actual.mids.has(keys[1]!)); assert(!actual.view.quotes.some(q => q.id === keys[1]));
      }
      previous = current; previousResult = actual;
    }
    const last = previous!;
    const nextSource = { number: last.sourceBlock + 1, generation: last.generation + 1, hash: address(last.sourceBlock + 1) };
    const input = { ...last, sourceBlock: nextSource.number, sourceBlockHash: nextSource.hash, generation: nextSource.generation,
      mids: new Map(), coverage: { resolvedEdgeKeys: keys } };
    const raw = await buildEffectiveMids({ pricing: input, weth, gasCostWei: null, enumerationSpreadBps: 0,
      previous: last.effectiveMids, touchedStateKeys: new Set(), control: {}, concurrency: 2,
      quote: async () => { throw new Error("no clean quote should run"); } });
    const current = organizeEffectivePricing({ ...input, effectiveMids: raw }, 7, false, mode);
    const actual = effectiveEthPricing(current, 7, false, mode);
    const stats = ethViewStatistics(actual.view, 0).incremental!;
    assert.equal(stats.nativeDelta, true); assert.equal(stats.projectionRowsVisited, 0);
    assert.equal(stats.derivedRowsVisited, 0); assert.equal(stats.rankedTokens, 0);
    assert.equal(actual.mids, previousResult!.mids); assert.equal(actual.view.quotes, previousResult!.view.quotes);
    assert.equal(actual.view.signals, previousResult!.view.signals);
    assert.equal(current.effectiveMids!.source, raw.source);
    for (const [key, row] of last.effectiveMids!.rows) assert.equal(current.effectiveMids!.rows.get(key), row);
    const map = current.effectiveMids!.rows as Map<string, EffectiveMidRow>;
    assert.throws(() => map.clear(), /readonly/); assert.throws(() => map.delete(keys[0]!), /readonly/);
    assert.throws(() => map.set(keys[0]!, map.get(keys[0]!)!), /readonly/);
    assert.deepEqual(structuredClone(map), new Map(map), "history remains a native cloneable Map");
  }
});

test("production Ready graph and effective builder share deltas; unpublished drafts and foreign inputs cannot borrow them", async () => {
  const family = "fixture-family";
  const readyEdges = Object.freeze([edge(weth, a, 301), edge(a, weth, 302)].map(e =>
    Object.freeze({ ...e, canonicalEdgeId: canonicalEdgeId(family, e) })));
  const ready = { generation: 9, graphHash: "graph", catalogHash: "catalog",
    sourceCoverage: [{ familyId: family, sourceId: "fixture" }] } as ReadyUniverseGeneration;
  const graphs = new StrictReadyGraphViewCoordinator({ ready, edges: readyEdges,
    catalog: { ownerOfAction: () => family } as never });
  const makeInput = (n: number) => {
    const hash = `0x${n.toString(16).padStart(64, "0")}`;
    const graph = graphs.build({ id: `block-${n}`, topologyKey: "strict-ready:9:graph",
      generation: n, sourceBlock: n, sourceBlockHash: hash, edges: Object.freeze([...readyEdges]) });
    return { sourceBlock: n, sourceBlockHash: hash, generation: n, graph, mids: new Map(),
      coverage: { resolvedEdgeKeys: graph.edges.map(blockScanEdgeKey) } };
  };
  const build = async (input: ReturnType<typeof makeInput>, previous?: EffectiveEnumerationPricing["effectiveMids"],
    touchedStateKeys = new Set<string>()) => buildEffectiveMids({ pricing: input, previous, touchedStateKeys,
    weth, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 2, control: {},
    quote: async ({ amountIn }) => ({ source: { number: input.sourceBlock, hash: input.sourceBlockHash,
      generation: input.generation }, amountIn, amountOut: amountIn * 2n }) });
  const firstInput = makeInput(5000);
  const first = organizeEffectivePricing({ ...firstInput, effectiveMids: await build(firstInput) }, 7, false);
  const saved = structuredClone(first.effectiveMids);
  const nextInput = makeInput(5001);
  assert.equal(nextInput.graph.edges, firstInput.graph.edges, "real Ready coordinator reuses immutable topology");
  // Building, then discarding a draft cannot advance the consumer's last publication.
  await build(nextInput, first.effectiveMids, new Set(readyEdges.map(edgeInstanceKey)));
  const raw = await build(nextInput, first.effectiveMids);
  assert.throws(() => organizeEffectivePricing({ ...nextInput, sourceBlock: 5002, effectiveMids: raw }, 7, false),
    /mismatched source/);
  const second = organizeEffectivePricing({ ...nextInput, effectiveMids: raw }, 7, false);
  const secondRead = effectiveEthPricing(second, 7, false);
  assert.equal(ethViewStatistics(secondRead.view, 0).incremental!.nativeDelta, true);
  assert.equal(ethViewStatistics(secondRead.view, 0).incremental!.projectionRowsVisited, 0);
  assert.deepEqual(structuredClone(first.effectiveMids), saved);
  const thirdInput = makeInput(5002), thirdRaw = await build(thirdInput, second.effectiveMids);
  const foreign = { ...thirdInput, effectiveMids: { ...thirdRaw } };
  const foreignResult = effectiveEthPricing(foreign, 7, false);
  assert.equal(ethViewStatistics(foreignResult.view, 0).incremental!.nativeDelta, false,
    "copying a snapshot cannot copy its private producer receipt");
  assert.deepEqual(foreignResult.view, buildBlockScanEthView(thirdInput.graph.edges, foreignResult.mids, 7, false));
  const reversed = { ...makeInput(5003), graph: { ...thirdInput.graph,
    edges: Object.freeze([...thirdInput.graph.edges].reverse()) } };
  const changed = organizeEffectivePricing({ ...reversed, effectiveMids: await build(reversed, thirdRaw) }, 7, false);
  const result = effectiveEthPricing(changed, 7, false);
  assert.equal(ethViewStatistics(result.view, 0).incremental!.nativeDelta, false);
  assert.deepEqual(result.view, buildBlockScanEthView(reversed.graph.edges, result.mids, 7, false));
});

test("serialized mixed-status baseline restores immutable carry and native deltas without repricing", async () => {
  const edges = Object.freeze([edge(weth, a, 401), edge(a, weth, 402), edge(c, b, 403),
    edge(weth, b, 404), edge(weth, c, 405)].map(e => Object.freeze({ ...e, canonicalEdgeId: blockScanEdgeKey(e) })));
  const input = { ...pricing(edges, new Map(), 6000), graph: { edges }, mids: new Map(),
    coverage: { resolvedEdgeKeys: edges.map(blockScanEdgeKey) },
    pricingStateKeyByEdgeKey: new Map(edges.map(e => [blockScanEdgeKey(e), edgeInstanceKey(e)])) };
  const common = { weth, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 2 };
  const raw = await buildEffectiveMids({ ...common, pricing: input,
    quote: async ({ edge: e, amountIn }) => {
      if (e === edges[3]) throw new Error("fixture quote failure");
      return { source: input.effectiveMids!.source, amountIn, amountOut: e === edges[4] ? 0n : amountIn * 2n };
    } });
  const saved = serialize({ snapshot: raw, lineage: exportEffectiveMidReplayState(raw) });
  const restored = deserialize(saved) as { snapshot: typeof raw; lineage: ReturnType<typeof exportEffectiveMidReplayState> };
  const values = structuredClone(restored.snapshot);
  assert.deepEqual([...new Set([...restored.snapshot.rows.values()].map(r => r.status))].sort(),
    ["missing-valuation", "no-output", "quote-failed", "quoted"]);
  assert([...restored.snapshot.rows.values()].every(row => !Object.isFrozen(row)));
  restoreEffectiveMidReplayState(restored.snapshot, restored.lineage, edges, weth);
  assert([...restored.snapshot.rows.values()].every(row => Object.isFrozen(row)));
  assert([...restored.snapshot.rows.values()].every(row => !row.quotedAt || Object.isFrozen(row.quotedAt)));
  assert.deepEqual(restored.snapshot, values, "restoration changes descriptors, not price data");
  let previous = { ...input, effectiveMids: restored.snapshot };
  let quotes = 0;
  for (let step = 1; step <= 2; step++) {
    const currentInput = { ...input, sourceBlock: 6000 + step, sourceBlockHash: address(6000 + step), generation: 6000 + step };
    const next = await buildEffectiveMids({ ...common, pricing: currentInput, previous: previous.effectiveMids,
      touchedStateKeys: new Set(), quote: async () => { quotes++; throw new Error("unexpected quote"); } });
    previous = organizeEffectivePricing({ ...currentInput, effectiveMids: next }, 7, false);
    const actual = effectiveEthPricing(previous, 7, false), stats = ethViewStatistics(actual.view, 0).incremental!;
    const observed = publishedEffectiveIncrementalStatistics(previous);
    assert.deepEqual(observed, stats);
    assert.notEqual(observed, stats, "diagnostic reads cannot mutate internal counters");
    assert.equal(publishedEffectiveIncrementalStatistics({ ...previous }), undefined,
      "unknown wrappers are not evaluated by the diagnostic read");
    assert.equal(stats.nativeDelta, step === 2);
    if (step === 2) {
      assert.equal(stats.projectionRowsVisited, 0);
      assert.equal(stats.derivedRowsVisited, 0);
    }
    assert.deepEqual(actual.view, buildBlockScanEthView(edges, effectiveEnumerationMids(previous), 7, false));
    assert.deepEqual(restored.snapshot, values, "later publications do not change restored data");
  }
  assert.equal(quotes, 0);
  const broken = deserialize(saved) as typeof restored;
  const last = [...broken.snapshot.rows.values()].at(-1)!;
  (last as { instanceKey: string }).instanceKey = "wrong-instance";
  assert.throws(() => restoreEffectiveMidReplayState(broken.snapshot, broken.lineage, edges, weth), /differs from Ready/);
  assert([...broken.snapshot.rows.values()].every(row => !Object.isFrozen(row)), "rejected input is not partly frozen");
  assert.equal(effectiveAmountReferences(broken.snapshot), undefined, "rejected input gains no carry authority");
});
