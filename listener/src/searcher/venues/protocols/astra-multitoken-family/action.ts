import { astraMultiTokenChangeActionAdapter } from "../../../../adapters/astra-multitoken.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const astraMultiTokenFamilyOwnedAction = bindFamilyOwnedAction({
  action: astraMultiTokenChangeActionAdapter,
  descriptor: {
    adapterId: "astra-multitoken-change",
    lineage: "custom-protocol:astra-multitoken",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
