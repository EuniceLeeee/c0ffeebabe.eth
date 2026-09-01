import { defineFamily, familyAuthoringDigest, type AuthoringModuleRefV1, type FamilyAuthoringDefinitionV1 } from "../../../packages/family-sdk/authoring/index.ts";
import { asCapabilityId, asCapabilityVersion, asOwnerRef, asSchemaRef, type CapabilityAuthoringDeclarationV1, type FamilyFactContractRefV1 } from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/runtime/index.ts";
import { UNIV3_ACTION_OWNER_ID, UNIV3_CAPABILITY_IDS, UNIV3_STANDARD_FAMILY_ID, UNIV3_STANDARD_FAMILY_VERSION, UNIV3_STANDARD_HISTORY_SOURCE_PLAN_ID, UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH, UNIV3_STANDARD_OWNER_REF, UNIV3_STANDARD_SOURCE_PLAN_ID, UNIV3_STANDARD_SOURCE_PLAN_SCHEMA_HASH } from "./manifest.ts";

const version = asCapabilityVersion(UNIV3_STANDARD_FAMILY_VERSION);
const moduleRoot = "families/univ3-standard/src";

type CoreStage = "nomination" | "identity" | "materialization" | "projection" | "rehydration";

function core<S extends CoreStage>(stage: S, exportName: string): AuthoringModuleRefV1 & { readonly artifactKind: S } & (S extends "nomination" ? { readonly sourcePlanIds: readonly string[] } : {});
function core(stage: CoreStage, exportName: string): AuthoringModuleRefV1 & { readonly artifactKind: CoreStage; readonly sourcePlanIds?: readonly string[] } {
  const capabilityId = asCapabilityId(`family.${UNIV3_STANDARD_FAMILY_ID}.${stage}`);
  const schemaHash = asSchemaRef(hashDomain("aloha/univ3-standard/stage-schema/v1", stage));
  return Object.freeze({ modulePath: `${moduleRoot}/runtime.ts`, exportName, artifactKind: stage, capabilityIds: Object.freeze([capabilityId]), schemaRefs: Object.freeze([schemaHash]), ...(stage === "nomination" ? { sourcePlanIds: Object.freeze([UNIV3_STANDARD_SOURCE_PLAN_ID, UNIV3_STANDARD_HISTORY_SOURCE_PLAN_ID].sort()) } : {}) });
}

function extension(name: "state" | "coarse" | "exact", exportName: string): CapabilityAuthoringDeclarationV1 {
  const capabilityId = asCapabilityId(UNIV3_CAPABILITY_IDS[name]);
  return Object.freeze({ capabilityId, version, schemaHash: asSchemaRef(hashDomain("aloha/univ3-standard/extension-schema/v1", name)), interpreterHash: hashDomain("aloha/univ3-standard/extension-interpreter/v1", { name, exportName }), dependencyIds: Object.freeze(name === "state" ? [] : [asCapabilityId(UNIV3_CAPABILITY_IDS.state)]), artifactKinds: Object.freeze([name]), modulePath: `${moduleRoot}/runtime.ts`, exportName });
}

const stageNomination = core("nomination", "UNIV3_NOMINATION_RUNTIME");
const stageIdentity = core("identity", "UNIV3_IDENTITY_RUNTIME");
const stageMaterialization = core("materialization", "UNIV3_MATERIALIZATION_RUNTIME");
const stageProjection = core("projection", "UNIV3_PROJECTION_RUNTIME");
const stageRehydration = core("rehydration", "UNIV3_REHYDRATION_RUNTIME");
const state = extension("state", "UNIV3_STANDARD_RUNTIME");
const coarse = extension("coarse", "UNIV3_STANDARD_RUNTIME");
const exact = extension("exact", "UNIV3_STANDARD_RUNTIME");
const facts: readonly FamilyFactContractRefV1[] = Object.freeze([
  Object.freeze({ factContractId: "family.univ3-standard.identity-reads", version, schemaHash: asSchemaRef(hashDomain("aloha/univ3-standard/fact-schema/v1", "identity")) }),
  Object.freeze({ factContractId: "family.univ3-standard.state-reads", version, schemaHash: asSchemaRef(hashDomain("aloha/univ3-standard/fact-schema/v1", "state")) }),
]);
const actionOwner = Object.freeze({ ownerId: UNIV3_ACTION_OWNER_ID, version, schemaHash: asSchemaRef(hashDomain("aloha/univ3-standard/action-schema/v1", "swap")), implementationHash: hashDomain("aloha/univ3-standard/action-implementation/v1", "swap"), actionKinds: Object.freeze(["swap"]), modulePath: `${moduleRoot}/action.ts`, exportName: "UNIV3_STANDARD_SWAP_ACTION_PORT" });
const physicalLifecycleAdapter = Object.freeze({ modulePath: `${moduleRoot}/runtime/physical-adapter.ts`, exportName: "UNIV3_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY", capabilityIds: Object.freeze({}), actionOwnerIds: Object.freeze({}) });

