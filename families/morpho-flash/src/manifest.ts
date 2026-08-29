import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export const MORPHO_FLASH_FAMILY_ID = "morpho-flash" as const;
export const MORPHO_FLASH_FAMILY_VERSION = "1.0.0" as const;
export const MORPHO_FLASH_SOURCE_WINDOW_BLOCKS = 50 as const;
export const MORPHO_FLASH_SOURCE_PLAN_ID = "morpho-flash.fixed-cutoff-50-block" as const;
export const MORPHO_FLASH_SINGLETON_SOURCE_PLAN_ID = "morpho-flash.singleton-complete-snapshot" as const;
export const MORPHO_FLASH_CAPABILITY_IDS = Object.freeze({
  state: "family.morpho-flash.state",
  coarse: "family.morpho-flash.coarse",
  exact: "family.morpho-flash.exact",
} as const);
export const MORPHO_FLASH_ACTION_OWNER_ID = "family.morpho-flash.flash-loan-action" as const;

/** Morpho Blue is an infrastructure singleton; assets and receivers remain chain-derived. */
export const MORPHO_BLUE_SINGLETON = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as const;
export const MORPHO_FLASH_LOAN_SELECTOR = "0xe0232b42" as const;
export const MORPHO_FLASH_CALLBACK_SELECTOR = "0x31f57072" as const;
/** Morpho Blue FlashLoan(address indexed caller,address indexed token,uint256). */
export const MORPHO_FLASH_EVIDENCE_TOPIC: Hash = "0xc76f1b4fe4396ac07a9fa55a415d4ca430e72651d37d3401f3bed7cb13fc4f12";
export const MORPHO_FLASH_INSTANCE_CONTRACT = Object.freeze({ category: "funding" as const, domain: "funding" as const, instanceRequirement: "optional" as const, zeroInstanceMeaning: "valid-only-with-complete-source-partition" as const, currentSourceAuthority: "singleton-complete-snapshot" as const, strictReleaseDenominator: "singleton-complete-snapshot" as const });
export const MORPHO_FLASH_INSTANCE_CONTRACT_SCHEMA_HASH = hashDomain("aloha/morpho-flash/instance-contract/v1", MORPHO_FLASH_INSTANCE_CONTRACT);

export const MORPHO_FLASH_MANIFEST = Object.freeze({
  familyId: MORPHO_FLASH_FAMILY_ID,
  version: MORPHO_FLASH_FAMILY_VERSION,
  domain: "funding" as const,
  category: "funding" as const,
  instanceContract: MORPHO_FLASH_INSTANCE_CONTRACT,
  sourcePlans: Object.freeze([
    { id: MORPHO_FLASH_SOURCE_PLAN_ID, windowBlocks: 50, evidenceChannel: "nominate" as const },
    { id: MORPHO_FLASH_SINGLETON_SOURCE_PLAN_ID, windowBlocks: 1, evidenceChannel: "complete-snapshot" as const },
  ]),
  core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const),
  extensions: Object.freeze(["state", "coarse", "exact"] as const),
  actionOwners: Object.freeze([MORPHO_FLASH_ACTION_OWNER_ID]),
});
export const MORPHO_FLASH_MANIFEST_HASH: Hash = hashDomain("aloha/morpho-flash/manifest/v1", MORPHO_FLASH_MANIFEST);
export const MORPHO_FLASH_OWNER_REF: Hash = hashDomain("aloha/morpho-flash/owner/v1", { familyId: MORPHO_FLASH_FAMILY_ID, version: MORPHO_FLASH_FAMILY_VERSION });
