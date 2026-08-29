import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";

export const EIGENPIE_FAMILY_ID = "eigenpie" as const;
export const EIGENPIE_FAMILY_VERSION = "1.0.0" as const;
export const EIGENPIE_SOURCE_WINDOW_BLOCKS = 50 as const;
export const EIGENPIE_SOURCE_PLAN_ID = "eigenpie.fixed-cutoff-50-block" as const;
export const EIGENPIE_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/eigenpie/source-plan-schema/v1", EIGENPIE_SOURCE_PLAN_ID));
export const EIGENPIE_HISTORY_SOURCE_PLAN_ID = "eigenpie.asset-deposit-contiguous-history" as const;
export const EIGENPIE_HISTORY_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/eigenpie/history-source-plan-schema/v1", EIGENPIE_HISTORY_SOURCE_PLAN_ID));
export const EIGENPIE_ASSET_DEPOSIT_TOPIC = "0x993597fdd4cbd87389cb9843bad4e114afb2fafa9811ac902e20896c4d1f8831" as const;
export const EIGENPIE_CAPABILITY_IDS = Object.freeze({
  state: "family.eigenpie.state",
  coarse: "family.eigenpie.coarse",
  exact: "family.eigenpie.exact",
} as const);
export const EIGENPIE_ACTION_OWNER_ID = "family.eigenpie.protocol-action" as const;
export const EIGENPIE_MANIFEST = Object.freeze({
  familyId: EIGENPIE_FAMILY_ID,
  version: EIGENPIE_FAMILY_VERSION,
  domain: "protocol" as const,
  sourcePlans: Object.freeze([
    { id: EIGENPIE_SOURCE_PLAN_ID, windowBlocks: EIGENPIE_SOURCE_WINDOW_BLOCKS, evidenceChannel: "nominate" as const },
    { id: EIGENPIE_HISTORY_SOURCE_PLAN_ID, historyStartBlock: "0", evidenceChannel: "complete-denominator" as const },
  ]),
  core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const),
  extensions: Object.freeze(["state", "coarse", "exact"] as const),
  actionOwners: Object.freeze([EIGENPIE_ACTION_OWNER_ID]),
});
export const EIGENPIE_FAMILY_DEFINITION_HASH: Hash = hashDomain("aloha/eigenpie/family-definition/v1", EIGENPIE_MANIFEST);
export const EIGENPIE_OWNER_REF: Hash = hashDomain("aloha/eigenpie/owner/v1", { familyId: EIGENPIE_FAMILY_ID, version: EIGENPIE_FAMILY_VERSION });
