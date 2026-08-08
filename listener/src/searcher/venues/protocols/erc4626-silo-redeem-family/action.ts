import { bindProtocolLegAction } from "../standard-family/common.js";

export const erc4626SiloRedeemFamilyOwnedAction = bindProtocolLegAction(
  "erc4626-redeem-silo",
  {
    adapterId: "erc4626-redeem-silo",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);
