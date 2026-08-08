import { dodoV2ActionAdapter } from "../../../../adapters/dodo-v2.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const dodoV2FamilyOwnedAction = bindFamilyOwnedAction({
  action: dodoV2ActionAdapter,
  descriptor: {
    adapterId: "dodo-v2-swap",
    lineage: "dodo-v2",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
