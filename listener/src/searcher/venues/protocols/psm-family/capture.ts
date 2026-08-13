import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { psmDiscovery } from "./discovery.js";
import { PSM_FAMILY_ID } from "./manifest.js";

export const psmCapture = createRouteCaptureMaterialization({ familyId: PSM_FAMILY_ID, discovery: psmDiscovery });
