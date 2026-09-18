import { buildBlockScanUsdView, usdViewStatistics, type BlockScanUsdView } from "../blockscan-usd-view.js";
import { enumeratePairedDfs, enumeratePairedLayered, type PairedEnumerationMethod } from "./blockscan-paired-dfs.js";
import { canonicalTokenRing, cycleFingerprint } from "./cycle-fingerprint.js";
import type { BlockScanOpportunity } from "./detector.js";
import { type TokenEdge, v4PoolId } from "../planner/token-graph.js";
import { pathLeavesStandingPosition, isBlockScanConversionEdge } from "../strategy-taxonomy.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";
import {
  validatedRouteImmutableBindingHash,
} from "../venues/route-immutable-binding.js";

export interface BlockScanCoreConfig {
  enumerationMethod?: PairedEnumerationMethod;
  /** Maximum compatible buy/sell signal pairs per token; defaults to 20. */
  usdSignalPairsPerToken?: number;
  maxHops: number;
  minSpreadBps: number;
  /** Historical caller compatibility only; DFS always requires a paired USD signal. */
  requireDislocatedPair?: boolean;
  /**
   * Coarse spread floor for exact-refine admission. Rings above minSpreadBps
   * are still enumerated (and counted in the funnel), but only rings above
   * this floor are returned as opportunities for the exact probe stage.
   * Defaults to minSpreadBps when omitted.
   */
  exactAdmissionSpreadBps?: number;
  /** Legacy configuration retained for refinement shadow telemetry only. */
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
  /** Telemetry-only pre-cap results; never an Exact admission input. */
  coarseEnumeration?: readonly BlockScanOpportunity[];
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
  enumeration?: { algorithm: "paired-dfs" | "paired-layered" } & ReturnType<typeof usdViewStatistics> & ReturnType<typeof enumeratePairedDfs>;
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
  readonly quoteAmountIn?: bigint;
  readonly quoteAmountOut?: bigint;
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

export function scanBlockStateFromResolvedMids(input: {
  edges: TokenEdge[];
  sourceBlock: number;
  swapTouched: Set<string> | null;
  cfg: BlockScanCoreConfig;
  mids: ReadonlyMap<string, ResolvedBlockScanMid>;
  usdView?: BlockScanUsdView;
  routeEligible?: (edges: readonly TokenEdge[]) => boolean;
  edgeEligible?: (edge: TokenEdge) => boolean;
  captureCoarseEnumeration?: boolean;
  onTiming?: (timing: BlockScanScanTiming) => void;
}): BlockScanOutcome {
  const started = Date.now(), deadlineAtMs = started + input.cfg.budgetMs;
  const eligibleEdges = input.edges.filter(edge => isBlockScanConversionEdge(edge) &&
    (!input.edgeEligible || input.edgeEligible(edge)));
  const edgesById = new Map(eligibleEdges.map(edge => [blockScanEdgeKey(edge), edge]));
  const view = input.usdView ?? buildBlockScanUsdView(eligibleEdges, input.mids, input.cfg.usdSignalPairsPerToken);
  const quotes = view.quotes.filter(q => edgesById.has(q.id));
  const ranked = new Map<string, RankedOpportunity>();
  let capitalRejected = 0;
  const preprocessingFinished = Date.now();
  const method = input.cfg.enumerationMethod ?? "dfs";
  const dfs = (method === "layered" ? enumeratePairedLayered : enumeratePairedDfs)({
    quotes, signals: view.signals, minSpreadBps: input.cfg.minSpreadBps,
    maxHops: input.cfg.maxHops, deadlineAtMs,
    funding: [...input.cfg.pricedTokens].filter(([, value]) => value.maxBorrow > 0n).map(([token]) => token),
    onCycle(path, estSpreadBps) {
      const seedEdges = path.map(q => edgesById.get(q.id)!);
      // DFS's validated split is relative to THIS funded start. Do not rotate
      // it after signal validation; a different rotation needs its own DFS proof.
      if (input.routeEligible && !input.routeEligible(seedEdges)) return;
      if (!isAdmissibleBlockScanRingShape(seedEdges, input.cfg.pricedTokens)) return;
      const firstVenue = readEdgeVenueMid(seedEdges[0]!, input.mids);
      if (!firstVenue || !Number.isFinite(estSpreadBps)) return;
      const flashToken = seedEdges[0]!.tokenIn.toLowerCase();
      const maxBorrow = input.cfg.pricedTokens.get(flashToken)?.maxBorrow ?? 0n;
      // The published effective quote owns P. Pool-depth proxies must not
      // recalculate or cap it; actual funding and amount quotes constrain execution.
      const searchCenter = firstVenue.quoteAmountIn ?? 0n;
      if (searchCenter <= 0n) return;
      if (searchCenter > maxBorrow) { capitalRejected++; return; }
      const ringTokens = ringTokensWithoutRepeat(seedEdges), canonicalRing = canonicalTokenRing(ringTokens);
      const opportunity: BlockScanOpportunity = {
        kind: "block-scan-arb", sourceBlock: input.sourceBlock, stateBlock: input.sourceBlock,
        cycleId: canonicalRing.join("|"), cycleFingerprint: cycleFingerprint(input.sourceBlock, ringTokens),
        seedEdges, flashToken, coarseSpreadBps: estSpreadBps, coarseMaxInput: maxBorrow,
        searchSeed: { startToken: flashToken, searchCenter, maxInput: maxBorrow },
        leavesStandingPosition: pathLeavesStandingPosition(seedEdges), affectedPools: uniqueLowercase(seedEdges.map(edgeVenueIdentity)),
        affectedTokens: canonicalRing,
      };
      const key = directedRouteFingerprint(seedEdges);
      const entry = { opportunity, rank: expectedReturnRank(estSpreadBps, searchCenter, maxBorrow), estSpreadBps };
      const previous = ranked.get(key);
      if (!previous || entry.rank > previous.rank) ranked.set(key, entry);
    },
  });
  const finalizing = Date.now();
  const ordered = [...ranked.values()].sort((a, b) => b.rank - a.rank ||
    directedRouteFingerprint(a.opportunity.seedEdges).localeCompare(directedRouteFingerprint(b.opportunity.seedEdges)));
  const opportunities = ordered.slice(0, input.cfg.maxCandidates).map(entry => entry.opportunity);
  const result: BlockScanOutcome = {
    outcome: dfs.deadlineHit ? "budget_exceeded" : "ran", stateBlock: input.sourceBlock,
    // Retained contract field; the DFS debug record names its new token-signal meaning.
    scannedPairs: view.comparableTokens, swapTouchedPools: input.swapTouched?.size ?? 0,
    opportunities,
    ...(input.captureCoarseEnumeration ? { coarseEnumeration: ordered.map(entry => entry.opportunity) } : {}),
    selection: { mode: "natural_ranked", enumeratedCount: ordered.length,
      admittedCount: ordered.filter(entry => entry.estSpreadBps >
        (input.cfg.exactAdmissionSpreadBps ?? input.cfg.minSpreadBps)).length,
      selectedCount: opportunities.length, forcedSelectionCount: 0 },
    debug: { skippedVenues: eligibleEdges.length - quotes.length, capitalRejected },
    enumeration: { algorithm: method === "dfs" ? "paired-dfs" : "paired-layered",
      ...usdViewStatistics(view, input.cfg.minSpreadBps), ...dfs },
  };
  input.onTiming?.({ preprocessing: preprocessingFinished - started, pairs: 0,
    general: finalizing - preprocessingFinished, finalization: Date.now() - finalizing, total: Date.now() - started });
  return result;
}

function readEdgeVenueMid(
  edge: TokenEdge,
  mids: ReadonlyMap<string, ResolvedBlockScanMid>,
): VenueMid | null {
  return mids.get(blockScanEdgeKey(edge)) ?? null;
}

function edgeVenueIdentity(edge: TokenEdge): string {
  if (edge.poolId) return edge.poolId.toLowerCase();
  if (edge.v4PoolKey) return v4PoolId(edge.v4PoolKey).toLowerCase();
  return edge.target.toLowerCase();
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
 * selection. This legacy depth diagnostic is not a sizing/admission gate for
 * production effective-price enumeration.
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
