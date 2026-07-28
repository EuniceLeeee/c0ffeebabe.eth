import { createHash } from "node:crypto";
import type { BlockScanOpportunity } from "./detector/detector.js";
import type { TokenEdge } from "./planner/token-graph.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";

const ROUTE_ID_DOMAIN = "blockscan-route-v1";

export interface BlockScanRouteLocator {
  readonly routeId: string;
  readonly tokenRing: readonly string[];
  readonly venuePath: readonly (readonly [adapterId: string, venueId: string])[];
  readonly flashToken: string;
}

export function blockScanRouteLocatorCacheKey(
  opportunity: Pick<BlockScanOpportunity, "seedEdges" | "flashToken">,
): string {
  return JSON.stringify([
    ROUTE_ID_DOMAIN,
    opportunity.seedEdges.map((edge) => [
      blockScanEdgeKey(edge),
      edge.adapterId,
      (edge.poolId ?? edge.target).toLowerCase(),
      edge.tokenIn.toLowerCase(),
      edge.tokenOut.toLowerCase(),
    ]),
    opportunity.flashToken.toLowerCase(),
  ]);
}

export function blockScanRouteId(edges: readonly TokenEdge[]): string {
  const preimage = JSON.stringify([
    ROUTE_ID_DOMAIN,
    ...edges.map(blockScanEdgeKey),
  ]);
  return `0x${createHash("sha256").update(preimage).digest("hex")}`;
}

export function blockScanRouteLocator(
  opportunity: Pick<BlockScanOpportunity, "seedEdges" | "flashToken">,
): BlockScanRouteLocator {
  const edges = opportunity.seedEdges;
  const tokenRing = edges.length === 0
    ? []
    : [
        edges[0]!.tokenIn.toLowerCase(),
        ...edges.map((edge) => edge.tokenOut.toLowerCase()),
      ];
  return Object.freeze({
    routeId: blockScanRouteId(edges),
    tokenRing: Object.freeze(tokenRing),
    venuePath: Object.freeze(
      edges.map((edge) =>
        Object.freeze([
          edge.adapterId,
          (edge.poolId ?? edge.target).toLowerCase(),
        ] as const)
      ),
    ),
    flashToken: opportunity.flashToken.toLowerCase(),
  });
}
