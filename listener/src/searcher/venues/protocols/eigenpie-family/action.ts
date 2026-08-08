import { eigenpieDepositActionAdapter } from
  "../../../../adapters/eigenpie-deposit.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const eigenpieFamilyOwnedAction = bindFamilyOwnedAction({
  action: eigenpieDepositActionAdapter,
  descriptor: {
    adapterId: "eigenpie-deposit-asset",
    lineage: "eigenpie",
    edgeKind: "protocol",
    action: "deposit",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
