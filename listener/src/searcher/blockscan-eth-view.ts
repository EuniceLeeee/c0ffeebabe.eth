import { ADDR } from "../shared/constants/addresses.js";
import { DirectedRateReferenceIndex, type RawTokenRate } from "./blockscan-amount-reference.js";
import { visitEffectiveEnumerationQuotes, withEffectiveRowColumns, effectiveNativeChangesSince, effectiveEnumerationQuote,
  type EffectiveEnumerationPricing, type EffectiveMidSnapshot } from "./blockscan-effective-mid.js";
import type { ResolvedBlockScanQuote } from "./detector/blockscan-scanner-core.js";
import { aboveSpread, DEFAULT_ALLOW_REPEATED_POOLS, type DfsQuote, type DirectedPriceSignal } from "./detector/blockscan-paired-dfs.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import { isBlockScanConversionEdge } from "./strategy-taxonomy.js";
import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "./blockscan-enumeration-config.js";

const compare = (a: RawTokenRate, b: RawTokenRate): number => {
  const delta = a.num * b.den - b.num * a.den;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
export const DEFAULT_ETH_SIGNAL_PAIRS_PER_TOKEN: number = BLOCKSCAN_ENUMERATION_DEFAULTS.signalPairsPerToken;
export type EthReferenceTouchedMode = "direct" | "dependencies";
export function resolveEthReferenceTouchedMode(raw?: string): EthReferenceTouchedMode {
  // Preserve the existing reference-view semantics unless explicitly selected.
  if (raw === undefined || raw === "dependencies") return "dependencies";
  if (raw === "direct") return "direct";
  throw new Error("SEARCHER_BLOCKSCAN_ETH_REFERENCE_TOUCHED must be direct or dependencies");
}
export function resolveEthSignalPairsPerToken(raw?: string): number {
  const value = raw === undefined ? DEFAULT_ETH_SIGNAL_PAIRS_PER_TOKEN : Number(raw);
  if ((raw !== undefined && !/^[1-9]\d*$/.test(raw)) || !Number.isSafeInteger(value) || value < 1)
    throw new Error("SEARCHER_BLOCKSCAN_ETH_SIGNAL_PAIRS_PER_TOKEN must be a positive safe integer");
  return value;
}
function quoteRate(quote: ResolvedBlockScanQuote): RawTokenRate {
  return { num: quote.quoteAmountOut, den: quote.quoteAmountIn };
}

export interface BlockScanEthView {
  readonly quotes: readonly DfsQuote[];
  /** Top compatible buy/sell pairs per token, ranked by reference spread. */
  readonly signals: readonly DirectedPriceSignal[];
  readonly signalPairsPerToken: number;
  readonly allowRepeatedPools: boolean;
  /** WETH wei per token raw unit, without a USD anchor or extra decimal scaling. */
  readonly referenceEthPerRaw: ReadonlyMap<string, RawTokenRate>;
  readonly comparableTokens: number;
  readonly missingBuyReference: number;
  readonly missingSellReference: number;
}

type Offer = { quote: DfsQuote; price: RawTokenRate };
export interface EffectiveEthColumns {
  quote: DfsQuote;
  markIn: RawTokenRate | undefined;
  markOut: RawTokenRate | undefined;
  buy?: Offer;
  sell?: Offer;
}
interface EthViewWork {
  edges: readonly TokenEdge[];
  topology: readonly { edge: TokenEdge; id: string; instance: string; tokenIn: string; tokenOut: string; order: number;
    conversion: boolean; leavesStandingPosition: boolean; immutable: boolean }[];
  references: DirectedRateReferenceIndex;
  /** Alias of the published effective table; never a separately maintained row map. */
  effective: EffectiveMidSnapshot | undefined;
  byToken: Map<string, Set<string>>;
  byId: Map<string, EthViewWork["topology"][number]>;
  buy: Map<string, Map<string, Offer>>;
  sell: Map<string, Map<string, Offer>>;
  pairs: Map<string, { signals: readonly DirectedPriceSignal[]; comparable: boolean }>;
  mids: ReadonlyMap<string, ResolvedBlockScanQuote>;
  output?: BlockScanEthView;
  quotePositions: Map<string, number>;
}
// Compare the representation too: preserving exact integer numerators and
// denominators preserves every tie and the published diagnostic surface.
const sameRate = (a: RawTokenRate | undefined, b: RawTokenRate | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.num === b.num && a.den === b.den);
const workStats = new WeakMap<BlockScanEthView, { touchedMode: EthReferenceTouchedMode; fullBuild: boolean;
  changedDirections: number; updatedQuotes: number; recomputedPairs: number; recomputedTokens: number; rankedTokens: number;
  nativeDelta: boolean; projectionRowsVisited: number; derivedRowsVisited: number; quoteMembershipChanged: boolean }>();

function sameTopology(work: EthViewWork, edges: readonly TokenEdge[]): boolean {
  return work.topology.length === edges.length && work.topology.every((old, i) => {
    const edge = edges[i]!;
    return old.immutable && edge === old.edge || (old.id === blockScanEdgeKey(edge) &&
      old.instance === edgeInstanceKey(edge) && old.tokenIn === edge.tokenIn.toLowerCase() &&
      old.tokenOut === edge.tokenOut.toLowerCase() && old.conversion === isBlockScanConversionEdge(edge) &&
      old.leavesStandingPosition === edge.leavesStandingPosition);
  });
}

/** One local ETH-reference view of published effective amounts, not another producer.
 * These marks are never final EV or a promise of capacity along a whole path. */
export function buildBlockScanEthView(
  edges: readonly TokenEdge[], mids: ReadonlyMap<string, ResolvedBlockScanQuote>,
  signalPairsPerToken = DEFAULT_ETH_SIGNAL_PAIRS_PER_TOKEN,
  allowRepeatedPools = DEFAULT_ALLOW_REPEATED_POOLS,
  /** A narrowed topology rebuild keeps the originating view's policy. */
  policyView?: BlockScanEthView,
): BlockScanEthView {
  return buildEthView(edges, mids, signalPairsPerToken, allowRepeatedPools, undefined,
    (policyView && workStats.get(policyView)?.touchedMode) ??
      resolveEthReferenceTouchedMode(process.env.SEARCHER_BLOCKSCAN_ETH_REFERENCE_TOUCHED)).view;
}

function buildEthView(
  edges: readonly TokenEdge[], mids: ReadonlyMap<string, ResolvedBlockScanQuote>,
  signalPairsPerToken: number, allowRepeatedPools: boolean, previous?: EthViewWork,
  touchedMode: EthReferenceTouchedMode = "dependencies",
  validatedChanges?: ReadonlyMap<string, RawTokenRate | undefined>,
  effective?: EffectiveMidSnapshot,
  nativeChangedIds?: ReadonlySet<string>,
  projectionRowsVisited = effective?.rows.size ?? mids.size,
): { view: BlockScanEthView; work: EthViewWork; effective?: EffectiveMidSnapshot } {
  if (!Number.isSafeInteger(signalPairsPerToken) || signalPairsPerToken < 1)
    throw new Error("ETH signal pairs per token must be a positive safe integer");
  const reusable = previous && (nativeChangedIds !== undefined && previous.edges === edges || sameTopology(previous, edges));
  const work: EthViewWork = reusable ? previous : {
    edges, topology: edges.map((edge, order) => ({ edge, order, id: blockScanEdgeKey(edge), instance: edgeInstanceKey(edge),
      tokenIn: edge.tokenIn.toLowerCase(), tokenOut: edge.tokenOut.toLowerCase(),
      conversion: isBlockScanConversionEdge(edge), leavesStandingPosition: edge.leavesStandingPosition,
      immutable: Boolean(edge.canonicalEdgeId) && Object.isFrozen(edge) &&
        (edge.routeBinding === undefined || Object.isFrozen(edge.routeBinding)) })),
    references: new DirectedRateReferenceIndex(edges, key => {
      const mid = mids.get(key); return mid && quoteRate(mid);
    }, ADDR.WETH), effective: undefined, byToken: new Map(), byId: new Map(),
    pairs: new Map(), buy: new Map(), sell: new Map(), mids, quotePositions: new Map(),
  };
  const priorOutput = reusable ? work.output : undefined;
  const priorRows = reusable ? work.effective?.rows : undefined;
  // A private change draft, discarded after publishing columns on effective.
  // Standalone narrowed-view callers use the same calculation, without retaining
  // a second source table or changing the caller's effective publication.
  const columns = new Map<string, EffectiveEthColumns | undefined>();
  const changes = new Map(reusable ? validatedChanges : undefined);
  if (!reusable || !validatedChanges) for (const item of work.topology) {
    const mid = mids.get(item.id), prior = priorRows?.get(item.id);
    if (!mid) {
      if (prior) changes.set(item.id, undefined);
    } else if (!prior || prior.amountOut !== mid.quoteAmountOut || prior.amountIn !== mid.quoteAmountIn) {
      changes.set(item.id, quoteRate(mid));
    }
    if (!reusable) {
      if (!work.byId.has(item.id)) work.byId.set(item.id, item);
      for (const token of [item.tokenIn, item.tokenOut]) {
        const ids = work.byToken.get(token) ?? new Set<string>();
        ids.add(item.id); work.byToken.set(token, ids);
      }
    }
  }
  const referenceUpdate = reusable ? work.references.update(changes, touchedMode) : undefined;
  const marks = work.references.marks, affected = new Set(changes.keys());
  for (const token of referenceUpdate?.changedTokens ?? [])
    for (const id of work.byToken.get(token) ?? []) affected.add(id);
  const dirtyTokens = new Set<string>();
  const quoteEdits = new Map<string, DfsQuote | undefined>();
  let missingBuyReference = priorOutput?.missingBuyReference ?? 0;
  let missingSellReference = priorOutput?.missingSellReference ?? 0;
  let comparableTokens = priorOutput?.comparableTokens ?? 0;
  const replaceContribution = (id: string, old: EffectiveEthColumns | undefined, next: EffectiveEthColumns | undefined) => {
    missingBuyReference += Number(next !== undefined && !next.buy) - Number(old !== undefined && !old.buy);
    missingSellReference += Number(next !== undefined && !next.sell) - Number(old !== undefined && !old.sell);
    if (old?.quote !== next?.quote) quoteEdits.set(id, next?.quote);
  };
  let updatedQuotes = 0;
  // Only affected quotes and token groups are rebuilt. Flattening the output
  // arrays below is still required by the existing enumeration contract.
  for (const id of affected) {
    const { instance, tokenIn, tokenOut, conversion } = work.byId.get(id)!;
    if (!conversion) continue;
    const mid = mids.get(id), old = priorRows?.get(id)?.eth;
    const rate = mid && quoteRate(mid);
    const mIn = marks.get(tokenIn), mOut = marks.get(tokenOut);
    if (!rate) {
      columns.set(id, undefined);
      replaceContribution(id, old, undefined);
      if (old) {
        work.buy.get(tokenOut)?.delete(id); work.sell.get(tokenIn)?.delete(id);
        dirtyTokens.add(tokenIn); dirtyTokens.add(tokenOut); updatedQuotes++;
      }
      continue;
    }
    const reusable = old && old.quote.instance === instance && old.quote.tokenIn === tokenIn &&
      old.quote.tokenOut === tokenOut && sameRate(old.quote, rate) &&
      sameRate(old.markIn, mIn) && sameRate(old.markOut, mOut);
    const q: DfsQuote = reusable ? old.quote : { id, instance, tokenIn, tokenOut, ...rate,
      value: mIn && mOut ? { num: rate.num * mOut.num * mIn.den,
        den: rate.den * mOut.den * mIn.num } : null };
    const entry: EffectiveEthColumns = reusable ? old : Object.freeze({ quote: q, markIn: mIn, markOut: mOut,
      buy: mIn ? { quote: q, price: { num: q.den * mIn.num, den: q.num * mIn.den } } : undefined,
      sell: mOut ? { quote: q, price: { num: q.num * mOut.num, den: q.den * mOut.den } } : undefined });
    columns.set(id, entry);
    replaceContribution(id, old, entry);
    if (reusable) continue;
    updatedQuotes++;
    dirtyTokens.add(tokenIn); dirtyTokens.add(tokenOut);
    if (entry.buy) {
      const list = work.buy.get(tokenOut) ?? new Map();
      list.set(id, entry.buy); work.buy.set(tokenOut, list);
    } else work.buy.get(tokenOut)?.delete(id);
    if (entry.sell) {
      const list = work.sell.get(tokenIn) ?? new Map();
      list.set(id, entry.sell); work.sell.set(tokenIn, list);
    } else work.sell.get(tokenIn)?.delete(id);
  }
  // Native rows already identify same-amount new observations, disables and
  // recoveries. Do not rediscover them by scanning the completed table.
  const rowIds = nativeChangedIds ?? effective?.rows.keys() ?? [];
  let derivedRowsVisited = 0;
  if (effective) for (const id of rowIds) {
    derivedRowsVisited++;
    const row = effective.rows.get(id);
    if (!row) continue;
    if (columns.has(id)) continue;
    const eth = row.status === "quoted" && work.byId.get(id)?.conversion
      ? priorRows?.get(id)?.eth : undefined;
    // A fresh same-amount observation inherits only derived fields, never an
    // older amount/source/lineage. A failed row cannot retain a valid ETH price.
    if (row.eth !== eth || row.enumeration !== mids.get(id)) columns.set(id, eth);
  }
  const changedSignals: DirectedPriceSignal[] = [];
  for (const token of dirtyTokens) {
    if (work.pairs.get(token)?.comparable) comparableTokens--;
    const buys = [...(work.buy.get(token)?.values() ?? [])], sells = [...(work.sell.get(token)?.values() ?? [])];
    if (!buys.length || !sells.length) { work.pairs.delete(token); continue; }
    const signals: DirectedPriceSignal[] = [];
    buys.sort((a, b) => compare(a.price, b.price) || a.quote.id.localeCompare(b.quote.id));
    sells.sort((a, b) => compare(b.price, a.price) || a.quote.id.localeCompare(b.quote.id));
    // Each buy is a descending row of sell/buy spreads. Merge row heads to
    // obtain exact top-K without materializing the full buy × sell product.
    // Buy/sell index tie-breaks also preserve the original K=1 choice.
    type Pair = { buy: number; sell: number; signal: DirectedPriceSignal };
    const heap: Pair[] = [];
    const better = (a: Pair, b: Pair) => {
      const order = compare(a.signal, b.signal);
      return order > 0 || (order === 0 && (a.buy < b.buy || (a.buy === b.buy && a.sell < b.sell)));
    };
    const push = (bi: number, si: number) => {
      const b = buys[bi]!;
      while (!allowRepeatedPools && si < sells.length && sells[si]!.quote.instance === b.quote.instance) si++;
      if (si === sells.length) return;
      const s = sells[si]!;
      const item: Pair = { buy: bi, sell: si, signal: { token, buy: b.quote.id, sell: s.quote.id,
        num: s.price.num * b.price.den, den: s.price.den * b.price.num } };
      let i = heap.length; heap.push(item);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!better(item, heap[parent]!)) break;
        heap[i] = heap[parent]!; i = parent;
      }
      heap[i] = item;
    };
    const pop = (): Pair => {
      const first = heap[0]!, last = heap.pop()!;
      if (heap.length > 0) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && better(heap[child + 1]!, heap[child]!)) child++;
          if (!better(heap[child]!, last)) break;
          heap[i] = heap[child]!; i = child;
        }
        heap[i] = last;
      }
      return first;
    };
    const firstOtherPool = allowRepeatedPools ? 0 : sells.findIndex(s => s.quote.instance !== sells[0]!.quote.instance);
    // With repeated pools allowed, every sorted buy row starts at sells[0].
    // Its seed dominates every later item in that row. The first K seeds
    // therefore dominate all omitted rows, including the existing index ties.
    // Pool exclusion changes each row's first sell: keep all seeds in that case.
    const seedLimit = allowRepeatedPools ? Math.min(signalPairsPerToken, buys.length) : buys.length;
    for (let bi = 0; bi < seedLimit; bi++) {
      const si = !allowRepeatedPools && buys[bi]!.quote.instance === sells[0]!.quote.instance ? firstOtherPool : 0;
      if (si >= 0) push(bi, si);
    }
    const comparable = heap.length > 0;
    for (let count = 0; count < signalPairsPerToken && heap.length > 0; count++) {
      const best = pop();
      if (best.signal.num <= best.signal.den) break;
      signals.push(best.signal);
      push(best.buy, best.sell + 1);
    }
    work.pairs.set(token, { comparable, signals });
    if (comparable) comparableTokens++;
    changedSignals.push(...signals);
  }
  const enriched = effective && withEffectiveRowColumns(effective, columns);
  // Output arrays remain native immutable-by-ownership arrays. Copy references
  // once when needed, but never traverse every effective row to reconstruct them.
  let quotes = priorOutput?.quotes ?? [];
  let quoteMembershipChanged = false;
  if (quoteEdits.size) {
    const next = quotes.slice(), additions: DfsQuote[] = [], removals = new Set<string>();
    for (const [id, quote] of quoteEdits) {
      const position = work.quotePositions.get(id);
      if (position !== undefined && quote) next[position] = quote;
      else if (quote) additions.push(quote);
      else if (position !== undefined) removals.add(id);
    }
    quoteMembershipChanged = additions.length > 0 || removals.size > 0;
    if (quoteMembershipChanged) {
      const retained = removals.size ? next.filter(quote => !removals.has(quote.id)) : next;
      const order = (quote: DfsQuote) => work.byId.get(quote.id)!.order;
      additions.sort((a, b) => order(a) - order(b));
      const merged: DfsQuote[] = [];
      let a = 0, b = 0;
      while (a < retained.length || b < additions.length) {
        if (b === additions.length || a < retained.length && order(retained[a]!) < order(additions[b]!))
          merged.push(retained[a++]!);
        else merged.push(additions[b++]!);
      }
      quotes = merged; work.quotePositions.clear();
      quotes.forEach((quote, index) => work.quotePositions.set(quote.id, index));
    } else quotes = next;
  }
  const signalOrder = (a: DirectedPriceSignal, b: DirectedPriceSignal) => compare(b, a) || a.token.localeCompare(b.token);
  let signals = priorOutput?.signals ?? [];
  if (dirtyTokens.size) {
    const retained = signals.filter(signal => !dirtyTokens.has(signal.token));
    changedSignals.sort(signalOrder);
    const merged: DirectedPriceSignal[] = [];
    let a = 0, b = 0;
    while (a < retained.length || b < changedSignals.length) {
      if (b === changedSignals.length || a < retained.length && signalOrder(retained[a]!, changedSignals[b]!) <= 0)
        merged.push(retained[a++]!);
      else merged.push(changedSignals[b++]!);
    }
    signals = merged;
  }
  const view = { quotes, signals, signalPairsPerToken, allowRepeatedPools, referenceEthPerRaw: marks,
    comparableTokens, missingBuyReference, missingSellReference };
  workStats.set(view, { touchedMode, fullBuild: !reusable, changedDirections: changes.size, updatedQuotes,
    recomputedPairs: referenceUpdate?.recomputedPairs ?? 0, recomputedTokens: referenceUpdate?.recomputedTokens ?? 0,
    rankedTokens: dirtyTokens.size, nativeDelta: nativeChangedIds !== undefined,
    projectionRowsVisited, derivedRowsVisited, quoteMembershipChanged });
  work.effective = enriched;
  work.edges = edges;
  work.mids = mids; work.output = view;
  return { view, work, effective: enriched };
}