const definitionInput: FamilyAuthoringDefinitionV1 = {
  manifest: { familyId: UNIV3_STANDARD_FAMILY_ID, version: UNIV3_STANDARD_FAMILY_VERSION, pluginCodeHash: hashDomain("aloha/univ3-standard/plugin-code/v1", { moduleRoot, stages: [stageNomination, stageIdentity, stageMaterialization, stageProjection, stageRehydration], extensions: [state, coarse, exact], actionOwner, physicalLifecycleAdapter, facts }), authorityDeclarationHash: hashDomain("aloha/univ3-standard/authority/v1", { ownerRef: UNIV3_STANDARD_OWNER_REF }), sourcePlans: [{ sourcePlanId: UNIV3_STANDARD_SOURCE_PLAN_ID, completeness: "nomination-only", historyStartBlock: null, schemaHash: UNIV3_STANDARD_SOURCE_PLAN_SCHEMA_HASH, modulePath: `${moduleRoot}/source-plan.ts`, exportName: "UNIV3_STANDARD_SOURCE_PLAN_RUNTIME", nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "UNIV3_STANDARD_SOURCE_NOMINATION_PROGRAM", schemaHash: UNIV3_STANDARD_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV3_STANDARD_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV3_STANDARD_NOMINATION_INDEPENDENT_ORACLE" } } } }, { sourcePlanId: UNIV3_STANDARD_HISTORY_SOURCE_PLAN_ID, completeness: "rolling-observation", historyStartBlock: null, schemaHash: UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH, modulePath: `${moduleRoot}/source-plan.ts`, exportName: "UNIV3_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME", nominationProgram: { kind: "present", program: { modulePath: `${moduleRoot}/source-plan.ts`, exportName: "UNIV3_STANDARD_HISTORY_NOMINATION_PROGRAM", schemaHash: UNIV3_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV3_STANDARD_NOMINATION_MUTATION_CORPUS" }, independentOracle: { modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "UNIV3_STANDARD_NOMINATION_INDEPENDENT_ORACLE" } } } }] },
  core: { nomination: stageNomination, identity: stageIdentity, materialization: stageMaterialization, projection: stageProjection, rehydration: stageRehydration },
  extensions: { [UNIV3_CAPABILITY_IDS.state]: { kind: "present", module: state }, [UNIV3_CAPABILITY_IDS.coarse]: { kind: "present", module: coarse }, [UNIV3_CAPABILITY_IDS.exact]: { kind: "present", module: exact } },
  runtimeAdapters: { "search/v1": { modulePath: `${moduleRoot}/search-adapter.ts`, exportName: "UNIV3_SEARCH_RUNTIME_ADAPTER_FACTORY", capabilityIds: { state: asCapabilityId(UNIV3_CAPABILITY_IDS.state), coarse: asCapabilityId(UNIV3_CAPABILITY_IDS.coarse), exact: asCapabilityId(UNIV3_CAPABILITY_IDS.exact) }, actionOwnerIds: { swap: UNIV3_ACTION_OWNER_ID } }, [FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1]: physicalLifecycleAdapter },
  actionOwners: [actionOwner],
  acceptanceDeclarations: facts,
};

export const UNIV3_STANDARD_DEFINITION = defineFamily(definitionInput);
export const UNIV3_STANDARD_FAMILY_AUTHORING_HASH: Hash = familyAuthoringDigest(UNIV3_STANDARD_DEFINITION);
export const UNIV3_STANDARD_FAMILY_DEFINITION_HASH = UNIV3_STANDARD_FAMILY_AUTHORING_HASH;
export { UNIV3_STANDARD_OWNER_REF };
