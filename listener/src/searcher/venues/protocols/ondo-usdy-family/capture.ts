import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { ondoDiscovery } from "./discovery.js";
import { FAMILY } from "./manifest.js";
export const ondoCapture = createRouteCaptureMaterialization({ familyId: FAMILY, discovery: ondoDiscovery });
