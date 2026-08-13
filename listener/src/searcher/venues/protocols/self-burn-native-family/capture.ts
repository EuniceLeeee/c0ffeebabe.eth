import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { selfBurnNativeDiscovery } from "./discovery.js";
import { SELF_BURN_NATIVE_FAMILY_ID } from "./manifest.js";

export const selfBurnNativeCapture = createRouteCaptureMaterialization({ familyId: SELF_BURN_NATIVE_FAMILY_ID, discovery: selfBurnNativeDiscovery });
