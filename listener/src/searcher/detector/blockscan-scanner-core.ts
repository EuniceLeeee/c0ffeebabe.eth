import { ADDR } from "../../shared/constants/addresses.js";
import {
  BLOCKSCAN_MIN_EXECUTABLE_INPUT,
  BLOCKSCAN_VENUE_DEPTH_DIVISOR,
} from "./blockscan-sizing-constants.js";
import { canonicalTokenRing, cycleFingerprint } from "./cycle-fingerprint.js";
import type { BlockScanOpportunity } from "./detector.js";
import { type TokenEdge, v4PoolId } from "../planner/token-graph.js";
import { getAmount0Delta, getAmount1Delta } from "../solver/v3-math.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";
import {
  validatedRouteImmutableBindingHash,
} from "../venues/route-immutable-binding.js";

export interface BlockScanCoreConfig {
  maxHops: number;
  minSpreadBps: number;
  /**
   * Coarse spread floor for exact-refine admission. Rings above minSpreadBps
   * are still enumerated (and counted in the funnel), but only rings above
   * this floor are returned as opportunities for the exact probe stage.
   * Defaults to minSpreadBps when omitted.
   */
  exactAdmissionSpreadBps?: number;
  /**
   * Minimum executable capital fraction (maxInput / maxBorrow) for a ring to
   * be enumerated. Filters dust rings whose spread is huge on paper but whose
   * deployable capital is negligible, before they consume exact probes.
   * Defaults to 0 (no filter) when omitted.
   */
  minCapitalFraction?: number;
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
  /**
   * Produced by the actual selection branch, not filled in by the audit
   * recorder. This makes the blind producer's "no forced candidate" claim a
   * property of the executed scanner path.
   */
  selection: {
    readonly mode: "natural_ranked";
    readonly enumeratedCount: number;
    readonly admittedCount: number;
    readonly selectedCount: number;
    readonly forcedSelectionCount: number;
  };
  debug?: { skippedVenues: number; capitalRejected: number };
}

export interface BlockScanScanTiming {
  readonly preprocessing: number;
  readonly pairs: number;
  readonly general: number;
  readonly finalization: number;
  readonly total: number;
}

export interface NaturalBlockScanSelectionProvenance {
  readonly kind: "natural_coarse_ranked";
  readonly selectionMode: "production";
  readonly forcedSelectionCount: number;
  readonly eligibleCandidateCount: number;
  readonly selectedCandidateCount: number;
  readonly maxCandidates: number;
}

export function blockScanSelectionProvenance(
  outcome: Pick<BlockScanOutcome, "selection">,
  maxCandidates: number,
): NaturalBlockScanSelectionProvenance {
  return Object.freeze({
    kind: "natural_coarse_ranked",
    selectionMode: "production",
    forcedSelectionCount: outcome.selection.forcedSelectionCount,
    eligibleCandidateCount: outcome.selection.enumeratedCount,
    selectedCandidateCount: outcome.selection.selectedCount,
    maxCandidates,
  });
}

interface PairGroup {
  a: string;
  b: string;
  venues: Map<string, TokenEdge[]>;
}

/**
 * Minimal scanner projection of a family-owned current-block mid.
 * The state coordinator's published mid is structurally compatible without
 * coupling this pure kernel to any legacy cache reader.
 */
export interface ResolvedBlockScanMid {
  readonly kind: string;
  readonly pool: string;
  readonly edges: readonly TokenEdge[];
  readonly mid: number;
  readonly feeBps: number;
  readonly reserveA?: bigint;
  readonly reserveB?: bigint;
  readonly sqrtABX96?: bigint;
  readonly liquidity?: bigint;
  readonly depthProxy: number;
}

export type ResolvedRingScoreRejection =
  | "empty_route"
  | "not_closed_continuous"
  | "missing_mid"
  | "fee_out_of_range"
  | "invalid_adjusted_mid"
  | "missing_or_nonpositive_input_depth"
  | "invalid_cumulative_mid"
  | "invalid_start_depth"
  | "nonpositive_log_return"
  | "invalid_spread";

export interface ResolvedRingEdgeScoreDiagnostic {
  readonly edgeIndex: number;
  readonly edgeKey: string;
  readonly mid: number | null;
  readonly feeBps: number | null;
  readonly adjustedMid: number | null;
  readonly reserveA: string | null;
  readonly reserveB: string | null;
  readonly liquidity: string | null;
  readonly depthProxy: number | null;
  readonly inputDepth: string | null;
  readonly cumulativeMidBefore: number;
  readonly startDepth: number | null;
}

export type ResolvedRingScoreDiagnosis =
  | {
      readonly status: "accepted";
      readonly estSpreadBps: number;
      readonly maxStartDepth: number;
      readonly edges: readonly ResolvedRingEdgeScoreDiagnostic[];
    }
  | {
      readonly status: "rejected";
      readonly reason: ResolvedRingScoreRejection;
      readonly edgeIndex: number | null;
      readonly edgeKey: string | null;
      readonly edges: readonly ResolvedRingEdgeScoreDiagnostic[];
    };

