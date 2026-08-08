import { bindProtocolLegAction } from "../standard-family/common.js";

export const erc4626DepositFamilyOwnedAction = bindProtocolLegAction(
  "erc4626-deposit",
  {
    adapterId: "erc4626-deposit",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "deposit",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);

export const erc4626RedeemFamilyOwnedAction = bindProtocolLegAction(
  "erc4626-redeem",
  {
    adapterId: "erc4626-redeem",
    lineage: "erc4626",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);
