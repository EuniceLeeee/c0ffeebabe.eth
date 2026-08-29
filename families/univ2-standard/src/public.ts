import { UNIV2_STANDARD_DEFINITION } from "./family-definition.ts";
import {
  UNIV2_STANDARD_NOMINATION_DEFINITION,
  UNIV2_STANDARD_IDENTITY_DEFINITION,
  UNIV2_STANDARD_MATERIALIZATION_DEFINITION,
  UNIV2_STANDARD_PROJECTION_DEFINITION,
  UNIV2_STANDARD_REHYDRATION_DEFINITION,
} from "./runtime/definitions.ts";

export { quoteV2ExactInput } from "./kernel/math.ts";
export { canonicalAddress, decodeAddressWord, decodeReserves, lowerAddress, sameAddress } from "./kernel/codec.ts";
export { verifyUniV2Identity } from "./kernel/identity.ts";
export { sealUniV2MaterializedState } from "./kernel/state.ts";
export type { UniV2IdentityFactsV1, UniV2IdentityVerdictV1 } from "./kernel/identity.ts";

export {
  UNIV2_STANDARD_AUTHORITY_DECLARATION_HASH,
  UNIV2_STANDARD_DEFINITION,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
  UNIV2_STANDARD_FAMILY_VERSION,
  UNIV2_STANDARD_OWNER_REF,
  UNIV2_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_DECLARATION,
  UNIV2_STANDARD_REQUESTED_ARTIFACT_DEPENDENCY_ROOT,
  UNIV2_STANDARD_SEARCH_ADAPTER_DECLARATION,
  UNIV2_STANDARD_STAGE_IDS,
  UNIV2_STANDARD_STAGE_INTERPRETER_HASHES,
  UNIV2_STANDARD_STAGE_SCHEMA_HASHES,
  UNIV2_STANDARD_EXTENSION_CAPABILITY_IDS,
  UNIV2_STANDARD_EXTENSION_SCHEMA_HASHES,
  UNIV2_STANDARD_SWAP_ACTION_OWNER,
} from "./family-definition.ts";
export { FAMILY_PHYSICAL_LIFECYCLE_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/runtime/index.ts";
export { FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1 } from "../../../packages/family-sdk/search-runtime/index.ts";

export {
  UNIV2_STANDARD_NOMINATION_DEFINITION,
  UNIV2_STANDARD_IDENTITY_DEFINITION,
  UNIV2_STANDARD_MATERIALIZATION_DEFINITION,
  UNIV2_STANDARD_PROJECTION_DEFINITION,
  UNIV2_STANDARD_REHYDRATION_DEFINITION,
  UNIV2_STANDARD_STAGE_DEFINITIONS,
  requireUniV2StageDefinition,
} from "./runtime/definitions.ts";

export {
  candidateFamilyKey,
  instanceNominationKey,
  nominateUniV2,
} from "./stages/nomination.ts";
export type { UniV2NominationOutcomeV1 } from "./stages/nomination.ts";
export {
  UNIV2_STANDARD_SOURCE_PLAN_DEFINITION,
  UNIV2_STANDARD_SOURCE_PLAN_ID,
  UNIV2_STANDARD_SOURCE_PLAN_SCHEMA_HASH,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_DEFINITION,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_ID,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  UNIV2_PAIR_CREATED_TOPIC0,
} from "./source-plan.ts";
export * from "./history-source-plan.ts";
export { UNIV2_STANDARD_SOURCE_NOMINATION_PROGRAM, UNIV2_STANDARD_SOURCE_PLAN_RUNTIME } from "./stages/nomination.ts";

export {
  buildIdentityBaseReadRequests,
  buildIdentityPairReadRequests,
  verifyUniV2IdentityStage,
} from "./stages/identity.ts";
export type { UniV2IdentityStageOutcomeV1, UniV2IdentityVerifiedV1 } from "./stages/identity.ts";

export { materializeUniV2 } from "./stages/materialization.ts";
export type { UniV2MaterializationOutcomeV1, UniV2MaterializationVerifiedV1 } from "./stages/materialization.ts";

export { projectUniV2 } from "./stages/projection.ts";
export type { UniV2ProjectionInputV1, UniV2ProjectionOutcomeV1, UniV2ProjectionVerifiedV1 } from "./stages/projection.ts";

export {
  UNIV2_STANDARD_STATE_PORT,
  decodeUniV2StateSnapshot,
} from "./capabilities/state.ts";
export type {
  UniV2StateReadPortV1,
  UniV2StateReadProgramV1,
  UniV2StateReadResponseV1,
  UniV2StateSnapshotV1,
} from "./capabilities/state.ts";

export {
  UNIV2_STANDARD_COARSE_PORT,
  decodeUniV2CoarseProjection,
} from "./capabilities/coarse.ts";
export type {
  UniV2CoarseDirectionV1,
  UniV2CoarseInputV1,
  UniV2CoarseProjectionV1,
  UniV2CoarsePortV1,
  UniV2ConservativeUpperBoundV1,
  UniV2GenericAssetAmountV1,
} from "./capabilities/coarse.ts";

export {
  UNIV2_STANDARD_EXACT_PORT,
  decodeUniV2ExactEvaluation,
} from "./capabilities/exact.ts";
export type {
  UniV2ExactEvaluationV1,
  UniV2ExactInputV1,
  UniV2ExactPortV1,
  UniV2ObligationRefV1,
} from "./capabilities/exact.ts";

export {
  UNIV2_STANDARD_SWAP_ACTION_PORT,
  decodeUniV2SwapAction,
} from "./capabilities/action.ts";
export type {
  UniV2SwapActionInputV1,
  UniV2SwapActionPortV1,
  UniV2SwapActionV1,
} from "./capabilities/action.ts";

export {
  createUniV2SearchAdapter,
  createUniV2SearchAdapterFromComposition,
  UNIV2_STANDARD_SEARCH_ADAPTER,
} from "./search/adapter.ts";
export type {
  UniV2SearchAdapterCompositionInputV1,
  UniV2SearchAdapterPortsV1,
} from "./search/adapter.ts";

export {
  UNIV2_STANDARD_SWAP_FEE_BPS,
  UNIV2_STANDARD_SWAP_FEE_BPS_DECIMAL,
  UNIV2_STANDARD_SWAP_GAS_UPPER_BOUND,
  UNIV2_STANDARD_SWAP_SELECTOR,
} from "./capabilities/metadata.ts";

export {
  issueUniV2RouteHandle,
  makeUniV2RehydrationRef,
  rehydrateUniV2RouteHandle,
  routeHandleBindingHash,
} from "./stages/rehydration.ts";
export type { UniV2RouteHandleAuthorityPort, UniV2RouteHandleV1 } from "./stages/rehydration.ts";

export * from "./schema/index.ts";

/**
 * Stable family release entry.  It contains only authoring metadata and the
 * exact runtime definition objects.  Compiler closure roots, generated
 * stage refs, executor handles, and authority values are deliberately absent;
 * the catalog generator computes and binds those from the named exports.
 */
export const UNIV2_STANDARD_STAGE_EXPORT_NAMES = Object.freeze({
  nomination: "UNIV2_STANDARD_NOMINATION_DEFINITION",
  identity: "UNIV2_STANDARD_IDENTITY_DEFINITION",
  materialization: "UNIV2_STANDARD_MATERIALIZATION_DEFINITION",
  projection: "UNIV2_STANDARD_PROJECTION_DEFINITION",
  rehydration: "UNIV2_STANDARD_REHYDRATION_DEFINITION",
});

export const UNIV2_STANDARD_RUNTIME_DEFINITIONS = Object.freeze({
  nomination: UNIV2_STANDARD_NOMINATION_DEFINITION,
  identity: UNIV2_STANDARD_IDENTITY_DEFINITION,
  materialization: UNIV2_STANDARD_MATERIALIZATION_DEFINITION,
  projection: UNIV2_STANDARD_PROJECTION_DEFINITION,
  rehydration: UNIV2_STANDARD_REHYDRATION_DEFINITION,
});

/** The real Family-owned factory imported by generated runtime composition. */
export { UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY } from "./search/adapter.ts";
export { UNIV2_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY } from "./runtime/physical-adapter.ts";

export const PUBLIC_ENTRY = Object.freeze({
  familyDefinition: UNIV2_STANDARD_DEFINITION,
  stageExportNames: UNIV2_STANDARD_STAGE_EXPORT_NAMES,
  runtimeDefinitions: UNIV2_STANDARD_RUNTIME_DEFINITIONS,
});
