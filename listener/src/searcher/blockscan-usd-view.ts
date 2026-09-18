import { ADDR } from "../shared/constants/addresses.js";
import { tokenToWethReferences, type RawTokenRate } from "./blockscan-amount-reference.js";
import { effectiveEnumerationMids } from "./blockscan-effective-mid.js";
import type { BlockScanStateSnapshot } from "./blockscan-state-coordinator.js";
import type { ResolvedBlockScanMid } from "./detector/blockscan-scanner-core.js";
import { aboveSpread, type DfsQuote, type DirectedPriceSignal } from "./detector/blockscan-paired-dfs.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";

const compare = (a: RawTokenRate, b: RawTokenRate): number => {
  const delta = a.num * b.den - b.num * a.den;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
};
export const DEFAULT_USD_SIGNAL_PAIRS_PER_TOKEN = 20;
export function resolveUsdSignalPairsPerToken(raw?: string): number {
  const value = raw === undefined ? DEFAULT_USD_SIGNAL_PAIRS_PER_TOKEN : Number(raw);
  if ((raw !== undefined && !/^[1-9]\d*$/.test(raw)) || !Number.isSafeInteger(value) || value < 1)
    throw new Error("SEARCHER_BLOCKSCAN_USD_SIGNAL_PAIRS_PER_TOKEN must be a positive safe integer");
  return value;
}
function decimalRate(value: number): RawTokenRate | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const [m, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = m!.split(".");
  const scale = fraction.length - Number(exponent), digits = BigInt(whole! + fraction);
  return scale >= 0 ? { num: digits, den: 10n ** BigInt(scale) } : { num: digits * 10n ** BigInt(-scale), den: 1n };
}

export interface BlockScanUsdView {
  readonly quotes: readonly DfsQuote[];
  /** Top compatible buy/sell pairs per token, ranked by reference spread. */
  readonly signals: readonly DirectedPriceSignal[];
  readonly signalPairsPerToken: number;
  readonly referenceUsdPerRaw: ReadonlyMap<string, RawTokenRate>;
  readonly comparableTokens: number;
  readonly missingBuyReference: number;
  readonly missingSellReference: number;
}

/** One local derived view of published effective amounts, not another producer.
 * USDC=$1 is a reference only. The common USD conversion cancels in the gap
 * ratio, so reference-WETH ratios also remain usable if USDC is unavailable.
 * These marks are never final EV or a promise of capacity along a whole path. */
