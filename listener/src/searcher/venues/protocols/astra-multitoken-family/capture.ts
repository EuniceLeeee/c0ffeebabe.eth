import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { astraMultiTokenDiscovery } from "./discovery.js";
import { ASTRA_MULTITOKEN_FAMILY_ID } from "./manifest.js";

export const astraMultiTokenCapture = createRouteCaptureMaterialization({ familyId: ASTRA_MULTITOKEN_FAMILY_ID, discovery: astraMultiTokenDiscovery });
