import { bindProtocolLegAction } from "../standard-family/common.js";

export const goldxFamilyOwnedAction = bindProtocolLegAction("goldx-mint", {
  adapterId: "goldx-mint",
  lineage: "goldx",
  edgeKind: "protocol",
  action: "convert",
  canSendValue: false,
  leavesStandingPositionDefault: false,
});
