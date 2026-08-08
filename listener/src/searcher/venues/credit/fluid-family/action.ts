import { fluidDexLiquidateAdapter } from "../../../../adapters/fluid-dex.js";
import { fluidVaultAdapter } from "../../../../adapters/fluid-vault.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const fluidCreditVaultAction = bindFamilyOwnedAction({
  action: fluidVaultAdapter,
  descriptor: {
    adapterId: "fluid-vault",
    lineage: "fluid-credit",
    edgeKind: "credit",
    action: "borrow",
    canSendValue: false,
    leavesStandingPositionDefault: true,
  },
});

export const fluidCreditLiquidateAction = bindFamilyOwnedAction({
  action: fluidDexLiquidateAdapter,
  descriptor: {
    adapterId: "fluid-dex-liquidate",
    lineage: "fluid-credit",
    edgeKind: "credit",
    action: "repay",
    canSendValue: false,
    leavesStandingPositionDefault: true,
  },
});
