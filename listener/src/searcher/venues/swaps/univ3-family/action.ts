import { univ3Adapter } from "../../../../adapters/univ3.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const univ3FamilyOwnedAction = bindFamilyOwnedAction({
  action: univ3Adapter,
  descriptor: {
    adapterId: "univ3-swap",
    lineage: "univ3",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
