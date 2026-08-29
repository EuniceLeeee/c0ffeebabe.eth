import { captureDodoEvidence } from "./capture.ts";
import { decodeDodoCandidate } from "./discovery.ts";
import { exactDodoV2 } from "./exact.ts";
import { compileDodoExecution } from "./execution.ts";
import { verifyDodoIdentityStage } from "./identity.ts";
import { materializeDodoV2 } from "./instance.ts";
import { nominateDodoV2 } from "./nomination.ts";
import { coarseDodoV2 } from "./pricing.ts";
import { deriveDodoRoutes } from "./routes.ts";
import { DODO_V2_MANIFEST } from "./manifest.ts";
export const DODO_V2_RUNTIME = Object.freeze({ manifest: DODO_V2_MANIFEST, discover: decodeDodoCandidate, capture: captureDodoEvidence, nominate: nominateDodoV2, identity: verifyDodoIdentityStage, materialize: materializeDodoV2, routes: deriveDodoRoutes, coarse: coarseDodoV2, exact: exactDodoV2, execute: compileDodoExecution });
export {
  DODO_V2_NOMINATION_DEFINITION as DODO_NOMINATION_RUNTIME,
  DODO_V2_IDENTITY_DEFINITION as DODO_IDENTITY_RUNTIME,
  DODO_V2_MATERIALIZATION_DEFINITION as DODO_MATERIALIZATION_RUNTIME,
  DODO_V2_PROJECTION_DEFINITION as DODO_PROJECTION_RUNTIME,
  DODO_V2_REHYDRATION_DEFINITION as DODO_REHYDRATION_RUNTIME,
  DODO_V2_NOMINATION_DEFINITION,
  DODO_V2_IDENTITY_DEFINITION,
  DODO_V2_MATERIALIZATION_DEFINITION,
  DODO_V2_PROJECTION_DEFINITION,
  DODO_V2_REHYDRATION_DEFINITION,
  DODO_V2_STAGE_DEFINITIONS,
  requireDodoV2StageDefinition,
} from "./runtime/definitions.ts";
export { DODO_SEARCH_RUNTIME_ADAPTER_FACTORY } from "./search-adapter.ts";
