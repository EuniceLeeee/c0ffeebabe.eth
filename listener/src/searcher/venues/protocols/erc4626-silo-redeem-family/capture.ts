import { createRouteCaptureMaterialization } from "../../capture-materialization.js";
import { erc4626SiloRedeemDiscovery } from "./discovery.js";
import { ERC4626_SILO_REDEEM_FAMILY_ID } from "./manifest.js";

export const erc4626SiloRedeemCapture = createRouteCaptureMaterialization({ familyId: ERC4626_SILO_REDEEM_FAMILY_ID, discovery: erc4626SiloRedeemDiscovery });
