import { ADDR } from "../../shared/constants/addresses.js";
import { canonicalTokenRing, cycleFingerprint } from "./cycle-fingerprint.js";
import type { BlockScanOpportunity } from "./detector.js";
import { buildTokenPaths, type TokenEdge } from "../planner/token-graph.js";
import type { CurveSnapshot, PoolStateCache, V2Seed, V3Snapshot } from "../solver/pool-state-cache.js";
import { getAmount0Delta, getAmount1Delta } from "../solver/v3-math.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";

export interface BlockScanConfig {
  maxHops: number;
  minSpreadBps: number;
  maxCandidates: number;
  budgetMs: number;
  pricedTokens: Map<string, { maxBorrow: bigint }>;
  protocolMids?: ReadonlyMap<string, ProtocolMid>;
}

export interface ProtocolMid {
  /** tokenOut raw units per 1 raw unit of tokenIn (decimals INCLUDED, same convention as AMM mids). */
  mid: number;
  feeBps: number;
  /** Max plausible size in tokenIn raw units (depth proxy for sizing/ranking). */
  depthIn: bigint;
}

export interface BlockScanOutcome {
  outcome: "ran" | "budget_exceeded";
  stateBlock: number | null;
  scannedPairs: number;
  swapTouchedPools: number;
  opportunities: BlockScanOpportunity[];
  debug?: { skippedVenues: number };
}

