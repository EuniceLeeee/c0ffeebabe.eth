import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { fluidDexDiscovery } from "./discovery.js";
import { FLUID_DEX_FAMILY_ID } from "./manifest.js";

export const fluidDexCapture = createRouteCaptureMaterialization({
  familyId: FLUID_DEX_FAMILY_ID,
  discovery: fluidDexDiscovery,
});
