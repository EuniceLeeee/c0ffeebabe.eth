import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";

export const CURVE_UNDERLYING_FAMILY_ID = "curve-underlying" as const;
export const CURVE_UNDERLYING_FAMILY_VERSION = "1.0.0" as const;
export const CURVE_UNDERLYING_SOURCE_WINDOW_BLOCKS = 50 as const;
export const CURVE_UNDERLYING_SOURCE_PLAN_ID = "curve-underlying.fixed-cutoff-50-block" as const;
export const CURVE_UNDERLYING_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/curve-underlying/source-plan-schema/v1", CURVE_UNDERLYING_SOURCE_PLAN_ID));
export const CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_ID = "curve-underlying.metaregistry-complete-snapshot" as const;
export const CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/curve-underlying/registry-source-plan-schema/v1", CURVE_UNDERLYING_REGISTRY_SOURCE_PLAN_ID));
export const CURVE_METAREGISTRY = "0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc" as const;
export const CURVE_UNDERLYING_I128_SELECTOR = "0xa6417ed6" as const;
export const CURVE_UNDERLYING_UINT_SELECTOR = "0x65b2489b" as const;
export const CURVE_UNDERLYING_I128_SWAP_TOPIC = "0xd013ca23e77a65003c2c659c5442c00c805371b7fc1ebd4c206c41d1536bd90b" as const;
export const CURVE_UNDERLYING_UINT_SWAP_TOPIC = "0xadf5c0d3bc909b7784721a34c8651ffa00123015ef32b9d69cf6d5b2bba40756" as const;
export const CURVE_UNDERLYING_CAPABILITY_IDS = Object.freeze({ state: "family.curve-underlying.state", coarse: "family.curve-underlying.coarse", exact: "family.curve-underlying.exact" } as const);
export const CURVE_UNDERLYING_ACTION_OWNER_ID = "family.curve-underlying.swap-action" as const;
export const CURVE_UNDERLYING_MANIFEST = Object.freeze({ familyId: CURVE_UNDERLYING_FAMILY_ID, version: CURVE_UNDERLYING_FAMILY_VERSION, domain: "swap" as const, sourcePlans: Object.freeze([{ id: CURVE_UNDERLYING_SOURCE_PLAN_ID, windowBlocks: 50, evidenceChannel: "nominate" as const }]), core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"]), extensions: Object.freeze(["state", "coarse", "exact"]), actionOwners: Object.freeze([CURVE_UNDERLYING_ACTION_OWNER_ID]) });
export const CURVE_UNDERLYING_OWNER_REF: Hash = hashDomain("aloha/curve-underlying/owner/v1", { familyId: CURVE_UNDERLYING_FAMILY_ID, version: CURVE_UNDERLYING_FAMILY_VERSION });
