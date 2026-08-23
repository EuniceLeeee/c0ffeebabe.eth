import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { univ4Discovery } from "../univ4-family/discovery.js";
import { UNIV4_FEE_HOOK_FAMILY_ID } from "./manifest.js";

export const univ4FeeHookCapture = createRouteCaptureMaterialization({
  familyId: UNIV4_FEE_HOOK_FAMILY_ID,
  discovery: univ4Discovery,
});
