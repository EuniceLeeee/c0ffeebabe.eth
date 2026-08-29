import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";

export const UNIV4_FAMILY_ID = "univ4" as const;
export const UNIV4_FAMILY_VERSION = "1.0.0" as const;
export const UNIV4_SOURCE_WINDOW_BLOCKS = 50 as const;
export const UNIV4_SOURCE_PLAN_ID = "univ4.fixed-cutoff-50-block" as const;
export const UNIV4_HISTORY_SOURCE_PLAN_ID = "univ4.pool-manager-initialize-history" as const;
export const UNIV4_CAPABILITY_IDS = Object.freeze({
  state: "family.univ4.state",
  coarse: "family.univ4.coarse",
  exact: "family.univ4.exact",
} as const);
export const UNIV4_ACTION_OWNER_ID = "family.univ4.swap-action" as const;

/** Uniswap v4 PoolManager Initialize(bytes32,address,address,uint24,int24,address,uint160,int24). */
export const UNIV4_CONTRACT_EVIDENCE_TOPIC: Hash = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH = hashDomain("aloha/univ4/history-source-plan-schema/v1", UNIV4_HISTORY_SOURCE_PLAN_ID);
export const UNIV4_SOURCE_CONTRACT = Object.freeze({
  identityAuthority: "pool-manager-initialize-history" as const,
  historyRange: "genesis-through-cutoff" as const,
  historyChunkBlocks: 10_000 as const,
  recentBehaviorWindowBlocks: 50 as const,
  recentBehaviorContributesOmissionAuthority: false as const,
});

export const UNIV4_MANIFEST = Object.freeze({
  familyId: UNIV4_FAMILY_ID,
  version: UNIV4_FAMILY_VERSION,
  domain: "swap" as const,
  sourcePlans: Object.freeze([{
    id: UNIV4_SOURCE_PLAN_ID,
    windowBlocks: UNIV4_SOURCE_WINDOW_BLOCKS,
    evidenceChannel: "nominate" as const,
  }, {
    id: UNIV4_HISTORY_SOURCE_PLAN_ID,
    historyStartBlock: "0" as const,
    evidenceChannel: "complete-history" as const,
  }]),
  core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const),
  extensions: Object.freeze(["state", "coarse", "exact"] as const),
  actionOwners: Object.freeze([UNIV4_ACTION_OWNER_ID]),
});
export const UNIV4_MANIFEST_HASH: Hash = hashDomain("aloha/univ4/manifest/v1", UNIV4_MANIFEST);
export const UNIV4_OWNER_REF: Hash = hashDomain("aloha/univ4/owner/v1", {
  familyId: UNIV4_FAMILY_ID,
  version: UNIV4_FAMILY_VERSION,
});
