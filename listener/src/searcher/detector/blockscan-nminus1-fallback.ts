import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import {
  blockScanEdgeMetadataFingerprint,
  blockScanEdgeKey,
  type VerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import { cycleFingerprint } from "./cycle-fingerprint.js";
import {
  assertAtomicBlockScanPricingView,
  type AtomicBlockScanPricingValidationTiming,
} from "./blockscan-scanner-production.js";
import {
  scanBlockStateFromResolvedMids,
  type BlockScanCoreConfig,
  type BlockScanOutcome,
  type BlockScanScanTiming,
} from "./blockscan-scanner-core.js";
import type { BlockScanOpportunity } from "./detector.js";

const nMinusOneCoarseCandidateBrand: unique symbol = Symbol(
  "n-minus-one-coarse-candidate",
);

export interface NMinusOneCoarseCandidate {
  readonly [nMinusOneCoarseCandidateBrand]: true;
  readonly coarseOpportunity: BlockScanOpportunity;
  readonly exactProbeOpportunity: BlockScanOpportunity;
  readonly coarseSourceBlock: number;
  readonly coarseSourceBlockHash: string;
  readonly requiredExactSourceBlock: number;
  readonly requiredExactSourceBlockHash: string;
}

export interface NMinusOneCoarseOutcome {
  readonly pricingMode: "n_minus_one_coarse_current_n_exact";
  readonly recallMode: "stale-positive-only";
  readonly fullCoverage: false;
  readonly degradedRecallReasons: readonly [
    "current_n_mutation_anchors_unavailable",
    "off_event_dependencies_uncovered",
  ];
  readonly coarseSourceBlock: number;
  readonly coarseSourceBlockHash: string;
  readonly requiredExactSourceBlock: number;
  readonly requiredExactSourceBlockHash: string;
  readonly scan: BlockScanOutcome;
  readonly scanTimingMs: BlockScanScanTiming | null;
  readonly atomicValidationTimingMs:
    AtomicBlockScanPricingValidationTiming | null;
  readonly wrapperTimingMs: NMinusOneCoarseTiming;
  readonly candidates: readonly NMinusOneCoarseCandidate[];
  readonly rejectedRouteCount: number;
}

export interface NMinusOneCoarseTiming {
  readonly atomicValidation: number;
  readonly edgeFilter: number;
  readonly scan: number;
  readonly exactEdgeMap: number;
  readonly candidateRebase: number;
  readonly total: number;
}

/**
 * Enumerate only from one already-completed predecessor pricing view, then
 * rebind every route to the current graph. The returned opportunities are
 * probe-only: callers must use promoteNMinusOneExactCandidates after a
 * whole-route current-N quote before planner/solver admission.
 */
export function enumerateNMinusOneCoarseCandidates(input: {
  readonly coarsePricing: BlockScanStateSnapshot;
  readonly canonicalPredecessorHash: string;
  readonly exactGraph: VerifiedGraphView;
  readonly cfg: BlockScanCoreConfig;
  readonly routeEligible?: (edges: readonly TokenEdge[]) => boolean;
  readonly edgeEligible?: (edge: TokenEdge) => boolean;
}): NMinusOneCoarseOutcome {
  const startedAtMs = Date.now();
  const coarse = input.coarsePricing;
  const exact = input.exactGraph;
  let atomicValidationTimingMs:
    AtomicBlockScanPricingValidationTiming | null = null;
  assertAtomicBlockScanPricingView(coarse.graph, coarse, (timing) => {
    atomicValidationTimingMs = timing;
  });
  const atomicValidationFinishedAtMs = Date.now();
  if (coarse.sourceBlock !== exact.sourceBlock - 1) {
    throw new Error(
      `coarse source must be exactly N-1: ` +
        `${coarse.sourceBlock} -> ${exact.sourceBlock}`,
    );
  }
  if (
    coarse.sourceBlockHash.toLowerCase() !==
      input.canonicalPredecessorHash.toLowerCase()
  ) {
    throw new Error("N-1 coarse source hash is no longer canonical");
  }

  const resolvedEdgeKeys = new Set(coarse.coverage.resolvedEdgeKeys);
  const scannerEdges = coarse.graph.edges.filter(
    (edge) =>
      !scannerConsumesEdge(edge) ||
      resolvedEdgeKeys.has(blockScanEdgeKey(edge)),
  );
  const edgeFilterFinishedAtMs = Date.now();
  let scanTimingMs: BlockScanScanTiming | null = null;
  const scan = scanBlockStateFromResolvedMids({
    edges: scannerEdges,
    sourceBlock: coarse.sourceBlock,
    swapTouched: null,
    cfg: input.cfg,
    mids: coarse.mids,
    routeEligible: input.routeEligible,
    edgeEligible: input.edgeEligible,
    onTiming: (timing) => {
      scanTimingMs = timing;
    },
  });
  const scanFinishedAtMs = Date.now();
  const exactByEdgeKey = exactEdgeMap(exact.edges);
  const exactEdgeMapFinishedAtMs = Date.now();
  const candidates: NMinusOneCoarseCandidate[] = [];
  let rejectedRouteCount = 0;
  for (const opportunity of scan.opportunities) {
    const exactEdges: TokenEdge[] = [];
    let rejected = false;
    for (const coarseEdge of opportunity.seedEdges) {
      const exactEdge = exactByEdgeKey.get(blockScanEdgeKey(coarseEdge));
      if (
        !exactEdge ||
        blockScanEdgeMetadataFingerprint(coarseEdge) !==
          blockScanEdgeMetadataFingerprint(exactEdge)
      ) {
        rejected = true;
        break;
      }
      exactEdges.push(exactEdge);
    }
    if (rejected || exactEdges.length !== opportunity.seedEdges.length) {
      rejectedRouteCount++;
      continue;
    }
    const exactProbeOpportunity = rebaseOpportunity(
      opportunity,
      exactEdges,
      exact.sourceBlock,
    );
    candidates.push(Object.freeze({
      [nMinusOneCoarseCandidateBrand]: true as const,
      coarseOpportunity: opportunity,
      exactProbeOpportunity,
      coarseSourceBlock: coarse.sourceBlock,
      coarseSourceBlockHash: coarse.sourceBlockHash,
      requiredExactSourceBlock: exact.sourceBlock,
      requiredExactSourceBlockHash: exact.sourceBlockHash,
    }));
  }
  const finishedAtMs = Date.now();

  return Object.freeze({
    pricingMode: "n_minus_one_coarse_current_n_exact" as const,
    recallMode: "stale-positive-only" as const,
    fullCoverage: false as const,
    degradedRecallReasons: Object.freeze([
      "current_n_mutation_anchors_unavailable",
      "off_event_dependencies_uncovered",
    ] as const),
    coarseSourceBlock: coarse.sourceBlock,
    coarseSourceBlockHash: coarse.sourceBlockHash,
    requiredExactSourceBlock: exact.sourceBlock,
    requiredExactSourceBlockHash: exact.sourceBlockHash,
    scan,
    scanTimingMs,
    atomicValidationTimingMs,
    wrapperTimingMs: Object.freeze({
      atomicValidation: Math.max(
        0,
        atomicValidationFinishedAtMs - startedAtMs,
      ),
      edgeFilter: Math.max(
        0,
        edgeFilterFinishedAtMs - atomicValidationFinishedAtMs,
      ),
      scan: Math.max(0, scanFinishedAtMs - edgeFilterFinishedAtMs),
      exactEdgeMap: Math.max(
        0,
        exactEdgeMapFinishedAtMs - scanFinishedAtMs,
      ),
      candidateRebase: Math.max(
        0,
        finishedAtMs - exactEdgeMapFinishedAtMs,
      ),
      total: Math.max(0, finishedAtMs - startedAtMs),
    }),
    candidates: Object.freeze(candidates),
    rejectedRouteCount,
  });
}

/**
 * Promote probe results emitted by the exact-N refiner, matched by route
 * content (seed-edge identity) instead of object identity. The refiner's
 * exact-positive output re-anchors searchCenter to the probed amount (a new
 * object), so object-identical matching can never succeed there; the
 * seed-edge key sequence is the same in both views and is the boundary guard.
 * A coarse opportunity or a newly forged lookalike cannot cross it.
 */
export function promoteNMinusOneExactCandidates(
  envelopes: readonly NMinusOneCoarseCandidate[],
  exactPositive: readonly BlockScanOpportunity[],
): BlockScanOpportunity[] {
  const envelopeByRoute = new Map(
    envelopes.map((candidate) => [
      opportunityRouteKey(candidate.exactProbeOpportunity),
      candidate,
    ] as const),
  );
  return exactPositive.map((opportunity) => {
    const envelope = envelopeByRoute.get(
      opportunityRouteKey(opportunity),
    );
    if (!envelope) {
      throw new Error(
        "N-1 fallback cannot promote a candidate outside the exact probe set",
      );
    }
    if (
      opportunity.sourceBlock !== envelope.requiredExactSourceBlock ||
      opportunity.stateBlock !== envelope.requiredExactSourceBlock
    ) {
      throw new Error("N-1 fallback exact candidate has mixed source provenance");
    }
    return Object.freeze({ ...opportunity });
  });
}

function opportunityRouteKey(
  opportunity: Pick<BlockScanOpportunity, "seedEdges">,
): string {
  return opportunity.seedEdges
    .map((edge) => blockScanEdgeKey(edge))
    .join(">");
}

function exactEdgeMap(edges: readonly TokenEdge[]): Map<string, TokenEdge> {
  const result = new Map<string, TokenEdge>();
  for (const edge of edges) {
    const key = blockScanEdgeKey(edge);
    if (result.has(key)) {
      throw new Error(`current graph has duplicate canonical edge ${key}`);
    }
    result.set(key, edge);
  }
  return result;
}

function rebaseOpportunity(
  opportunity: BlockScanOpportunity,
  exactEdges: readonly TokenEdge[],
  exactSourceBlock: number,
): BlockScanOpportunity {
  const ringTokens = exactEdges.map((edge) => edge.tokenIn.toLowerCase());
  return Object.freeze({
    ...opportunity,
    sourceBlock: exactSourceBlock,
    stateBlock: exactSourceBlock,
    cycleFingerprint: cycleFingerprint(exactSourceBlock, ringTokens),
    seedEdges: [...exactEdges],
    leavesStandingPosition: pathLeavesStandingPosition(exactEdges),
  });
}

function scannerConsumesEdge(edge: {
  readonly slotKind: string;
  readonly leavesStandingPosition: boolean;
}): boolean {
  return edge.slotKind === "swap" ||
    (edge.slotKind === "protocol" && !edge.leavesStandingPosition);
}
