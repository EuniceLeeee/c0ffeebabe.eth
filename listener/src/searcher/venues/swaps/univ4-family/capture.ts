import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { univ4Discovery } from "./discovery.js";
import { UNIV4_FAMILY_ID } from "./manifest.js";

export const univ4Capture = createRouteCaptureMaterialization({
  familyId: UNIV4_FAMILY_ID,
  discovery: univ4Discovery,
});
