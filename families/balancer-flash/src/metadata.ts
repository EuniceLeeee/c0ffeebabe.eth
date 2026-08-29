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
import { defineFundingFamilyContract } from "../../../packages/funding/src/index.ts";
import {
  BALANCER_FLASH_ACTION_OWNER_ID,
  BALANCER_FLASH_FAMILY_ID,
  BALANCER_FLASH_FAMILY_VERSION,
  BALANCER_FLASH_OWNER_REF,
  BALANCER_FLASH_SOURCE_PLAN_ID,
  BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID,
  BALANCER_FLASH_CAPABILITY_IDS,
  BALANCER_FLASH_INSTANCE_CONTRACT,
  BALANCER_FLASH_INSTANCE_CONTRACT_SCHEMA_HASH,
} from "./manifest.ts";

const moduleRoot = "families/balancer-flash/src";
const version = asCapabilityVersion(BALANCER_FLASH_FAMILY_VERSION);
export const BALANCER_FLASH_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/balancer-flash/source-plan-schema/v1",
  BALANCER_FLASH_SOURCE_PLAN_ID,
));
export const BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH = asSchemaRef(hashDomain(
  "aloha/balancer-flash/singleton-source-plan-schema/v1",
  BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID,
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
    capabilityIds: Object.freeze([asCapabilityId(`family.balancer-flash.${stage}`)]),
    schemaRefs: Object.freeze([asSchemaRef(hashDomain("aloha/balancer-flash/stage-schema/v1", stage))]),
    ...(stage === "nomination" ? { sourcePlanIds: Object.freeze([BALANCER_FLASH_SOURCE_PLAN_ID, BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID]) } : {}),
  });
}
function slot(name: "state" | "coarse" | "exact"): CapabilityAuthoringDeclarationV1 {
  const dependencyIds = name === "state"
    ? []
    : [asCapabilityId(BALANCER_FLASH_CAPABILITY_IDS.state)];
  return Object.freeze({
    capabilityId: asCapabilityId(BALANCER_FLASH_CAPABILITY_IDS[name]),
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/balancer-flash/extension-schema/v1", name)),
    interpreterHash: hashDomain("aloha/balancer-flash/extension-interpreter/v1", name),
    dependencyIds: Object.freeze(dependencyIds),
    artifactKinds: Object.freeze([name]),
    modulePath: `${moduleRoot}/runtime.ts`,
    exportName: "BALANCER_FLASH_RUNTIME",
  });
}
const nomination = core("nomination", "BALANCER_FLASH_NOMINATION_DEFINITION");
const identity = core("identity", "BALANCER_FLASH_IDENTITY_DEFINITION");
const materialization = core("materialization", "BALANCER_FLASH_MATERIALIZATION_DEFINITION");
const projection = core("projection", "BALANCER_FLASH_PROJECTION_DEFINITION");
const rehydration = core("rehydration", "BALANCER_FLASH_REHYDRATION_DEFINITION");
const state = slot("state");
const coarse = slot("coarse");
const exact = slot("exact");

export const BALANCER_FLASH_FUNDING_CONTRACT = defineFundingFamilyContract({
  familyId: BALANCER_FLASH_FAMILY_ID,
  version: BALANCER_FLASH_FAMILY_VERSION,
  actionOwnerId: BALANCER_FLASH_ACTION_OWNER_ID,
});

export const BALANCER_FLASH_ACTION_OWNER = Object.freeze({
  ownerId: BALANCER_FLASH_ACTION_OWNER_ID,
  version,
  schemaHash: asSchemaRef(hashDomain("aloha/balancer-flash/action-schema/v1", "flash-loan")),
  implementationHash: hashDomain("aloha/balancer-flash/action-implementation/v1", "flash-loan"),
  actionKinds: Object.freeze(["flash-loan"]),
  modulePath: `${moduleRoot}/action.ts`,
  exportName: "BALANCER_FLASH_ACTION_PORT",
});

