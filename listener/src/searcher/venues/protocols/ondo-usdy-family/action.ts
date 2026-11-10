import { ondoUsdyRedeemActionAdapter } from "../../../../adapters/ondo-usdy-redeem.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
export const ondoFamilyOwnedAction = bindFamilyOwnedAction({ action: ondoUsdyRedeemActionAdapter, descriptor: ondoUsdyRedeemActionAdapter.descriptor });
