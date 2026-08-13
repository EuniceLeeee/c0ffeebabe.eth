import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { rocksolidDiscovery } from "./discovery.js";
import { ROCKSOLID_FAMILY_ID } from "./manifest.js";

export const rocksolidCapture = createRouteCaptureMaterialization({ familyId: ROCKSOLID_FAMILY_ID, discovery: rocksolidDiscovery });
