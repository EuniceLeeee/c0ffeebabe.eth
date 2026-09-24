import { aboveSpread, resolvePairedEnumerationOptions, type DfsQuote,
  type PairedEnumerationInput } from "./blockscan-paired-dfs.js";

interface IndexedQuote {
  readonly quote: DfsQuote;
  readonly from: number;
  readonly to: number;
  readonly pool: number;
}

// Algorithm-private, discardable duplicate-work cache; clearing never drops a path.
const MEMO_MAX_ENTRIES = 16_384, MEMO_MAX_CHARACTERS = 1_048_576;

/** A signal fixes sell(anchor -> left) and buy(right -> anchor). Either frontier
 * may then move, sharing one total edge budget and one reference-value floor.
 * The floor is a heuristic prefix policy, not an upper bound on future returns.
 * Token revisits and extensions after a closure remain legal; only pool reuse
 * has an independent policy. Funding rotations are emitted after closure. */
export function enumerateJointDfs(input: PairedEnumerationInput) {
  const { allowRepeatedPools, prefixPruningEnabled, maxPrefixDrawdownBps } = resolvePairedEnumerationOptions(input);
  const prefixFloor = BigInt(10_000 - maxPrefixDrawdownBps);
  const stats = { expanded: 0, completedSignalTokens: 0, completedSignalPairs: 0,
    deadlineHit: false, closed: 0, halfPaths: 0, joins: 0, signalMatched: 0,
    indexedJoinComparisons: 0, joinSkippedBeforeConflicts: 0,
    gateRule: "signal-rooted-joint-prefix" as const,
    prefixPruningEnabled, maxPrefixDrawdownBps, prefixPrunedForward: 0,
    prefixPrunedJoin: 0, prefixPrunedTotal: 0, prefixPrunedJoint: 0,
    jointStates: 0, duplicateStatesSkipped: 0, traversal: "joint-dfs" as const,
    phase: "prepare" };
  const expired = () => stats.deadlineHit ||= Date.now() >= input.deadlineAtMs;
  const finish = () => {
    expired(); stats.phase = stats.deadlineHit ? "interrupted" : "complete";
    return stats;
  };
  if (expired()) return finish();

  const tokens = new Map<string, number>(), pools = new Map<string, number>();
  const intern = (map: Map<string, number>, key: string): number => {
    let id = map.get(key);
    if (id === undefined) { id = map.size; map.set(key, id); }
    return id;
  };
  const byId = new Map<string, number>(), edges: IndexedQuote[] = [];
  for (const quote of input.quotes) {
    if ((edges.length & 1023) === 0 && expired()) return finish();
    if (byId.has(quote.id)) throw new Error("duplicate directed quote id");
    if (quote.num <= 0n || quote.den <= 0n) throw new Error("invalid directed quote amount");
    if (quote.value && (quote.value.num <= 0n || quote.value.den <= 0n))
      throw new Error("invalid quote value");
    byId.set(quote.id, edges.length);
    edges.push({ quote, from: intern(tokens, quote.tokenIn), to: intern(tokens, quote.tokenOut),
      pool: intern(pools, quote.instance) });
  }
  const outgoing: number[][] = Array.from({ length: tokens.size }, () => []);
  const incoming: number[][] = Array.from({ length: tokens.size }, () => []);
  for (let id = 0; id < edges.length; id++) {
    if ((id & 1023) === 0 && expired()) return finish();
    const edge = edges[id]!;
    if (!edge.quote.value) continue;
    outgoing[edge.from]!.push(id); incoming[edge.to]!.push(id);
  }
  const anchors = new Map<number, { buy: number; sell: number }[]>();
  const seedKeys = new Set<string>();
  for (let i = 0; i < input.signals.length; i++) {
    if ((i & 1023) === 0 && expired()) return finish();
    const signal = input.signals[i]!;
    const b = byId.get(signal.buy), s = byId.get(signal.sell);
    if (b === undefined || s === undefined) continue;
    const buy = edges[b]!, sell = edges[s]!;
    if (buy.quote.tokenOut !== signal.token || sell.quote.tokenIn !== signal.token ||
        (!allowRepeatedPools && buy.pool === sell.pool) || signal.den <= 0n || signal.num <= 0n)
      throw new Error("invalid directed price signal");
    if (!buy.quote.value || !sell.quote.value ||
        !aboveSpread(signal.num, signal.den, input.minSpreadBps)) continue;
    const key = `${s},${b}`;
    if (seedKeys.has(key)) continue;
    seedKeys.add(key);
    let seeds = anchors.get(sell.from);
    if (!seeds) { seeds = []; anchors.set(sell.from, seeds); }
    seeds.push({ buy: b, sell: s });
  }
  const funding = new Set(input.funding), emitted = new Set<string>();
  if (funding.size === 0 || anchors.size === 0) return finish();
  stats.phase = "joint";

  for (const seeds of anchors.values()) {
    for (const seed of seeds) {
      if (expired()) break;
      // left is in execution order; right is stored in reverse search order.
      const left = [seed.sell], right = [seed.buy];
      const usedPools = new Set([edges[seed.sell]!.pool, edges[seed.buy]!.pool]);
      const memo = new Set<string>();
      let memoCharacters = 0;
      const emit = (): void => {
        stats.joins++; stats.signalMatched++;
        const path = [...left, ...right.slice().reverse()];
        let n = 1n, d = 1n;
        for (const id of path) {
          const quote = edges[id]!.quote;
          n *= quote.num; d *= quote.den;
        }
        if (!aboveSpread(n, d, input.minSpreadBps)) return;
        const spread = (Number(n) / Number(d) - 1) * 10_000;
        for (let start = 0; start < path.length; start++) {
          if (expired()) return;
          if (!funding.has(edges[path[start]!]!.quote.tokenIn)) continue;
          let key = "";
          for (let offset = 0; offset < path.length; offset++)
            key += (offset === 0 ? "" : ",") + path[(start + offset) % path.length]!;
          if (emitted.has(key)) continue;
          emitted.add(key); stats.closed++;
          const rotated = Array.from({ length: path.length }, (_, offset) =>
            edges[path[(start + offset) % path.length]!]!.quote);
          // Preserve the established spread conversion and caller object identity.
          input.onCycle(rotated, Number.isFinite(spread) ? spread
            : Number(n * 1_000_000_000n / d - 1_000_000_000n) / 100_000);
          if (expired()) return;
        }
      };
      const visit = (leftToken: number, rightToken: number, valueN: bigint, valueD: bigint): void => {
        if (expired()) return;
        if (prefixPruningEnabled && valueN * 10_000n < valueD * prefixFloor) {
          stats.prefixPrunedJoint++; stats.prefixPrunedTotal++; return;
        }
        const hops = left.length + right.length;
        // Only mixed, expandable states can repeat useful future work through
        // a different left/right interleaving. Full paths, not endpoints or
        // products, define identity; failed-floor states are never remembered.
        if (left.length > 1 && right.length > 1 && hops < input.maxHops) {
          const key = `${left.join(",")}|${right.join(",")}`;
          if (memo.has(key)) { stats.duplicateStatesSkipped++; return; }
          if (memo.size >= MEMO_MAX_ENTRIES || memoCharacters + key.length > MEMO_MAX_CHARACTERS) {
            memo.clear(); memoCharacters = 0;
          }
          if (key.length <= MEMO_MAX_CHARACTERS) { memo.add(key); memoCharacters += key.length; }
        }
        stats.jointStates++;
        if (leftToken === rightToken) emit();
        if (stats.deadlineHit || hops >= input.maxHops) return;
        const extend = (reverse: boolean): void => {
          const candidates = reverse ? incoming[rightToken]! : outgoing[leftToken]!;
          const path = reverse ? right : left;
          for (const id of candidates) {
            if ((stats.expanded++ & 1023) === 0 && expired()) return;
            const edge = edges[id]!;
            if (!allowRepeatedPools && usedPools.has(edge.pool)) continue;
            path.push(id);
            if (!allowRepeatedPools) usedPools.add(edge.pool);
            const nextN = prefixPruningEnabled ? valueN * edge.quote.value!.num : valueN;
            const nextD = prefixPruningEnabled ? valueD * edge.quote.value!.den : valueD;
            visit(reverse ? leftToken : edge.to, reverse ? edge.from : rightToken, nextN, nextD);
            if (!allowRepeatedPools) usedPools.delete(edge.pool);
            path.pop();
            if (stats.deadlineHit) return;
          }
        };
        extend(false);
        if (!stats.deadlineHit) extend(true);
      };
      const sell = edges[seed.sell]!, buy = edges[seed.buy]!;
      visit(sell.to, buy.from,
        prefixPruningEnabled ? sell.quote.value!.num * buy.quote.value!.num : 1n,
        prefixPruningEnabled ? sell.quote.value!.den * buy.quote.value!.den : 1n);
      if (stats.deadlineHit) break;
      stats.completedSignalPairs++;
    }
    if (stats.deadlineHit) break;
    stats.completedSignalTokens++;
  }
  return finish();
}
