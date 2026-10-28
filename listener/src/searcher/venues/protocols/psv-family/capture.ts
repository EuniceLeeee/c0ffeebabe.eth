import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { discovery } from "./discovery.js";
import { FAMILY } from "./manifest.js";
export const capture = createRouteCaptureMaterialization({ familyId: FAMILY, discovery });
