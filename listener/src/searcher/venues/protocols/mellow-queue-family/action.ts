import {
  mellowDepositActionAdapter,
  mellowRedeemActionAdapter,
} from "../../../../adapters/mellow-queue.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const mellowDepositFamilyOwnedAction = bindFamilyOwnedAction({
  action: mellowDepositActionAdapter,
  descriptor: mellowDepositActionAdapter.descriptor,
});

export const mellowRedeemFamilyOwnedAction = bindFamilyOwnedAction({
  action: mellowRedeemActionAdapter,
  descriptor: mellowRedeemActionAdapter.descriptor,
});
