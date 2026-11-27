import { aboveSpread, resolvePairedEnumerationOptions, type DfsQuote,
  type PairedEnumerationInput } from "./blockscan-paired-dfs.js";
import { selectTopHopTokens } from "./blockscan-hop-quotes.js";

interface IndexedQuote {
  readonly quote: DfsQuote;
  readonly from: number;
  readonly to: number;
  readonly pool: number;
  readonly valNum: bigint;
  readonly valDen: bigint;
  readonly valFloat: number;
  readonly valExactOnly: boolean;
  readonly quoteFloat: number;
  readonly quoteExactOnly: boolean;
}

// Algorithm-private, discardable duplicate-work cache; clearing never drops a path.
const MEMO_MAX_ENTRIES = 16_384, MEMO_MAX_CHARACTERS = 1_048_576;
const PACK_BASE = 131_072; // 2^17; 3 * PACK_BASE^3 = 6.75e15 < Number.MAX_SAFE_INTEGER (9.007e15).
const PACK_CUBE = PACK_BASE * PACK_BASE * PACK_BASE;

/** A signal fixes sell(anchor -> left) and buy(right -> anchor). Either frontier
 * may then move, sharing one total edge budget and one reference-value floor.
 * The floor is a heuristic prefix policy, not an upper bound on future returns.
 * Token and pool reuse have independent policies. Simple cycles stop at their
 * first closure. Funding rotations are emitted after closure. */
