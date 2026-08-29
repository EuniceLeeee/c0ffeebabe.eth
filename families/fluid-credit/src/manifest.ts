import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export const FLUID_CREDIT_FAMILY_ID = "fluid-credit" as const;
export const FLUID_CREDIT_FAMILY_VERSION = "1.0.0" as const;
export const FLUID_CREDIT_SOURCE_WINDOW_BLOCKS = 50 as const;
export const FLUID_CREDIT_SOURCE_PLAN_ID = "fluid-credit.fixed-cutoff-50-block" as const;
export const FLUID_CREDIT_FACTORY_SOURCE_PLAN_ID = "fluid-credit.vault-factory-complete-snapshot" as const;
export const FLUID_VAULT_FACTORY = "0x324c5dc1fc42c7a4d43d92df1eba58a54d13bf2d" as const;
export const FLUID_CREDIT_CAPABILITY_IDS = Object.freeze({ state: "family.fluid-credit.state", coarse: "family.fluid-credit.coarse", exact: "family.fluid-credit.exact" } as const);
export const FLUID_CREDIT_ACTION_OWNER_ID = "family.fluid-credit.vault-action" as const;
export const FLUID_CREDIT_PROBE_ACTOR = "0x000000000000000000000000000000000000f1d2" as const;
export const FLUID_VAULT_OPERATE_SELECTOR = "0x032d2276" as const;
export const FLUID_VAULT_CONSTANTS_SELECTOR = "0xb7791bf2" as const;
export const FLUID_VAULT_FACTORY_REVERSE_SELECTOR = "0xe6bd26a2" as const;
/** Fluid Liquidity/Vault LogOperate(address,uint256,int256,int256,address). */
export const FLUID_CREDIT_EVIDENCE_TOPIC: Hash = "0xfef64760e30a41b9d5ba7dd65ff7236a61d89ed8b44c67a29e84db1a67513a1c";
export const FLUID_CREDIT_INSTANCE_CONTRACT = Object.freeze({ category: "credit" as const, domain: "credit" as const, instanceRequirement: "optional" as const, zeroInstanceMeaning: "valid-only-with-complete-source-partition" as const, currentSourceAuthority: "complete-snapshot" as const, strictReleaseDenominator: "factory-complete-snapshot" as const });
export const FLUID_CREDIT_INSTANCE_CONTRACT_SCHEMA_HASH = hashDomain("aloha/fluid-credit/instance-contract/v1", FLUID_CREDIT_INSTANCE_CONTRACT);
export const FLUID_CREDIT_MANIFEST = Object.freeze({ familyId: FLUID_CREDIT_FAMILY_ID, version: FLUID_CREDIT_FAMILY_VERSION, domain: "credit" as const, category: "credit" as const, instanceContract: FLUID_CREDIT_INSTANCE_CONTRACT, sourcePlans: Object.freeze([{ id: FLUID_CREDIT_SOURCE_PLAN_ID, windowBlocks: 50, evidenceChannel: "nominate" as const }, { id: FLUID_CREDIT_FACTORY_SOURCE_PLAN_ID, completeness: "complete-snapshot" as const, factory: FLUID_VAULT_FACTORY }]), core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const), extensions: Object.freeze(["state", "coarse", "exact"] as const), actionOwners: Object.freeze([FLUID_CREDIT_ACTION_OWNER_ID]) });
export const FLUID_CREDIT_MANIFEST_HASH: Hash = hashDomain("aloha/fluid-credit/manifest/v1", FLUID_CREDIT_MANIFEST);
export const FLUID_CREDIT_OWNER_REF: Hash = hashDomain("aloha/fluid-credit/owner/v1", { familyId: FLUID_CREDIT_FAMILY_ID, version: FLUID_CREDIT_FAMILY_VERSION });
