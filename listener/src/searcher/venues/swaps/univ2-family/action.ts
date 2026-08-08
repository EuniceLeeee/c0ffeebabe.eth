import { univ2Adapter } from "../../../../adapters/univ2.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const univ2FamilyOwnedAction = bindFamilyOwnedAction({
  action: univ2Adapter,
  descriptor: {
    adapterId: "univ2-swap",
    lineage: "univ2",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
