import { fluidDexSwapAdapter } from "../../../../adapters/fluid-dex.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const fluidDexFamilyOwnedAction = bindFamilyOwnedAction({
  action: fluidDexSwapAdapter,
  descriptor: {
    adapterId: "fluid-dex-swap",
    lineage: "fluid-dex",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
