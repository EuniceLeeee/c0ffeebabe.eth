import type { PoolEntry } from "./planner/token-graph.js";
import {
  validatedRouteImmutableBindingHash,
} from "./venues/route-immutable-binding.js";

/**
 * Low-level physical registry identity. This module deliberately has no
 * production-registry dependency so discovery kernels can key cache rows
 * without creating a registry initialization cycle.
 */
export function poolRegistryKey(pool: PoolEntry): string {
  const routeBindingHash =
    validatedRouteImmutableBindingHash(pool.routeBinding);
  if (routeBindingHash !== null) {
    return JSON.stringify([
      pool.address.toLowerCase(),
      pool.logicalInstanceId ?? null,
      pool.poolId?.toLowerCase() ?? null,
      routeBindingHash,
      pool.currency0?.toLowerCase() ?? null,
      pool.currency1?.toLowerCase() ?? null,
      pool.fee ?? null,
      pool.tickSpacing ?? null,
      pool.hooks?.toLowerCase() ?? null,
    ]);
  }
  // Data-driven physical identity: a pool carrying v4-style identity fields
  // (poolId, or the currency/fee/tickSpacing/hooks tuple) keys on those
  // fields; a bare address keys on the address. No family name is consulted.
  const hasV4StyleIdentity =
    pool.poolId !== undefined ||
    (
      pool.currency0 !== undefined &&
      pool.currency1 !== undefined &&
      pool.fee !== undefined &&
      pool.tickSpacing !== undefined &&
      pool.hooks !== undefined
    );
  if (hasV4StyleIdentity) {
    return [
      pool.address.toLowerCase(),
      pool.poolId?.toLowerCase() ?? "",
      pool.currency0?.toLowerCase() ?? "",
      pool.currency1?.toLowerCase() ?? "",
      pool.fee === undefined ? "" : String(pool.fee),
      pool.tickSpacing === undefined ? "" : String(pool.tickSpacing),
      pool.hooks?.toLowerCase() ?? "",
    ].join(":");
  }
  const address = pool.address.toLowerCase();
  return pool.logicalInstanceId === undefined
    ? address
    : `${address}:${pool.logicalInstanceId}`;
}

/**
 * Collection-only identity for runtime rows projected by protocol discovery.
 * Execution and semantic-route identity remain owned by route-instance
 * capabilities; this key is only for registry row replacement/deduplication.
 */
export function poolProjectionRowKey(pool: PoolEntry): string {
  const physicalKey = poolRegistryKey(pool);
  const owner = pool.discoveryOwnerAdapterId;
  if (owner === undefined) return physicalKey;
  if (!owner || owner !== owner.trim() || /[\u0000-\u001f\u007f]/.test(owner)) {
    throw new Error("discovery projection owner must be a stable non-empty id");
  }
  return JSON.stringify([owner, physicalKey]);
}
