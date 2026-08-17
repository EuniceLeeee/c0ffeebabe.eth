/**
 * Legacy/trusted-harness compatibility facade.
 *
 * Production must import blockscan-scanner-production.ts instead. This file
 * preserves the historical cache + protocolMids API byte-for-byte at its call
 * sites while adapting it to the single resolved-mid scanner kernel.
 */
import type { TokenEdge } from "../planner/token-graph.js";
import { v4PoolId } from "../planner/token-graph.js";
import type { PoolStateCache } from "../solver/pool-state-cache.js";
import {
  readAnyWarmMid,
  type ExternalMidQuote,
  type RouteVenueMid,
  type SyncMidReadContext,
} from "../venues/mid-readers.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  blockScanSelectionProvenance,
  estimateResolvedRingSpreadBps,
  isAdmissibleBlockScanRingShape,
  scanBlockStateFromResolvedMids,
  type BlockScanCoreConfig,
  type BlockScanOutcome as CoreBlockScanOutcome,
  type NaturalBlockScanSelectionProvenance,
} from "./blockscan-scanner-core.js";

export { isAdmissibleBlockScanRingShape };
export type { NaturalBlockScanSelectionProvenance };

export interface ProtocolMid extends ExternalMidQuote {}

export interface BlockScanConfig extends BlockScanCoreConfig {
  protocolMids?: ReadonlyMap<string, ProtocolMid>;
}

export interface BlockScanOutcome extends CoreBlockScanOutcome {
  readonly selectionProvenance: NaturalBlockScanSelectionProvenance;
}

export function naturalBlockScanSelectionProvenance<T>(input: {
  readonly naturallyEnumerated: readonly T[];
  readonly selected: readonly T[];
  readonly maxCandidates: number;
}): NaturalBlockScanSelectionProvenance {
  const naturalEntries = new Set(input.naturallyEnumerated);
  return Object.freeze({
    kind: "natural_coarse_ranked",
    selectionMode: "production",
    forcedSelectionCount: input.selected.reduce(
      (count, entry) => count + (naturalEntries.has(entry) ? 0 : 1),
      0,
    ),
    eligibleCandidateCount: input.naturallyEnumerated.length,
    selectedCandidateCount: input.selected.length,
    maxCandidates: input.maxCandidates,
  });
}

export function detectBlockScanOpportunities(input: {
  edges: TokenEdge[];
  cache: PoolStateCache;
  sourceBlock: number;
  swapTouched: Set<string> | null;
  cfg: BlockScanConfig;
}): BlockScanOutcome {
  const { protocolMids, ...cfg } = input.cfg;
  const outcome = scanBlockStateFromResolvedMids({
    edges: input.edges,
    sourceBlock: input.sourceBlock,
    swapTouched: input.swapTouched,
    cfg,
    mids: buildLegacyMidBook(
      input.edges,
      input.cache,
      input.sourceBlock,
      protocolMids,
    ),
  });
  return Object.freeze({
    ...outcome,
    selectionProvenance: blockScanSelectionProvenance(
      outcome,
      input.cfg.maxCandidates,
    ),
  });
}

/** Historical diagnostic signature retained for the trusted harnesses. */
export function estimateBlockScanRingSpreadBps(
  cache: PoolStateCache,
  sourceBlock: number,
  edges: TokenEdge[],
  protocolMids?: ReadonlyMap<string, ProtocolMid>,
): number | null {
  return estimateResolvedRingSpreadBps(
    edges,
    buildLegacyMidBook(edges, cache, sourceBlock, protocolMids),
  );
}

function buildLegacyMidBook(
  edges: readonly TokenEdge[],
  cache: PoolStateCache,
  sourceBlock: number,
  protocolMids?: ReadonlyMap<string, ProtocolMid>,
): ReadonlyMap<string, RouteVenueMid> {
  const mids = new Map<string, RouteVenueMid>();
  for (const edge of edges) {
    const reader = legacyReader(edge);
    if (!reader) continue;
    const mid = reader({
      cache,
      sourceBlock,
      a: edge.tokenIn.toLowerCase(),
      b: edge.tokenOut.toLowerCase(),
      pool: edgeVenueIdentity(edge),
      edges: [edge],
      externalMids: protocolMids,
    });
    if (mid) mids.set(blockScanEdgeKey(edge), mid);
  }
  return mids;
}

function legacyReader(
  edge: TokenEdge,
): ((ctx: SyncMidReadContext) => RouteVenueMid | null) | null {
  const family = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(edge.adapterId);
  if (!family) return null;
  return readAnyWarmMid;
}

function edgeVenueIdentity(edge: TokenEdge): string {
  if (edge.poolId) return edge.poolId.toLowerCase();
  if (edge.v4PoolKey) return v4PoolId(edge.v4PoolKey).toLowerCase();
  return edge.target.toLowerCase();
}
