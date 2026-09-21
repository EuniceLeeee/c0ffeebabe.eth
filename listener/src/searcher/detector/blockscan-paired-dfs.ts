/** Pure, amount-sensitive directed enumeration. No protocol state or RPC. */
export interface DfsQuote {
  readonly id: string;
  readonly instance: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly num: bigint;
  readonly den: bigint;
  /** Output reference value / input reference value; null is ineligible. */
  readonly value: { readonly num: bigint; readonly den: bigint } | null;
}
export interface DirectedPriceSignal {
  readonly token: string;
  readonly buy: string;
  readonly sell: string;
  readonly num: bigint;
  readonly den: bigint;
}
export type PairedEnumerationMethod = "dfs" | "layered";
export function resolvePairedEnumerationMethod(value?: string): PairedEnumerationMethod {
  if (value === undefined || value === "dfs") return "dfs";
  if (value === "layered") return value;
  throw new Error("SEARCHER_BLOCKSCAN_ENUMERATION_METHOD must be dfs or layered");
}
export const aboveSpread = (num: bigint, den: bigint, bps: number): boolean =>
  num * 10_000n > den * BigInt(10_000 + bps);
interface EnumerationInput {
  readonly quotes: readonly DfsQuote[];
  readonly signals: readonly DirectedPriceSignal[];
  readonly funding: readonly string[];
  readonly minSpreadBps: number;
  readonly maxHops: number;
  readonly deadlineAtMs: number;
  readonly onCycle: (quotes: readonly DfsQuote[], spreadBps: number) => void;
}
interface IndexedQuote {
  readonly quote: DfsQuote;
  readonly from: number;
  readonly to: number;
  readonly pool: number;
}
const NONE = 0xffffffff, CHUNK = 65536;
/** All eligible half paths; compact storage, no score truncation or top-K. */
class HalfLayer {
  readonly head: Uint32Array;
  private readonly chunks: Uint32Array[] = [];
  count = 0;
  constructor(tokens: number, readonly hops: number) { this.head = new Uint32Array(tokens).fill(NONE); }
  add(token: number, path: readonly number[]): void {
    const index = this.count++;
    if (index >= NONE) throw new Error("paired path index capacity exceeded");
    const stride = this.hops + 1;
    const chunk = Math.floor(index / CHUNK), offset = (index % CHUNK) * stride;
    const values = this.chunks[chunk] ??= new Uint32Array(CHUNK * stride);
    for (let i = 0; i < this.hops; i++) values[offset + i] = path[i]!;
    values[offset + this.hops] = this.head[token]!;
    this.head[token] = index;
  }
  read(index: number, path: number[]): number {
    const values = this.chunks[Math.floor(index / CHUNK)]!, offset = (index % CHUNK) * (this.hops + 1);
    for (let i = 0; i < this.hops; i++) path[i] = values[offset + i]!;
    path.length = this.hops;
    return values[offset + this.hops]!;
  }
}
/** Simple halves rooted at the price-signal token, joined by token. Each half
 * uses at most ceil(maxHops / 2) edges; their combined length cannot exceed maxHops.
 * No per-half profit gate. Join buckets are sorted by rate so binary search
 * skips combinations below the whole-cycle threshold before conflict checks.
 * Only after joining do we rotate to each available funding token for execution.
 * Both traversals share this gate, sorted index, storage and join rules. No future-return
 * or signal-completion pruning. Live caller deadline remains explicitly partial. */