// One consumer-owned working index, never source-bound execution authority.
// All current amounts are validated before diffing; only derived calculations
// are incremental. Topology/configuration changes and backwards sources rebuild.
// Direct mode deliberately retains indirect marks on ordinary price changes;
// exclusions/removals always propagate. Published arrays/maps are never mutated.
let recent: { pricing: Pick<EffectiveEnumerationPricing, "sourceBlock" | "sourceBlockHash" | "generation">;
  work: EthViewWork; signalPairsPerToken: number;
  allowRepeatedPools: boolean; touchedMode: EthReferenceTouchedMode } | undefined;
const published = new WeakMap<EffectiveEnumerationPricing, {
  mids: ReadonlyMap<string, ResolvedBlockScanQuote>; view: BlockScanEthView;
}>();
/** Producer seam: publish native amounts and ETH columns as one effective table.
 * All later consumers use indexes referencing those same row columns. */
export function organizeEffectiveTable(pricing: EffectiveEnumerationPricing,
  signalPairsPerToken = DEFAULT_ETH_SIGNAL_PAIRS_PER_TOKEN, allowRepeatedPools = DEFAULT_ALLOW_REPEATED_POOLS,
  touchedMode: EthReferenceTouchedMode = resolveEthReferenceTouchedMode(process.env.SEARCHER_BLOCKSCAN_ETH_REFERENCE_TOUCHED),
): { effective: EffectiveMidSnapshot; view: BlockScanEthView } {
  const result = effectiveEthPricing(pricing, signalPairsPerToken, allowRepeatedPools, touchedMode);
  const effective = organizedTables.get(pricing);
  if (!effective) throw new Error("effective table organization missing");
  return { effective, view: result.view };
}
const organizedTables = new WeakMap<EffectiveEnumerationPricing, EffectiveMidSnapshot>();
/** Called only at the coordinator's successful synchronous publication seam. */
export function organizeEffectivePricing<T extends EffectiveEnumerationPricing>(pricing: T,
  signalPairsPerToken = DEFAULT_ETH_SIGNAL_PAIRS_PER_TOKEN, allowRepeatedPools = DEFAULT_ALLOW_REPEATED_POOLS,
  touchedMode: EthReferenceTouchedMode = resolveEthReferenceTouchedMode(process.env.SEARCHER_BLOCKSCAN_ETH_REFERENCE_TOUCHED),
): T {
  const { effective } = organizeEffectiveTable(pricing, signalPairsPerToken, allowRepeatedPools, touchedMode);
  const next = Object.freeze({ ...pricing, effectiveMids: effective });
  // Only this exact published object inherits the validated indexes. A different
  // wrapper (including mutable diagnostic inputs) crosses validation again.
  published.set(next, published.get(pricing)!);
  organizedTables.set(next, effective);
  return next;
}
export function effectiveEthPricing(pricing: EffectiveEnumerationPricing, signalPairsPerToken = DEFAULT_ETH_SIGNAL_PAIRS_PER_TOKEN,
  allowRepeatedPools = DEFAULT_ALLOW_REPEATED_POOLS,
  touchedMode: EthReferenceTouchedMode = resolveEthReferenceTouchedMode(process.env.SEARCHER_BLOCKSCAN_ETH_REFERENCE_TOUCHED)) {
  let result = published.get(pricing);
  const effective = pricing.effectiveMids;
  if (!result || result.view.signalPairsPerToken !== signalPairsPerToken || result.view.allowRepeatedPools !== allowRepeatedPools ||
      workStats.get(result.view)?.touchedMode !== touchedMode) {
    const old = recent;
    const forward = old && (pricing.sourceBlock > old.pricing.sourceBlock && pricing.generation > old.pricing.generation ||
      pricing.sourceBlock === old.pricing.sourceBlock && pricing.generation >= old.pricing.generation &&
      pricing.sourceBlockHash.toLowerCase() === old.pricing.sourceBlockHash.toLowerCase());
    const advance = !old || forward || (pricing.sourceBlock === old.pricing.sourceBlock &&
      pricing.generation > old.pricing.generation);
    const previous = forward && old?.signalPairsPerToken === signalPairsPerToken &&
      old.allowRepeatedPools === allowRepeatedPools && old.touchedMode === touchedMode
      ? old.work : undefined;
    // Validate and organize effective quantities together. All drafts remain
    // private until every row passes; only then may the working index advance.
    const native = previous?.effective && previous.edges === pricing.graph.edges
      ? effectiveNativeChangesSince(pricing, previous.effective) : undefined;
    let mids: ReadonlyMap<string, ResolvedBlockScanQuote>;
    const changes = new Map<string, RawTokenRate | undefined>();
    let nativeIds: Set<string> | undefined;
    if (native && previous) {
      nativeIds = new Set(native.removals);
      // Validate ALL changed rows before mutating the reference/ranking work.
      const updated = native.updates.map(([id, row]) => [id, effectiveEnumerationQuote(pricing, id, row)] as const);
      let draft: Map<string, ResolvedBlockScanQuote> | undefined, added = false;
      const edit = (id: string, quote: ResolvedBlockScanQuote | undefined) => {
        nativeIds!.add(id);
        const prior = previous.mids.get(id);
        if (prior === quote) return;
        draft ??= new Map(previous.mids);
        if (quote) { draft.set(id, quote); if (!prior) added = true; }
        else draft.delete(id);
        if (!quote || !prior || prior.quoteAmountIn !== quote.quoteAmountIn || prior.quoteAmountOut !== quote.quoteAmountOut)
          changes.set(id, quote && quoteRate(quote));
      };
      for (const [id, quote] of updated) edit(id, quote);
      for (const id of native.removals) edit(id, undefined);
      mids = draft ?? previous.mids;
      // Map.set appends a recovered direction; restore native table order only
      // on membership additions, without revalidating/repricing unchanged rows.
      if (added) {
        const ordered = new Map<string, ResolvedBlockScanQuote>();
        for (const id of effective!.rows.keys()) { const quote = mids.get(id); if (quote) ordered.set(id, quote); }
        mids = ordered;
      }
    } else {
      const full = new Map<string, ResolvedBlockScanQuote>();
      visitEffectiveEnumerationQuotes(pricing, (id, quote) => {
        full.set(id, quote);
        const prior = previous?.effective?.rows.get(id);
        if (!prior || prior.status !== "quoted" || prior.amountIn !== quote.quoteAmountIn || prior.amountOut !== quote.quoteAmountOut)
          changes.set(id, quoteRate(quote));
      });
      if (previous?.effective) for (const [id, row] of previous.effective.rows)
        if (row.status === "quoted" && !full.has(id)) changes.set(id, undefined);
      mids = full;
    }
    const built = buildEthView(pricing.graph.edges, mids, signalPairsPerToken, allowRepeatedPools, previous,
      touchedMode, changes, effective, nativeIds, native ? native.updates.length + native.removals.length : effective?.rows.size);
    // Historical/overlapping readers may build their own view, but must never
    // replace the current working history (especially in non-propagating mode).
    if (advance) recent = { pricing: { sourceBlock: pricing.sourceBlock, sourceBlockHash: pricing.sourceBlockHash,
      generation: pricing.generation }, work: built.work,
      signalPairsPerToken, allowRepeatedPools, touchedMode };
    result = { mids, view: built.view };
    published.set(pricing, result);
    if (built.effective) {
      organizedTables.set(pricing, built.effective);
    }
  }
  return result;
}

/** Read already-published counters without rebuilding or scanning the view. */
export function publishedEffectiveIncrementalStatistics(pricing: EffectiveEnumerationPricing) {
  const view = published.get(pricing)?.view;
  const stats = view && workStats.get(view);
  return stats ? { ...stats } : undefined;
}

export function ethViewStatistics(view: BlockScanEthView, thresholdBps: number) {
  const above = view.signals.filter(s => aboveSpread(s.num, s.den, thresholdBps));
  return { quotedDirections: view.quotes.length, referenceEthTokens: view.referenceEthPerRaw.size,
    incremental: workStats.get(view),
    comparableTokens: view.comparableTokens,
    tokensAboveThreshold: new Set(above.map(s => s.token)).size,
    signalPairsPerToken: view.signalPairsPerToken, allowRepeatedPools: view.allowRepeatedPools, signalPairsAboveThreshold: above.length,
    thresholdBps, missingBuyReference: view.missingBuyReference, missingSellReference: view.missingSellReference };
}
