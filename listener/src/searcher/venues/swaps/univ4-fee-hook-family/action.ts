import {
  univ4SettleAdapter,
  univ4SettleValueAdapter,
  univ4SwapAdapter,
  univ4SyncAdapter,
  univ4TakeAdapter,
  univ4UnlockAdapter,
} from "../../../../adapters/univ4.js";
import type { ActionAdapter } from "../../../../types.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";

/**
 * The fee-hook Family reuses the standard V4 execution encoders (same
 * manager, same unlock/swap/take/settle order) under family-owned adapter
 * ids. The raw adapters are cloned because an ActionAdapter can be bound to
 * exactly one Family; the embedded descriptor is cleared so the binding
 * re-derives it with the fee-hook lineage.
 */
function clonedAdapter(
  action: ActionAdapter,
  id: string,
): ActionAdapter {
  return Object.freeze({
    id,
    isWrapper: action.isWrapper,
    field2Offset: action.field2Offset,
    encode: action.encode,
    matchTrace: action.matchTrace,
  });
}

function owned(
  action: ActionAdapter,
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

export const univ4FeeHookUnlockFamilyOwnedAction = owned(
  clonedAdapter(univ4UnlockAdapter, "univ4-fee-hook-unlock"),
  false,
);
export const univ4FeeHookSwapFamilyOwnedAction = owned(
  clonedAdapter(univ4SwapAdapter, "univ4-fee-hook-swap"),
  false,
);
export const univ4FeeHookTakeFamilyOwnedAction = owned(
  clonedAdapter(univ4TakeAdapter, "univ4-fee-hook-take"),
  false,
);
export const univ4FeeHookSyncFamilyOwnedAction = owned(
  clonedAdapter(univ4SyncAdapter, "univ4-fee-hook-sync"),
  false,
);
export const univ4FeeHookSettleFamilyOwnedAction = owned(
  clonedAdapter(univ4SettleAdapter, "univ4-fee-hook-settle"),
  false,
);
export const univ4FeeHookSettleValueFamilyOwnedAction = owned(
  clonedAdapter(univ4SettleValueAdapter, "univ4-fee-hook-settle-value"),
  true,
);

export const univ4FeeHookFamilyOwnedActions = Object.freeze([
  univ4FeeHookUnlockFamilyOwnedAction,
  univ4FeeHookSwapFamilyOwnedAction,
  univ4FeeHookTakeFamilyOwnedAction,
  univ4FeeHookSyncFamilyOwnedAction,
  univ4FeeHookSettleFamilyOwnedAction,
  univ4FeeHookSettleValueFamilyOwnedAction,
]);
