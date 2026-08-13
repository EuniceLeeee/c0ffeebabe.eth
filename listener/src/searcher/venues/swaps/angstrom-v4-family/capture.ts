import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { angstromV4Discovery } from "./discovery.js";
import { ANGSTROM_V4_FAMILY_ID } from "./manifest.js";

export const angstromV4Capture = createRouteCaptureMaterialization({
  familyId: ANGSTROM_V4_FAMILY_ID,
  discovery: angstromV4Discovery,
});
