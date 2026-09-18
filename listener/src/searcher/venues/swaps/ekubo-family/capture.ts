import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { ekuboDiscovery } from "./discovery.js";
import { EKUBO_FAMILY_ID } from "./manifest.js";
export const ekuboCapture = createRouteCaptureMaterialization({ familyId: EKUBO_FAMILY_ID, discovery: ekuboDiscovery });
