import { psmAdapter as psmActionAdapter } from "../../../../adapters/psm.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const psmFamilyOwnedAction = bindFamilyOwnedAction({
  action: psmActionAdapter,
  descriptor: {
    adapterId: "psm",
    lineage: "psm",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
