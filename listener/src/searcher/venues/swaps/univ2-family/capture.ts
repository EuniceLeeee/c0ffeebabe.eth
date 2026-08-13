import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { univ2Discovery } from "./discovery.js";
import { UNIV2_FAMILY_ID } from "./manifest.js";

export const univ2Capture = createRouteCaptureMaterialization({
  familyId: UNIV2_FAMILY_ID,
  discovery: univ2Discovery,
});
