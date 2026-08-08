import {
  univ4SettleAdapter,
  univ4SettleValueAdapter,
  univ4SwapAdapter,
  univ4SyncAdapter,
  univ4TakeAdapter,
  univ4UnlockAdapter,
} from "../../../../adapters/univ4.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

export const univ4UnlockFamilyOwnedAction = owned(univ4UnlockAdapter, false);
export const univ4SwapFamilyOwnedAction = owned(univ4SwapAdapter, false);
export const univ4TakeFamilyOwnedAction = owned(univ4TakeAdapter, false);
export const univ4SyncFamilyOwnedAction = owned(univ4SyncAdapter, false);
export const univ4SettleFamilyOwnedAction = owned(univ4SettleAdapter, false);
export const univ4SettleValueFamilyOwnedAction = owned(
  univ4SettleValueAdapter,
  true,
);

export const univ4FamilyOwnedActions = Object.freeze([
  univ4UnlockFamilyOwnedAction,
  univ4SwapFamilyOwnedAction,
  univ4TakeFamilyOwnedAction,
  univ4SyncFamilyOwnedAction,
  univ4SettleFamilyOwnedAction,
  univ4SettleValueFamilyOwnedAction,
]);

function owned(
  action:
    | typeof univ4UnlockAdapter
    | typeof univ4SwapAdapter
    | typeof univ4TakeAdapter
    | typeof univ4SyncAdapter
    | typeof univ4SettleAdapter
    | typeof univ4SettleValueAdapter,
  canSendValue: boolean,
) {
  return bindFamilyOwnedAction({
    action,
    descriptor: {
      adapterId: action.id,
      lineage: "univ4",
      edgeKind: "swap",
      action: "swap",
      canSendValue,
      leavesStandingPositionDefault: false,
    },
  });
}
