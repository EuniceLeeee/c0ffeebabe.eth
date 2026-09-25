import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "../blockscan-enumeration-config.js";
import { selectTopHopTokens } from "./blockscan-hop-quotes.js";

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
export type PairedEnumerationMethod = "joint-dfs" | "dfs" | "layered";
export const DEFAULT_ALLOW_REPEATED_POOLS: boolean = BLOCKSCAN_ENUMERATION_DEFAULTS.allowRepeatedPools;
export function resolveAllowRepeatedPools(raw?: string): boolean {
  if (raw === undefined) return DEFAULT_ALLOW_REPEATED_POOLS;
  if (raw === "0" || raw === "1") return raw === "1";
  throw new Error("SEARCHER_BLOCKSCAN_ALLOW_REPEATED_POOLS_ENABLED must be 0 or 1");
}
export function resolvePairedEnumerationMethod(value?: string): PairedEnumerationMethod {
  if (value === undefined) return BLOCKSCAN_ENUMERATION_DEFAULTS.method;
  if (value === "joint-dfs") return value;
  if (value === "dfs") return value;
  if (value === "layered") return value;
  throw new Error("SEARCHER_BLOCKSCAN_ENUMERATION_METHOD must be joint-dfs, dfs or layered");
}
export const aboveSpread = (num: bigint, den: bigint, bps: number): boolean =>
  num * 10_000n > den * BigInt(10_000 + bps);
