import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { FAMILY } from "./manifest.js";
import { discovery } from "./discovery.js";
export const capture = createRouteCaptureMaterialization({ familyId: FAMILY, discovery });