function enumerate(input: EnumerationInput, traversal: PairedEnumerationMethod) {
  if (!Number.isSafeInteger(input.minSpreadBps) || input.minSpreadBps < 0 ||
      !Number.isSafeInteger(input.maxHops) || input.maxHops < 2)
    throw new Error("paired enumeration requires integer spread bps and maxHops >= 2");
  const stats = { expanded: 0, completedSignalTokens: 0, deadlineHit: false, closed: 0,
    halfPaths: 0, joins: 0, signalMatched: 0, indexedJoinComparisons: 0,
    joinSkippedBeforeConflicts: 0, gateRule: "signal-rooted-sorted-profitable-join" as const,
    traversal, phase: "prepare" };
  const expired = () => stats.deadlineHit ||= Date.now() >= input.deadlineAtMs;
  if (expired()) return stats;
  const tokens = new Map<string, number>(), pools = new Map<string, number>();
  const intern = (map: Map<string, number>, key: string): number => {
    let id = map.get(key); if (id === undefined) { id = map.size; map.set(key, id); } return id;
  };
  const byId = new Map<string, number>(), edges: IndexedQuote[] = [];
  for (const q of input.quotes) {
    if (byId.has(q.id)) throw new Error("duplicate directed quote id");
    if (q.num <= 0n || q.den <= 0n) throw new Error("invalid directed quote amount");
    byId.set(q.id, edges.length);
    if (q.value && (q.value.num <= 0n || q.value.den <= 0n)) throw new Error("invalid quote value");
    edges.push({ quote: q, from: intern(tokens, q.tokenIn), to: intern(tokens, q.tokenOut),
      pool: intern(pools, q.instance) });
  }
  const outgoing: number[][] = Array.from({ length: tokens.size }, () => []);
  const incoming: number[][] = Array.from({ length: tokens.size }, () => []);
  for (let id = 0; id < edges.length; id++) {
    const e = edges[id]!; if (!e.quote.value) continue;
    outgoing[e.from]!.push(id); incoming[e.to]!.push(id);
  }
  const partners = edges.map(() => new Set<number>());
  const anchors = new Map<number, { buys: Set<number>; sells: Set<number> }>();
  let pairCount = 0;
  for (const signal of input.signals) {
    const b = byId.get(signal.buy), s = byId.get(signal.sell);
    if (b === undefined || s === undefined) continue;
    const buy = edges[b]!, sell = edges[s]!;
    if (buy.quote.tokenOut !== signal.token || sell.quote.tokenIn !== signal.token ||
        buy.pool === sell.pool || signal.den <= 0n || signal.num <= 0n)
      throw new Error("invalid directed price signal");
    if (!aboveSpread(signal.num, signal.den, input.minSpreadBps)) continue;
    partners[b]!.add(s); partners[s]!.add(b); pairCount++;
    let seeds = anchors.get(sell.from);
    if (!seeds) { seeds = { buys: new Set(), sells: new Set() }; anchors.set(sell.from, seeds); }
    seeds.buys.add(b); seeds.sells.add(s);
  }
  if (expired() || pairCount === 0) return stats;
  const rate = (path: readonly number[]) => {
    let n = 1n, d = 1n;
    for (const id of path) {
      const q = edges[id]!.quote;
      n *= q.num; d *= q.den;
    }
    return { n, d };
  };
  const maxHalf = Math.min(Math.ceil(input.maxHops / 2), tokens.size - 1);
  const halves = (anchor: number, reverse: boolean, seeds: ReadonlySet<number>): HalfLayer[] => {
    const result = Array.from({ length: maxHalf }, (_, i) => new HalfLayer(tokens.size, i + 1));
    const path: number[] = [], executionPath: number[] = [];
    stats.phase = reverse ? "reverse" : "forward";
    const extend = (token: number, recurse: boolean): void => {
      const ids = (reverse ? incoming : outgoing)[token]!;
      for (let i = 0; i < ids.length; i++) {
        if ((stats.expanded++ & 4095) === 0 && expired()) return;
        const id = ids[i]!, edge = edges[id]!, next = reverse ? edge.from : edge.to;
        if (path.length === 0 && !seeds.has(id)) continue;
        if (next === anchor) continue;
        let conflict = false;
        for (const oldId of path) {
          const old = edges[oldId]!;
          if (old.pool === edge.pool || old.from === next || old.to === next) { conflict = true; break; }
        }
        if (conflict) continue;
        path.push(id);
        executionPath.length = path.length;
        for (let j = 0; j < path.length; j++) executionPath[j] = path[reverse ? path.length - 1 - j : j]!;
        result[path.length - 1]!.add(next, executionPath); stats.halfPaths++;
        if (recurse && path.length < maxHalf) extend(next, true);
        path.pop();
        if (stats.deadlineHit) return;
      }
    };
    if (traversal === "dfs") extend(anchor, true);
    else for (let hops = 1; hops <= maxHalf && !stats.deadlineHit; hops++) {
      if (hops === 1) extend(anchor, false);
      else {
        const previous = result[hops - 2]!;
        for (let pi = 0; pi < previous.count; pi++) {
          if ((pi & 4095) === 0 && expired()) break;
          previous.read(pi, path);
          if (reverse) path.reverse();
          const endpoint = reverse ? edges[path.at(-1)!]!.from : edges[path.at(-1)!]!.to;
          extend(endpoint, false);
          if (stats.deadlineHit) break;
        }
      }
    }
    return result;
  };
  const funding = new Set(input.funding), emitted = new Set<string>();
  if (funding.size === 0) return stats;
  for (const [anchor, seeds] of anchors) {
    if (expired()) break;
    const forward = halves(anchor, false, seeds.sells);
    const reverse = stats.deadlineHit ? [] : halves(anchor, true, seeds.buys);
    if (stats.deadlineHit) break;
    stats.phase = "join";
    const p: number[] = [], q: number[] = [];
    outer: for (const b of reverse) {
      for (let token = 0; token < tokens.size; token++) {
        if ((token & 4095) === 0 && expired()) break outer;
        if (b.head[token] === NONE) continue;
        // Same endpoint and hop count. Reference-value scaling is common to
        // this bucket, so sorting exact token rates has the same order; on
        // closing the cycle the USD reference factors cancel completely.
        const sorted: { index: number; n: bigint; d: bigint }[] = [];
        for (let qi = b.head[token]!; qi !== NONE;) {
          if ((sorted.length & 4095) === 0 && expired()) break outer;
          const index = qi; qi = b.read(qi, q);
          sorted.push({ index, ...rate(q) });
        }
        sorted.sort((x, y) => {
          const delta = x.n * y.d - y.n * x.d;
          return delta < 0n ? -1 : delta > 0n ? 1 : x.index - y.index;
        });
        if (expired()) break outer;
        for (const a of forward) {
          if (a.hops + b.hops > input.maxHops) continue;
          // Every split is eligible now. Emit only the first legal split,
          // without keeping a profit-dependent prefix test.
          if (a.hops !== Math.max(1, a.hops + b.hops - maxHalf)) continue;
          for (let pi = a.head[token]!; pi !== NONE;) {
            if (expired()) break outer;
            pi = a.read(pi, p);
            const ar = rate(p);
            let low = 0, high = sorted.length;
            while (low < high) {
              const mid = Math.floor((low + high) / 2), br = sorted[mid]!;
              stats.indexedJoinComparisons++;
              if (aboveSpread(ar.n * br.n, ar.d * br.d, input.minSpreadBps)) high = mid;
              else low = mid + 1;
            }
            stats.joinSkippedBeforeConflicts += low;
            for (let bi = low; bi < sorted.length; bi++) {
              const br = sorted[bi]!;
              b.read(br.index, q);
              if ((stats.joins++ & 4095) === 0 && expired()) break outer;
              if (!partners[p[0]!]!.has(q[q.length - 1]!)) continue;
              stats.signalMatched++;
              const path = [...p, ...q];
              if (new Set(path.map(id => edges[id]!.pool)).size !== path.length ||
                  new Set(path.map(id => edges[id]!.from)).size !== path.length) continue;
              const n = ar.n * br.n, d = ar.d * br.d;
              const quotes = path.map(id => edges[id]!.quote);
              const spread = (Number(n) / Number(d) - 1) * 10000;
              for (let start = 0; start < quotes.length; start++) {
                if (!funding.has(quotes[start]!.tokenIn)) continue;
                const rotated = [...quotes.slice(start), ...quotes.slice(0, start)];
                const key = JSON.stringify(rotated.map(quote => quote.id));
                if (emitted.has(key)) continue;
                emitted.add(key); stats.closed++;
                input.onCycle(rotated, Number.isFinite(spread) ? spread
                  : Number(n * 1_000_000_000n / d - 1_000_000_000n) / 100_000);
              }
            }
          }
        }
      }
    }
    if (stats.deadlineHit) break;
    stats.completedSignalTokens++;
  }
  expired(); stats.phase = stats.deadlineHit ? "interrupted" : "complete";
  return stats;
}
export const enumeratePairedDfs = (input: EnumerationInput) => enumerate(input, "dfs");
export const enumeratePairedLayered = (input: EnumerationInput) => enumerate(input, "layered");
