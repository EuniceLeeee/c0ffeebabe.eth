import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export const ANGSTROM_V4_FAMILY_ID = "angstrom-v4" as const;
export const ANGSTROM_V4_FAMILY_VERSION = "1.0.0" as const;
export const ANGSTROM_V4_SOURCE_WINDOW_BLOCKS = 50 as const;
export const ANGSTROM_V4_SOURCE_PLAN_ID = "angstrom-v4.fixed-cutoff-50-block" as const;
export const ANGSTROM_V4_HISTORY_SOURCE_PLAN_ID = "angstrom-v4.pool-manager-initialize-history" as const;
export const ANGSTROM_V4_CAPABILITY_IDS = Object.freeze({
  state: "family.angstrom-v4.state",
  coarse: "family.angstrom-v4.coarse",
  exact: "family.angstrom-v4.exact",
} as const);
export const ANGSTROM_V4_ACTION_OWNER_ID = "family.angstrom-v4.swap-action" as const;

/** Angstrom uses the Uniswap v4 PoolManager Initialize event as its pool witness. */
export const ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC: Hash = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH = hashDomain("aloha/angstrom-v4/history-source-plan-schema/v1", ANGSTROM_V4_HISTORY_SOURCE_PLAN_ID);
export const ANGSTROM_V4_SOURCE_CONTRACT = Object.freeze({
  identityAuthority: "pool-manager-initialize-history-plus-hook-binding" as const,
  historyRange: "latest-14400-blocks" as const,
  historyChunkBlocks: 500 as const,
  recentBehaviorWindowBlocks: 50 as const,
  recentBehaviorContributesOmissionAuthority: false as const,
});

export const ANGSTROM_V4_MANIFEST = Object.freeze({
  familyId: ANGSTROM_V4_FAMILY_ID,
  version: ANGSTROM_V4_FAMILY_VERSION,
  domain: "swap" as const,
  sourcePlans: Object.freeze([{
    id: ANGSTROM_V4_SOURCE_PLAN_ID,
    windowBlocks: ANGSTROM_V4_SOURCE_WINDOW_BLOCKS,
    evidenceChannel: "nominate" as const,
  }, {
    id: ANGSTROM_V4_HISTORY_SOURCE_PLAN_ID,
    historyStartBlock: null,
    evidenceChannel: "complete-history" as const,
  }]),
  core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const),
  extensions: Object.freeze(["state", "coarse", "exact"] as const),
  actionOwners: Object.freeze([ANGSTROM_V4_ACTION_OWNER_ID]),
});
export const ANGSTROM_V4_MANIFEST_HASH: Hash = hashDomain("aloha/angstrom-v4/manifest/v1", ANGSTROM_V4_MANIFEST);
export const ANGSTROM_V4_OWNER_REF: Hash = hashDomain("aloha/angstrom-v4/owner/v1", {
  familyId: ANGSTROM_V4_FAMILY_ID,
  version: ANGSTROM_V4_FAMILY_VERSION,
});