type VenueMid = ResolvedBlockScanMid;

interface RankedOpportunity {
  opportunity: BlockScanOpportunity;
  rank: number;
  estSpreadBps: number;
}

interface PricedSearchEdge {
  readonly edge: TokenEdge;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly logRate: number;
  readonly inputDepth: number;
  readonly stableKey: string;
  readonly activityTieBreak: number;
}

interface PriceSearchNode {
  readonly anchorToken: string;
  readonly token: string;
  readonly edge: PricedSearchEdge;
  readonly parent: PriceSearchNode | null;
  readonly depth: number;
  readonly cumulativeLogReturn: number;
  readonly upperBoundLogReturn: number;
  readonly maxStartDepth: number;
  readonly upperBoundRank: number;
  readonly activityTieBreak: number;
  readonly sequence: number;
}

interface PriceRankedRingSearchResult {
  readonly rings: readonly TokenEdge[][];
  readonly deadlineHit: boolean;
}

const Q96 = 1n << 96n;
const MIN_SEARCH_CENTER = 1_000n;
const WETH = ADDR.WETH.toLowerCase();

export function scanBlockStateFromResolvedMids(input: {
  edges: TokenEdge[];
  sourceBlock: number;
  swapTouched: Set<string> | null;
  cfg: BlockScanCoreConfig;
  /** Required exact edge-key map; this kernel has no cache or legacy fallback. */
  mids: ReadonlyMap<string, ResolvedBlockScanMid>;
  /**
   * Per-pass execution availability. This never removes graph edges; it
   * prevents routes that cannot execute in the current immutable context from
   * consuming ranking/candidate capacity.
   */
  routeEligible?: (edges: readonly TokenEdge[]) => boolean;
  /** Per-edge execution availability applied only to this scanner pass. */
  edgeEligible?: (edge: TokenEdge) => boolean;
  /** Non-semantic timing observer; never becomes part of scanner output. */
  onTiming?: (timing: BlockScanScanTiming) => void;
}): BlockScanOutcome {
  const scanStartedAtMs = Date.now();
  const deadlineAtMs = scanStartedAtMs + input.cfg.budgetMs;
  const touched = input.swapTouched
    ? new Set([...input.swapTouched].map((pool) => pool.toLowerCase()))
    : null;
  const eligibleEdges = input.edgeEligible
    ? input.edges.filter(input.edgeEligible)
    : input.edges;
  const groups = groupPairs(eligibleEdges);
  const ranked: RankedOpportunity[] = [];
  let scannedPairs = 0;
  let skippedVenues = 0;
  let capitalRejected = 0;
  const preprocessingFinishedAtMs = Date.now();
  let activePhase: "pairs" | "general" = "pairs";
  let phaseStartedAtMs = preprocessingFinishedAtMs;
  const phaseMs = { pairs: 0, general: 0 };
  const enterPhase = (next: typeof activePhase): void => {
    const now = Date.now();
    phaseMs[activePhase] += Math.max(0, now - phaseStartedAtMs);
    activePhase = next;
    phaseStartedAtMs = now;
  };

  const finish = (outcome: BlockScanOutcome["outcome"]): BlockScanOutcome => {
    const finalizeStartedAtMs = Date.now();
    phaseMs[activePhase] += Math.max(0, finalizeStartedAtMs - phaseStartedAtMs);
    const admissionSpreadBps =
      input.cfg.exactAdmissionSpreadBps ?? input.cfg.minSpreadBps;
    ranked.sort((a, b) => b.rank - a.rank);
    const deduped: RankedOpportunity[] = [];
    const seenRoutes = new Set<string>();
    for (const entry of ranked) {
      const route = directedRouteFingerprint(entry.opportunity.seedEdges);
      if (seenRoutes.has(route)) continue;
      seenRoutes.add(route);
      deduped.push(entry);
    }
    const admitted = deduped.filter(
      (entry) => entry.estSpreadBps > admissionSpreadBps,
    );
    const selected = deduped.slice(0, input.cfg.maxCandidates);
    const result: BlockScanOutcome = {
      outcome,
      stateBlock: input.sourceBlock,
      scannedPairs,
      swapTouchedPools: touched?.size ?? 0,
      opportunities: selected.map((entry) => entry.opportunity),
      selection: Object.freeze({
        mode: "natural_ranked" as const,
        enumeratedCount: deduped.length,
        admittedCount: admitted.length,
        selectedCount: selected.length,
        forcedSelectionCount: 0,
      }),
      debug: { skippedVenues, capitalRejected },
    };
    const finishedAtMs = Date.now();
    input.onTiming?.(Object.freeze({
      preprocessing: Math.max(0, preprocessingFinishedAtMs - scanStartedAtMs),
      ...phaseMs,
      finalization: Math.max(0, finishedAtMs - finalizeStartedAtMs),
      total: Math.max(0, finishedAtMs - scanStartedAtMs),
    }));
    return result;
  };

  for (const group of groups.values()) {
    if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
    if (group.venues.size < 2) continue;
    if (touched && !pairTouches(group, touched)) continue;
    scannedPairs++;

    const venues: VenueMid[] = [];
    for (const edges of group.venues.values()) {
      if (Date.now() >= deadlineAtMs) return finish("budget_exceeded");
      const mid = readVenueMid(
        group.a,
        group.b,
        edges,
        input.mids,
      );
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
    if (input.routeEligible && !input.routeEligible(seedEdges)) continue;

    const maxBorrow = input.cfg.pricedTokens.get(flashToken)?.maxBorrow ?? 0n;
    const routeScore = scoreRing(seedEdges, input.mids);
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
    if (!passesMinimumCapitalFraction(
      sizing.maxInput,
      maxBorrow,
      input.cfg.minCapitalFraction,
    )) {
      // Shadow-only: record the would-reject count for calibration but keep
      // the ring so its exact outcome can be measured.
      capitalRejected++;
    }

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
      coarseSpreadBps: routeScore.estSpreadBps,
      coarseMaxInput: sizing.maxInput,
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
      estSpreadBps: routeScore.estSpreadBps,
    });
  }

  const considerRing = (ringEdges: TokenEdge[]): void => {
    if (input.routeEligible && !input.routeEligible(ringEdges)) return;
    if (touched && !ringEdges.some((edge) => touched.has(edgeVenueIdentity(edge)))) return;
    if (pathLeavesStandingPosition(ringEdges)) return;
    if (!isAdmissibleBlockScanRingShape(ringEdges, input.cfg.pricedTokens)) return;
    const score = scoreRing(ringEdges, input.mids);
    if (!score || score.estSpreadBps <= input.cfg.minSpreadBps) return;

    const ringTokens = ringTokensWithoutRepeat(ringEdges);
    const flashToken = pickRingFlashToken(ringTokens, input.cfg.pricedTokens);
    if (!flashToken) return;
    const seedEdges = rotateRingEdges(ringEdges, flashToken);
    if (!seedEdges) return;

    const rotatedScore = scoreRing(seedEdges, input.mids);
    if (!rotatedScore || rotatedScore.estSpreadBps <= input.cfg.minSpreadBps) return;

    const firstVenue = readEdgeVenueMid(
      seedEdges[0],
      input.mids,
    );
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
    if (!passesMinimumCapitalFraction(
      sizing.maxInput,
      maxBorrow,
      input.cfg.minCapitalFraction,
    )) {
      capitalRejected++;
    }

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
      coarseSpreadBps: rotatedScore.estSpreadBps,
      coarseMaxInput: sizing.maxInput,
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
      estSpreadBps: rotatedScore.estSpreadBps,
    });
  };

  enterPhase("general");
  const priceSearch = enumeratePriceRankedRings({
    edges: eligibleEdges,
    mids: input.mids,
    pricedTokens: input.cfg.pricedTokens,
    touched,
    maxHops: input.cfg.maxHops,
    minSpreadBps: input.cfg.minSpreadBps,
    maxRings: Math.max(2_000, input.cfg.maxCandidates * 20),
    deadlineAtMs,
    routeEligible: input.routeEligible,
  });
  for (const ring of priceSearch.rings) {
    considerRing(ring);
  }

  return finish(priceSearch.deadlineHit ? "budget_exceeded" : "ran");
}

