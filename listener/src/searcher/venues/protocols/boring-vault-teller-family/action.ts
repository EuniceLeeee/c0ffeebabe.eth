import { boringVaultWithdrawActionAdapter } from "../../../../adapters/boring-vault-teller.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const boringFamilyOwnedAction = bindFamilyOwnedAction({
  action: boringVaultWithdrawActionAdapter,
  descriptor: boringVaultWithdrawActionAdapter.descriptor,
});
