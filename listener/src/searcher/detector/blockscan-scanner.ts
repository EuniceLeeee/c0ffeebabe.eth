import { ADDR } from "../../shared/constants/addresses.js";
import { canonicalTokenRing, cycleFingerprint } from "./cycle-fingerprint.js";
import type { BlockScanOpportunity } from "./detector.js";
import { buildTokenPaths, type TokenEdge, v4PoolId } from "../planner/token-graph.js";
import type { PoolStateCache } from "../solver/pool-state-cache.js";
import { getAmount0Delta, getAmount1Delta } from "../solver/v3-math.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import {
  readProtocolExternalMid,
  type ExternalMidQuote,
  type RouteVenueMid,
} from "../venues/mid-readers.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";

export interface BlockScanConfig {
  maxHops: number;
  minSpreadBps: number;
  maxCandidates: number;
  budgetMs: number;
  pricedTokens: Map<string, { maxBorrow: bigint }>;
  protocolMids?: ReadonlyMap<string, ProtocolMid>;
  /** Code-owned protocol edges do not consume the scored DEX-edge budget. */
  pinnedOutsideBudget?: boolean;
}

export interface ProtocolMid extends ExternalMidQuote {}

export interface BlockScanOutcome {
  outcome: "ran" | "budget_exceeded";
  stateBlock: number | null;
  scannedPairs: number;
  swapTouchedPools: number;
  opportunities: BlockScanOpportunity[];
  debug?: { skippedVenues: number };
}

interface PairGroup {
  a: string;
  b: string;
  venues: Map<string, TokenEdge[]>;
}

type VenueMid = RouteVenueMid;

interface RankedOpportunity {
  opportunity: BlockScanOpportunity;
  rank: number;
}

