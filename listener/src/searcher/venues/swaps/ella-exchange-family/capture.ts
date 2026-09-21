import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { ellaDiscovery } from "./discovery.js";
import { ELLA_ID } from "./manifest.js";
export const ellaCapture = createRouteCaptureMaterialization({ familyId: ELLA_ID, discovery: ellaDiscovery });
