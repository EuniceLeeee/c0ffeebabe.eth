import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { boringDiscovery } from "./discovery.js";
import { FAMILY } from "./manifest.js";

export const boringCapture = createRouteCaptureMaterialization({ familyId: FAMILY, discovery: boringDiscovery });
