import { UNIV3_STANDARD_MANIFEST } from "./manifest.ts";
import { captureUniV3Evidence } from "./capture.ts";
import { decodeUniV3Candidate } from "./discovery.ts";
import { exactUniV3 } from "./exact.ts";
import { compileUniV3Execution } from "./execution.ts";
import { verifyUniV3IdentityStage } from "./identity.ts";
import { materializeUniV3 } from "./instance.ts";
import { nominateUniV3 } from "./nomination.ts";
import { coarseUniV3 } from "./pricing.ts";
import { deriveUniV3Routes } from "./routes.ts";

/** Family-local semantic runtime. It has no Graph, scheduler, signer, or topology authority. */
export const UNIV3_STANDARD_RUNTIME = Object.freeze({
  manifest: UNIV3_STANDARD_MANIFEST,
  discover: decodeUniV3Candidate,
  capture: captureUniV3Evidence,
  nominate: nominateUniV3,
  identity: verifyUniV3IdentityStage,
  materialize: materializeUniV3,
  routes: deriveUniV3Routes,
  coarse: coarseUniV3,
  exact: exactUniV3,
  execute: compileUniV3Execution,
});

export {
  UNIV3_STAGE_IDS,
  UNIV3_STAGE_SCHEMA_HASHES,
  UNIV3_NOMINATION_DEFINITION as UNIV3_NOMINATION_RUNTIME,
  UNIV3_IDENTITY_DEFINITION as UNIV3_IDENTITY_RUNTIME,
  UNIV3_MATERIALIZATION_DEFINITION as UNIV3_MATERIALIZATION_RUNTIME,
  UNIV3_PROJECTION_DEFINITION as UNIV3_PROJECTION_RUNTIME,
  UNIV3_REHYDRATION_DEFINITION as UNIV3_REHYDRATION_RUNTIME,
  UNIV3_NOMINATION_DEFINITION,
  UNIV3_IDENTITY_DEFINITION,
  UNIV3_MATERIALIZATION_DEFINITION,
  UNIV3_PROJECTION_DEFINITION,
  UNIV3_REHYDRATION_DEFINITION,
  UNIV3_STAGE_DEFINITIONS,
  requireUniV3StageDefinition,
} from "./runtime/definitions.ts";
export { UNIV3_SEARCH_RUNTIME_ADAPTER_FACTORY } from "./search-adapter.ts";