/**
 * Enumerate profitable closed rings from current resolved prices without an
 * edge-count gate. A reverse dynamic program supplies an optimistic return
 * bound for every token/hop budget; a best-first queue then spends the global
 * time/result budget only on partial paths that can still clear the spread
 * floor. Activity is a deterministic tie-break only and can never make an
 * otherwise profitable edge unreachable.
 *
 * With a touched set, the observed edge is seeded before any budgeting. This
 * preserves causal backrun recall without teaching the central scanner any
 * Family or protocol identity.
 */
function enumeratePriceRankedRings(input: {
  readonly edges: readonly TokenEdge[];
  readonly mids: ReadonlyMap<string, ResolvedBlockScanMid>;
  readonly pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>;
  readonly touched: ReadonlySet<string> | null;
  readonly maxHops: number;
  readonly minSpreadBps: number;
  readonly maxRings: number;
  readonly deadlineAtMs: number;
  readonly routeEligible?: (edges: readonly TokenEdge[]) => boolean;
}): PriceRankedRingSearchResult {
  if (
    !Number.isSafeInteger(input.maxHops) || input.maxHops <= 0 ||
    !Number.isSafeInteger(input.maxRings) || input.maxRings <= 0
  ) {
    throw new Error("price-ranked ring search requires positive integer budgets");
  }
  const minLogReturn = Math.log1p(input.minSpreadBps / 10_000);
  if (!Number.isFinite(minLogReturn)) {
    throw new Error(`invalid block-scan spread floor ${input.minSpreadBps}`);
  }

  const pricedEdges = buildPricedSearchEdges(input.edges, input.mids);
  const outgoing = new Map<string, PricedSearchEdge[]>();
  for (const priced of pricedEdges) {
    const entries = outgoing.get(priced.tokenIn);
    if (entries) entries.push(priced);
    else outgoing.set(priced.tokenIn, [priced]);
  }
  for (const entries of outgoing.values()) {
    entries.sort((a, b) => a.stableKey.localeCompare(b.stableKey));
  }

  const boundsByAnchor = new Map<
    string,
    readonly ReadonlyMap<string, number>[]
  >();
  const boundsFor = (
    anchorToken: string,
  ): readonly ReadonlyMap<string, number>[] => {
    const anchor = anchorToken.toLowerCase();
    const cached = boundsByAnchor.get(anchor);
    if (cached) return cached;
    const bounds = buildReverseReturnBounds(
      pricedEdges,
      anchor,
      input.maxHops,
    );
    boundsByAnchor.set(anchor, bounds);
    return bounds;
  };

  const queue = new PriceSearchMaxHeap();
  let sequence = 0;
  const pushFirstEdge = (
    anchorToken: string,
    priced: PricedSearchEdge,
  ): void => {
    const anchor = anchorToken.toLowerCase();
    if (priced.tokenIn !== anchor || priced.tokenOut === anchor) return;
    const tailBound = boundsFor(anchor)[input.maxHops - 1]?.get(
      priced.tokenOut,
    );
    if (tailBound === undefined) return;
    const upperBoundLogReturn = priced.logRate + tailBound;
    if (!(upperBoundLogReturn > minLogReturn)) return;
    const maxBorrow = input.pricedTokens.get(anchor)?.maxBorrow ?? null;
    queue.push(Object.freeze({
      anchorToken: anchor,
      token: priced.tokenOut,
      edge: priced,
      parent: null,
      depth: 1,
      cumulativeLogReturn: priced.logRate,
      upperBoundLogReturn,
      maxStartDepth: priced.inputDepth,
      upperBoundRank: optimisticSearchRank(
        upperBoundLogReturn,
        priced.inputDepth,
        maxBorrow,
      ),
      activityTieBreak: priced.activityTieBreak,
      sequence: sequence++,
    }));
  };

  if (input.touched) {
    for (const priced of pricedEdges) {
      if (!input.touched.has(edgeVenueIdentity(priced.edge))) continue;
      pushFirstEdge(priced.tokenIn, priced);
      if (Date.now() >= input.deadlineAtMs) {
        return Object.freeze({ rings: Object.freeze([]), deadlineHit: true });
      }
    }
  } else {
    const anchors = [...input.pricedTokens.keys()]
      .map((token) => token.toLowerCase())
      .sort();
    for (const anchor of anchors) {
      for (const priced of outgoing.get(anchor) ?? []) {
        pushFirstEdge(anchor, priced);
      }
      if (Date.now() >= input.deadlineAtMs) {
        return Object.freeze({ rings: Object.freeze([]), deadlineHit: true });
      }
    }
  }

  const rings: TokenEdge[][] = [];
  const seenRings = new Set<string>();
  let workUnits = 0;
  while (queue.size > 0 && rings.length < input.maxRings) {
    if ((workUnits++ & 0xff) === 0 && Date.now() >= input.deadlineAtMs) {
      return Object.freeze({ rings: Object.freeze(rings), deadlineHit: true });
    }
    const node = queue.pop()!;
    if (node.token === node.anchorToken) {
      const ring = materializePriceSearchPath(node);
      if (
        node.cumulativeLogReturn > minLogReturn &&
        pickRingFlashToken(
          ringTokensWithoutRepeat(ring),
          input.pricedTokens,
        ) !== null &&
        isAdmissibleBlockScanRingShape(ring, input.pricedTokens) &&
        (!input.routeEligible || input.routeEligible(ring))
      ) {
        const fingerprint = directedRouteFingerprint(ring);
        if (!seenRings.has(fingerprint)) {
          seenRings.add(fingerprint);
          rings.push(ring);
        }
      }
      continue;
    }
    if (node.depth >= input.maxHops) continue;

    const remainingAfterNext = input.maxHops - node.depth - 1;
    const bounds = boundsFor(node.anchorToken);
    for (const next of outgoing.get(node.token) ?? []) {
      if ((workUnits++ & 0xff) === 0 && Date.now() >= input.deadlineAtMs) {
        return Object.freeze({ rings: Object.freeze(rings), deadlineHit: true });
      }
      if (priceSearchPathUsesEdge(node, next.stableKey)) continue;
      const closes = next.tokenOut === node.anchorToken;
      const tailBound = closes
        ? 0
        : bounds[remainingAfterNext]?.get(next.tokenOut);
      if (tailBound === undefined) continue;
      const cumulativeMidBeforeNext = Math.exp(node.cumulativeLogReturn);
      if (
        !Number.isFinite(cumulativeMidBeforeNext) ||
        cumulativeMidBeforeNext <= 0
      ) continue;
      const nextStartDepth = next.inputDepth / cumulativeMidBeforeNext;
      if (!Number.isFinite(nextStartDepth) || nextStartDepth <= 0) continue;
      const maxStartDepth = Math.min(node.maxStartDepth, nextStartDepth);
      const cumulativeLogReturn = node.cumulativeLogReturn + next.logRate;
      const upperBoundLogReturn = cumulativeLogReturn + tailBound;
      if (!(upperBoundLogReturn > minLogReturn)) continue;
      const child: PriceSearchNode = Object.freeze({
        anchorToken: node.anchorToken,
        token: next.tokenOut,
        edge: next,
        parent: node,
        depth: node.depth + 1,
        cumulativeLogReturn,
        upperBoundLogReturn,
        maxStartDepth,
        upperBoundRank: optimisticSearchRank(
          upperBoundLogReturn,
          maxStartDepth,
          input.pricedTokens.get(node.anchorToken)?.maxBorrow ?? null,
        ),
        activityTieBreak: node.activityTieBreak + next.activityTieBreak,
        sequence: sequence++,
      });
      if (
        !closes &&
        !partialRingShapeCanStillPass(
          materializePriceSearchPath(child),
          input.pricedTokens,
        )
      ) continue;
      queue.push(child);
    }
  }
  return Object.freeze({
    rings: Object.freeze(rings),
    deadlineHit: Date.now() >= input.deadlineAtMs,
  });
}

