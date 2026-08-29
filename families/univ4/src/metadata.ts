import {
  defineFamily,
  familyAuthoringDigest,
  type AuthoringModuleRefV1,
  type FamilyAuthoringDefinitionV1,
} from "../../../packages/family-sdk/authoring/index.ts";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
  type CapabilityAuthoringDeclarationV1,
  type FamilyFactContractRefV1,
} from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import {
  UNIV4_ACTION_OWNER_ID,
  UNIV4_FAMILY_ID,
  UNIV4_FAMILY_VERSION,
  UNIV4_OWNER_REF,
  UNIV4_SOURCE_PLAN_ID,
  UNIV4_HISTORY_SOURCE_PLAN_ID,
  UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  UNIV4_CAPABILITY_IDS,
} from "./manifest.ts";

const moduleRoot = "families/univ4/src";
const version = asCapabilityVersion(UNIV4_FAMILY_VERSION);
export const UNIV4_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/univ4/source-plan-schema/v1",
  UNIV4_SOURCE_PLAN_ID,
));

type CoreStage = "nomination" | "identity" | "materialization" | "projection" | "rehydration";
function core<S extends CoreStage>(
  stage: S,
  exportName: string,
): AuthoringModuleRefV1 & { readonly artifactKind: S } & (S extends "nomination" ? { readonly sourcePlanIds: readonly string[] } : {});
function core(
  stage: CoreStage,
  exportName: string,
): AuthoringModuleRefV1 & { readonly artifactKind: CoreStage; readonly sourcePlanIds?: readonly string[] } {
  return Object.freeze({
    modulePath: `${moduleRoot}/runtime/definitions.ts`,
    exportName,
    artifactKind: stage,
    capabilityIds: Object.freeze([asCapabilityId(`family.univ4.${stage}`)]),
    schemaRefs: Object.freeze([asSchemaRef(hashDomain("aloha/univ4/stage-schema/v1", stage))]),
    ...(stage === "nomination" ? { sourcePlanIds: Object.freeze([UNIV4_SOURCE_PLAN_ID, UNIV4_HISTORY_SOURCE_PLAN_ID]) } : {}),
  });
}
function slot(name: "state" | "coarse" | "exact"): CapabilityAuthoringDeclarationV1 {
  const dependencyIds = name === "state"
    ? []
    : [asCapabilityId(UNIV4_CAPABILITY_IDS.state)];
  return Object.freeze({
    capabilityId: asCapabilityId(UNIV4_CAPABILITY_IDS[name]),
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/univ4/extension-schema/v1", name)),
    interpreterHash: hashDomain("aloha/univ4/extension-interpreter/v1", name),
    dependencyIds: Object.freeze(dependencyIds),
    artifactKinds: Object.freeze([name]),
    modulePath: `${moduleRoot}/runtime.ts`,
    exportName: "UNIV4_RUNTIME",
  });
}
const nomination = core("nomination", "UNIV4_NOMINATION_DEFINITION");
const identity = core("identity", "UNIV4_IDENTITY_DEFINITION");
const materialization = core("materialization", "UNIV4_MATERIALIZATION_DEFINITION");
const projection = core("projection", "UNIV4_PROJECTION_DEFINITION");
const rehydration = core("rehydration", "UNIV4_REHYDRATION_DEFINITION");
const state = slot("state");
const coarse = slot("coarse");
const exact = slot("exact");

export const UNIV4_ACTION_OWNER = Object.freeze({
  ownerId: UNIV4_ACTION_OWNER_ID,
  version,
  schemaHash: asSchemaRef(hashDomain("aloha/univ4/action-schema/v1", "swap")),
  implementationHash: hashDomain("aloha/univ4/action-implementation/v1", "swap"),
  actionKinds: Object.freeze(["swap"]),
  modulePath: `${moduleRoot}/action.ts`,
  exportName: "UNIV4_ACTION_PORT",
});

const facts: readonly FamilyFactContractRefV1[] = Object.freeze([
  Object.freeze({
    factContractId: "family.univ4.identity-reads",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/univ4/fact-schema/v1", "identity")),
  }),
  Object.freeze({
    factContractId: "family.univ4.complete-identity-history",
    version,
    schemaHash: asSchemaRef(UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH),
  }),
  Object.freeze({
    factContractId: "family.univ4.state-observation",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/univ4/fact-schema/v1", "state")),
  }),
  Object.freeze({
    factContractId: "family.univ4.pattern-evidence",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/univ4/fact-schema/v1", "pattern")),
  }),
]);

const runtimeAdapter = Object.freeze({
  modulePath: `${moduleRoot}/search-adapter.ts`,
  exportName: "UNIV4_SEARCH_RUNTIME_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({
    state: asCapabilityId(UNIV4_CAPABILITY_IDS.state),
    coarse: asCapabilityId(UNIV4_CAPABILITY_IDS.coarse),
    exact: asCapabilityId(UNIV4_CAPABILITY_IDS.exact),
  }),
  actionOwnerIds: Object.freeze({ action: UNIV4_ACTION_OWNER_ID }),
});

const input: FamilyAuthoringDefinitionV1 = {
  manifest: {
    familyId: UNIV4_FAMILY_ID,
    version: UNIV4_FAMILY_VERSION,
    pluginCodeHash: hashDomain("aloha/univ4/plugin-code/v1", {
      moduleRoot,
      core: [nomination, identity, materialization, projection, rehydration],
      extensions: [state, coarse, exact],
      runtimeAdapter,
      actionOwner: UNIV4_ACTION_OWNER,
      facts,
    }),
    authorityDeclarationHash: hashDomain("aloha/univ4/authority/v1", UNIV4_OWNER_REF),
    sourcePlans: [{
      sourcePlanId: UNIV4_SOURCE_PLAN_ID,
      completeness: "nomination-only",
      historyStartBlock: null,
      schemaHash: UNIV4_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: `${moduleRoot}/source-plan.ts`,
      exportName: "UNIV4_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "UNIV4_SOURCE_NOMINATION_PROGRAM", schemaHash: UNIV4_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV4_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV4_NOMINATION_INDEPENDENT_ORACLE" } } },
    }, {
      sourcePlanId: UNIV4_HISTORY_SOURCE_PLAN_ID,
      completeness: "contiguous-history",
      historyStartBlock: "0",
      schemaHash: asSchemaRef(UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH),
      modulePath: `${moduleRoot}/history-source-plan.ts`,
      exportName: "UNIV4_HISTORY_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/history-source-plan.ts`, exportName: "UNIV4_HISTORY_NOMINATION_PROGRAM", schemaHash: asSchemaRef(UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH), mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV4_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV4_NOMINATION_INDEPENDENT_ORACLE" } } },
    }],
  },
  core: {
    nomination: nomination as never,
    identity: identity as never,
    materialization: materialization as never,
    projection: projection as never,
    rehydration: rehydration as never,
  },
  extensions: {
    [UNIV4_CAPABILITY_IDS.state]: { kind: "present", module: state },
    [UNIV4_CAPABILITY_IDS.coarse]: { kind: "present", module: coarse },
    [UNIV4_CAPABILITY_IDS.exact]: { kind: "present", module: exact },
  },
  runtimeAdapters: {
    [FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1]: runtimeAdapter,
  },
  actionOwners: [UNIV4_ACTION_OWNER],
  acceptanceDeclarations: facts,
};

export const UNIV4_DEFINITION_INPUT = defineFamily(input);
export const UNIV4_AUTHORING_HASH: Hash = familyAuthoringDigest(UNIV4_DEFINITION_INPUT);
