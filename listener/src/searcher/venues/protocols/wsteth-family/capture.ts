import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { wstethDiscovery } from "./discovery.js";
import { WSTETH_FAMILY_ID } from "./manifest.js";

export const wstethCapture = createRouteCaptureMaterialization({ familyId: WSTETH_FAMILY_ID, discovery: wstethDiscovery });
