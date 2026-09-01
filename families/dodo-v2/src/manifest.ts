import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
export const DODO_V2_FAMILY_ID = "dodo-v2" as const;
export const DODO_V2_FAMILY_VERSION = "1.0.0" as const;
export const DODO_V2_SOURCE_WINDOW_BLOCKS = 50 as const;
export const DODO_V2_SOURCE_PLAN_ID = "dodo-v2.fixed-cutoff-50-block" as const;
export const DODO_V2_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/dodo-v2/source-plan-schema/v1", DODO_V2_SOURCE_PLAN_ID));
export const DODO_V2_HISTORY_SOURCE_PLAN_ID = "dodo-v2.creation-rolling-observation" as const;
export const DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain("aloha/dodo-v2/history-source-plan-schema/v1", DODO_V2_HISTORY_SOURCE_PLAN_ID));
export const DODO_V2_SELL_BASE_SELECTOR = "0xbd6015b4" as const;
export const DODO_V2_SELL_QUOTE_SELECTOR = "0xdd93f59a" as const;
export const DODO_V2_SWAP_TOPIC = "0xc2c0245e056d5fb095f04cd6373bc770802ebd1e6c918eb78fdef843cdb37b0f" as const;
export const DODO_V2_FACTORIES = Object.freeze([
  Object.freeze({ kind: "dvm" as const, address: "0x72d220ce168c4f361dd4dee5d826a01ad8598f6c", creationTopic: "0xaf5c5f12a80fc937520df6fcaed66262a4cc775e0f3fceaf7a7cfe476d9a751d" as Hash }),
  Object.freeze({ kind: "dpp" as const, address: "0x5336ede8f971339f6c0e304c66ba16f1296a2fbe", creationTopic: "0x8494fe594cd5087021d4b11758a2bbc7be28a430e94f2b268d668e5991ed3b8a" as Hash }),
  Object.freeze({ kind: "dsp" as const, address: "0x6fddb76c93299d985f4d3fc7ac468f9a168577a4", creationTopic: "0xbc1083a2c1c5ef31e13fb436953d22b47880cf7db279c2c5666b16083afd6b9d" as Hash }),
]);
export const DODO_V2_CAPABILITY_IDS = Object.freeze({ state: "family.dodo-v2.state", coarse: "family.dodo-v2.coarse", exact: "family.dodo-v2.exact" } as const);
export const DODO_V2_ACTION_OWNER_ID = "family.dodo-v2.swap-action" as const;
export const DODO_V2_QUOTE_ACTOR = "0x1000000000000000000000000000000000000001" as const;
export const DODO_V2_MANIFEST = Object.freeze({ familyId: DODO_V2_FAMILY_ID, version: DODO_V2_FAMILY_VERSION, domain: "swap" as const, sourcePlans: Object.freeze([{ id: DODO_V2_SOURCE_PLAN_ID, windowBlocks: 50, evidenceChannel: "nominate" as const }, { id: DODO_V2_HISTORY_SOURCE_PLAN_ID, historyStartBlock: null, evidenceChannel: "complete-denominator" as const }]), core: Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"]), extensions: Object.freeze(["state", "coarse", "exact"]), actionOwners: Object.freeze([DODO_V2_ACTION_OWNER_ID]) });
export const DODO_V2_OWNER_REF: Hash = hashDomain("aloha/dodo-v2/owner/v1", { familyId: DODO_V2_FAMILY_ID, version: DODO_V2_FAMILY_VERSION });