export function enumerateJointDfs(input: PairedEnumerationInput) {
  const started = performance.now();
  let selectedAt = started, preparedAt = started;
  let selectionComplete = false, indexingComplete = false;
  const { allowRepeatedPools, allowRepeatedTokens, prefixPruningEnabled, maxPrefixDrawdownBps, hopTokensPerStep } = resolvePairedEnumerationOptions(input);
  const prefixFloor = BigInt(10_000 - maxPrefixDrawdownBps);
  const prefixFloorFloat = Number(prefixFloor);
  const prefixAcceptBound = prefixFloorFloat * 1.000001;
  const prefixRejectBound = prefixFloorFloat * 0.999999;
  const spreadRejectBound = (10_000 + input.minSpreadBps) * 0.999999;
  const stats = { expanded: 0, completedSignalTokens: 0, completedSignalPairs: 0,
    deadlineHit: false, closed: 0, halfPaths: 0, joins: 0, signalMatched: 0,
    indexedJoinComparisons: 0, joinSkippedBeforeConflicts: 0,
    gateRule: "signal-rooted-joint-prefix" as const,
    allowRepeatedTokens, prefixPruningEnabled, maxPrefixDrawdownBps, prefixPrunedForward: 0,
    prefixPrunedJoin: 0, prefixPrunedTotal: 0, prefixPrunedJoint: 0,
    jointStates: 0, duplicateStatesSkipped: 0, finalHopUnclosedPruned: 0, traversal: "joint-dfs" as const,
    phase: "prepare", hopTokensPerStep, hopTokenForwardQuotes: 0,
    hopTokenReverseQuotes: 0, hopSignalPairsSelected: 0 };
  const expired = () => stats.deadlineHit ||= Date.now() >= input.deadlineAtMs;
  const finish = () => {
    expired(); stats.phase = stats.deadlineHit ? "interrupted" : "complete";
    if (process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS === "1") {
      const finished = performance.now();
      try { console.log(`[searcher/blockscan-joint-timing] ${JSON.stringify({
        tokenSelectionMs: selectionComplete ? selectedAt - started : finished - started,
        indexingMs: selectionComplete ? (indexingComplete ? preparedAt : finished) - selectedAt : 0,
        searchMs: indexingComplete ? finished - preparedAt : 0, deadlineHit: stats.deadlineHit,
      })}`); } catch { /* Diagnostic observers cannot alter enumeration. */ }
    }
    return stats;
  };
  if (expired()) return finish();
  const selected = selectTopHopTokens(input.quotes, hopTokensPerStep);
  selectedAt = preparedAt = performance.now();
  selectionComplete = true;
  stats.hopTokenForwardQuotes = selected.forward.size;
  stats.hopTokenReverseQuotes = selected.reverse.size;

  const tokens = new Map<string, number>(), pools = new Map<string, number>();
  const intern = (map: Map<string, number>, key: string): number => {
    let id = map.get(key);
    if (id === undefined) { id = map.size; map.set(key, id); }
    return id;
  };
  const byId = new Map<string, number>(), edges: IndexedQuote[] = [];
  for (const quote of input.quotes) {
    if ((edges.length & 1023) === 0 && expired()) return finish();
    byId.set(quote.id, edges.length);
    const valNum = quote.value?.num ?? 1n;
    const valDen = quote.value?.den ?? 1n;
    const valFloat = Number(valNum) / Number(valDen);
    const quoteFloat = Number(quote.num) / Number(quote.den);
    edges.push({
      quote,
      from: intern(tokens, quote.tokenIn),
      to: intern(tokens, quote.tokenOut),
      pool: intern(pools, quote.instance),
      valNum,
      valDen,
      valFloat,
      valExactOnly: !Number.isFinite(valFloat) || valFloat <= 0,
      quoteFloat,
      quoteExactOnly: !Number.isFinite(quoteFloat) || quoteFloat <= 0,
    });
  }
  const outgoing: number[][] = Array.from({ length: tokens.size }, () => []);
  const incoming: number[][] = Array.from({ length: tokens.size }, () => []);
  for (let id = 0; id < edges.length; id++) {
    if ((id & 1023) === 0 && expired()) return finish();
    const edge = edges[id]!;
    if (selected.forward.has(edge.quote.id)) outgoing[edge.from]!.push(id);
    if (selected.reverse.has(edge.quote.id)) incoming[edge.to]!.push(id);
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
    if (!aboveSpread(signal.num, signal.den, input.minSpreadBps)) continue;
    if (!allowRepeatedTokens && (sell.from === sell.to || buy.from === buy.to)) continue;
    if (!selected.forward.has(sell.quote.id) || !selected.reverse.has(buy.quote.id)) continue;
    const key = `${s},${b}`;
    if (seedKeys.has(key)) continue;
    seedKeys.add(key);
    stats.hopSignalPairsSelected++;
    let seeds = anchors.get(sell.from);
    if (!seeds) { seeds = []; anchors.set(sell.from, seeds); }
    seeds.push({ buy: b, sell: s });
  }
  const funding = new Set(input.funding), emitted = new Set<string>();
  const canStart = new Uint8Array(tokens.size);
  for (const f of funding) {
    const tid = tokens.get(f);
    if (tid !== undefined) canStart[tid] = 1;
  }
  preparedAt = performance.now();
  indexingComplete = true;
  if (funding.size === 0 || anchors.size === 0) return finish();
  stats.phase = "joint";

  const usedPools = new Uint8Array(pools.size);
  const usedTokens = new Uint8Array(tokens.size);
  const canPackMemo = edges.length < PACK_BASE;
  const numMemo = new Set<number>();
  const strMemo = new Set<string>();

  for (const seeds of anchors.values()) {
    for (const seed of seeds) {
      if (expired()) break;
      const sell = edges[seed.sell]!, buy = edges[seed.buy]!;
      // left is in execution order; right is stored in reverse search order.
      const left = [seed.sell], right = [seed.buy];
      usedPools[sell.pool] = 1;
      usedPools[buy.pool] = 1;
      usedTokens[sell.from] = 1;
      usedTokens[sell.to] = 1;
      usedTokens[buy.from] = 1;
      numMemo.clear();
      strMemo.clear();
      let strMemoCharacters = 0;

      const emit = (): void => {
        stats.joins++; stats.signalMatched++;
        const pathLen = left.length + right.length;
        const path = new Array<number>(pathLen);
        let pIdx = 0;
        let qFloat = 1;
        let qExact = false;
        for (let i = 0; i < left.length; i++) {
          const id = left[i]!;
          path[pIdx++] = id;
          const e = edges[id]!;
          qFloat *= e.quoteFloat;
          if (e.quoteExactOnly) qExact = true;
        }
        for (let i = right.length - 1; i >= 0; i--) {
          const id = right[i]!;
          path[pIdx++] = id;
          const e = edges[id]!;
          qFloat *= e.quoteFloat;
          if (e.quoteExactOnly) qExact = true;
        }
        if (!qExact && Number.isFinite(qFloat) && qFloat > 0 && qFloat * 10_000 < spreadRejectBound) return;
        let n = 1n, d = 1n;
        for (let i = 0; i < pathLen; i++) {
          const q = edges[path[i]!]!.quote;
          n *= q.num; d *= q.den;
        }
        if (!aboveSpread(n, d, input.minSpreadBps)) return;
        const spread = (Number(n) / Number(d) - 1) * 10_000;
        for (let start = 0; start < pathLen; start++) {
          if (expired()) return;
          if (canStart[edges[path[start]!]!.from] === 0) continue;
          let key = "";
          for (let offset = 0; offset < pathLen; offset++)
            key += (offset === 0 ? "" : ",") + path[(start + offset) % pathLen]!;
          if (emitted.has(key)) continue;
          emitted.add(key); stats.closed++;
          const rotated = Array.from({ length: pathLen }, (_, offset) =>
            edges[path[(start + offset) % pathLen]!]!.quote);
          // Preserve the established spread conversion and caller object identity.
          input.onCycle(rotated, Number.isFinite(spread) ? spread
            : Number(n * 1_000_000_000n / d - 1_000_000_000n) / 100_000);
          if (expired()) return;
        }
      };

      const exactPrefixPruned = (): boolean => {
        let valueN = 1n, valueD = 1n;
        for (let i = 0; i < left.length; i++) {
          const e = edges[left[i]!]!;
          valueN *= e.valNum; valueD *= e.valDen;
        }
        for (let i = 0; i < right.length; i++) {
          const e = edges[right[i]!]!;
          valueN *= e.valNum; valueD *= e.valDen;
        }
        return valueN * 10_000n < valueD * prefixFloor;
      };

      const visit = (leftToken: number, rightToken: number, valFloat: number, valExact: boolean): void => {
        if (stats.deadlineHit || ((stats.jointStates & 255) === 0 && expired())) return;
        if (prefixPruningEnabled) {
          if (!valExact && Number.isFinite(valFloat) && valFloat > 0) {
            const scaled = valFloat * 10_000;
            if (scaled < prefixRejectBound) {
              stats.prefixPrunedJoint++; stats.prefixPrunedTotal++; return;
            }
            if (scaled <= prefixAcceptBound && exactPrefixPruned()) {
              stats.prefixPrunedJoint++; stats.prefixPrunedTotal++; return;
            }
          } else if (exactPrefixPruned()) {
            stats.prefixPrunedJoint++; stats.prefixPrunedTotal++; return;
          }
        }
        const hops = left.length + right.length;
        // Only mixed, expandable states can repeat useful future work through
        // a different left/right interleaving. Full paths, not endpoints or
        // products, define identity; failed-floor states are never remembered.
        if (left.length > 1 && right.length > 1 && hops < input.maxHops) {
          if (canPackMemo && hops <= 5) {
            const packed = left.length === 2 && right.length === 2
              ? left[1]! * PACK_BASE + right[1]!
              : left.length === 3
                ? PACK_CUBE + (left[1]! * PACK_BASE + left[2]!) * PACK_BASE + right[1]!
                : 2 * PACK_CUBE + (left[1]! * PACK_BASE + right[1]!) * PACK_BASE + right[2]!;
            if (numMemo.has(packed)) { stats.duplicateStatesSkipped++; return; }
            if (numMemo.size >= MEMO_MAX_ENTRIES) numMemo.clear();
            numMemo.add(packed);
          } else {
            const key = `${left.join(",")}|${right.join(",")}`;
            if (strMemo.has(key)) { stats.duplicateStatesSkipped++; return; }
            if (strMemo.size >= MEMO_MAX_ENTRIES || strMemoCharacters + key.length > MEMO_MAX_CHARACTERS) {
              strMemo.clear(); strMemoCharacters = 0;
            }
            if (key.length <= MEMO_MAX_CHARACTERS) { strMemo.add(key); strMemoCharacters += key.length; }
          }
        }
        stats.jointStates++;
        if (leftToken === rightToken) {
          emit();
          if (!allowRepeatedTokens) return;
        }
        if (stats.deadlineHit || hops >= input.maxHops) return;
        const extend = (reverse: boolean): void => {
          const candidates = reverse ? incoming[rightToken]! : outgoing[leftToken]!;
          const path = reverse ? right : left;
          for (let ci = 0; ci < candidates.length; ci++) {
            const id = candidates[ci]!;
            if ((stats.expanded++ & 1023) === 0 && expired()) return;
            const edge = edges[id]!;
            if (!allowRepeatedPools && usedPools[edge.pool] !== 0) continue;
            const next = reverse ? edge.from : edge.to;
            const closes = next === (reverse ? leftToken : rightToken);
            // Both seed legs count toward the configured total. With only one
            // hop left, an edge that cannot meet the other frontier is dead.
            if (hops + 1 === input.maxHops && !closes) {
              stats.finalHopUnclosedPruned++;
              continue;
            }
            if (!allowRepeatedTokens && usedTokens[next] !== 0 && !closes) continue;
            path.push(id);
            if (!allowRepeatedPools) usedPools[edge.pool] = 1;
            if (!allowRepeatedTokens && !closes) usedTokens[next] = 1;
            const nextFloat = prefixPruningEnabled ? valFloat * edge.valFloat : 1;
            const nextExact = prefixPruningEnabled ? (valExact || edge.valExactOnly) : false;
            visit(reverse ? leftToken : edge.to, reverse ? edge.from : rightToken, nextFloat, nextExact);
            if (!allowRepeatedPools) usedPools[edge.pool] = 0;
            if (!allowRepeatedTokens && !closes) usedTokens[next] = 0;
            path.pop();
            if (stats.deadlineHit) return;
          }
        };
        extend(false);
        if (!stats.deadlineHit) extend(true);
      };

      try {
        visit(sell.to, buy.from,
          prefixPruningEnabled ? sell.valFloat * buy.valFloat : 1,
          prefixPruningEnabled ? (sell.valExactOnly || buy.valExactOnly) : false);
      } finally {
        usedPools[sell.pool] = 0;
        usedPools[buy.pool] = 0;
        usedTokens[sell.from] = 0;
        usedTokens[sell.to] = 0;
        usedTokens[buy.from] = 0;
      }
      if (stats.deadlineHit) break;
      stats.completedSignalPairs++;
    }
    if (stats.deadlineHit) break;
    stats.completedSignalTokens++;
  }
  return finish();
}
