import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { UNIV4_FEE_HOOK_FAMILY_ID } from "./manifest.js";
import { univ4FeeHookDiscovery } from "./discovery.js";

export const univ4FeeHookCapture = createRouteCaptureMaterialization({
  familyId: UNIV4_FEE_HOOK_FAMILY_ID,
  discovery: univ4FeeHookDiscovery,
});
