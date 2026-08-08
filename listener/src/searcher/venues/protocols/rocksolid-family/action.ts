import { bindProtocolLegAction } from "../standard-family/common.js";

export const rocksolidFamilyOwnedAction = bindProtocolLegAction(
  "rocksolid-sync-deposit",
  {
    adapterId: "rocksolid-sync-deposit",
    lineage: "rocksolid",
    edgeKind: "protocol",
    action: "deposit",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
);
