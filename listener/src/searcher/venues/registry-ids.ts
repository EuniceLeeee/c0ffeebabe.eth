import type { V2LineageVenueId } from "./v2-lineage.js";

/**
 * Known IDs remain literal types so existing fast paths keep exhaustive,
 * typo-resistant declarations. A new family does not extend this central
 * list: it creates a branded ID and registers ownership with its identity
 * policy.
 */
export const KNOWN_POOL_ADAPTER_IDS = Object.freeze([
  "curve",
  "curve-nr",
  "curve-underlying",
  "univ3",
  "univ2",
  "univ4",
  "balancer-v3",
  "dodo-v2",
  "psm",
  "fluid-vault",
  "fluid-dex",
  "wsteth",
  "erc4626",
  "erc4626-silo-redeem",
  "goldx",
  "rocksolid",
  "metronome-synth",
  "metronome-hgusdc",
  "eigenpie-deposit-router",
] as const);

export type KnownPoolAdapterId = typeof KNOWN_POOL_ADAPTER_IDS[number];
declare const registeredPoolAdapterIdBrand: unique symbol;
export type RegisteredPoolAdapterId = string & {
  readonly [registeredPoolAdapterIdBrand]: "RegisteredPoolAdapterId";
};
export type PoolAdapterId = KnownPoolAdapterId | RegisteredPoolAdapterId;

export const KNOWN_VENUE_IDS = Object.freeze([
  "unknown",
  "univ2",
  "sushiswap-v2",
  "pancake-v2",
  "rigelswap",
  "difx",
  "univ3",
  "pancake-v3",
  "univ3-fork-075c",
  "panoramaswap-v1",
  "univ4",
  "balancer-v3",
  "dodo-v2",
  "erc4626",
  "erc4626-silo-redeem",
  "curve",
  "curve-nr",
  "goldx",
  "psm",
  "fluid",
  "smardex",
  "ousd",
  "enzyme",
] as const);

type KnownStaticVenueId = typeof KNOWN_VENUE_IDS[number];
export type KnownVenueId = KnownStaticVenueId | V2LineageVenueId;
declare const registeredVenueIdBrand: unique symbol;
export type RegisteredVenueId = string & {
  readonly [registeredVenueIdBrand]: "RegisteredVenueId";
};
export type VenueId = KnownVenueId | RegisteredVenueId;

export const VENUE_IDENTITY_SOURCES = Object.freeze([
  "factory-call",
  "factory-call-provisional",
  "factory-event",
  "curve-metaregistry",
  "curve-metaregistry-underlying",
  "curve-underlying-provisional",
  "v4-manager",
  "balancer-v3-vault",
  "dodo-factory-registry",
  "erc4626-standard",
  "erc4626-silo-redeem-behavior",
  "eigenpie-compatible-call-surface",
  "fluid-dex-factory-behavior",
  "fluid-vault-factory-behavior",
  "seed",
  // The strict catalog lifecycle is the only startup identity authority; its
  // emitted identitySource label is a registered source like any other.
  "strict-lifecycle",
] as const);

export type KnownVenueIdentitySource = typeof VENUE_IDENTITY_SOURCES[number];
declare const registeredVenueIdentitySourceBrand: unique symbol;
export type RegisteredVenueIdentitySource = string & {
  readonly [registeredVenueIdentitySourceBrand]: "RegisteredVenueIdentitySource";
};
export type VenueIdentitySource =
  | KnownVenueIdentitySource
  | RegisteredVenueIdentitySource;

export function poolAdapterId(value: string): RegisteredPoolAdapterId {
  return checkedId(value, "pool adapter") as RegisteredPoolAdapterId;
}

export function venueId(value: string): RegisteredVenueId {
  return checkedId(value, "venue") as RegisteredVenueId;
}

export function venueIdentitySource(value: string): RegisteredVenueIdentitySource {
  return checkedId(value, "venue identity source") as RegisteredVenueIdentitySource;
}

export function isKnownPoolAdapterId(value: unknown): value is KnownPoolAdapterId {
  return typeof value === "string" &&
    (KNOWN_POOL_ADAPTER_IDS as readonly string[]).includes(value);
}

export function isKnownVenueId(value: unknown): value is KnownVenueId {
  if (typeof value !== "string") return false;
  if ((KNOWN_VENUE_IDS as readonly string[]).includes(value)) return true;
  return /^v2-factory:0x[0-9a-f]{40}$/.test(value);
}

export function isKnownVenueIdentitySource(
  value: unknown,
): value is KnownVenueIdentitySource {
  return typeof value === "string" &&
    (VENUE_IDENTITY_SOURCES as readonly string[]).includes(value);
}

export function isNonemptyRegistryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function checkedId(value: string, kind: string): string {
  if (!isNonemptyRegistryId(value)) {
    throw new Error(`${kind} id must be a non-empty trimmed string`);
  }
  return value;
}
