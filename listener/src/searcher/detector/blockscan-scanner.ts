import { ADDR } from "../../shared/constants/addresses.js";
import { canonicalTokenRing, cycleFingerprint } from "./cycle-fingerprint.js";
import type { BlockScanOpportunity } from "./detector.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { CurveSnapshot, PoolStateCache, V2Seed, V3Snapshot } from "../solver/pool-state-cache.js";
import { getAmount0Delta, getAmount1Delta } from "../solver/v3-math.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";

export interface BlockScanConfig {
  maxHops: number;
  minSpreadBps: number;
  maxCandidates: number;
  budgetMs: number;
  pricedTokens: Map<string, { maxBorrow: bigint }>;
}

export interface BlockScanOutcome {
  outcome: "ran" | "budget_exceeded";
  stateBlock: number | null;
  scannedPairs: number;
  swapTouchedPools: number;
  opportunities: BlockScanOpportunity[];
  debug?: { skippedVenues: number };
}

type VenueKind = "v2" | "v3" | "curve";

interface PairGroup {
  a: string;
  b: string;
  venues: Map<string, TokenEdge[]>;
}

interface VenueMid {
  kind: VenueKind;
  pool: string;
  edges: TokenEdge[];
  mid: number;
  feeBps: number;
  reserveA?: bigint;
  reserveB?: bigint;
  sqrtABX96?: bigint;
  liquidity?: bigint;
  depthProxy: number;
}

interface RankedOpportunity {
  opportunity: BlockScanOpportunity;
  rank: number;
}

const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const MIN_SEARCH_CENTER = 1_000n;
const WETH = ADDR.WETH.toLowerCase();

export function detectBlockScanOpportunities(input: {
  edges: TokenEdge[];
  cache: PoolStateCache;
  sourceBlock: number;
  swapTouched: Set<string> | null;
  cfg: BlockScanConfig;
}): BlockScanOutcome {
  const deadlineAtMs = Date.now() + input.cfg.budgetMs;
  const touched = input.swapTouched
    ? new Set([...input.swapTouched].map((pool) => pool.toLowerCase()))
    : null;
  const groups = groupPairs(input.edges);
  const ranked: RankedOpportunity[] = [];
  let scannedPairs = 0;
  let skippedVenues = 0;

  const finish = (outcome: BlockScanOutcome["outcome"]): BlockScanOutcome => {
    ranked.sort((a, b) => b.rank - a.rank);
    return {
      outcome,
      stateBlock: input.sourceBlock,
      scannedPairs,
      swapTouchedPools: touched?.size ?? 0,
      opportunities: ranked.slice(0, input.cfg.maxCandidates).map((entry) => entry.opportunity),
      debug: { skippedVenues },
    };
  };

  for (const group of groups.values()) {
    if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
    if (group.venues.size < 2) continue;
    if (touched && !pairTouches(group, touched)) continue;
    scannedPairs++;

    const venues: VenueMid[] = [];
    for (const [pool, edges] of group.venues) {
      if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
      const mid = readVenueMid(input.cache, input.sourceBlock, group.a, group.b, pool, edges);
      if (mid) venues.push(mid);
      else skippedVenues++;
    }
    if (venues.length < 2) continue;

    let minVenue = venues[0];
    let maxVenue = venues[0];
    for (const venue of venues.slice(1)) {
      if (venue.mid < minVenue.mid) minVenue = venue;
      if (venue.mid > maxVenue.mid) maxVenue = venue;
    }
    if (minVenue.mid <= 0 || maxVenue.mid <= minVenue.mid) continue;

    const estSpreadBps =
      ((maxVenue.mid - minVenue.mid) / minVenue.mid) * 10_000 -
      minVenue.feeBps -
      maxVenue.feeBps;
    if (!Number.isFinite(estSpreadBps) || estSpreadBps <= input.cfg.minSpreadBps) continue;

    const flashToken = pickFlashToken(group.a, group.b, input.cfg.pricedTokens);
    if (!flashToken) continue;
    const otherToken = flashToken === group.a ? group.b : group.a;
    const cheapVenue = flashToken === group.a ? maxVenue : minVenue;
    const richVenue = flashToken === group.a ? minVenue : maxVenue;
    if (cheapVenue.pool === richVenue.pool) continue;

    const buyCheap = findEdge(cheapVenue.edges, flashToken, otherToken);
    const sellRich = findEdge(richVenue.edges, otherToken, flashToken);
    if (!buyCheap || !sellRich) continue;
    const seedEdges = [buyCheap, sellRich];

    const maxBorrow = input.cfg.pricedTokens.get(flashToken)?.maxBorrow ?? 0n;
    const sizing = estimateSizing(cheapVenue, flashToken, group.a, group.b, minVenue.mid, maxVenue.mid, estSpreadBps, maxBorrow);
    if (!sizing || sizing.searchCenter <= 8n) continue;

    const ring = [flashToken, otherToken];
    const canonicalRing = canonicalTokenRing(ring);
    const opportunity: BlockScanOpportunity = {
      kind: "block-scan-arb",
      sourceBlock: input.sourceBlock,
      stateBlock: input.sourceBlock,
      cycleId: canonicalRing.join("|"),
      cycleFingerprint: cycleFingerprint(input.sourceBlock, ring),
      seedEdges,
      flashToken,
      searchSeed: {
        startToken: flashToken,
        searchCenter: sizing.searchCenter,
        maxInput: sizing.maxInput,
      },
      leavesStandingPosition: pathLeavesStandingPosition(seedEdges),
      affectedPools: [cheapVenue.pool, richVenue.pool],
      affectedTokens: canonicalRing,
    };
    const depth = Math.max(1, Math.min(cheapVenue.depthProxy, richVenue.depthProxy));
    ranked.push({ opportunity, rank: estSpreadBps * Math.log10(depth) });
  }

  return finish("ran");
}

