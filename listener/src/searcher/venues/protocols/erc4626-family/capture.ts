import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { erc4626Discovery } from "./discovery.js";
import { ERC4626_FAMILY_ID } from "./manifest.js";

export const erc4626Capture = createRouteCaptureMaterialization({ familyId: ERC4626_FAMILY_ID, discovery: erc4626Discovery });
