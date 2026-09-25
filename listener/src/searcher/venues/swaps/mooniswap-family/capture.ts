import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { MOONISWAP_ID } from "./codec.js";
import { mooniswapDiscovery } from "./discovery.js";
export const mooniswapCapture = createRouteCaptureMaterialization({ familyId: MOONISWAP_ID, discovery: mooniswapDiscovery });
