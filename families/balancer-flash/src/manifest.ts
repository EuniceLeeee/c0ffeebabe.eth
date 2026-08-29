import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export const BALANCER_FLASH_FAMILY_ID = "balancer-flash" as const;
export const BALANCER_FLASH_FAMILY_VERSION = "1.0.0" as const;
export const BALANCER_FLASH_SOURCE_WINDOW_BLOCKS = 50 as const;
export const BALANCER_FLASH_SOURCE_PLAN_ID = "balancer-flash.fixed-cutoff-50-block" as const;
export const BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID = "balancer-flash.singleton-complete-snapshot" as const;
export const BALANCER_FLASH_CAPABILITY_IDS = Object.freeze({
  state: "family.balancer-flash.state",
  coarse: "family.balancer-flash.coarse",
  exact: "family.balancer-flash.exact",
} as const);
export const BALANCER_FLASH_ACTION_OWNER_ID = "family.balancer-flash.flash-loan-action" as const;
export const BALANCER_VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8" as const;

/** Balancer Vault FlashLoan(address indexed recipient,address indexed token,uint256,uint256). */
export const BALANCER_FLASH_CONTRACT_EVIDENCE_TOPIC: Hash = "0x0d7d75e01ab95780d3cd1c8ec0dd6c2ce19e3a20427eec8bf53283b6fb8e95f0";
export const BALANCER_FLASH_INSTANCE_CONTRACT = Object.freeze({
  category: "funding" as const,
  domain: "funding" as const,
  instanceRequirement: "optional" as const,
  zeroInstanceMeaning: "valid-only-with-complete-source-partition" as const,
  currentSourceAuthority: "singleton-complete-snapshot" as const,
  strictReleaseDenominator: "singleton-complete-snapshot" as const,
});
export const BALANCER_FLASH_INSTANCE_CONTRACT_SCHEMA_HASH = hashDomain("aloha/balancer-flash/instance-contract/v1", BALANCER_FLASH_INSTANCE_CONTRACT);

export const BALANCER_FLASH_MANIFEST = Object.freeze({
  familyId: BALANCER_FLASH_FAMILY_ID,
  version: BALANCER_FLASH_FAMILY_VERSION,
  domain: "funding" as const,
  category: "funding" as const,
  instanceContract: BALANCER_FLASH_INSTANCE_CONTRACT,
  sourcePlans: Object.freeze([
    { id: BALANCER_FLASH_SOURCE_PLAN_ID, windowBlocks: BALANCER_FLASH_SOURCE_WINDOW_BLOCKS, evidenceChannel: "nominate" as const },
    { id: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID, windowBlocks: 1, evidenceChannel: "complete-snapshot" as const },
  ]),
  core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const),
  extensions: Object.freeze(["state", "coarse", "exact"] as const),
  actionOwners: Object.freeze([BALANCER_FLASH_ACTION_OWNER_ID]),
});
export const BALANCER_FLASH_MANIFEST_HASH: Hash = hashDomain("aloha/balancer-flash/manifest/v1", BALANCER_FLASH_MANIFEST);
export const BALANCER_FLASH_OWNER_REF: Hash = hashDomain("aloha/balancer-flash/owner/v1", {
  familyId: BALANCER_FLASH_FAMILY_ID,
  version: BALANCER_FLASH_FAMILY_VERSION,
});
