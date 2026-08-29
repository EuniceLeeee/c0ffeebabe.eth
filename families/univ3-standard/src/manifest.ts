import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";

export const UNIV3_STANDARD_FAMILY_ID = "univ3-standard" as const;
export const UNIV3_STANDARD_FAMILY_VERSION = "1.0.0" as const;
export const UNIV3_STANDARD_SOURCE_WINDOW_BLOCKS = 50 as const;
export const UNIV3_STANDARD_SOURCE_PLAN_ID = "univ3-standard.fixed-cutoff-50-block" as const;
export const UNIV3_STANDARD_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/univ3-standard/source-plan-schema/v1", UNIV3_STANDARD_SOURCE_PLAN_ID));
export const UNIV3_STANDARD_HISTORY_SOURCE_PLAN_ID = "univ3-standard.pool-created-contiguous-history" as const;
export const UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/univ3-standard/history-source-plan-schema/v1", UNIV3_STANDARD_HISTORY_SOURCE_PLAN_ID));

export const UNIV3_SWAP_SELECTOR = "0x128acb08" as const;
export const UNIV3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118" as const;
export const UNIV3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as const;

export const UNIV3_CAPABILITY_IDS = Object.freeze({
  state: "family.univ3-standard.state",
  coarse: "family.univ3-standard.coarse",
  exact: "family.univ3-standard.exact",
} as const);

export const UNIV3_ACTION_OWNER_ID = "family.univ3-standard.swap-action" as const;

export const UNIV3_STANDARD_MANIFEST = Object.freeze({
  familyId: UNIV3_STANDARD_FAMILY_ID,
  version: UNIV3_STANDARD_FAMILY_VERSION,
  domain: "swap" as const,
  sourcePlans: Object.freeze([Object.freeze({
    id: UNIV3_STANDARD_SOURCE_PLAN_ID,
    windowBlocks: UNIV3_STANDARD_SOURCE_WINDOW_BLOCKS,
    evidenceChannel: "nominate" as const,
  })]),
  core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const),
  extensions: Object.freeze(["state", "coarse", "exact"] as const),
  actionOwners: Object.freeze([UNIV3_ACTION_OWNER_ID]),
});

export const UNIV3_STANDARD_OWNER_REF: Hash = hashDomain("aloha/univ3-standard/owner/v1", {
  familyId: UNIV3_STANDARD_FAMILY_ID,
  version: UNIV3_STANDARD_FAMILY_VERSION,
});

export const UNIV3_STANDARD_DISCOVERY = Object.freeze({
  evidenceChannel: "nominate" as const,
  patternIds: Object.freeze(["univ3-pool-surface", "univ3-pool-created", "univ3-swap-call", "univ3-swap-log"]),
  reverseIdentity: "factory.getPool(token0, token1, fee)" as const,
});
