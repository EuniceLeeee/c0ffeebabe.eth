import { defineFamily, familyAuthoringDigest, type FamilyAuthoringDefinitionV1 } from "../../../packages/family-sdk/authoring/index.ts";
import { asCapabilityId, asCapabilityVersion, asSchemaRef } from "../../../packages/capability-contracts/src/index.ts";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { ASTRA_ACTION_OWNER_ID, ASTRA_FAMILY_ID, ASTRA_FAMILY_VERSION, ASTRA_HISTORY_SOURCE_PLAN_ID, ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH, ASTRA_OWNER_REF, ASTRA_SOURCE_PLAN_ID, ASTRA_STAGE_IDS } from "./manifest.ts";
import { ASTRA_ACTION_OWNER } from "./action.ts";
import { ASTRA_RUNTIME_ADAPTER } from "./runtime/adapter.ts";
import { ASTRA_SOURCE_PLAN_SCHEMA_HASH } from "./source-plan.ts";

const version = asCapabilityVersion(ASTRA_FAMILY_VERSION);
const moduleRoot = "families/astra-multitoken/src";
const extension = (stage: "state" | "coarse" | "exact") => Object.freeze({ capabilityId: asCapabilityId(ASTRA_STAGE_IDS[stage]), version, schemaHash: asSchemaRef(hashDomain("aloha/astra-multitoken/stage-schema/v1", stage)), interpreterHash: hashDomain("aloha/astra-multitoken/stage-interpreter/v1", stage), dependencyIds: Object.freeze([]), artifactKinds: Object.freeze([stage]), modulePath: `${moduleRoot}/runtime.ts`, exportName: `ASTRA_${stage.toUpperCase()}_DEFINITION` });
const core = (stage: "nomination" | "identity" | "materialization" | "projection" | "rehydration") => Object.freeze({ modulePath: `${moduleRoot}/runtime/definitions.ts`, exportName: `ASTRA_${stage.toUpperCase()}_DEFINITION`, artifactKind: stage, capabilityIds: Object.freeze([asCapabilityId(ASTRA_STAGE_IDS[stage])]), schemaRefs: Object.freeze([asSchemaRef(hashDomain("aloha/astra-multitoken/stage-schema/v1", stage))]), ...(stage === "nomination" ? { sourcePlanIds: Object.freeze([ASTRA_SOURCE_PLAN_ID, ASTRA_HISTORY_SOURCE_PLAN_ID]) } : {}) });
const sourcePlan = Object.freeze({
  sourcePlanId: ASTRA_SOURCE_PLAN_ID,
  completeness: "nomination-only" as const,
  historyStartBlock: null,
  schemaHash: ASTRA_SOURCE_PLAN_SCHEMA_HASH,
  modulePath: `${moduleRoot}/source-plan-runtime.ts`,
  exportName: "ASTRA_SOURCE_PLAN_RUNTIME",
  nominationProgram: Object.freeze({ kind: "present" as const, program: Object.freeze({ modulePath: `${moduleRoot}/source-plan-runtime.ts`, exportName: "ASTRA_SOURCE_NOMINATION_PROGRAM", schemaHash: ASTRA_SOURCE_PLAN_SCHEMA_HASH, mutationCorpus: Object.freeze({ modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ASTRA_NOMINATION_MUTATION_CORPUS" }), independentOracle: Object.freeze({ modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ASTRA_NOMINATION_INDEPENDENT_ORACLE" }) }) }),
});
const historySourcePlan = Object.freeze({
  sourcePlanId: ASTRA_HISTORY_SOURCE_PLAN_ID,
  completeness: "rolling-observation" as const,
  historyStartBlock: null,
  schemaHash: asSchemaRef(ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH),
  modulePath: `${moduleRoot}/history-source-plan.ts`,
  exportName: "ASTRA_HISTORY_SOURCE_PLAN_RUNTIME",
  nominationProgram: Object.freeze({ kind: "present" as const, program: Object.freeze({ modulePath: `${moduleRoot}/history-source-plan.ts`, exportName: "ASTRA_HISTORY_NOMINATION_PROGRAM", schemaHash: asSchemaRef(ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH), mutationCorpus: Object.freeze({ modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ASTRA_NOMINATION_MUTATION_CORPUS" }), independentOracle: Object.freeze({ modulePath: `${moduleRoot}/nomination-qualification.ts`, exportName: "ASTRA_NOMINATION_INDEPENDENT_ORACLE" }) }) }),
});
const actionOwner = Object.freeze({ ownerId: ASTRA_ACTION_OWNER_ID, version, schemaHash: asSchemaRef(hashDomain("aloha/astra-multitoken/action-schema/v1", ASTRA_ACTION_OWNER_ID)), implementationHash: ASTRA_ACTION_OWNER.implementationHash, actionKinds: Object.freeze([ASTRA_ACTION_OWNER.actionKind]), modulePath: `${moduleRoot}/action.ts`, exportName: "ASTRA_ACTION_OWNER" });
const factContracts = Object.freeze(ASTRA_RUNTIME_ADAPTER.factContracts.map(fact => Object.freeze({ factContractId: fact.factContractId, version, schemaHash: asSchemaRef(fact.schemaHash) })));
// The authoring digest is over the canonical declaration, never over a live
// function value.  The executable effect builder is bound by the runtime
// adapter/module declarations below; including it here would make the digest
// impossible to encode and would turn a code identity into an untyped DTO.
const currentSourceExactDeclaration = Object.freeze({
  kind: ASTRA_RUNTIME_ADAPTER.currentSourceExact.kind,
  sourcePlanIds: Object.freeze([sourcePlan.sourcePlanId, historySourcePlan.sourcePlanId]),
  obligations: ASTRA_RUNTIME_ADAPTER.currentSourceExact.obligations,
  modulePath: `${moduleRoot}/execution.ts`,
  exportName: "buildAstraEffectSimulation",
});
const definitionInput: FamilyAuthoringDefinitionV1 = {
  manifest: { familyId: ASTRA_FAMILY_ID, version: ASTRA_FAMILY_VERSION, pluginCodeHash: hashDomain("aloha/astra-multitoken/plugin-code/v1", { moduleRoot, stages: ASTRA_RUNTIME_ADAPTER.stages, sourcePlans: [sourcePlan, historySourcePlan], exact: currentSourceExactDeclaration, actionOwner, factContracts }), authorityDeclarationHash: hashDomain("aloha/astra-multitoken/authority/v1", { ownerRef: ASTRA_OWNER_REF }), sourcePlans: [sourcePlan, historySourcePlan] },
  core: { nomination: core("nomination") as never, identity: core("identity") as never, materialization: core("materialization") as never, projection: core("projection") as never, rehydration: core("rehydration") as never },
  extensions: { [ASTRA_STAGE_IDS.state]: { kind: "present", module: extension("state") }, [ASTRA_STAGE_IDS.coarse]: { kind: "present", module: extension("coarse") }, [ASTRA_STAGE_IDS.exact]: { kind: "present", module: extension("exact") } },
  runtimeAdapters: { "search/v1": { modulePath: `${moduleRoot}/search-adapter.ts`, exportName: "ASTRA_SEARCH_RUNTIME_ADAPTER_FACTORY", capabilityIds: { state: asCapabilityId(ASTRA_STAGE_IDS.state), coarse: asCapabilityId(ASTRA_STAGE_IDS.coarse), exact: asCapabilityId(ASTRA_STAGE_IDS.exact) }, actionOwnerIds: { protocol: ASTRA_ACTION_OWNER_ID } } },
  actionOwners: [actionOwner],
  acceptanceDeclarations: factContracts,
};

export const ASTRA_DEFINITION = defineFamily(definitionInput);
export const ASTRA_FAMILY_DEFINITION_HASH: Hash = familyAuthoringDigest(ASTRA_DEFINITION);
export const ASTRA_AUTHORITY_DECLARATION_HASH = ASTRA_DEFINITION.manifest.authorityDeclarationHash;
