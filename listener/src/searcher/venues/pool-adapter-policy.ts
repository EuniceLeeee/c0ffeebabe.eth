import type { PoolEntry } from "../planner/token-graph.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./production-family-composition.js";
import {
  isKnownVenueId,
  isKnownVenueIdentitySource,
  type VenueId,
  type VenueIdentitySource,
} from "./registry-ids.js";

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
  return isKnownVenueId(value) ||
    // Strict-catalog universe rows carry the plugin-declared pool-adapter
    // label as their venueId (provenance projection, same catalog source as
    // PRODUCTION_POOL_ADAPTERS); accept any catalog-declared label.
    (typeof value === "string" &&
      PRODUCTION_POOL_ADAPTER_SET.has(value as PoolEntry["adapter"]));
}

export function isProductionVenueIdentitySource(
  value: unknown,
): value is VenueIdentitySource {
  return isKnownVenueIdentitySource(value);
}
