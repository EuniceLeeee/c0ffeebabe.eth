import { createRouteCaptureMaterialization } from
  "../../capture-materialization.js";
import { kyberswapElasticDiscovery } from "./discovery.js";
import { KYSWAP_FAMILY_ID } from "./manifest.js";

export const kyberswapElasticCapture = createRouteCaptureMaterialization({
  familyId: KYSWAP_FAMILY_ID,
  discovery: kyberswapElasticDiscovery,
});
