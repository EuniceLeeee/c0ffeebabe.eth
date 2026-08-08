import { angstromV4SwapActionAdapter } from "../../../../adapters/angstrom-v4.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const angstromV4FamilyOwnedAction = bindFamilyOwnedAction({
  action: angstromV4SwapActionAdapter,
  descriptor: {
    adapterId: "angstrom-v4-swap",
    lineage: "angstrom-v4",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