export interface PairedEnumerationInput {
  readonly quotes: readonly DfsQuote[];
  readonly signals: readonly DirectedPriceSignal[];
  readonly funding: readonly string[];
  readonly minSpreadBps: number;
  readonly maxHops: number;
  /** Top N next tokens by effective reference-value ratio; 0 keeps all tokens. */
  readonly hopTokensPerStep?: number;
  /** Dispatch retains top M distinct pools per directed pair; 0 keeps all pools. */
  readonly hopPoolsPerPair?: number;
  readonly allowRepeatedPools?: boolean;
  readonly prefixPruningEnabled?: boolean;
  readonly maxPrefixDrawdownBps?: number;
  readonly rustThreads?: number;
  readonly rustScratchMb?: number;
  readonly deadlineAtMs: number;
  readonly onCycle: (quotes: readonly DfsQuote[], spreadBps: number) => void;
}
/** Shared policy resolution keeps the TS and native boundary on one contract. */
export function resolvePairedEnumerationOptions(input: PairedEnumerationInput) {
  const allowRepeatedPools = input.allowRepeatedPools ?? DEFAULT_ALLOW_REPEATED_POOLS;
  const prefixPruningEnabled = input.prefixPruningEnabled ?? BLOCKSCAN_ENUMERATION_DEFAULTS.prefixPruningEnabled;
  const maxPrefixDrawdownBps = input.maxPrefixDrawdownBps ?? BLOCKSCAN_ENUMERATION_DEFAULTS.maxPrefixDrawdownBps;
  const rustThreads = input.rustThreads ?? BLOCKSCAN_ENUMERATION_DEFAULTS.rustThreads;
  const rustScratchMb = input.rustScratchMb ?? BLOCKSCAN_ENUMERATION_DEFAULTS.rustScratchMb;
  const hopTokensPerStep = input.hopTokensPerStep ?? BLOCKSCAN_ENUMERATION_DEFAULTS.hopTokensPerStep;
  if (!Number.isSafeInteger(hopTokensPerStep) || hopTokensPerStep < 0)
    throw new Error("hopTokensPerStep must be a nonnegative safe integer");
  if (!Number.isSafeInteger(input.minSpreadBps) || input.minSpreadBps < 0 ||
      !Number.isSafeInteger(input.maxHops) || input.maxHops < 2)
    throw new Error("paired enumeration requires integer spread bps and maxHops >= 2");
  if (typeof prefixPruningEnabled !== "boolean") throw new Error("prefixPruningEnabled must be boolean");
  if (!Number.isSafeInteger(maxPrefixDrawdownBps) || maxPrefixDrawdownBps < 0 || maxPrefixDrawdownBps > 10_000)
    throw new Error("maxPrefixDrawdownBps must be a safe integer from 0 to 10000");
  if (!Number.isSafeInteger(rustThreads) || rustThreads < 1 || rustThreads > 8)
    throw new Error("rustThreads must be an integer from 1 to 8");
  if (!Number.isSafeInteger(rustScratchMb) || rustScratchMb < 1 || rustScratchMb > 2048)
    throw new Error("rustScratchMb must be an integer from 1 to 2048");
  return { allowRepeatedPools, prefixPruningEnabled, maxPrefixDrawdownBps, rustThreads, rustScratchMb, hopTokensPerStep };
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
/** Bounded walks rooted at the price-signal token, joined by token. Each half
 * uses at most ceil(maxHops / 2) edges; their combined length cannot exceed maxHops.
 * No per-half profit gate. Join buckets are sorted by rate so binary search
 * skips combinations below the whole-cycle threshold before conflict checks.
 * Only after joining do we rotate to each available funding token for execution.
 * Optional prefix pruning bounds reference-value loss from the signal anchor,
 * not from a funding rotation or a later peak. Reverse halves are suffixes, so
 * their execution-order prefixes are checked only with the forward value at join.
 * Both traversals share this gate, sorted index, storage and join rules. No future-return
 * or signal-completion pruning. Live caller deadline remains explicitly partial. */
function enumerate(input: PairedEnumerationInput, traversal: PairedEnumerationMethod) {
  const { allowRepeatedPools, prefixPruningEnabled, maxPrefixDrawdownBps, hopTokensPerStep } = resolvePairedEnumerationOptions(input);
  const prefixFloor = prefixPruningEnabled ? BigInt(10_000 - maxPrefixDrawdownBps) : 0n;
  const stats = { expanded: 0, completedSignalTokens: 0, deadlineHit: false, closed: 0,
    halfPaths: 0, joins: 0, signalMatched: 0, indexedJoinComparisons: 0,
    joinSkippedBeforeConflicts: 0, gateRule: "signal-rooted-sorted-profitable-join" as const,
    prefixPruningEnabled, maxPrefixDrawdownBps, prefixPrunedForward: 0, prefixPrunedJoin: 0,
    prefixPrunedTotal: 0, traversal, phase: "prepare", hopTokensPerStep,
    hopTokenForwardQuotes: 0, hopTokenReverseQuotes: 0, hopSignalPairsSelected: 0 };
  const expired = () => stats.deadlineHit ||= Date.now() >= input.deadlineAtMs;
  if (expired()) return stats;
  const selected = selectTopHopTokens(input.quotes, hopTokensPerStep);
  stats.hopTokenForwardQuotes = selected.forward.size;
  stats.hopTokenReverseQuotes = selected.reverse.size;
  const tokens = new Map<string, number>(), pools = new Map<string, number>();
  const intern = (map: Map<string, number>, key: string): number => {
    let id = map.get(key); if (id === undefined) { id = map.size; map.set(key, id); } return id;
  };
  const byId = new Map<string, number>(), edges: IndexedQuote[] = [];
  for (const q of input.quotes) {
    if (byId.has(q.id)) throw new Error("duplicate directed quote id");
    byId.set(q.id, edges.length);
    edges.push({ quote: q, from: intern(tokens, q.tokenIn), to: intern(tokens, q.tokenOut),
      pool: intern(pools, q.instance) });
  }
  const outgoing: number[][] = Array.from({ length: tokens.size }, () => []);
  const incoming: number[][] = Array.from({ length: tokens.size }, () => []);
  for (let id = 0; id < edges.length; id++) {
    const e = edges[id]!; if (!e.quote.value) continue;
    if (selected.forward.has(e.quote.id)) outgoing[e.from]!.push(id);
    if (selected.reverse.has(e.quote.id)) incoming[e.to]!.push(id);
  }
  const partners = edges.map(() => new Set<number>());
  const anchors = new Map<number, { buys: Set<number>; sells: Set<number> }>();
  let pairCount = 0;
  for (const signal of input.signals) {
    const b = byId.get(signal.buy), s = byId.get(signal.sell);
    if (b === undefined || s === undefined) continue;
    const buy = edges[b]!, sell = edges[s]!;
    if (buy.quote.tokenOut !== signal.token || sell.quote.tokenIn !== signal.token ||
        (!allowRepeatedPools && buy.pool === sell.pool) || signal.den <= 0n || signal.num <= 0n)
      throw new Error("invalid directed price signal");
    if (!aboveSpread(signal.num, signal.den, input.minSpreadBps)) continue;
    // With the Token cap disabled, preserve legacy anchor/counter semantics;
    // null-valued quotes still never enter either traversal adjacency.
    if (hopTokensPerStep > 0 && (!selected.forward.has(sell.quote.id) || !selected.reverse.has(buy.quote.id))) continue;
    stats.hopSignalPairsSelected++;
    // Bind this directed signal to its actual sell anchor. With token revisits,
    // reversing a pair can join unrelated occurrences of the signal token.
    partners[s]!.add(b); pairCount++;
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
  const valueRate = (path: readonly number[]) => {
    let n = 1n, d = 1n;
    for (const id of path) {
      const value = edges[id]!.quote.value!;
      n *= value.num; d *= value.den;
    }
    return { n, d };
  };
  const minimumValuePrefix = (path: readonly number[]) => {
    let n = 1n, d = 1n, minN = 1n, minD = 1n;
    for (const id of path) {
      const value = edges[id]!.quote.value!;
      n *= value.num; d *= value.den;
      if (n * minD < minN * d) { minN = n; minD = d; }
    }
    return { n: minN, d: minD };
  };
  const maxHalf = Math.ceil(input.maxHops / 2);
  const halves = (anchor: number, reverse: boolean, seeds: ReadonlySet<number>): HalfLayer[] => {
    const result = Array.from({ length: maxHalf }, (_, i) => new HalfLayer(tokens.size, i + 1));
    const path: number[] = [], executionPath: number[] = [];
    stats.phase = reverse ? "reverse" : "forward";
    const extend = (token: number, recurse: boolean, prefixN = 1n, prefixD = 1n): void => {
      const ids = (reverse ? incoming : outgoing)[token]!;
      for (let i = 0; i < ids.length; i++) {
        if ((stats.expanded++ & 4095) === 0 && expired()) return;
        const id = ids[i]!, edge = edges[id]!, next = reverse ? edge.from : edge.to;
        if (path.length === 0 && !seeds.has(id)) continue;
        let conflict = false;
        for (const oldId of path) {
          const old = edges[oldId]!;
          if (!allowRepeatedPools && old.pool === edge.pool) { conflict = true; break; }
        }
        if (conflict) continue;
        let nextN = prefixN, nextD = prefixD;
        if (prefixPruningEnabled && !reverse) {
          nextN *= edge.quote.value!.num; nextD *= edge.quote.value!.den;
          if (nextN * 10_000n < nextD * prefixFloor) {
            stats.prefixPrunedForward++; stats.prefixPrunedTotal++; continue;
          }
        }
        path.push(id);
        executionPath.length = path.length;
        for (let j = 0; j < path.length; j++) executionPath[j] = path[reverse ? path.length - 1 - j : j]!;
        result[path.length - 1]!.add(next, executionPath); stats.halfPaths++;
        if (recurse && path.length < maxHalf) extend(next, true, nextN, nextD);
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
          if (prefixPruningEnabled && !reverse) {
            const prefix = valueRate(path);
            extend(endpoint, false, prefix.n, prefix.d);
          } else extend(endpoint, false);
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
        const sorted: { index: number; n: bigint; d: bigint; minPrefix?: { n: bigint; d: bigint } }[] = [];
        for (let qi = b.head[token]!; qi !== NONE;) {
          if ((sorted.length & 4095) === 0 && expired()) break outer;
          const index = qi; qi = b.read(qi, q);
          const entry: (typeof sorted)[number] = { index, ...rate(q) };
          if (prefixPruningEnabled) entry.minPrefix = minimumValuePrefix(q);
          sorted.push(entry);
        }
        sorted.sort((x, y) => {
          const delta = x.n * y.d - y.n * x.d;
          return delta < 0n ? -1 : delta > 0n ? 1 : x.index - y.index;
        });
        if (expired()) break outer;
        for (const a of forward) {
          if (a.hops + b.hops > input.maxHops) continue;
          // With no directional Token cap, every split has the same eligibility.
          // Under Top-N an edge may win only one frontier, so the first nominal
          // split may be absent. Try other splits; emitted still deduplicates.
          if (hopTokensPerStep === 0 && a.hops !== Math.max(1, a.hops + b.hops - maxHalf)) continue;
          for (let pi = a.head[token]!; pi !== NONE;) {
            if (expired()) break outer;
            pi = a.read(pi, p);
            const ar = rate(p);
            const forwardValue = prefixPruningEnabled ? valueRate(p) : null;
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
              if (forwardValue && forwardValue.n * br.minPrefix!.n * 10_000n <
                  forwardValue.d * br.minPrefix!.d * prefixFloor) {
                stats.prefixPrunedJoin++; stats.prefixPrunedTotal++; continue;
              }
              // Token revisits are legal. Pool reuse remains an independent
              // policy, checked both within halves and across this join.
              let conflict = false;
              for (const pId of p) {
                const left = edges[pId]!;
                for (const qId of q) {
                  const right = edges[qId]!;
                  if (!allowRepeatedPools && left.pool === right.pool) {
                    conflict = true; break;
                  }
                }
                if (conflict) break;
              }
              if (conflict) continue;
              const path = [...p, ...q];
              const n = ar.n * br.n, d = ar.d * br.d;
              const spread = (Number(n) / Number(d) - 1) * 10000;
              for (let start = 0; start < path.length; start++) {
                if (!funding.has(edges[path[start]!]!.quote.tokenIn)) continue;
                // Interned edge indexes are unique within this enumeration;
                // their delimited sequence has the same identity as quote IDs.
                let key = "";
                for (let offset = 0; offset < path.length; offset++) {
                  key += (offset === 0 ? "" : ",") + path[(start + offset) % path.length]!;
                }
                if (emitted.has(key)) continue;
                emitted.add(key); stats.closed++;
                const rotated = Array.from({ length: path.length }, (_, offset) =>
                  edges[path[(start + offset) % path.length]!]!.quote);
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
export const enumeratePairedDfs = (input: PairedEnumerationInput) => enumerate(input, "dfs");
export const enumeratePairedLayered = (input: PairedEnumerationInput) => enumerate(input, "layered");
