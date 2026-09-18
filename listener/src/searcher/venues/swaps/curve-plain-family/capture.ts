import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { curvePlainDiscovery } from "./discovery.js";
import { CURVE_PLAIN_FAMILY_ID } from "./manifest.js";
export const curvePlainCapture = createRouteCaptureMaterialization({ familyId: CURVE_PLAIN_FAMILY_ID, discovery: curvePlainDiscovery });
