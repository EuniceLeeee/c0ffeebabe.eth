import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { originStethArmDiscovery } from "./discovery.js";
import { ORIGIN_STETH_ARM_FAMILY_ID } from "./manifest.js";

export const originStethArmCapture = createRouteCaptureMaterialization({
  familyId: ORIGIN_STETH_ARM_FAMILY_ID,
  discovery: originStethArmDiscovery,
});
