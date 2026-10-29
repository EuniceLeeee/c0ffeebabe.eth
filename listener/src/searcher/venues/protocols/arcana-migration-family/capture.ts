import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { arcanaMigrationDiscovery } from "./discovery.js";
import { FAMILY } from "./manifest.js";

export const arcanaMigrationCapture = createRouteCaptureMaterialization({
  familyId: FAMILY,
  discovery: arcanaMigrationDiscovery,
});
