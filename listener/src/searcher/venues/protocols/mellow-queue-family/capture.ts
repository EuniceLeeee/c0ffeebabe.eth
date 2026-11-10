import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { mellowQueueDiscovery } from "./discovery.js";
import { FAMILY } from "./manifest.js";

export const mellowQueueCapture = createRouteCaptureMaterialization({
  familyId: FAMILY,
  discovery: mellowQueueDiscovery,
});