export function buildBlockScanUsdView(
  edges: readonly TokenEdge[], mids: ReadonlyMap<string, ResolvedBlockScanMid>,
  signalPairsPerToken = DEFAULT_USD_SIGNAL_PAIRS_PER_TOKEN,
): BlockScanUsdView {
  if (!Number.isSafeInteger(signalPairsPerToken) || signalPairsPerToken < 1)
    throw new Error("USD signal pairs per token must be a positive safe integer");
  const marks = tokenToWethReferences({ graph: { edges }, mids,
    coverage: { resolvedEdgeKeys: [...mids.keys()] } }, ADDR.WETH);
  const anchor = marks.get(ADDR.USDC.toLowerCase());
  const referenceUsdPerRaw = new Map<string, RawTokenRate>();
  if (anchor) for (const [token, mark] of marks) referenceUsdPerRaw.set(token, {
    num: mark.num * anchor.den, den: mark.den * anchor.num * 1_000_000n,
  });
  type Offer = { quote: DfsQuote; price: RawTokenRate };
  const buy = new Map<string, Offer[]>(), sell = new Map<string, Offer[]>();
  const quotes: DfsQuote[] = [], seen = new Set<string>();
  let missingBuyReference = 0, missingSellReference = 0;
  for (const edge of edges) {
    if (edge.leavesStandingPosition) continue;
    const id = blockScanEdgeKey(edge), mid = mids.get(id);
    if (!mid || seen.has(id)) continue;
    seen.add(id);
    // Production effective rows supply exact integer amounts. Decimal-rate
    // compatibility exists only for historical resolved/raw-mid diagnostics.
    const rate = mid.quoteAmountIn !== undefined && mid.quoteAmountOut !== undefined
      ? { num: mid.quoteAmountOut, den: mid.quoteAmountIn }
      : decimalRate(mid.mid * (1 - mid.feeBps / 10_000));
    if (!rate || rate.num <= 0n || rate.den <= 0n) continue;
    const tokenIn = edge.tokenIn.toLowerCase(), tokenOut = edge.tokenOut.toLowerCase();
    const mIn = marks.get(tokenIn), mOut = marks.get(tokenOut);
    const q: DfsQuote = { id, instance: edgeInstanceKey(edge), tokenIn, tokenOut, ...rate,
      value: mIn && mOut ? { num: rate.num * mOut.num * mIn.den,
        den: rate.den * mOut.den * mIn.num } : null };
    quotes.push(q);
    if (mIn) {
      const list = buy.get(q.tokenOut) ?? [];
      list.push({ quote: q, price: { num: q.den * mIn.num, den: q.num * mIn.den } }); buy.set(q.tokenOut, list);
    } else missingBuyReference++;
    if (mOut) {
      const list = sell.get(q.tokenIn) ?? [];
      list.push({ quote: q, price: { num: q.num * mOut.num, den: q.den * mOut.den } }); sell.set(q.tokenIn, list);
    } else missingSellReference++;
  }
  const signals: DirectedPriceSignal[] = [];
  let comparableTokens = 0;
  for (const [token, buys] of buy) {
    const sells = sell.get(token); if (!sells) continue;
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
      while (si < sells.length && sells[si]!.quote.instance === b.quote.instance) si++;
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
    const firstOtherPool = sells.findIndex(s => s.quote.instance !== sells[0]!.quote.instance);
    for (let bi = 0; bi < buys.length; bi++) {
      const si = buys[bi]!.quote.instance === sells[0]!.quote.instance ? firstOtherPool : 0;
      if (si >= 0) push(bi, si);
    }
    if (heap.length > 0) comparableTokens++;
    for (let count = 0; count < signalPairsPerToken && heap.length > 0; count++) {
      const best = pop();
      if (best.signal.num <= best.signal.den) break;
      signals.push(best.signal);
      push(best.buy, best.sell + 1);
    }
  }
  signals.sort((a, b) => compare(b, a) || a.token.localeCompare(b.token));
  return { quotes, signals, signalPairsPerToken, referenceUsdPerRaw, comparableTokens, missingBuyReference, missingSellReference };
}

const published = new WeakMap<BlockScanStateSnapshot, {
  mids: ReadonlyMap<string, ResolvedBlockScanMid>; view: BlockScanUsdView;
}>();
export function effectiveUsdPricing(pricing: BlockScanStateSnapshot, signalPairsPerToken = DEFAULT_USD_SIGNAL_PAIRS_PER_TOKEN) {
  let result = published.get(pricing);
  if (!result || result.view.signalPairsPerToken !== signalPairsPerToken) {
    const mids = result?.mids ?? effectiveEnumerationMids(pricing);
    result = { mids, view: buildBlockScanUsdView(pricing.graph.edges, mids, signalPairsPerToken) };
    published.set(pricing, result);
  }
  return result;
}

export function usdViewStatistics(view: BlockScanUsdView, thresholdBps: number) {
  const above = view.signals.filter(s => aboveSpread(s.num, s.den, thresholdBps));
  return { quotedDirections: view.quotes.length, referenceUsdTokens: view.referenceUsdPerRaw.size,
    comparableTokens: view.comparableTokens,
    tokensAboveThreshold: new Set(above.map(s => s.token)).size,
    signalPairsPerToken: view.signalPairsPerToken, signalPairsAboveThreshold: above.length,
    thresholdBps, missingBuyReference: view.missingBuyReference, missingSellReference: view.missingSellReference };
}
