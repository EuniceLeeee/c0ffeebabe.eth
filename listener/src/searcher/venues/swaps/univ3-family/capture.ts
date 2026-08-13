import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { univ3Discovery } from "./discovery.js";
import { UNIV3_FAMILY_ID } from "./manifest.js";

export const univ3Capture = createRouteCaptureMaterialization({
  familyId: UNIV3_FAMILY_ID,
  discovery: univ3Discovery,
});
