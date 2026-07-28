import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import type {
  PlanExecutionIdentity,
  PlanExecutionIdentityCapability,
} from "./route-leg-adapter.js";

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

/**
 * Graph-build collection key. Only a discovery-owned projection may qualify
 * the family-neutral instance key by owner. Unowned/static rows retain the
 * strict historical collision behavior, so an unarbitrated cross-family
 * overlap still fails closed.
 *
 * This key must never be written onto an edge or used as semantic route
 * identity.
 */
export function routeGraphCollectionKey(
  family: {
    readonly id: string;
    readonly routeIdentity?: RouteInstanceIdentityCapability;
  },
  pool: PoolEntry,
): string {
  const instanceKey = routeInstanceKey(family, pool);
  const owner = pool.discoveryOwnerAdapterId;
  if (owner === undefined) return instanceKey;
  if (owner !== family.id) {
    throw new Error(
      `${family.id} cannot build discovery row owned by ${owner}`,
    );
  }
  return JSON.stringify([owner, instanceKey]);
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

const DEFAULT_PLAN_EXECUTION_IDENTITY: PlanExecutionIdentityCapability =
  Object.freeze({
    resolve(node: ResolvedPlanNode): PlanExecutionIdentity {
      return Object.freeze({ routeTarget: node.target });
    },
  });

/**
 * Resolve and validate the final-plan identity once at the trusted registry
 * boundary. The family callback sees only the resolved subtree; the caller
 * independently compares this result with the graph edge.
 */
export function resolvedPlanExecutionIdentity(
  family: {
    readonly id: string;
    readonly planExecutionIdentity?: PlanExecutionIdentityCapability;
  },
  node: ResolvedPlanNode,
): PlanExecutionIdentity {
  const capability =
    family.planExecutionIdentity ?? DEFAULT_PLAN_EXECUTION_IDENTITY;
  const first = normalizePlanExecutionIdentity(
    capability.resolve(node),
    family.id,
  );
  const second = normalizePlanExecutionIdentity(
    capability.resolve(node),
    family.id,
  );
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`${family.id} produced an unstable plan execution identity`);
  }
  return first;
}

export function planExecutionIdentityMatchesEdge(
  identity: PlanExecutionIdentity,
  edge: TokenEdge,
): boolean {
  if (identity.routeTarget !== normalizedAddress(edge.target, "edge target")) {
    return false;
  }
  if (edge.poolId === undefined) return identity.poolId === undefined;
  return identity.poolId === normalizedBytes32(edge.poolId, "edge poolId");
}

function normalizePlanExecutionIdentity(
  value: PlanExecutionIdentity,
  familyId: string,
): PlanExecutionIdentity {
  if (!value || typeof value !== "object") {
    throw new Error(`${familyId} produced an invalid plan execution identity`);
  }
  const routeTarget = normalizedAddress(
    value.routeTarget,
    `${familyId} plan route target`,
  );
  const poolId = value.poolId === undefined
    ? undefined
    : normalizedBytes32(value.poolId, `${familyId} plan poolId`);
  return Object.freeze({
    routeTarget,
    ...(poolId === undefined ? {} : { poolId }),
  });
}

function normalizedAddress(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be an address`);
  }
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be an address`);
  }
  return normalized;
}

function normalizedBytes32(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be bytes32`);
  }
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be bytes32`);
  }
  return normalized;
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
