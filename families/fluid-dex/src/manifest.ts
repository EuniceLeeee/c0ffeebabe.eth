import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export const FLUID_DEX_FAMILY_ID = "fluid-dex" as const;
export const FLUID_DEX_FAMILY_VERSION = "1.0.0" as const;
export const FLUID_DEX_SOURCE_WINDOW_BLOCKS = 50 as const;
export const FLUID_DEX_SOURCE_PLAN_ID = "fluid-dex.fixed-cutoff-50-block" as const;
export const FLUID_DEX_FACTORY_SOURCE_PLAN_ID = "fluid-dex.factory-complete-snapshot" as const;
export const FLUID_DEX_FACTORY = "0x91716c4eda1fb55e84bf8b4c7085f84285c19085" as const;
export const FLUID_DEX_CAPABILITY_IDS = Object.freeze({
  state: "family.fluid-dex.state",
  coarse: "family.fluid-dex.coarse",
  exact: "family.fluid-dex.exact",
} as const);
export const FLUID_DEX_ACTION_OWNER_ID = "family.fluid-dex.swap-action" as const;

/** Fluid DEX Swap(address,address,uint256,uint256) event. */
export const FLUID_DEX_CONTRACT_EVIDENCE_TOPIC: Hash = "0xdc004dbca4ef9c966218431ee5d9133d337ad018dd5b5c5493722803f75c64f7";

export const FLUID_DEX_MANIFEST = Object.freeze({
  familyId: FLUID_DEX_FAMILY_ID,
  version: FLUID_DEX_FAMILY_VERSION,
  domain: "swap" as const,
  sourcePlans: Object.freeze([{
    id: FLUID_DEX_SOURCE_PLAN_ID,
    windowBlocks: FLUID_DEX_SOURCE_WINDOW_BLOCKS,
    evidenceChannel: "nominate" as const,
  }, {
    id: FLUID_DEX_FACTORY_SOURCE_PLAN_ID,
    completeness: "complete-snapshot" as const,
    factory: FLUID_DEX_FACTORY,
  }]),
  core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const),
  extensions: Object.freeze(["state", "coarse", "exact"] as const),
  actionOwners: Object.freeze([FLUID_DEX_ACTION_OWNER_ID]),
});
export const FLUID_DEX_MANIFEST_HASH: Hash = hashDomain("aloha/fluid-dex/manifest/v1", FLUID_DEX_MANIFEST);
export const FLUID_DEX_OWNER_REF: Hash = hashDomain("aloha/fluid-dex/owner/v1", {
  familyId: FLUID_DEX_FAMILY_ID,
  version: FLUID_DEX_FAMILY_VERSION,
});