function groupPairs(edges: TokenEdge[]): Map<string, PairGroup> {
  const groups = new Map<string, PairGroup>();
  for (const edge of edges) {
    if (edge.slotKind !== "swap") continue;
    const tokenIn = edge.tokenIn.toLowerCase();
    const tokenOut = edge.tokenOut.toLowerCase();
    if (tokenIn === tokenOut) continue;
    const [a, b] = tokenIn < tokenOut ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
    const key = `${a}|${b}`;
    let group = groups.get(key);
    if (!group) {
      group = { a, b, venues: new Map() };
      groups.set(key, group);
    }
    const pool = edge.target.toLowerCase();
    const venueEdges = group.venues.get(pool);
    if (venueEdges) venueEdges.push(edge);
    else group.venues.set(pool, [edge]);
  }
  return groups;
}

function pairTouches(group: PairGroup, touched: Set<string>): boolean {
  for (const pool of group.venues.keys()) {
    if (touched.has(pool)) return true;
  }
  return false;
}

function readVenueMid(
  cache: PoolStateCache,
  sourceBlock: number,
  a: string,
  b: string,
  pool: string,
  edges: TokenEdge[],
): VenueMid | null {
  const kind = venueKind(edges[0]);
  if (!kind) return null;
  if (kind === "v2") return readV2Mid(cache.snapshotV2(pool, sourceBlock), pool, edges, a, b);
  if (kind === "v3") return readV3Mid(cache.snapshotV3(pool, sourceBlock), pool, edges, a, b);
  return readCurveMid(cache.snapshotCurve(pool, sourceBlock), pool, edges, a, b);
}

function venueKind(edge: TokenEdge): VenueKind | null {
  const adapterId = edge.adapterId.toLowerCase();
  if (adapterId.includes("univ2")) return "v2";
  if (adapterId.includes("univ3")) return "v3";
  if (adapterId.includes("curve")) return "curve";
  return null;
}

function readV2Mid(snapshot: V2Seed | null, pool: string, edges: TokenEdge[], a: string, b: string): VenueMid | null {
  if (!snapshot) return null;
  const token0 = snapshot.token0.toLowerCase();
  const token1 = snapshot.token1.toLowerCase();
  const reserveA = token0 === a ? snapshot.reserve0 : token1 === a ? snapshot.reserve1 : null;
  const reserveB = token0 === b ? snapshot.reserve0 : token1 === b ? snapshot.reserve1 : null;
  if (reserveA === null || reserveB === null || reserveA <= 0n || reserveB <= 0n) return null;
  const mid = Number(reserveB) / Number(reserveA);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return {
    kind: "v2",
    pool,
    edges,
    mid,
    feeBps: 30,
    reserveA,
    reserveB,
    depthProxy: Number(minBigint(reserveA, reserveB)),
  };
}

