import { createFundingCaptureMaterialization } from "../../capture-materialization.js";
import { balancerFlashManifest } from "./parts.js";

export const balancerFlashCapture = createFundingCaptureMaterialization({
  familyId: balancerFlashManifest.familyId,
});
