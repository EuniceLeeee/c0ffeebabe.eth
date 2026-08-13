import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { curveUnderlyingDiscovery } from "./discovery.js";
import { CURVE_UNDERLYING_FAMILY_ID } from "./manifest.js";

export const curveUnderlyingCapture = createRouteCaptureMaterialization({
  familyId: CURVE_UNDERLYING_FAMILY_ID,
  discovery: curveUnderlyingDiscovery,
});