type VenueKind = "v2" | "v3" | "curve" | "protocol";

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
  const anchorTokens = new Set<string>();
  let scannedPairs = 0;
  let skippedVenues = 0;

  const finish = (outcome: BlockScanOutcome["outcome"]): BlockScanOutcome => {
    ranked.sort((a, b) => b.rank - a.rank);
    const deduped: RankedOpportunity[] = [];
    const seenFingerprints = new Set<string>();
    for (const entry of ranked) {
      if (seenFingerprints.has(entry.opportunity.cycleFingerprint)) continue;
      seenFingerprints.add(entry.opportunity.cycleFingerprint);
      deduped.push(entry);
    }
    return {
      outcome,
      stateBlock: input.sourceBlock,
      scannedPairs,
      swapTouchedPools: touched?.size ?? 0,
      opportunities: deduped.slice(0, input.cfg.maxCandidates).map((entry) => entry.opportunity),
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
      const mid = readVenueMid(input.cache, input.sourceBlock, group.a, group.b, pool, edges, input.cfg.protocolMids);
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
    anchorTokens.add(group.a);
    anchorTokens.add(group.b);

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

  for (const edge of input.edges) {
    if (edge.slotKind !== "protocol" || edge.leavesStandingPosition) continue;
    anchorTokens.add(edge.tokenIn.toLowerCase());
    anchorTokens.add(edge.tokenOut.toLowerCase());
  }

  for (const anchorToken of anchorTokens) {
    if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
    const rings = buildTokenPaths(input.edges, anchorToken, anchorToken, {
      maxHops: input.cfg.maxHops,
      maxPoolsPerToken: 8,
      maxPaths: 2000,
      deadlineAtMs,
    });
    if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");

    for (const ring of rings) {
      if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
      if (pathLeavesStandingPosition(ring.edges)) continue;
      const score = scoreRing(input.cache, input.sourceBlock, ring.edges, input.cfg.protocolMids);
      if (!score || score.estSpreadBps <= input.cfg.minSpreadBps) continue;

      const ringTokens = ringTokensWithoutRepeat(ring.edges);
      const flashToken = pickRingFlashToken(ringTokens, input.cfg.pricedTokens);
      if (!flashToken) continue;
      const seedEdges = rotateRingEdges(ring.edges, flashToken);
      if (!seedEdges) continue;

      const firstVenue = readEdgeVenueMid(input.cache, input.sourceBlock, seedEdges[0], input.cfg.protocolMids);
      if (!firstVenue) continue;
      const maxBorrow = input.cfg.pricedTokens.get(flashToken)?.maxBorrow ?? 0n;
      const spreadMultiplier = 1 + score.estSpreadBps / 10_000;
      const minMid = firstVenue.mid / Math.max(spreadMultiplier, 1);
      const sizing = estimateSizing(
        firstVenue,
        flashToken,
        seedEdges[0].tokenIn.toLowerCase(),
        seedEdges[0].tokenOut.toLowerCase(),
        minMid,
        firstVenue.mid,
        score.estSpreadBps,
        maxBorrow,
      );
      if (!sizing || sizing.searchCenter <= 8n) continue;

      const rotatedRingTokens = ringTokensWithoutRepeat(seedEdges);
      const canonicalRing = canonicalTokenRing(rotatedRingTokens);
      const opportunity: BlockScanOpportunity = {
        kind: "block-scan-arb",
        sourceBlock: input.sourceBlock,
        stateBlock: input.sourceBlock,
        cycleId: canonicalRing.join("|"),
        cycleFingerprint: cycleFingerprint(input.sourceBlock, rotatedRingTokens),
        seedEdges,
        flashToken,
        searchSeed: {
          startToken: flashToken,
          searchCenter: sizing.searchCenter,
          maxInput: sizing.maxInput,
        },
        leavesStandingPosition: pathLeavesStandingPosition(seedEdges),
        affectedPools: uniqueLowercase(seedEdges.map((edge) => edge.target)),
        affectedTokens: canonicalRing,
      };
      const depth = Math.max(1, score.minDepth);
      ranked.push({ opportunity, rank: score.estSpreadBps * Math.log10(depth) });
    }
  }

  return finish("ran");
}

function groupPairs(edges: TokenEdge[]): Map<string, PairGroup> {
  const groups = new Map<string, PairGroup>();
  for (const edge of edges) {
    if (edge.slotKind !== "swap" && (edge.slotKind !== "protocol" || edge.leavesStandingPosition)) continue;
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
  protocolMids?: ReadonlyMap<string, ProtocolMid>,
): VenueMid | null {
  const kind = venueKind(edges[0]);
  if (!kind) return null;
  if (kind === "v2") return readV2Mid(cache.snapshotV2(pool, sourceBlock), pool, edges, a, b);
  if (kind === "v3") return readV3Mid(cache.snapshotV3(pool, sourceBlock), pool, edges, a, b);
  if (kind === "protocol") return readProtocolMid(protocolMids, pool, edges, a, b);
  return readCurveMid(cache.snapshotCurve(pool, sourceBlock), pool, edges, a, b);
}

function venueKind(edge: TokenEdge): VenueKind | null {
  if (edge.slotKind === "protocol") return "protocol";
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

function readProtocolMid(
  protocolMids: ReadonlyMap<string, ProtocolMid> | undefined,
  pool: string,
  edges: TokenEdge[],
  a: string,
  b: string,
): VenueMid | null {
  if (!protocolMids || !findEdge(edges, a, b)) return null;
  const direct = protocolMids.get(`${pool}|${a}|${b}`);
  const reverse = direct ? null : protocolMids.get(`${pool}|${b}|${a}`);
  const quoted = direct ?? reverse;
  if (!quoted || !Number.isFinite(quoted.mid) || quoted.mid <= 0 || quoted.depthIn <= 0n) return null;
  const mid = direct ? quoted.mid : 1 / quoted.mid;
  const reserveBNumber = Number(quoted.depthIn) * mid;
  if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(reserveBNumber) || reserveBNumber <= 0) {
    return null;
  }
  const reserveA = quoted.depthIn;
  const reserveB = BigInt(Math.floor(reserveBNumber));
  if (reserveB <= 0n) return null;
  return {
    kind: "protocol",
    pool,
    edges,
    mid,
    feeBps: quoted.feeBps,
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

function readEdgeVenueMid(
  cache: PoolStateCache,
  sourceBlock: number,
  edge: TokenEdge,
  protocolMids?: ReadonlyMap<string, ProtocolMid>,
): VenueMid | null {
  return readVenueMid(
    cache,
    sourceBlock,
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.target.toLowerCase(),
    [edge],
    protocolMids,
  );
}

function edgeMidTimesOneMinusFee(
  cache: PoolStateCache,
  sourceBlock: number,
  edge: TokenEdge,
  protocolMids?: ReadonlyMap<string, ProtocolMid>,
): number | null {
  const venue = readEdgeVenueMid(cache, sourceBlock, edge, protocolMids);
  if (!venue || venue.feeBps >= 10_000) return null;
  const adjusted = venue.mid * (1 - venue.feeBps / 10_000);
  return Number.isFinite(adjusted) && adjusted > 0 ? adjusted : null;
}

function scoreRing(
  cache: PoolStateCache,
  sourceBlock: number,
  edges: TokenEdge[],
  protocolMids?: ReadonlyMap<string, ProtocolMid>,
): { estSpreadBps: number; minDepth: number } | null {
  if (edges.length === 0 || !isClosedContinuousRing(edges)) return null;
  const tokens = ringTokensWithoutRepeat(edges);
  if (new Set(tokens).size !== tokens.length) return null;
  let logSum = 0;
  let minDepth = Infinity;
  for (const edge of edges) {
    const adjustedMid = edgeMidTimesOneMinusFee(cache, sourceBlock, edge, protocolMids);
    if (adjustedMid === null) return null;
    const venue = readEdgeVenueMid(cache, sourceBlock, edge, protocolMids);
    if (!venue) return null;
    logSum += Math.log(adjustedMid);
    minDepth = Math.min(minDepth, venue.depthProxy);
  }
  if (!Number.isFinite(logSum) || logSum <= 0 || !Number.isFinite(minDepth)) return null;
  const estSpreadBps = (Math.exp(logSum) - 1) * 10_000;
  return Number.isFinite(estSpreadBps) && estSpreadBps > 0 ? { estSpreadBps, minDepth } : null;
}

function isClosedContinuousRing(edges: TokenEdge[]): boolean {
  if (edges.length === 0) return false;
  for (let i = 1; i < edges.length; i++) {
    if (edges[i - 1].tokenOut.toLowerCase() !== edges[i].tokenIn.toLowerCase()) return false;
  }
  return edges[edges.length - 1].tokenOut.toLowerCase() === edges[0].tokenIn.toLowerCase();
}

function ringTokensWithoutRepeat(edges: TokenEdge[]): string[] {
  if (edges.length === 0) return [];
  const tokens = [edges[0].tokenIn.toLowerCase(), ...edges.map((edge) => edge.tokenOut.toLowerCase())];
  if (tokens.length > 1 && tokens[tokens.length - 1] === tokens[0]) tokens.pop();
  return tokens;
}

function pickRingFlashToken(ringTokens: string[], pricedTokens: Map<string, { maxBorrow: bigint }>): string | null {
  const tokens = ringTokens.map((token) => token.toLowerCase());
  if (tokens.includes(WETH) && pricedTokens.has(WETH)) return WETH;
  return tokens.find((token) => pricedTokens.has(token)) ?? null;
}

function rotateRingEdges(edges: TokenEdge[], startToken: string): TokenEdge[] | null {
  const wanted = startToken.toLowerCase();
  for (let i = 0; i < edges.length; i++) {
    if (edges[i].tokenIn.toLowerCase() !== wanted) continue;
    const rotated = [...edges.slice(i), ...edges.slice(0, i)];
    if (isClosedContinuousRing(rotated) && rotated[0].tokenIn.toLowerCase() === wanted) return rotated;
  }
  return null;
}

function uniqueLowercase(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
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
