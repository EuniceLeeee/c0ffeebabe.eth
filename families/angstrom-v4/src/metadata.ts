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
import { FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/runtime/index.ts";
import {
  ANGSTROM_V4_ACTION_OWNER_ID,
  ANGSTROM_V4_FAMILY_ID,
  ANGSTROM_V4_FAMILY_VERSION,
  ANGSTROM_V4_OWNER_REF,
  ANGSTROM_V4_SOURCE_PLAN_ID,
  ANGSTROM_V4_HISTORY_SOURCE_PLAN_ID,
  ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  ANGSTROM_V4_CAPABILITY_IDS,
} from "./manifest.ts";

const moduleRoot = "families/angstrom-v4/src";
const version = asCapabilityVersion(ANGSTROM_V4_FAMILY_VERSION);
export const ANGSTROM_V4_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/angstrom-v4/source-plan-schema/v1",
  ANGSTROM_V4_SOURCE_PLAN_ID,
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
    modulePath: `${moduleRoot}/runtime.ts`,
    exportName,
    artifactKind: stage,
    capabilityIds: Object.freeze([asCapabilityId(`family.angstrom-v4.${stage}`)]),
    schemaRefs: Object.freeze([asSchemaRef(hashDomain("aloha/angstrom-v4/stage-schema/v1", stage))]),
    ...(stage === "nomination" ? { sourcePlanIds: Object.freeze([ANGSTROM_V4_SOURCE_PLAN_ID, ANGSTROM_V4_HISTORY_SOURCE_PLAN_ID]) } : {}),
  });
}
function slot(name: "state" | "coarse" | "exact"): CapabilityAuthoringDeclarationV1 {
  const dependencyIds = name === "state"
    ? []
    : [asCapabilityId(ANGSTROM_V4_CAPABILITY_IDS.state)];
  return Object.freeze({
    capabilityId: asCapabilityId(ANGSTROM_V4_CAPABILITY_IDS[name]),
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/angstrom-v4/extension-schema/v1", name)),
    interpreterHash: hashDomain("aloha/angstrom-v4/extension-interpreter/v1", name),
    dependencyIds: Object.freeze(dependencyIds),
    artifactKinds: Object.freeze([name]),
    modulePath: `${moduleRoot}/runtime.ts`,
    exportName: "ANGSTROM_V4_RUNTIME",
  });
}
const nomination = core("nomination", "ANGSTROM_V4_NOMINATION_RUNTIME");
const identity = core("identity", "ANGSTROM_V4_IDENTITY_RUNTIME");
const materialization = core("materialization", "ANGSTROM_V4_MATERIALIZATION_RUNTIME");
const projection = core("projection", "ANGSTROM_V4_PROJECTION_RUNTIME");
const rehydration = core("rehydration", "ANGSTROM_V4_REHYDRATION_RUNTIME");
const state = slot("state");
const coarse = slot("coarse");
const exact = slot("exact");

export const ANGSTROM_V4_ACTION_OWNER = Object.freeze({
  ownerId: ANGSTROM_V4_ACTION_OWNER_ID,
  version,
  schemaHash: asSchemaRef(hashDomain("aloha/angstrom-v4/action-schema/v1", "swap")),
  implementationHash: hashDomain("aloha/angstrom-v4/action-implementation/v1", "swap"),
  actionKinds: Object.freeze(["swap"]),
  modulePath: `${moduleRoot}/action.ts`,
  exportName: "ANGSTROM_V4_ACTION_PORT",
});

const facts: readonly FamilyFactContractRefV1[] = Object.freeze([
  Object.freeze({
    factContractId: "family.angstrom-v4.identity-reads",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/angstrom-v4/fact-schema/v1", "identity")),
  }),
  Object.freeze({
    factContractId: "family.angstrom-v4.complete-identity-history",
    version,
    schemaHash: asSchemaRef(ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH),
  }),
  Object.freeze({
    factContractId: "family.angstrom-v4.state-observation",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/angstrom-v4/fact-schema/v1", "state")),
  }),
  Object.freeze({
    factContractId: "family.angstrom-v4.pattern-evidence",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/angstrom-v4/fact-schema/v1", "pattern")),
  }),
]);

