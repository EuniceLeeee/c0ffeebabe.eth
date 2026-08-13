import { createFundingCaptureMaterialization } from "../../capture-materialization.js";
import { morphoFlashManifest } from "./parts.js";

export const morphoFlashCapture = createFundingCaptureMaterialization({
  familyId: morphoFlashManifest.familyId,
});
