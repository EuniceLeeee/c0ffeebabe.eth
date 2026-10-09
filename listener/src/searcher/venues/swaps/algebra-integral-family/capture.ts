import { createRouteCaptureMaterialization } from
  "../../capture-materialization.js";
import { algebraIntegralDiscovery } from "./discovery.js";
import { ALGEBRA_INTEGRAL_FAMILY_ID } from "./manifest.js";

export const algebraIntegralCapture = createRouteCaptureMaterialization({
  familyId: ALGEBRA_INTEGRAL_FAMILY_ID,
  discovery: algebraIntegralDiscovery,
});
