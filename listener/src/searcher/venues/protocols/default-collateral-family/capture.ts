import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { defaultCollateralDiscovery } from "./discovery.js";
import { DEFAULT_COLLATERAL_FAMILY_ID } from "./manifest.js";

export const defaultCollateralCapture = createRouteCaptureMaterialization({
  familyId: DEFAULT_COLLATERAL_FAMILY_ID,
  discovery: defaultCollateralDiscovery,
});
