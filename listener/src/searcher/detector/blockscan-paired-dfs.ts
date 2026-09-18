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
export const PAIRED_MAX_STEP_DROP_BPS = 10;
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
  readonly n: bigint;
  readonly d: bigint;
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
    const chunk = Math.floor(index / CHUNK), offset = (index % CHUNK) * 4;
    const values = this.chunks[chunk] ??= new Uint32Array(CHUNK * 4);
    for (let i = 0; i < 3; i++) values[offset + i] = path[i] ?? NONE;
    values[offset + 3] = this.head[token]!;
    this.head[token] = index;
  }
  read(index: number, path: number[]): number {
    const values = this.chunks[Math.floor(index / CHUNK)]!, offset = (index % CHUNK) * 4;
    for (let i = 0; i < this.hops; i++) path[i] = values[offset + i]!;
    path.length = this.hops;
    return values[offset + 3]!;
  }
}
const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };

/** 1..3 + 1..3 simple halves, joined by token. Both traversals share the exact
 * absolute 0.1pp step gate, sorted index, storage and join rules. No future-return
 * or signal-completion pruning. Live caller deadline remains explicitly partial. */
function enumerate(input: EnumerationInput, traversal: PairedEnumerationMethod) {
  if (!Number.isSafeInteger(input.minSpreadBps) || input.minSpreadBps < 0 ||
      !Number.isSafeInteger(input.maxHops) || input.maxHops < 2 || input.maxHops > 6)
    throw new Error("paired enumeration requires integer spread bps and 2..6 hops");
  const stats = { expanded: 0, completedFunding: 0, deadlineHit: false, closed: 0,
    halfPaths: 0, joins: 0, signalMatched: 0, indexedGateComparisons: 0,
    gateSkippedBeforeConflicts: 0, maxStepDropBps: PAIRED_MAX_STEP_DROP_BPS,
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
    const n = q.value?.num ?? 0n, d = q.value?.den ?? 1n, divisor = gcd(n, d);
    edges.push({ quote: q, from: intern(tokens, q.tokenIn), to: intern(tokens, q.tokenOut),
      pool: intern(pools, q.instance), n: n / divisor, d: d / divisor });
  }
  const outgoing: number[][] = Array.from({ length: tokens.size }, () => []);
  const incoming: number[][] = Array.from({ length: tokens.size }, () => []);
  for (let id = 0; id < edges.length; id++) {
    const e = edges[id]!; if (!e.quote.value) continue;
    outgoing[e.from]!.push(id); incoming[e.to]!.push(id);
  }
  const partners = edges.map(() => new Set<number>());
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
  }
  if (expired() || pairCount === 0) return stats;
  for (const buckets of [outgoing, incoming]) for (const ids of buckets)
    ids.sort((a, b) => {
      const x = edges[a]!, y = edges[b]!, left = x.n * y.d, right = y.n * x.d;
      return left < right ? -1 : left > right ? 1 : x.quote.id.localeCompare(y.quote.id);
    });
  if (expired()) return stats;
  const firstEligible = (ids: readonly number[], n: bigint, d: bigint): number => {
    const left = 10000n * n, right = left - BigInt(PAIRED_MAX_STEP_DROP_BPS) * d;
    if (right <= 0n) return 0;
    let low = 0, high = ids.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2), edge = edges[ids[mid]!]!;
      stats.indexedGateComparisons++;
      if (left * edge.n >= right * edge.d) high = mid; else low = mid + 1;
    }
    stats.gateSkippedBeforeConflicts += low;
    return low;
  };
  const halfOK = (path: readonly number[], reverse: boolean): boolean => {
    let n = 1n, d = 1n;
    for (let i = 0; i < path.length; i++) {
      const e = edges[path[reverse ? path.length - 1 - i : i]!]!;
      if (10000n * n * e.n < (10000n * n - BigInt(PAIRED_MAX_STEP_DROP_BPS) * d) * e.d) return false;
      n *= e.n; d *= e.d;
    }
    return true;
  };
  const firstSplit = (path: readonly number[]): number => {
    for (let s = Math.max(1, path.length - 3); s <= Math.min(3, path.length - 1); s++) {
      if (!halfOK(path.slice(0, s), false) || !halfOK(path.slice(s), true)) continue;
      for (let a = 0; a < s; a++) for (let b = s; b < path.length; b++)
        if (partners[path[a]!]!.has(path[b]!)) return s;
    }
    return -1;
  };
  const maxHalf = Math.min(3, input.maxHops - 1);
  const halves = (anchor: number, reverse: boolean): HalfLayer[] => {
    const result = Array.from({ length: maxHalf }, (_, i) => new HalfLayer(tokens.size, i + 1));
    const path: number[] = [], executionPath: number[] = [];
    stats.phase = reverse ? "reverse" : "forward";
    const extend = (token: number, n: bigint, d: bigint, recurse: boolean): void => {
      const ids = (reverse ? incoming : outgoing)[token]!, begin = firstEligible(ids, n, d);
      for (let i = begin; i < ids.length; i++) {
        if ((stats.expanded++ & 4095) === 0 && expired()) return;
        const id = ids[i]!, edge = edges[id]!, next = reverse ? edge.from : edge.to;
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
        if (recurse && path.length < maxHalf) extend(next, n * edge.n, d * edge.d, true);
        path.pop();
        if (stats.deadlineHit) return;
      }
    };
    if (traversal === "dfs") extend(anchor, 1n, 1n, true);
    else for (let hops = 1; hops <= maxHalf && !stats.deadlineHit; hops++) {
      if (hops === 1) extend(anchor, 1n, 1n, false);
      else {
        const previous = result[hops - 2]!;
        for (let pi = 0; pi < previous.count; pi++) {
          if ((pi & 4095) === 0 && expired()) break;
          previous.read(pi, path);
          if (reverse) path.reverse();
          const endpoint = reverse ? edges[path.at(-1)!]!.from : edges[path.at(-1)!]!.to;
          let n = 1n, d = 1n;
          for (const id of path) { n *= edges[id]!.n; d *= edges[id]!.d; }
          extend(endpoint, n, d, false);
          if (stats.deadlineHit) break;
        }
      }
    }
    return result;
  };
  for (const funding of new Set(input.funding)) {
    if (expired()) break;
    const anchor = tokens.get(funding);
    if (anchor === undefined) { stats.completedFunding++; continue; }
    const forward = halves(anchor, false), reverse = stats.deadlineHit ? [] : halves(anchor, true);
    if (stats.deadlineHit) break;
    stats.phase = "join";
    const p: number[] = [], q: number[] = [];
    outer: for (const a of forward) for (const b of reverse) {
      if (a.hops + b.hops > input.maxHops) continue;
      for (let token = 0; token < tokens.size; token++) {
        if ((token & 4095) === 0 && expired()) break outer;
        if (b.head[token] === NONE) continue;
        for (let pi = a.head[token]!; pi !== NONE;) {
          pi = a.read(pi, p);
          for (let qi = b.head[token]!; qi !== NONE;) {
            qi = b.read(qi, q);
            if ((stats.joins++ & 4095) === 0 && expired()) break outer;
            if (!p.some(left => q.some(right => partners[left]!.has(right)))) continue;
            stats.signalMatched++;
            const path = [...p, ...q];
            if (new Set(path.map(id => edges[id]!.pool)).size !== path.length ||
                new Set(path.map(id => edges[id]!.from)).size !== path.length) continue;
            if (firstSplit(path) !== a.hops) continue;
            let n = 1n, d = 1n;
            const quotes = path.map(id => edges[id]!.quote);
            for (const quote of quotes) { n *= quote.num; d *= quote.den; }
            if (!aboveSpread(n, d, input.minSpreadBps)) continue;
            stats.closed++;
            const spread = (Number(n) / Number(d) - 1) * 10000;
            input.onCycle(quotes, Number.isFinite(spread) ? spread
              : Number(n * 1_000_000_000n / d - 1_000_000_000n) / 100_000);
          }
        }
      }
    }
    if (stats.deadlineHit) break;
    stats.completedFunding++;
  }
  expired(); stats.phase = stats.deadlineHit ? "interrupted" : "complete";
  return stats;
}
export const enumeratePairedDfs = (input: EnumerationInput) => enumerate(input, "dfs");
export const enumeratePairedLayered = (input: EnumerationInput) => enumerate(input, "layered");
