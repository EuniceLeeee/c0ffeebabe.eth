import type { CaptureMaterializationSemantics } from "../../adapter-family-plugin.js";
import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { metafactoryDiscovery } from "./discovery.js";
import { METAFACTORY_FAMILY_ID } from "./manifest.js";

export const metafactoryCapture: CaptureMaterializationSemantics =
  createRouteCaptureMaterialization({
    familyId: METAFACTORY_FAMILY_ID,
    discovery: metafactoryDiscovery,
  });