const facts: readonly FamilyFactContractRefV1[] = Object.freeze([
  Object.freeze({
    factContractId: "family.balancer-flash.identity-reads",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/balancer-flash/fact-schema/v1", "identity")),
  }),
  Object.freeze({
    factContractId: "family.balancer-flash.state-observation",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/balancer-flash/fact-schema/v1", "state")),
  }),
  Object.freeze({
    factContractId: "family.balancer-flash.pattern-evidence",
    version,
    schemaHash: asSchemaRef(hashDomain("aloha/balancer-flash/fact-schema/v1", "pattern")),
  }),
  Object.freeze({
    factContractId: "family.balancer-flash.funding-obligation",
    version,
    schemaHash: asSchemaRef(BALANCER_FLASH_FUNDING_CONTRACT.schemaHash),
  }),
  Object.freeze({
    factContractId: "family.balancer-flash.optional-instance-partition",
    version,
    schemaHash: asSchemaRef(BALANCER_FLASH_INSTANCE_CONTRACT_SCHEMA_HASH),
  }),
]);

const runtimeAdapter = Object.freeze({
  modulePath: `${moduleRoot}/search-adapter.ts`,
  exportName: "BALANCER_FLASH_SEARCH_RUNTIME_ADAPTER_FACTORY",
  capabilityIds: Object.freeze({
    state: asCapabilityId(BALANCER_FLASH_CAPABILITY_IDS.state),
    coarse: asCapabilityId(BALANCER_FLASH_CAPABILITY_IDS.coarse),
    exact: asCapabilityId(BALANCER_FLASH_CAPABILITY_IDS.exact),
  }),
  actionOwnerIds: Object.freeze({ action: BALANCER_FLASH_ACTION_OWNER_ID }),
});

const input: FamilyAuthoringDefinitionV1 = {
  manifest: {
    familyId: BALANCER_FLASH_FAMILY_ID,
    version: BALANCER_FLASH_FAMILY_VERSION,
    pluginCodeHash: hashDomain("aloha/balancer-flash/plugin-code/v1", {
      moduleRoot,
      core: [nomination, identity, materialization, projection, rehydration],
      extensions: [state, coarse, exact],
      runtimeAdapter,
      actionOwner: BALANCER_FLASH_ACTION_OWNER,
      fundingContract: BALANCER_FLASH_FUNDING_CONTRACT,
      instanceContract: BALANCER_FLASH_INSTANCE_CONTRACT,
      facts,
    }),
    authorityDeclarationHash: hashDomain("aloha/balancer-flash/authority/v1", BALANCER_FLASH_OWNER_REF),
    sourcePlans: [{
      sourcePlanId: BALANCER_FLASH_SOURCE_PLAN_ID,
      completeness: "nomination-only",
      historyStartBlock: null,
      schemaHash: BALANCER_FLASH_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: `${moduleRoot}/source-plan.ts`,
      exportName: "BALANCER_FLASH_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "BALANCER_FLASH_SOURCE_NOMINATION_PROGRAM", schemaHash: BALANCER_FLASH_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "BALANCER_FLASH_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "BALANCER_FLASH_NOMINATION_INDEPENDENT_ORACLE" } } },
    }, {
      sourcePlanId: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_ID,
      completeness: "complete-snapshot",
      historyStartBlock: null,
      schemaHash: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH,
      modulePath: `${moduleRoot}/source-plan.ts`,
      exportName: "BALANCER_FLASH_SINGLETON_SOURCE_PLAN_RUNTIME",
      nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "BALANCER_FLASH_SINGLETON_NOMINATION_PROGRAM", schemaHash: BALANCER_FLASH_SINGLETON_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "BALANCER_FLASH_SINGLETON_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "BALANCER_FLASH_SINGLETON_INDEPENDENT_ORACLE" } } },
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
    [BALANCER_FLASH_CAPABILITY_IDS.state]: { kind: "present", module: state },
    [BALANCER_FLASH_CAPABILITY_IDS.coarse]: { kind: "present", module: coarse },
    [BALANCER_FLASH_CAPABILITY_IDS.exact]: { kind: "present", module: exact },
  },
  runtimeAdapters: {
    [FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1]: runtimeAdapter,
  },
  actionOwners: [BALANCER_FLASH_ACTION_OWNER],
  acceptanceDeclarations: facts,
};

export const BALANCER_FLASH_DEFINITION_INPUT = defineFamily(input);
export const BALANCER_FLASH_AUTHORING_HASH: Hash = familyAuthoringDigest(BALANCER_FLASH_DEFINITION_INPUT);
