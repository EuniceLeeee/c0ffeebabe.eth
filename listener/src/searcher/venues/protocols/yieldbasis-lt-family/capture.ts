import { createRouteCaptureMaterialization } from
  "../../capture-materialization.js";
import { yieldBasisLtDiscovery } from "./discovery.js";
import { YIELDBASIS_FAMILY_ID } from "./manifest.js";

export const yieldBasisLtCapture = createRouteCaptureMaterialization({
  familyId: YIELDBASIS_FAMILY_ID,
  discovery: yieldBasisLtDiscovery,
});
