import { bindProtocolLegAction } from "../standard-family/common.js";

export const wstethWrapFamilyOwnedAction = bindProtocolLegAction(
  "wsteth-wrap",
  {
    adapterId: "wsteth-wrap",
    lineage: "wsteth",
    edgeKind: "protocol",
    action: "wrap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);

export const wstethUnwrapFamilyOwnedAction = bindProtocolLegAction(
  "wsteth-unwrap",
  {
    adapterId: "wsteth-unwrap",
    lineage: "wsteth",
    edgeKind: "protocol",
    action: "unwrap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);