function readV3Mid(snapshot: V3Snapshot | null, pool: string, edges: TokenEdge[], a: string, b: string): VenueMid | null {
  if (!snapshot || snapshot.state.sqrtPriceX96 <= 0n || snapshot.state.liquidity <= 0n) return null;
  const token0 = snapshot.token0.toLowerCase();
  const token1 = snapshot.token1.toLowerCase();
  const price0To1 = sqrtPriceToNumber(snapshot.state.sqrtPriceX96) ** 2;
  let mid: number;
  let sqrtABX96: bigint;
  if (token0 === a && token1 === b) {
    mid = price0To1;
    sqrtABX96 = snapshot.state.sqrtPriceX96;
  } else if (token0 === b && token1 === a) {
    mid = 1 / price0To1;
    sqrtABX96 = Q192 / snapshot.state.sqrtPriceX96;
  } else {
    return null;
  }
  if (!Number.isFinite(mid) || mid <= 0 || sqrtABX96 <= 0n) return null;
  return {
    kind: "v3",
    pool,
    edges,
    mid,
    feeBps: Number(snapshot.state.fee) / 100,
    sqrtABX96,
    liquidity: snapshot.state.liquidity,
    depthProxy: Number(snapshot.state.liquidity),
  };
}

function readCurveMid(
  snapshot: CurveSnapshot | null,
  pool: string,
  edges: TokenEdge[],
  a: string,
  b: string,
): VenueMid | null {
  if (!snapshot) return null;
  const state = snapshot.kind === "plain" ? snapshot.plain : snapshot.ng;
  if (!state || !state.balances || state.balances.length === 0) return null;
  const i = snapshot.coins.findIndex((coin) => coin.toLowerCase() === a);
  const j = snapshot.coins.findIndex((coin) => coin.toLowerCase() === b);
  if (i < 0 || j < 0) return null;
  const reserveA = state.balances[i];
  const reserveB = state.balances[j];
  if (reserveA <= 0n || reserveB <= 0n) return null;
  const mid = Number(reserveB) / Number(reserveA);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return {
    kind: "curve",
    pool,
    edges,
    mid,
    feeBps: state.fee === undefined ? 4 : Number(state.fee) / 1_000_000,
    reserveA,
    reserveB,
    depthProxy: Number(minBigint(reserveA, reserveB)),
  };
}

function sqrtPriceToNumber(sqrtPriceX96: bigint): number {
  return Number(sqrtPriceX96) / Number(Q96);
}

function pickFlashToken(a: string, b: string, pricedTokens: Map<string, { maxBorrow: bigint }>): string | null {
  const hasA = pricedTokens.has(a);
  const hasB = pricedTokens.has(b);
  if (!hasA && !hasB) return null;
  if ((a === WETH && hasA) || (b === WETH && hasB)) return WETH;
  return hasA ? a : b;
}

function findEdge(edges: TokenEdge[], tokenIn: string, tokenOut: string): TokenEdge | null {
  return edges.find(
    (edge) => edge.tokenIn.toLowerCase() === tokenIn && edge.tokenOut.toLowerCase() === tokenOut,
  ) ?? null;
}

function estimateSizing(
  cheapVenue: VenueMid,
  flashToken: string,
  a: string,
  b: string,
  minMid: number,
  maxMid: number,
  estSpreadBps: number,
  maxBorrow: bigint,
): { searchCenter: bigint; maxInput: bigint } | null {
  const reserveIn = reserveForToken(cheapVenue, flashToken, a, b);
  const ceiling = minBigint(reserveIn / 4n, maxBorrow);
  if (ceiling <= 8n) return null;

  let rawCenter: bigint;
  if (cheapVenue.kind === "v3" && cheapVenue.sqrtABX96 && cheapVenue.liquidity) {
    const targetMid = Math.sqrt(minMid * maxMid);
    const targetSqrtABX96 = numberToSqrtPriceX96(Math.sqrt(targetMid));
    if (targetSqrtABX96 <= 0n) return null;
    rawCenter = flashToken === a
      ? getAmount0Delta(targetSqrtABX96, cheapVenue.sqrtABX96, cheapVenue.liquidity, true)
      : getAmount1Delta(cheapVenue.sqrtABX96, targetSqrtABX96, cheapVenue.liquidity, true);
  } else {
    rawCenter = (reserveIn * BigInt(Math.max(1, Math.floor(estSpreadBps)))) / 20_000n;
  }

  const lower = ceiling < MIN_SEARCH_CENTER ? ceiling : MIN_SEARCH_CENTER;
  return { searchCenter: clampBigint(rawCenter, lower, ceiling), maxInput: ceiling };
}

function reserveForToken(venue: VenueMid, token: string, a: string, b: string): bigint {
  if (venue.reserveA !== undefined && venue.reserveB !== undefined) {
    return token === a ? venue.reserveA : token === b ? venue.reserveB : 0n;
  }
  return venue.liquidity ?? 0n;
}

function numberToSqrtPriceX96(sqrtPrice: number): bigint {
  if (!Number.isFinite(sqrtPrice) || sqrtPrice <= 0) return 0n;
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

function clampBigint(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