const Q96 = 1n << 96n;
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
    const seenRoutes = new Set<string>();
    for (const entry of ranked) {
      const route = directedRouteFingerprint(entry.opportunity.seedEdges);
      if (seenRoutes.has(route)) continue;
      seenRoutes.add(route);
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
    const routeScore = scoreRing(input.cache, input.sourceBlock, seedEdges, input.cfg.protocolMids);
    if (!routeScore) continue;
    const routeMaxInput = bigintFloor(routeScore.maxStartDepth / 4);
    const sizing = estimateSizing(
      cheapVenue,
      flashToken,
      group.a,
      group.b,
      minVenue.mid,
      maxVenue.mid,
      routeScore.estSpreadBps,
      maxBorrow,
      routeMaxInput,
    );
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
    ranked.push({
      opportunity,
      rank: expectedReturnRank(routeScore.estSpreadBps, sizing.searchCenter, maxBorrow),
    });
  }

  const protocolEdges = input.edges.filter(
    (edge) => edge.slotKind === "protocol" && !edge.leavesStandingPosition,
  );
  for (const edge of protocolEdges) {
    anchorTokens.add(edge.tokenIn.toLowerCase());
    anchorTokens.add(edge.tokenOut.toLowerCase());
  }
  for (const token of input.cfg.pricedTokens.keys()) {
    anchorTokens.add(token.toLowerCase());
  }

  const considerRing = (ringEdges: TokenEdge[]): void => {
    if (touched && !ringEdges.some((edge) => touched.has(edgeVenueIdentity(edge)))) return;
    if (pathLeavesStandingPosition(ringEdges)) return;
    if (!isAdmissibleBlockScanRingShape(ringEdges, input.cfg.pricedTokens)) return;
    const score = scoreRing(input.cache, input.sourceBlock, ringEdges, input.cfg.protocolMids);
    if (!score || score.estSpreadBps <= input.cfg.minSpreadBps) return;

    const ringTokens = ringTokensWithoutRepeat(ringEdges);
    const flashToken = pickRingFlashToken(ringTokens, input.cfg.pricedTokens);
    if (!flashToken) return;
    const seedEdges = rotateRingEdges(ringEdges, flashToken);
    if (!seedEdges) return;

    const rotatedScore = scoreRing(input.cache, input.sourceBlock, seedEdges, input.cfg.protocolMids);
    if (!rotatedScore || rotatedScore.estSpreadBps <= input.cfg.minSpreadBps) return;

    const firstVenue = readEdgeVenueMid(input.cache, input.sourceBlock, seedEdges[0], input.cfg.protocolMids);
    if (!firstVenue) return;
    const maxBorrow = input.cfg.pricedTokens.get(flashToken)?.maxBorrow ?? 0n;
    const spreadMultiplier = 1 + rotatedScore.estSpreadBps / 10_000;
    const minMid = firstVenue.mid / Math.max(spreadMultiplier, 1);
    const routeMaxInput = bigintFloor(rotatedScore.maxStartDepth / 4);
    const sizing = estimateSizing(
      firstVenue,
      flashToken,
      seedEdges[0].tokenIn.toLowerCase(),
      seedEdges[0].tokenOut.toLowerCase(),
      minMid,
      firstVenue.mid,
      rotatedScore.estSpreadBps,
      maxBorrow,
      routeMaxInput,
    );
    if (!sizing || sizing.searchCenter <= 8n) return;

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
      affectedPools: uniqueLowercase(seedEdges.map(edgeVenueIdentity)),
      affectedTokens: canonicalRing,
    };
    ranked.push({
      opportunity,
      rank: expectedReturnRank(rotatedScore.estSpreadBps, sizing.searchCenter, maxBorrow),
    });
  };

  // A protocol conversion is itself the uncommon middle edge. Enumerate its
  // swap-only return path directly so a low-volume closing venue cannot be
  // crowded out by unrelated exits before the protocol edge is ever reached.
  for (const protocolEdge of protocolEdges) {
    if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
    const tails = buildTokenPaths(input.edges, protocolEdge.tokenOut, protocolEdge.tokenIn, {
      maxHops: Math.max(0, input.cfg.maxHops - 1),
      maxPoolsPerToken: 20,
      pinnedOutsideBudget: input.cfg.pinnedOutsideBudget,
      preferDirectClosure: true,
      maxPaths: 2000,
      deadlineAtMs,
    });
    for (const tail of tails) {
      if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
      considerRing([protocolEdge, ...tail.edges]);
    }
  }

  for (const anchorToken of anchorTokens) {
    if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
    const rings = buildTokenPaths(input.edges, anchorToken, anchorToken, {
      maxHops: input.cfg.maxHops,
      // Keep broader closure coverage while maxPaths/deadline remain hard
      // bounds. This is a generic path budget, not a venue allowlist.
      maxPoolsPerToken: 20,
      pinnedOutsideBudget: input.cfg.pinnedOutsideBudget,
      maxPaths: 2000,
      deadlineAtMs,
    });
    if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");

    for (const ring of rings) {
      if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
      considerRing(ring.edges);
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
    const pool = edgeVenueIdentity(edge);
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
  const adapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.findForEdge(edges[0]?.adapterId ?? "");
  if (adapter?.readMid) {
    return adapter.readMid({
      cache,
      sourceBlock,
      a,
      b,
      pool,
      edges,
      externalMids: protocolMids,
    });
  }
  // Phase 5 remains fixture-blocked. Keep Fluid DEX behavior explicit until
  // it has a pinned graph→final-simulation equivalence corpus.
  if (edges[0]?.adapterId === "fluid-dex-swap") {
    return readProtocolExternalMid({
      cache,
      sourceBlock,
      a,
      b,
      pool,
      edges,
      externalMids: protocolMids,
    });
  }
  return null;
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
    edgeVenueIdentity(edge),
    [edge],
    protocolMids,
  );
}