function buildPricedSearchEdges(
  edges: readonly TokenEdge[],
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
): PricedSearchEdge[] {
  const priced: PricedSearchEdge[] = [];
  for (const edge of edges) {
    if (edge.leavesStandingPosition) continue;
    const tokenIn = edge.tokenIn.toLowerCase();
    const tokenOut = edge.tokenOut.toLowerCase();
    if (tokenIn === tokenOut) continue;
    const venue = mids.get(blockScanEdgeKey(edge));
    if (!venue || venue.feeBps < 0 || venue.feeBps >= 10_000) continue;
    const inputDepth = venue.reserveA ?? venue.liquidity;
    if (inputDepth === undefined || inputDepth <= 0n) continue;
    const inputDepthNumber = Number(inputDepth);
    if (!Number.isFinite(inputDepthNumber) || inputDepthNumber <= 0) continue;
    const adjustedMid = venue.mid * (1 - venue.feeBps / 10_000);
    if (!Number.isFinite(adjustedMid) || adjustedMid <= 0) continue;
    const logRate = Math.log(adjustedMid);
    if (!Number.isFinite(logRate)) continue;
    priced.push(Object.freeze({
      edge,
      tokenIn,
      tokenOut,
      logRate,
      inputDepth: inputDepthNumber,
      stableKey: blockScanEdgeKey(edge),
      activityTieBreak:
        typeof edge.score === "number" && Number.isFinite(edge.score)
          ? Math.max(0, edge.score)
          : 0,
    }));
  }
  return priced.sort((a, b) => a.stableKey.localeCompare(b.stableKey));
}

