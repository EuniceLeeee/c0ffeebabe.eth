import type { PoolEntry } from "../planner/token-graph.js";
import {
  LEGACY_PRODUCTION_ROUTE_EDGES,
  PRODUCTION_ROUTE_ADAPTERS,
} from "./production-registry.js";

/**
 * Runtime pool adapter ids accepted by file-backed production inputs.
 * Route Registry is the execution source of truth; legacy routes remain
 * explicit until their fixture-blocked migration is complete.
 */
export const PRODUCTION_POOL_ADAPTERS: readonly PoolEntry["adapter"][] = Object.freeze([
  ...new Set<PoolEntry["adapter"]>([
    ...PRODUCTION_ROUTE_ADAPTERS.routeLegs.list().flatMap((adapter) => adapter.poolAdapters),
    ...LEGACY_PRODUCTION_ROUTE_EDGES.flatMap((descriptor) => descriptor.poolAdapters),
  ]),
]);

const PRODUCTION_POOL_ADAPTER_SET = new Set(PRODUCTION_POOL_ADAPTERS);

export function isProductionPoolAdapter(value: unknown): value is PoolEntry["adapter"] {
  return typeof value === "string" &&
    PRODUCTION_POOL_ADAPTER_SET.has(value as PoolEntry["adapter"]);
}