const runtimeAdapter = Object.freeze({
  modulePath: `${moduleRoot}/search-adapter.ts`,
  exportName: "ANGSTROM_V4_SEARCH_RUNTIME_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({
    state: asCapabilityId(ANGSTROM_V4_CAPABILITY_IDS.state),
    coarse: asCapabilityId(ANGSTROM_V4_CAPABILITY_IDS.coarse),
    exact: asCapabilityId(ANGSTROM_V4_CAPABILITY_IDS.exact),
  }),
  actionOwnerIds: Object.freeze({ action: ANGSTROM_V4_ACTION_OWNER_ID }),
});
const physicalAdapter = Object.freeze({
  modulePath: `${moduleRoot}/runtime/physical-adapter.ts`,
  exportName: "ANGSTROM_V4_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({}),
  actionOwnerIds: Object.freeze({}),
});

const input: FamilyAuthoringDefinitionV1 = {
  manifest: {
    familyId: ANGSTROM_V4_FAMILY_ID,
    version: ANGSTROM_V4_FAMILY_VERSION,
    pluginCodeHash: hashDomain("aloha/angstrom-v4/plugin-code/v1", {
      moduleRoot,
      core: [nomination, identity, materialization, projection, rehydration],
      extensions: [state, coarse, exact],
      runtimeAdapter,
      physicalAdapter,
      actionOwner: ANGSTROM_V4_ACTION_OWNER,
      facts,
    }),
    authorityDeclarationHash: hashDomain("aloha/angstrom-v4/authority/v1", ANGSTROM_V4_OWNER_REF),
    sourcePlans: [{
      sourcePlanId: ANGSTROM_V4_SOURCE_PLAN_ID,
      completeness: "nomination-only",
      historyStartBlock: null,
      schemaHash: ANGSTROM_V4_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: `${moduleRoot}/source-plan.ts`,
      exportName: "ANGSTROM_V4_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "ANGSTROM_V4_SOURCE_NOMINATION_PROGRAM", schemaHash: ANGSTROM_V4_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ANGSTROM_V4_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ANGSTROM_V4_NOMINATION_INDEPENDENT_ORACLE" } } },
    }, {
      sourcePlanId: ANGSTROM_V4_HISTORY_SOURCE_PLAN_ID,
      completeness: "contiguous-history",
      historyStartBlock: "0",
      schemaHash: asSchemaRef(ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH),
      modulePath: `${moduleRoot}/history-source-plan.ts`,
      exportName: "ANGSTROM_V4_HISTORY_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/history-source-plan.ts`, exportName: "ANGSTROM_V4_HISTORY_NOMINATION_PROGRAM", schemaHash: asSchemaRef(ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH), mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ANGSTROM_V4_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ANGSTROM_V4_NOMINATION_INDEPENDENT_ORACLE" } } },
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
    [ANGSTROM_V4_CAPABILITY_IDS.state]: { kind: "present", module: state },
    [ANGSTROM_V4_CAPABILITY_IDS.coarse]: { kind: "present", module: coarse },
    [ANGSTROM_V4_CAPABILITY_IDS.exact]: { kind: "present", module: exact },
  },
  runtimeAdapters: {
    [FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1]: runtimeAdapter,
    [FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1]: physicalAdapter,
  },
  actionOwners: [ANGSTROM_V4_ACTION_OWNER],
  acceptanceDeclarations: facts,
};

export const ANGSTROM_V4_DEFINITION_INPUT = defineFamily(input);
export const ANGSTROM_V4_AUTHORING_HASH: Hash = familyAuthoringDigest(ANGSTROM_V4_DEFINITION_INPUT);
