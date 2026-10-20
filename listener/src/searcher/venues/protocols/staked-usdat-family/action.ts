import { makeProtocolAdapter } from "../../../../adapters/protocol-legs.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const stakedUsdatDepositFamilyOwnedAction = bindFamilyOwnedAction({
  action: makeProtocolAdapter({ id: "staked-usdat-deposit", signature: "deposit(uint256,address)",
    amountArg: 0, executorArgs: [1], needsApprove: true, quoteSig: "previewDeposit(uint256)" }),
  descriptor: { adapterId: "staked-usdat-deposit", lineage: "erc4626", edgeKind: "protocol",
    action: "deposit", canSendValue: false, leavesStandingPositionDefault: false },
});
