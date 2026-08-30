import {
  defineFamily,
  familyAuthoringDigest,
  type AuthoringModuleRefV1,
  type FamilyAuthoringDefinitionV1,
} from "../../../packages/family-sdk/authoring/index.ts";
import {
  asCapabilityId,
  asCapabilityVersion,
  asSchemaRef,
  type CapabilityAuthoringDeclarationV1,
  type FamilyFactContractRefV1,
} from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/runtime/index.ts";
import { DODO_V2_ACTION_IMPLEMENTATION_HASH, DODO_V2_ACTION_SCHEMA_REF } from "./action.ts";
import {
  DODO_V2_ACTION_OWNER_ID,
  DODO_V2_CAPABILITY_IDS,
  DODO_V2_FAMILY_ID,
  DODO_V2_FAMILY_VERSION,
  DODO_V2_HISTORY_SOURCE_PLAN_ID,
  DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  DODO_V2_OWNER_REF,
  DODO_V2_SOURCE_PLAN_ID,
  DODO_V2_SOURCE_PLAN_SCHEMA_HASH,
} from "./manifest.ts";

const version = asCapabilityVersion(DODO_V2_FAMILY_VERSION);
const moduleRoot = "families/dodo-v2/src";
type CoreStage = "nomination" | "identity" | "materialization" | "projection" | "rehydration";

function core<S extends CoreStage>(stage: S, exportName: string): AuthoringModuleRefV1 & { readonly artifactKind: S } & (S extends "nomination" ? { readonly sourcePlanIds: readonly string[] } : {});
function core(stage: CoreStage, exportName: string): AuthoringModuleRefV1 & { readonly artifactKind: CoreStage; readonly sourcePlanIds?: readonly string[] } {
  const capabilityId = asCapabilityId(`family.${DODO_V2_FAMILY_ID}.${stage}`);
  const schemaHash = asSchemaRef(hashDomain("aloha/dodo-v2/stage-schema/v1", stage));
  return Object.freeze({
    modulePath: `${moduleRoot}/runtime.ts`,
    exportName,
    artifactKind: stage,
    capabilityIds: Object.freeze([capabilityId]),
    schemaRefs: Object.freeze([schemaHash]),
    ...(stage === "nomination" ? { sourcePlanIds: Object.freeze([DODO_V2_SOURCE_PLAN_ID, DODO_V2_HISTORY_SOURCE_PLAN_ID]) } : {}),
  });
}

function ext(name: "state" | "coarse" | "exact"): CapabilityAuthoringDeclarationV1 {
  const capabilityId = asCapabilityId(DODO_V2_CAPABILITY_IDS[name]);
  return Object.freeze({
    capabilityId,
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/dodo-v2/extension-schema/v1", name)),
    interpreterHash: hashDomain("aloha/dodo-v2/extension-interpreter/v1", name),
    dependencyIds: Object.freeze(name === "state" ? [] : [asCapabilityId(DODO_V2_CAPABILITY_IDS.state)]),
    artifactKinds: Object.freeze([name]),
    modulePath: `${moduleRoot}/runtime.ts`,
    exportName: "DODO_V2_RUNTIME",
  });
}

