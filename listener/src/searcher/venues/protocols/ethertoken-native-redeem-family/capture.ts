import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { etherTokenNativeRedeemDiscovery } from "./discovery.js";
import { ETHERTOKEN_NATIVE_FAMILY_ID } from "./manifest.js";

export const etherTokenNativeRedeemCapture = createRouteCaptureMaterialization({ familyId: ETHERTOKEN_NATIVE_FAMILY_ID, discovery: etherTokenNativeRedeemDiscovery });
