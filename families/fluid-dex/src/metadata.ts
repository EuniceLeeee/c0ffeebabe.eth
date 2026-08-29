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
  FLUID_DEX_ACTION_OWNER_ID,
  FLUID_DEX_FACTORY_SOURCE_PLAN_ID,
  FLUID_DEX_FAMILY_ID,
  FLUID_DEX_FAMILY_VERSION,
  FLUID_DEX_OWNER_REF,
  FLUID_DEX_SOURCE_PLAN_ID,
  FLUID_DEX_CAPABILITY_IDS,
} from "./manifest.ts";

const moduleRoot = "families/fluid-dex/src";
const version = asCapabilityVersion(FLUID_DEX_FAMILY_VERSION);
export const FLUID_DEX_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/fluid-dex/source-plan-schema/v1",
  FLUID_DEX_SOURCE_PLAN_ID,
));
export const FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/fluid-dex/source-plan-schema/v1",
  FLUID_DEX_FACTORY_SOURCE_PLAN_ID,
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
    capabilityIds: Object.freeze([asCapabilityId(`family.fluid-dex.${stage}`)]),
    schemaRefs: Object.freeze([asSchemaRef(hashDomain("aloha/fluid-dex/stage-schema/v1", stage))]),
    ...(stage === "nomination" ? { sourcePlanIds: Object.freeze([FLUID_DEX_SOURCE_PLAN_ID, FLUID_DEX_FACTORY_SOURCE_PLAN_ID]) } : {}),
  });
}
function slot(name: "state" | "coarse" | "exact"): CapabilityAuthoringDeclarationV1 {
  const dependencyIds = name === "state"
    ? []
    : [asCapabilityId(FLUID_DEX_CAPABILITY_IDS.state)];
  return Object.freeze({
    capabilityId: asCapabilityId(FLUID_DEX_CAPABILITY_IDS[name]),
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/fluid-dex/extension-schema/v1", name)),
    interpreterHash: hashDomain("aloha/fluid-dex/extension-interpreter/v1", name),
    dependencyIds: Object.freeze(dependencyIds),
    artifactKinds: Object.freeze([name]),
    modulePath: `${moduleRoot}/runtime.ts`,
    exportName: "FLUID_DEX_RUNTIME",
  });
}
const nomination = core("nomination", "FLUID_DEX_NOMINATION_DEFINITION");
const identity = core("identity", "FLUID_DEX_IDENTITY_DEFINITION");
const materialization = core("materialization", "FLUID_DEX_MATERIALIZATION_DEFINITION");
const projection = core("projection", "FLUID_DEX_PROJECTION_DEFINITION");
const rehydration = core("rehydration", "FLUID_DEX_REHYDRATION_DEFINITION");
const state = slot("state");
const coarse = slot("coarse");
const exact = slot("exact");

export const FLUID_DEX_ACTION_OWNER = Object.freeze({
  ownerId: FLUID_DEX_ACTION_OWNER_ID,
  version,
  schemaHash: asSchemaRef(hashDomain("aloha/fluid-dex/action-schema/v1", "swap")),
  implementationHash: hashDomain("aloha/fluid-dex/action-implementation/v1", "swap"),
  actionKinds: Object.freeze(["swap"]),
  modulePath: `${moduleRoot}/action.ts`,
  exportName: "FLUID_DEX_ACTION_PORT",
});

const facts: readonly FamilyFactContractRefV1[] = Object.freeze([
  Object.freeze({
    factContractId: "family.fluid-dex.identity-reads",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/fluid-dex/fact-schema/v1", "identity")),
  }),
  Object.freeze({
    factContractId: "family.fluid-dex.state-observation",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/fluid-dex/fact-schema/v1", "state")),
  }),
  Object.freeze({
    factContractId: "family.fluid-dex.pattern-evidence",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/fluid-dex/fact-schema/v1", "pattern")),
  }),
]);

const runtimeAdapter = Object.freeze({
  modulePath: `${moduleRoot}/search-adapter.ts`,
  exportName: "FLUID_DEX_SEARCH_RUNTIME_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({
    state: asCapabilityId(FLUID_DEX_CAPABILITY_IDS.state),
    coarse: asCapabilityId(FLUID_DEX_CAPABILITY_IDS.coarse),
    exact: asCapabilityId(FLUID_DEX_CAPABILITY_IDS.exact),
  }),
  actionOwnerIds: Object.freeze({ action: FLUID_DEX_ACTION_OWNER_ID }),
});
const physicalAdapter = Object.freeze({
  modulePath: `${moduleRoot}/runtime/physical-adapter.ts`,
  exportName: "FLUID_DEX_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({}),
  actionOwnerIds: Object.freeze({}),
});

const input: FamilyAuthoringDefinitionV1 = {
  manifest: {
    familyId: FLUID_DEX_FAMILY_ID,
    version: FLUID_DEX_FAMILY_VERSION,
    pluginCodeHash: hashDomain("aloha/fluid-dex/plugin-code/v1", {
      moduleRoot,
      core: [nomination, identity, materialization, projection, rehydration],
      extensions: [state, coarse, exact],
      runtimeAdapter,
      physicalAdapter,
      actionOwner: FLUID_DEX_ACTION_OWNER,
      facts,
    }),
    authorityDeclarationHash: hashDomain("aloha/fluid-dex/authority/v1", FLUID_DEX_OWNER_REF),
    sourcePlans: [{
      sourcePlanId: FLUID_DEX_SOURCE_PLAN_ID,
      completeness: "nomination-only",
      historyStartBlock: null,
      schemaHash: FLUID_DEX_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: `${moduleRoot}/source-plan.ts`,
      exportName: "FLUID_DEX_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "FLUID_DEX_SOURCE_NOMINATION_PROGRAM", schemaHash: FLUID_DEX_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "FLUID_DEX_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "FLUID_DEX_NOMINATION_INDEPENDENT_ORACLE" } } },
    }, {
      sourcePlanId: FLUID_DEX_FACTORY_SOURCE_PLAN_ID,
      completeness: "complete-snapshot",
      historyStartBlock: null,
      schemaHash: FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: `${moduleRoot}/source-plan.ts`,
      exportName: "FLUID_DEX_FACTORY_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "FLUID_DEX_FACTORY_NOMINATION_PROGRAM", schemaHash: FLUID_DEX_FACTORY_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "FLUID_DEX_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "FLUID_DEX_NOMINATION_INDEPENDENT_ORACLE" } } },
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
    [FLUID_DEX_CAPABILITY_IDS.state]: { kind: "present", module: state },
    [FLUID_DEX_CAPABILITY_IDS.coarse]: { kind: "present", module: coarse },
    [FLUID_DEX_CAPABILITY_IDS.exact]: { kind: "present", module: exact },
  },
  runtimeAdapters: {
    [FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1]: runtimeAdapter,
    [FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1]: physicalAdapter,
  },
  actionOwners: [FLUID_DEX_ACTION_OWNER],
  acceptanceDeclarations: facts,
};

export const FLUID_DEX_DEFINITION_INPUT = defineFamily(input);
export const FLUID_DEX_AUTHORING_HASH: Hash = familyAuthoringDigest(FLUID_DEX_DEFINITION_INPUT);