function buildReverseReturnBounds(
  edges: readonly PricedSearchEdge[],
  anchorToken: string,
  maxHops: number,
): readonly ReadonlyMap<string, number>[] {
  const bounds: Map<string, number>[] = [
    new Map([[anchorToken.toLowerCase(), 0]]),
  ];
  for (let hops = 1; hops <= maxHops; hops++) {
    const previous = bounds[hops - 1];
    const current = new Map(previous);
    for (const edge of edges) {
      // Reaching the anchor ends a production route. Keeping it absorbing
      // makes this a tight bound instead of pretending the route may leave
      // the funding token for another cycle after it has already closed.
      if (edge.tokenIn === anchorToken) continue;
      const tail = previous.get(edge.tokenOut);
      if (tail === undefined) continue;
      const candidate = edge.logRate + tail;
      if (candidate > (current.get(edge.tokenIn) ?? -Infinity)) {
        current.set(edge.tokenIn, candidate);
      }
    }
    bounds.push(current);
  }
  return bounds;
}

function materializePriceSearchPath(node: PriceSearchNode): TokenEdge[] {
  const path = new Array<TokenEdge>(node.depth);
  let current: PriceSearchNode | null = node;
  for (let index = node.depth - 1; index >= 0; index--) {
    if (!current) throw new Error("price search path depth mismatch");
    path[index] = current.edge.edge;
    current = current.parent;
  }
  return path;
}

