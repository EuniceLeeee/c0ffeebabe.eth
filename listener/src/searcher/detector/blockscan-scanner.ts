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
  readCurveUnderlyingExternalMid,
  readCurveWarmMid,
  readExternalSwapMid,
  readProtocolExternalMid,
  readV2WarmMid,
  readV3WarmMid,
  readV4WarmMid,
  type ExternalMidQuote,
  type RouteVenueMid,
  type SyncMidReadContext,
} from "../venues/mid-readers.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  estimateResolvedRingSpreadBps,
  isAdmissibleBlockScanRingShape,
  scanBlockStateFromResolvedMids,
  type BlockScanCoreConfig,
  type BlockScanOutcome,
} from "./blockscan-scanner-core.js";

export type { BlockScanOutcome };
export { isAdmissibleBlockScanRingShape };

export interface ProtocolMid extends ExternalMidQuote {}

export interface BlockScanConfig extends BlockScanCoreConfig {
  protocolMids?: ReadonlyMap<string, ProtocolMid>;
}

export function detectBlockScanOpportunities(input: {
  edges: TokenEdge[];
  cache: PoolStateCache;
  sourceBlock: number;
  swapTouched: Set<string> | null;
  cfg: BlockScanConfig;
}): BlockScanOutcome {
  const { protocolMids, ...cfg } = input.cfg;
  return scanBlockStateFromResolvedMids({
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
  if (family.kind === "protocol-conversion") return readProtocolExternalMid;
  if (family.id === "univ2-standard") return readV2WarmMid;
  if (family.id === "univ3-standard") return readV3WarmMid;
  if (family.id === "univ4") return readV4WarmMid;
  if (family.id === "curve-plain") return readCurveWarmMid;
  if (family.id === "curve-underlying") return readCurveUnderlyingExternalMid;
  return readExternalSwapMid;
}

function edgeVenueIdentity(edge: TokenEdge): string {
  if (edge.poolId) return edge.poolId.toLowerCase();
  if (edge.v4PoolKey) return v4PoolId(edge.v4PoolKey).toLowerCase();
  return edge.target.toLowerCase();
}
