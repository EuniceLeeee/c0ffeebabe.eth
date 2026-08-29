import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import { ASTRA_FAMILY_ID, ASTRA_FAMILY_VERSION, ASTRA_STAGE_IDS } from "./manifest.ts";
import { nominateAstra } from "./nomination.ts";
import { verifyAstraIdentity } from "./identity.ts";
import { compileAstraInstance, rehydrateAstraInstance } from "./instance.ts";
import { deriveAstraRoutes } from "./routes.ts";
import {
  ASTRA_CURRENT_SOURCE_EXACT,
  ASTRA_RUNTIME_ADAPTER,
  ASTRA_RUNTIME_ADAPTER_FACTORY,
} from "./runtime/adapter.ts";
import {
  ASTRA_IDENTITY_DEFINITION,
  ASTRA_MATERIALIZATION_DEFINITION,
  ASTRA_NOMINATION_DEFINITION,
  ASTRA_PROJECTION_DEFINITION,
  ASTRA_REHYDRATION_DEFINITION,
  ASTRA_STAGE_DEFINITIONS,
} from "./runtime/definitions.ts";

export {
  ASTRA_IDENTITY_DEFINITION,
  ASTRA_MATERIALIZATION_DEFINITION,
  ASTRA_NOMINATION_DEFINITION,
  ASTRA_PROJECTION_DEFINITION,
  ASTRA_REHYDRATION_DEFINITION,
  ASTRA_STAGE_DEFINITIONS,
  requireAstraStageDefinition,
} from "./runtime/definitions.ts";

export {
  ASTRA_CURRENT_SOURCE_EXACT,
  ASTRA_RUNTIME_ADAPTER,
  ASTRA_RUNTIME_ADAPTER_FACTORY,
} from "./runtime/adapter.ts";
export type {
  AstraCurrentSourceExactDeclarationV1,
  AstraRuntimeAdapterV1,
} from "./runtime/adapter.ts";

export const ASTRA_RUNTIME_STAGE_NAMES = Object.freeze(["nomination", "identity", "materialization", "projection", "rehydration"] as const);
export type AstraRuntimeStageNameV1 = (typeof ASTRA_RUNTIME_STAGE_NAMES)[number];

export const ASTRA_EXTENSION_DEFINITIONS = Object.freeze(([
  "state",
  "coarse",
  "exact",
] as const).map(stage => Object.freeze({ stage, capabilityId: ASTRA_STAGE_IDS[stage], familyId: ASTRA_FAMILY_ID, version: ASTRA_FAMILY_VERSION, schemaHash: hashDomain("aloha/astra-multitoken/stage-schema/v1", stage), interpreterHash: hashDomain("aloha/astra-multitoken/stage-interpreter/v1", stage), sourcePlans: [] })));

/** Family-local executable stage seam; generated composition only binds its declared refs. */
export const ASTRA_STAGE_RUNTIME = Object.freeze({
  nomination: nominateAstra,
  identity: verifyAstraIdentity,
  materialization: compileAstraInstance,
  projection: deriveAstraRoutes,
  rehydration: rehydrateAstraInstance,
});

export const ASTRA_STATE_DEFINITION = ASTRA_EXTENSION_DEFINITIONS[0]!;
export const ASTRA_COARSE_DEFINITION = ASTRA_EXTENSION_DEFINITIONS[1]!;
export const ASTRA_EXACT_DEFINITION = ASTRA_EXTENSION_DEFINITIONS[2]!;
