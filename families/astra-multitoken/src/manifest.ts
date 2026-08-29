import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export const ASTRA_FAMILY_ID = "astra-multitoken" as const;
export const ASTRA_FAMILY_VERSION = "1.0.0" as const;
export const ASTRA_SOURCE_PLAN_ID = "astra-multitoken.fixed-cutoff-50-block" as const;
export const ASTRA_HISTORY_SOURCE_PLAN_ID = "astra-multitoken.change-history" as const;
export const ASTRA_SOURCE_WINDOW_BLOCKS = 50 as const;

// Keccak-derived selector/topic for the actual Astra ABI.  Keep these in the
// Family leaf: discovery and execution must agree on the same protocol
// surface, while the central pipeline remains selector-agnostic.
export const ASTRA_CHANGE_SELECTOR = "0x5e5144eb" as const;
export const ASTRA_CHANGE_TOPIC = "0x24cee3d6b5651a987362aa6216b9d34a39212f0f1967dfd48c2c3a4fc3c576dc" as Hash;
export const ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH = hashDomain("aloha/astra-multitoken/history-source-plan-schema/v1", ASTRA_HISTORY_SOURCE_PLAN_ID);
export const ASTRA_MULTITOKEN_INTERFACE_ID = "0x81624e24" as const;
export const ASTRA_BASE_INTERFACE_ID = "0xd5c368b6" as const;

export const ASTRA_STAGE_IDS = Object.freeze({
  nomination: "family.astra-multitoken.nomination",
  identity: "family.astra-multitoken.identity",
  materialization: "family.astra-multitoken.materialization",
  projection: "family.astra-multitoken.projection",
  rehydration: "family.astra-multitoken.rehydration",
  state: "family.astra-multitoken.state",
  coarse: "family.astra-multitoken.coarse",
  exact: "family.astra-multitoken.exact",
} as const);

export const ASTRA_ACTION_OWNER_ID = "family.astra-multitoken.convert-action" as const;
export const ASTRA_OWNER_REF: Hash = hashDomain("aloha/astra-multitoken/owner/v1", {
  familyId: ASTRA_FAMILY_ID,
  version: ASTRA_FAMILY_VERSION,
});

export const ASTRA_EFFECT_OBLIGATIONS = Object.freeze([
  "return-data",
  "token-delta",
  "logs",
] as const);

export const ASTRA_SOURCE_CONTRACT = Object.freeze({
  category: "protocol" as const,
  domain: "protocol" as const,
  completeness: "nomination-only" as const,
  recentBehaviorWindowBlocks: 50 as const,
  recentBehaviorContributesOmissionAuthority: false as const,
  strictReleaseDenominator: "complete-change-event-history-plus-reverse-identity" as const,
});
export const ASTRA_SOURCE_CONTRACT_SCHEMA_HASH = hashDomain("aloha/astra-multitoken/source-contract/v1", ASTRA_SOURCE_CONTRACT);
export const ASTRA_MANIFEST = Object.freeze({ familyId: ASTRA_FAMILY_ID, version: ASTRA_FAMILY_VERSION, category: "protocol" as const, domain: "protocol" as const, sourceContract: ASTRA_SOURCE_CONTRACT });
export const ASTRA_MANIFEST_HASH = hashDomain("aloha/astra-multitoken/manifest/v1", ASTRA_MANIFEST);