const n = core("nomination", "DODO_NOMINATION_RUNTIME");
const i = core("identity", "DODO_IDENTITY_RUNTIME");
const m = core("materialization", "DODO_MATERIALIZATION_RUNTIME");
const p = core("projection", "DODO_PROJECTION_RUNTIME");
const r = core("rehydration", "DODO_REHYDRATION_RUNTIME");
const state = ext("state");
const coarse = ext("coarse");
const exact = ext("exact");
const facts: readonly FamilyFactContractRefV1[] = Object.freeze([
  Object.freeze({ factContractId: "family.dodo-v2.identity-reads", version, schemaHash: asSchemaRef(hashDomain("aloha/dodo-v2/fact-schema/v1", "identity")) }),
  Object.freeze({ factContractId: "family.dodo-v2.state-reads", version, schemaHash: asSchemaRef(hashDomain("aloha/dodo-v2/fact-schema/v1", "state")) }),
]);
const qualificationRefs = Object.freeze({
  mutationCorpus: Object.freeze({ modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "DODO_V2_NOMINATION_MUTATION_CORPUS" }),
  independentOracle: Object.freeze({ modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "DODO_V2_NOMINATION_INDEPENDENT_ORACLE" }),
});
const sourcePlan = Object.freeze({
  sourcePlanId: DODO_V2_SOURCE_PLAN_ID,
  completeness: "nomination-only" as const,
  historyStartBlock: null,
  schemaHash: DODO_V2_SOURCE_PLAN_SCHEMA_HASH,
  modulePath: `${moduleRoot}/source-plan.ts`,
  exportName: "DODO_V2_SOURCE_PLAN_RUNTIME",
  nominationProgram: Object.freeze({ kind: "present" as const, program: Object.freeze({ modulePath: `${moduleRoot}/source-plan.ts`, exportName: "DODO_V2_SOURCE_NOMINATION_PROGRAM", schemaHash: DODO_V2_SOURCE_PLAN_SCHEMA_HASH, ...qualificationRefs }) }),
});
const historySourcePlan = Object.freeze({
  sourcePlanId: DODO_V2_HISTORY_SOURCE_PLAN_ID,
  completeness: "contiguous-history" as const,
  historyStartBlock: "0",
  schemaHash: DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  modulePath: `${moduleRoot}/history-source-plan.ts`,
  exportName: "DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME",
  nominationProgram: Object.freeze({ kind: "present" as const, program: Object.freeze({ modulePath: `${moduleRoot}/history-source-plan.ts`, exportName: "DODO_V2_HISTORY_NOMINATION_PROGRAM", schemaHash: DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH, ...qualificationRefs }) }),
});
const actionOwner = Object.freeze({
  ownerId: DODO_V2_ACTION_OWNER_ID,
  version,
  schemaHash: asSchemaRef(DODO_V2_ACTION_SCHEMA_REF),
  implementationHash: DODO_V2_ACTION_IMPLEMENTATION_HASH,
  actionKinds: Object.freeze(["swap"]),
  modulePath: `${moduleRoot}/action.ts`,
  exportName: "DODO_V2_SWAP_ACTION_PORT",
});
const physicalAdapter = Object.freeze({
  modulePath: `${moduleRoot}/runtime/physical-adapter.ts`,
  exportName: "DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({}),
  actionOwnerIds: Object.freeze({}),
});
const input: FamilyAuthoringDefinitionV1 = {
  manifest: {
    familyId: DODO_V2_FAMILY_ID,
    version: DODO_V2_FAMILY_VERSION,
    pluginCodeHash: hashDomain("aloha/dodo-v2/plugin-code/v1", { n, i, m, p, r, state, coarse, exact, actionOwner, facts, sourcePlans: [sourcePlan, historySourcePlan], physicalAdapter }),
    authorityDeclarationHash: hashDomain("aloha/dodo-v2/authority/v1", DODO_V2_OWNER_REF),
    sourcePlans: [sourcePlan, historySourcePlan],
  },
  core: { nomination: n, identity: i, materialization: m, projection: p, rehydration: r },
  extensions: {
    [DODO_V2_CAPABILITY_IDS.state]: { kind: "present", module: state },
    [DODO_V2_CAPABILITY_IDS.coarse]: { kind: "present", module: coarse },
    [DODO_V2_CAPABILITY_IDS.exact]: { kind: "present", module: exact },
  },
  runtimeAdapters: {
    "search/v1": {
      modulePath: `${moduleRoot}/search-adapter.ts`,
      exportName: "DODO_SEARCH_RUNTIME_ADAPTER_FACTORY",
      capabilityIds: { state: asCapabilityId(DODO_V2_CAPABILITY_IDS.state), coarse: asCapabilityId(DODO_V2_CAPABILITY_IDS.coarse), exact: asCapabilityId(DODO_V2_CAPABILITY_IDS.exact) },
      actionOwnerIds: { swap: DODO_V2_ACTION_OWNER_ID },
    },
    [FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1]: physicalAdapter,
  },
  actionOwners: [actionOwner],
  acceptanceDeclarations: facts,
};

export const DODO_V2_DEFINITION = defineFamily(input);
export const DODO_V2_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(DODO_V2_DEFINITION);
