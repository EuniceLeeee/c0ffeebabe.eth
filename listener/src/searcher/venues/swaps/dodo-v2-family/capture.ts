import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { dodoV2Discovery } from "./discovery.js";
import { DODO_V2_FAMILY_ID } from "./manifest.js";

export const dodoV2Capture = createRouteCaptureMaterialization({
  familyId: DODO_V2_FAMILY_ID,
  discovery: dodoV2Discovery,
});