function priceSearchPathUsesEdge(
  node: PriceSearchNode,
  stableKey: string,
): boolean {
  let current: PriceSearchNode | null = node;
  while (current) {
    if (current.edge.stableKey === stableKey) return true;
    current = current.parent;
  }
  return false;
}

function partialRingShapeCanStillPass(
  edges: readonly TokenEdge[],
  pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>,
): boolean {
  if (edges.length === 0) return true;
  const tokens = [
    edges[0].tokenIn.toLowerCase(),
    ...edges.map((edge) => edge.tokenOut.toLowerCase()),
  ];
  const positions = new Map<string, number[]>();
  for (let index = 0; index < tokens.length; index++) {
    const prior = positions.get(tokens[index]);
    if (prior) prior.push(index);
    else positions.set(tokens[index], [index]);
  }
  const repeated = [...positions.entries()].filter(
    ([, indexes]) => indexes.length > 1,
  );
  if (repeated.length === 0) return true;
  if (repeated.length !== 1) return false;
  const [token, indexes] = repeated[0];
  if (indexes.length !== 2 || pricedTokens.has(token)) return false;
  const [start, end] = indexes;
  return edges.slice(start, end).some((edge) => edge.slotKind === "protocol");
}

class PriceSearchMaxHeap {
  readonly #items: PriceSearchNode[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(node: PriceSearchNode): void {
    const items = this.#items;
    items.push(node);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!priceSearchNodeBefore(items[index], items[parent])) break;
      [items[index], items[parent]] = [items[parent], items[index]];
      index = parent;
    }
  }

  pop(): PriceSearchNode | undefined {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const first = items[0];
    const last = items.pop()!;
    if (items.length === 0) return first;
    items[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (
        left < items.length &&
        priceSearchNodeBefore(items[left], items[next])
      ) next = left;
      if (
        right < items.length &&
        priceSearchNodeBefore(items[right], items[next])
      ) next = right;
      if (next === index) break;
      [items[index], items[next]] = [items[next], items[index]];
      index = next;
    }
    return first;
  }
}

function priceSearchNodeBefore(
  a: PriceSearchNode,
  b: PriceSearchNode,
): boolean {
  if (a.upperBoundRank !== b.upperBoundRank) {
    return a.upperBoundRank > b.upperBoundRank;
  }
  if (a.upperBoundLogReturn !== b.upperBoundLogReturn) {
    return a.upperBoundLogReturn > b.upperBoundLogReturn;
  }
  if (a.cumulativeLogReturn !== b.cumulativeLogReturn) {
    return a.cumulativeLogReturn > b.cumulativeLogReturn;
  }
  if (a.activityTieBreak !== b.activityTieBreak) {
    return a.activityTieBreak > b.activityTieBreak;
  }
  return a.sequence < b.sequence;
}

/**
 * Safe coarse upper bound for a partially explored route. Future legs may
 * improve the quoted rate but can only reduce the currently executable input
 * depth, so this rank never excludes a path whose feasible gross return can
 * still beat the queue. Non-funded touched-edge searches fall back to spread;
 * their eventual ring is rotated to a real funding token before admission.
 */
function optimisticSearchRank(
  upperBoundLogReturn: number,
  maxStartDepth: number,
  maxBorrow: bigint | null,
): number {
  const spreadBps = Math.expm1(upperBoundLogReturn) * 10_000;
  if (!(spreadBps > 0)) return 0;
  if (maxBorrow === null || maxBorrow <= 0n) return spreadBps;
  const executableDepth =
    maxStartDepth / Number(BLOCKSCAN_VENUE_DEPTH_DIVISOR);
  const capacityShare = executableDepth / Number(maxBorrow);
  if (!(capacityShare > 0)) return 0;
  return spreadBps * Math.min(1, capacityShare);
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
    const pool = routeVenueIdentity(edge);
    const venueEdges = group.venues.get(pool);
    if (venueEdges) venueEdges.push(edge);
    else group.venues.set(pool, [edge]);
  }
  return groups;
}

function pairTouches(group: PairGroup, touched: Set<string>): boolean {
  for (const edges of group.venues.values()) {
    if (edges.some((edge) => touched.has(edgeVenueIdentity(edge)))) {
      return true;
    }
  }
  return false;
}

function readVenueMid(
  a: string,
  b: string,
  edges: TokenEdge[],
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
): VenueMid | null {
  const direct = findEdge(edges, a, b);
  if (!direct) return null;
  const mid = mids.get(blockScanEdgeKey(direct));
  return mid ? { ...mid, edges } : null;
}

