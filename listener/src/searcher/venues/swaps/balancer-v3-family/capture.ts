import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { balancerV3Discovery } from "./discovery.js";
import { BALANCER_V3_FAMILY_ID } from "./manifest.js";
export const balancerV3Capture = createRouteCaptureMaterialization({ familyId: BALANCER_V3_FAMILY_ID, discovery: balancerV3Discovery });
