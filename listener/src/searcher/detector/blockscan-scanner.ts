/**
 * Historical raw-mid diagnostics only.
 *
 * Enumeration requires explicit effective amounts through the scanner kernel
 * or the atomic production wrapper. Cache/protocol mids cannot enumerate.
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
import { PRODUCTION_STRICT_FAMILY_DECLARATIONS } from
  "../strict-production-family-declarations.js";
import {
  estimateResolvedRingSpreadBps,
} from "./blockscan-scanner-core.js";

export interface ProtocolMid extends ExternalMidQuote {}

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
  try {
    PRODUCTION_STRICT_FAMILY_DECLARATIONS.familyIdForEdge(edge.adapterId);
    return readAnyWarmMid;
  } catch {
    return null;
  }
}

function edgeVenueIdentity(edge: TokenEdge): string {
  if (edge.poolId) return edge.poolId.toLowerCase();
  if (edge.v4PoolKey) return v4PoolId(edge.v4PoolKey).toLowerCase();
  return edge.target.toLowerCase();
}
