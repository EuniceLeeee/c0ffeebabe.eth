import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { eigenpieDiscovery } from "./discovery.js";
import { EIGENPIE_FAMILY_ID } from "./manifest.js";

export const eigenpieCapture = createRouteCaptureMaterialization({ familyId: EIGENPIE_FAMILY_ID, discovery: eigenpieDiscovery });
