import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { olympusDiscovery } from "./discovery.js";
import { OLYMPUS_FAMILY_ID } from "./manifest.js";

export const olympusCapture = createRouteCaptureMaterialization({
  familyId: OLYMPUS_FAMILY_ID,
  discovery: olympusDiscovery,
});
