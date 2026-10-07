import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { discovery } from "./discovery.js";
import { ID } from "./manifest.js";
export const capture = createRouteCaptureMaterialization({ familyId: ID, discovery });
