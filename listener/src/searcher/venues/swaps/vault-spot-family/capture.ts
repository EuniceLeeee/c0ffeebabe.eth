import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { ID } from "./manifest.js";
import { discovery } from "./discovery.js";
export const capture = createRouteCaptureMaterialization({ familyId: ID, discovery });
