import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";

export interface RouteInstanceIdentityCapability {
  /**
   * Stable family-local instance identity. It must distinguish two logical
   * instances that share one execution target.
   */
  instanceKey(pool: PoolEntry): string;
  /**
   * Stable execution discriminator within one instance and direction.
   * Venue-specific fields belong in this family callback, never in the kernel.
   */
  executionVariantKey(edge: TokenEdge, pool: PoolEntry): string;
}

/**
 * Mature address-backed families use this wrapper. Multi-instance families
 * already expose logicalInstanceId; singleton managers override the capability
 * in their own family module.
 */
export const DEFAULT_ROUTE_INSTANCE_IDENTITY: RouteInstanceIdentityCapability =
  Object.freeze({
    instanceKey(pool: PoolEntry) {
      const address = pool.address.toLowerCase();
      return JSON.stringify([address, pool.logicalInstanceId ?? null]);
    },
    executionVariantKey(edge: TokenEdge) {
      return edge.adapterId;
    },
  });

export function routeIdentityCapability(
  family: { readonly routeIdentity?: RouteInstanceIdentityCapability },
): RouteInstanceIdentityCapability {
  return family.routeIdentity ?? DEFAULT_ROUTE_INSTANCE_IDENTITY;
}

/**
 * One validated identity boundary shared by registry declarations, graph
 * input deduplication and edge binding.
 */
export function routeInstanceKey(
  family: {
    readonly id: string;
    readonly routeIdentity?: RouteInstanceIdentityCapability;
  },
  pool: PoolEntry,
): string {
  const capability = routeIdentityCapability(family);
  const instanceKey = stableNonemptyKey(
    capability.instanceKey(pool),
    `${family.id} instance`,
  );
  if (capability.instanceKey(pool) !== instanceKey) {
    throw new Error(`${family.id} produced an unstable instance key`);
  }
  return instanceKey;
}

export function bindRouteInstanceIdentity(
  family: {
    readonly id: string;
    readonly routeIdentity?: RouteInstanceIdentityCapability;
  },
  pool: PoolEntry,
  edges: readonly TokenEdge[],
): TokenEdge[] {
  const capability = routeIdentityCapability(family);
  const instanceKey = routeInstanceKey(family, pool);

  const seen = new Set<string>();
  return edges.map((edge) => {
    const executionVariantKey = stableNonemptyKey(
      capability.executionVariantKey(edge, pool),
      `${family.id} execution variant`,
    );
    if (capability.executionVariantKey(edge, pool) !== executionVariantKey) {
      throw new Error(`${family.id} produced an unstable execution variant key`);
    }
    const directedKey = [
      instanceKey,
      edge.tokenIn.toLowerCase(),
      edge.tokenOut.toLowerCase(),
      executionVariantKey,
    ].join("\u001f");
    if (seen.has(directedKey)) {
      throw new Error(
        `${family.id} produced duplicate family-instance route ${directedKey}`,
      );
    }
    seen.add(directedKey);
    const { canonicalEdgeId: _staleCanonicalEdgeId, ...unbound } = edge;
    return {
      ...unbound,
      instanceKey,
      executionVariantKey,
    };
  });
}

export function edgeInstanceKey(edge: TokenEdge): string {
  return edge.instanceKey ?? edge.target.toLowerCase();
}

export function edgeExecutionVariantKey(edge: TokenEdge): string {
  if (edge.executionVariantKey) return edge.executionVariantKey;
  /**
   * Compatibility identity for edges that have not crossed the registry
   * binding boundary yet (focused fixtures and frozen legacy artifacts).
   *
   * Production graph edges always carry the family-owned key.  The fallback
   * must nevertheless retain every structural discriminator already present
   * on TokenEdge; falling back to adapterId alone collapses singleton-manager
   * venues (for example two opaque pool ids sharing one target).  This is a
   * protocol-agnostic tuple, not a venue switch.
   */
  return JSON.stringify([
    edge.adapterId,
    edge.poolId?.toLowerCase() ?? null,
    canonicalV4PoolKey(edge.v4PoolKey),
    edge.curveI ?? null,
    edge.curveJ ?? null,
  ]);
}

function stableNonemptyKey(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} key must be a non-empty trimmed string`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} key must not contain control separators`);
  }
  return value;
}

function canonicalV4PoolKey(
  value: TokenEdge["v4PoolKey"],
): readonly unknown[] | null {
  if (!value) return null;
  return [
    value.currency0.toLowerCase(),
    value.currency1.toLowerCase(),
    value.fee,
    value.tickSpacing,
    value.hooks.toLowerCase(),
  ];
}
