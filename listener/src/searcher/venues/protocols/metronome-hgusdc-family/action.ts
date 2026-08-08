import { metronomeHgUsdcExitAdapter } from "../../../../adapters/metronome-hgusdc.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const metronomeHgUsdcFamilyOwnedAction = bindFamilyOwnedAction({
  action: metronomeHgUsdcExitAdapter,
  descriptor: {
    adapterId: "metronome-hgusdc-exit",
    lineage: "metronome",
    edgeKind: "protocol",
    action: "redeem",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
