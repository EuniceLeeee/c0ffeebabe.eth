import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { goldxDiscovery } from "./discovery.js";
import { GOLDX_FAMILY_ID } from "./manifest.js";

export const goldxCapture = createRouteCaptureMaterialization({ familyId: GOLDX_FAMILY_ID, discovery: goldxDiscovery });