function edgeVenueIdentity(edge: TokenEdge): string {
  if (edge.adapterId === "univ4-unlock" && edge.v4PoolKey) {
    return (edge.poolId ?? v4PoolId(edge.v4PoolKey)).toLowerCase();
  }
  return edge.target.toLowerCase();
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
): { estSpreadBps: number; maxStartDepth: number } | null {
  if (edges.length === 0 || !isClosedContinuousRing(edges)) return null;
  let logSum = 0;
  let cumulativeMid = 1;
  let maxStartDepth = Infinity;
  for (const edge of edges) {
    const adjustedMid = edgeMidTimesOneMinusFee(cache, sourceBlock, edge, protocolMids);
    if (adjustedMid === null) return null;
    const venue = readEdgeVenueMid(cache, sourceBlock, edge, protocolMids);
    if (!venue) return null;
    const inputDepth = venue.reserveA ?? venue.liquidity;
    if (inputDepth === undefined || inputDepth <= 0n || !Number.isFinite(cumulativeMid) || cumulativeMid <= 0) {
      return null;
    }
    const startDepth = Number(inputDepth) / cumulativeMid;
    if (!Number.isFinite(startDepth) || startDepth <= 0) return null;
    maxStartDepth = Math.min(maxStartDepth, startDepth);
    logSum += Math.log(adjustedMid);
    cumulativeMid *= adjustedMid;
  }
  if (!Number.isFinite(logSum) || logSum <= 0 || !Number.isFinite(maxStartDepth)) return null;
  const estSpreadBps = (Math.exp(logSum) - 1) * 10_000;
  return Number.isFinite(estSpreadBps) && estSpreadBps > 0
    ? { estSpreadBps, maxStartDepth }
    : null;
}

/** Production-owned coarse spread estimate used by diagnostics and replay reports. */
export function estimateBlockScanRingSpreadBps(
  cache: PoolStateCache,
  sourceBlock: number,
  edges: TokenEdge[],
  protocolMids?: ReadonlyMap<string, ProtocolMid>,
): number | null {
  return scoreRing(cache, sourceBlock, edges, protocolMids)?.estSpreadBps ?? null;
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

export function isAdmissibleBlockScanRingShape(
  edges: TokenEdge[],
  pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>,
): boolean {
  const tokens = ringTokensWithoutRepeat(edges);
  const positions = new Map<string, number[]>();
  for (let i = 0; i < tokens.length; i++) {
    const seen = positions.get(tokens[i]);
    if (seen) seen.push(i);
    else positions.set(tokens[i], [i]);
  }
  const repeated = [...positions.entries()].filter(([, indexes]) => indexes.length > 1);
  if (repeated.length === 0) return true;
  if (repeated.length !== 1) return false;

  const [token, indexes] = repeated[0];
  if (indexes.length !== 2 || pricedTokens.has(token)) return false;
  const [start, end] = indexes;
  // Admit a nested conversion cycle only when it is protocol-defined. This
  // covers funded NAV/conversion loops without letting arbitrary concatenated
  // AMM cycles crowd out the scanner's bounded candidate set.
  return edges.slice(start, end).some((edge) => edge.slotKind === "protocol");
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

function directedRouteFingerprint(edges: TokenEdge[]): string {
  const parts = edges.map((edge) =>
    `${edge.adapterId.toLowerCase()}|${edgeVenueIdentity(edge)}|` +
      `${edge.tokenIn.toLowerCase()}>${edge.tokenOut.toLowerCase()}`
  );
  if (parts.length <= 1) return parts.join(";");
  let canonical = parts.join(";");
  for (let i = 1; i < parts.length; i++) {
    const rotated = [...parts.slice(i), ...parts.slice(0, i)].join(";");
    if (rotated < canonical) canonical = rotated;
  }
  return canonical;
}

function expectedReturnRank(estSpreadBps: number, searchCenter: bigint, maxBorrow: bigint): number {
  if (maxBorrow <= 0n || searchCenter <= 0n) return 0;
  const capitalFraction = Number(searchCenter) / Number(maxBorrow);
  if (!Number.isFinite(capitalFraction) || capitalFraction <= 0) return 0;
  return estSpreadBps * Math.min(1, capitalFraction);
}

function bigintFloor(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value));
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
  routeMaxInput?: bigint,
): { searchCenter: bigint; maxInput: bigint } | null {
  const reserveIn = reserveForToken(cheapVenue, flashToken, a, b);
  const venueCeiling = minBigint(reserveIn / 4n, maxBorrow);
  const ceiling = routeMaxInput === undefined
    ? venueCeiling
    : minBigint(venueCeiling, routeMaxInput);
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
