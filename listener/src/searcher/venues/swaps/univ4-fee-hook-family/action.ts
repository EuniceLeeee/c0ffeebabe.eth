import {
  univ4SettleAdapter,
  univ4SettleValueAdapter,
  univ4SwapAdapter,
  univ4SyncAdapter,
  univ4TakeAdapter,
  univ4UnlockAdapter,
} from "../../../../adapters/univ4.js";
import type { ActionAdapter } from "../../../../types.js";
import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import { hookDataFor, sat1Permissions } from "./sat1.js";
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
  { ...clonedAdapter(univ4SwapAdapter, "univ4-fee-hook-swap"),
    encode(node, executor, inner) {
      if (node.params.hookData === undefined || node.params.hookData === "0x") {
        if (sat1Permissions(String(node.params.hooks))) throw new Error("sat1 swap requires actor binding");
        return univ4SwapAdapter.encode(node, executor, inner);
      }
      if (!sat1Permissions(String(node.params.hooks)) ||
        typeof node.params.zeroForOne !== "boolean" ||
        node.params.hookData !== hookDataFor({ hookModel: "sat1", hook: String(node.params.hooks) }, executor, node.params.zeroForOne) ||
        node.params.amountSpecified !== -node.amount || node.amount <= 0n || node.children.length !== 0) {
        throw new Error("sat1 swap actor or amount mismatch");
      }
      const iface = new ethers.Interface([
        "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96),bytes)",
      ]);
      return encodeCall(node.target, ethers.getBytes(iface.encodeFunctionData("swap", [
        [node.params.currency0, node.params.currency1, node.params.fee, node.params.tickSpacing, node.params.hooks],
        [node.params.zeroForOne, node.params.amountSpecified, node.params.sqrtPriceLimit], node.params.hookData,
      ])));
    },
  },
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
