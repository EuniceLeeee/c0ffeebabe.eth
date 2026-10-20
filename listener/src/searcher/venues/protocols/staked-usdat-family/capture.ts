import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { stakedUsdatDiscovery } from "./discovery.js";
import { STAKED_USDAT_FAMILY_ID } from "./manifest.js";
export const stakedUsdatCapture = createRouteCaptureMaterialization({ familyId: STAKED_USDAT_FAMILY_ID, discovery: stakedUsdatDiscovery });
