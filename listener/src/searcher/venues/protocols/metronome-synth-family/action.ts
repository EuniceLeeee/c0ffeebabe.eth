import { bindProtocolLegAction } from "../standard-family/common.js";

export const metronomeSynthFamilyOwnedAction = bindProtocolLegAction(
  "metronome-synth-swap",
  {
    adapterId: "metronome-synth-swap",
    lineage: "metronome",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);
