import { etherTokenNativeRedeemActionAdapter } from "../../../../adapters/ethertoken-native-redeem.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const etherTokenNativeRedeemFamilyOwnedAction = bindFamilyOwnedAction({
  action: etherTokenNativeRedeemActionAdapter,
  descriptor: {
    adapterId: "ethertoken-native-redeem",
    lineage: "custom-protocol:ethertoken-native-redeem",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
