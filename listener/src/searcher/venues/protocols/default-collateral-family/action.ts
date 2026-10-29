import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import type { ActionAdapter } from "../../../../types.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import {
  canonicalAddress,
  sameAddress,
} from "../standard-family/common.js";
import {
  DEFAULT_COLLATERAL_ASSET,
  DEFAULT_COLLATERAL_INTERFACE,
  DEFAULT_COLLATERAL_WITHDRAW_SELECTOR,
  defaultCollateralUint,
} from "./codec.js";
import { DEFAULT_COLLATERAL_ACTION_ID } from "./manifest.js";

/**
 * Family-owned action for the verified share-vault redeem. The plan supplies
 * the share amount; the callee is the verified vault and the payout recipient
 * is the executor, whose shares `withdraw` burns. `minAmountOut` is validated
 * against the proven 1:1 conversion but has no calldata field (the verified
 * ABI exposes no minimum argument).
 */
const defaultCollateralWithdrawAction: ActionAdapter = {
  id: DEFAULT_COLLATERAL_ACTION_ID,
  isWrapper: false,
  field2Offset: null,
  encode(node, executor, inner) {
    const minimum = node.params.minAmountOut;
    const amount = defaultCollateralUint(node.amount);
    if (
      inner.length !== 0 ||
      node.children.length !== 0 ||
      node.adapterId !== DEFAULT_COLLATERAL_ACTION_ID ||
      amount === 0n ||
      typeof minimum !== "bigint" ||
      minimum < 0n ||
      minimum > amount ||
      !sameAddress(node.tokenIn, node.target) ||
      !sameAddress(node.tokenOut, DEFAULT_COLLATERAL_ASSET)
    ) {
      throw new Error("default-collateral invalid withdraw action");
    }
    const actor = ethers.getAddress(executor);
    if (actor === ethers.ZeroAddress) {
      throw new Error("default-collateral executor is the zero address");
    }
    return encodeCall(
      canonicalAddress(node.target),
      ethers.getBytes(DEFAULT_COLLATERAL_INTERFACE.encodeFunctionData(
        "withdraw",
        [actor, amount],
      )),
    );
  },
  matchTrace: (_target, selector) =>
    selector === DEFAULT_COLLATERAL_WITHDRAW_SELECTOR,
};

export const defaultCollateralFamilyOwnedAction = bindFamilyOwnedAction({
  action: defaultCollateralWithdrawAction,
  descriptor: {
    adapterId: DEFAULT_COLLATERAL_ACTION_ID,
    lineage: "custom-protocol:default-collateral",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