function pickFlashToken(a: string, b: string, pricedTokens: Map<string, { maxBorrow: bigint }>): string | null {
  const hasA = pricedTokens.has(a);
  const hasB = pricedTokens.has(b);
  if (!hasA && !hasB) return null;
  if ((a === WETH && hasA) || (b === WETH && hasB)) return WETH;
  return hasA ? a : b;
}

function findEdge(
  edges: readonly TokenEdge[],
  tokenIn: string,
  tokenOut: string,
): TokenEdge | null {
  return edges.find(
    (edge) => edge.tokenIn.toLowerCase() === tokenIn && edge.tokenOut.toLowerCase() === tokenOut,
  ) ?? null;
}

function readEdgeVenueMid(
  edge: TokenEdge,
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
): VenueMid | null {
  return readVenueMid(
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    [edge],
    mids,
  );
}

function edgeVenueIdentity(edge: TokenEdge): string {
  if (edge.poolId) return edge.poolId.toLowerCase();
  if (edge.v4PoolKey) return v4PoolId(edge.v4PoolKey).toLowerCase();
  return edge.target.toLowerCase();
}

/**
 * Pricing venue identity retains immutable family metadata even when logical
 * instances share one physical target and token pair. Touched matching remains
 * tied to the physical identity above.
 */
function routeVenueIdentity(edge: TokenEdge): string {
  const physicalIdentity = edgeVenueIdentity(edge);
  const routeBindingHash =
    validatedRouteImmutableBindingHash(edge.routeBinding);
  if (routeBindingHash === null) return physicalIdentity;
  return [
    physicalIdentity,
    edgeInstanceKey(edge),
    routeBindingHash,
  ].join("\u001f");
}

function scoreRing(
  edges: TokenEdge[],
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
  trace?: MutableResolvedRingScoreTrace,
): { estSpreadBps: number; maxStartDepth: number } | null {
  if (edges.length === 0) {
    if (trace) rejectResolvedRingScore(trace, "empty_route");
    return null;
  }
  if (!isClosedContinuousRing(edges)) {
    if (trace) rejectResolvedRingScore(trace, "not_closed_continuous");
    return null;
  }
  let logSum = 0;
  let cumulativeMid = 1;
  let maxStartDepth = Infinity;
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    const edge = edges[edgeIndex];
    const venue = readEdgeVenueMid(edge, mids);
    if (!venue) {
      if (trace) {
        recordResolvedRingEdge(trace, edge, edgeIndex, cumulativeMid, null);
        rejectResolvedRingScore(trace, "missing_mid", edge, edgeIndex);
      }
      return null;
    }
    if (venue.feeBps >= 10_000) {
      if (trace) {
        recordResolvedRingEdge(trace, edge, edgeIndex, cumulativeMid, venue);
        rejectResolvedRingScore(trace, "fee_out_of_range", edge, edgeIndex);
      }
      return null;
    }
    const adjustedMid = venue.mid * (1 - venue.feeBps / 10_000);
    if (!Number.isFinite(adjustedMid) || adjustedMid <= 0) {
      if (trace) {
        recordResolvedRingEdge(
          trace,
          edge,
          edgeIndex,
          cumulativeMid,
          venue,
          adjustedMid,
        );
        rejectResolvedRingScore(
          trace,
          "invalid_adjusted_mid",
          edge,
          edgeIndex,
        );
      }
      return null;
    }
    const inputDepth = venue.reserveA ?? venue.liquidity;
    if (inputDepth === undefined || inputDepth <= 0n) {
      if (trace) {
        recordResolvedRingEdge(
          trace,
          edge,
          edgeIndex,
          cumulativeMid,
          venue,
          adjustedMid,
          inputDepth,
        );
        rejectResolvedRingScore(
          trace,
          "missing_or_nonpositive_input_depth",
          edge,
          edgeIndex,
        );
      }
      return null;
    }
    if (!Number.isFinite(cumulativeMid) || cumulativeMid <= 0) {
      if (trace) {
        recordResolvedRingEdge(
          trace,
          edge,
          edgeIndex,
          cumulativeMid,
          venue,
          adjustedMid,
          inputDepth,
        );
        rejectResolvedRingScore(
          trace,
          "invalid_cumulative_mid",
          edge,
          edgeIndex,
        );
      }
      return null;
    }
    const startDepth = Number(inputDepth) / cumulativeMid;
    if (trace) {
      recordResolvedRingEdge(
        trace,
        edge,
        edgeIndex,
        cumulativeMid,
        venue,
        adjustedMid,
        inputDepth,
        startDepth,
      );
    }
    if (!Number.isFinite(startDepth) || startDepth <= 0) {
      if (trace) {
        rejectResolvedRingScore(
          trace,
          "invalid_start_depth",
          edge,
          edgeIndex,
        );
      }
      return null;
    }
    maxStartDepth = Math.min(maxStartDepth, startDepth);
    logSum += Math.log(adjustedMid);
    cumulativeMid *= adjustedMid;
  }
  if (!Number.isFinite(logSum) || logSum <= 0) {
    if (trace) rejectResolvedRingScore(trace, "nonpositive_log_return");
    return null;
  }
  if (!Number.isFinite(maxStartDepth)) {
    if (trace) rejectResolvedRingScore(trace, "invalid_start_depth");
    return null;
  }
  const estSpreadBps = (Math.exp(logSum) - 1) * 10_000;
  if (!Number.isFinite(estSpreadBps) || estSpreadBps <= 0) {
    if (trace) rejectResolvedRingScore(trace, "invalid_spread");
    return null;
  }
  return { estSpreadBps, maxStartDepth };
}

