import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { originOusdDiscovery } from "./discovery.js";
import { ORIGIN_OUSD_FAMILY_ID } from "./manifest.js";

export const originOusdCapture = createRouteCaptureMaterialization({
  familyId: ORIGIN_OUSD_FAMILY_ID,
  discovery: originOusdDiscovery,
});
