import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { discovery } from "./discovery.js";
import { BALANCER_V2_FAMILY_ID } from "./manifest.js";
export const capture = createRouteCaptureMaterialization({ familyId: BALANCER_V2_FAMILY_ID, discovery });