/** Coarse spread estimate over one already-resolved state snapshot. */
export function estimateResolvedRingSpreadBps(
  edges: TokenEdge[],
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
): number | null {
  return scoreRing(edges, mids)?.estSpreadBps ?? null;
}

/**
 * Explain one already-resolved ring without changing scanner enumeration or
 * selection. The production scorer and this diagnostic execute the same
 * arithmetic; trace allocation occurs only for an explicit diagnostic call.
 */
export function diagnoseResolvedRingScore(
  edges: TokenEdge[],
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
): ResolvedRingScoreDiagnosis {
  const trace: MutableResolvedRingScoreTrace = { edges: [] };
  const score = scoreRing(edges, mids, trace);
  if (score) {
    return Object.freeze({
      status: "accepted" as const,
      ...score,
      edges: Object.freeze(trace.edges),
    });
  }
  const rejection = trace.rejection ?? {
    reason: "invalid_spread" as const,
    edgeIndex: null,
    edgeKey: null,
  };
  return Object.freeze({
    status: "rejected" as const,
    ...rejection,
    edges: Object.freeze(trace.edges),
  });
}

interface MutableResolvedRingScoreTrace {
  readonly edges: ResolvedRingEdgeScoreDiagnostic[];
  rejection?: {
    readonly reason: ResolvedRingScoreRejection;
    readonly edgeIndex: number | null;
    readonly edgeKey: string | null;
  };
}

function rejectResolvedRingScore(
  trace: MutableResolvedRingScoreTrace | undefined,
  reason: ResolvedRingScoreRejection,
  edge?: TokenEdge,
  edgeIndex?: number,
): null {
  if (trace) {
    trace.rejection = Object.freeze({
      reason,
      edgeIndex: edgeIndex ?? null,
      edgeKey: edge ? blockScanEdgeKey(edge) : null,
    });
  }
  return null;
}

function recordResolvedRingEdge(
  trace: MutableResolvedRingScoreTrace | undefined,
  edge: TokenEdge,
  edgeIndex: number,
  cumulativeMidBefore: number,
  venue: VenueMid | null,
  adjustedMid: number | null = null,
  inputDepth?: bigint,
  startDepth: number | null = null,
): void {
  if (!trace) return;
  trace.edges.push(Object.freeze({
    edgeIndex,
    edgeKey: blockScanEdgeKey(edge),
    mid: venue?.mid ?? null,
    feeBps: venue?.feeBps ?? null,
    adjustedMid,
    reserveA: venue?.reserveA?.toString() ?? null,
    reserveB: venue?.reserveB?.toString() ?? null,
    liquidity: venue?.liquidity?.toString() ?? null,
    depthProxy: venue?.depthProxy ?? null,
    inputDepth: inputDepth?.toString() ?? null,
    cumulativeMidBefore,
    startDepth,
  }));
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

function pickRingFlashToken(
  ringTokens: string[],
  pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>,
): string | null {
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
  const parts = edges.map((edge) => {
    const legacy =
      `${edge.adapterId.toLowerCase()}|${edgeVenueIdentity(edge)}|` +
      `${edge.tokenIn.toLowerCase()}>${edge.tokenOut.toLowerCase()}`;
    const bindingHash =
      validatedRouteImmutableBindingHash(edge.routeBinding);
    return bindingHash === null
      ? legacy
      : `${legacy}|${edgeInstanceKey(edge)}|${bindingHash}`;
  });
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

function passesMinimumCapitalFraction(
  maxInput: bigint,
  maxBorrow: bigint,
  minCapitalFraction: number | undefined,
): boolean {
  if (minCapitalFraction === undefined || minCapitalFraction <= 0) return true;
  if (maxBorrow <= 0n || maxInput <= 0n) return false;
  return Number(maxInput) / Number(maxBorrow) >= minCapitalFraction;
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
  const venueCeiling = minBigint(
    reserveIn / BLOCKSCAN_VENUE_DEPTH_DIVISOR,
    maxBorrow,
  );
  const ceiling = routeMaxInput === undefined
    ? venueCeiling
    : minBigint(venueCeiling, routeMaxInput);
  if (ceiling < BLOCKSCAN_MIN_EXECUTABLE_INPUT) return null;

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
