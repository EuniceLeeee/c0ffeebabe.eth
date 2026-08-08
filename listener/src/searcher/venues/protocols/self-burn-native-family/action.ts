import { selfBurnNativeRedeemActionAdapter } from "../../../../adapters/self-burn-native.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const selfBurnNativeFamilyOwnedAction = bindFamilyOwnedAction({
  action: selfBurnNativeRedeemActionAdapter,
  descriptor: {
    adapterId: "self-burn-native-redeem",
    lineage: "self-burn-native",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
