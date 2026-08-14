import type { PoolEntry } from "../planner/token-graph.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./production-family-composition.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "./production-registry.js";
import type { VenueId, VenueIdentitySource } from "./registry-ids.js";

/**
 * Runtime pool adapter ids accepted by file-backed production inputs.
 * The universal family registry is the execution source of truth.
 */
export const PRODUCTION_POOL_ADAPTERS: readonly PoolEntry["adapter"][] = Object.freeze([
  ...new Set<PoolEntry["adapter"]>([
    ...PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll().flatMap(
      (family) => (family.plugin.manifest.poolAdapterIds ?? []) as
        PoolEntry["adapter"][],
    ),
  ]),
]);

const PRODUCTION_POOL_ADAPTER_SET = new Set(PRODUCTION_POOL_ADAPTERS);

export function isProductionPoolAdapter(value: unknown): value is PoolEntry["adapter"] {
  return typeof value === "string" &&
    PRODUCTION_POOL_ADAPTER_SET.has(value as PoolEntry["adapter"]);
}

export function isProductionVenueId(value: unknown): value is VenueId {
  return PRODUCTION_ADAPTER_FAMILIES.isRegisteredVenueId(value);
}

export function isProductionVenueIdentitySource(
  value: unknown,
): value is VenueIdentitySource {
  return PRODUCTION_ADAPTER_FAMILIES.isRegisteredIdentitySource(value);
}
