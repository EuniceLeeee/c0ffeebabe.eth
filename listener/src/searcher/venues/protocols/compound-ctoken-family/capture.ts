import { createRouteCaptureMaterialization } from
  "../../capture-materialization.js";
import { compoundCTokenDiscovery } from "./discovery.js";
import { CTOKEN_FAMILY_ID } from "./manifest.js";

export const compoundCTokenCapture = createRouteCaptureMaterialization({
  familyId: CTOKEN_FAMILY_ID,
  discovery: compoundCTokenDiscovery,
});
