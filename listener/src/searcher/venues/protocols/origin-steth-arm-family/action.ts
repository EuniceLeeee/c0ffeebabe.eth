import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import type { ActionAdapter } from "../../../../types.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import {
  ORIGIN_STETH_ARM_INTERFACE,
  ORIGIN_STETH_ARM_STETH,
  ORIGIN_STETH_ARM_SWAP_SELECTOR,
  ORIGIN_STETH_ARM_WETH,
} from "./codec.js";
import { ORIGIN_STETH_ARM_ACTION_ID } from "./manifest.js";

/**
 * Family-owned action for the verified ARM swap. The plan supplies the exact
 * input amount and the minimum output floor; the callee is the verified ARM
 * proxy and the output goes to the executor (msg.sender is the payer).
 */
const originStethArmSwapActionAdapter: ActionAdapter = {
  id: ORIGIN_STETH_ARM_ACTION_ID,
  isWrapper: false,
  field2Offset: null,
  encode(node, executor, inner) {
    const minAmountOut = node.params.minAmountOut;
    if (
      inner.length !== 0 ||
      node.children.length !== 0 ||
      node.amount <= 0n ||
      node.amount > (1n << 256n) - 1n ||
      typeof minAmountOut !== "bigint" ||
      minAmountOut < 0n ||
      minAmountOut > (1n << 256n) - 1n
    ) {
      throw new Error("Origin stETH ARM invalid swap action");
    }
    const tokenIn = ethers.getAddress(node.tokenIn);
    const tokenOut = ethers.getAddress(node.tokenOut);
    const forward = tokenIn === ethers.getAddress(ORIGIN_STETH_ARM_STETH) &&
      tokenOut === ethers.getAddress(ORIGIN_STETH_ARM_WETH);
    const reverse = tokenIn === ethers.getAddress(ORIGIN_STETH_ARM_WETH) &&
      tokenOut === ethers.getAddress(ORIGIN_STETH_ARM_STETH);
    if (!forward && !reverse) {
      throw new Error("Origin stETH ARM swap tokens are not stETH/WETH");
    }
    const caller = ethers.getAddress(executor);
    if (caller === ethers.ZeroAddress) {
      throw new Error("Origin stETH ARM swap executor is the zero address");
    }
    return encodeCall(node.target, ethers.getBytes(
      ORIGIN_STETH_ARM_INTERFACE.encodeFunctionData(
        "swapExactTokensForTokens",
        [tokenIn, tokenOut, node.amount, minAmountOut, caller],
      ),
    ));
  },
  matchTrace: (_target, selector) =>
    selector === ORIGIN_STETH_ARM_SWAP_SELECTOR,
};

export const originStethArmFamilyOwnedAction = bindFamilyOwnedAction({
  action: originStethArmSwapActionAdapter,
  descriptor: {
    adapterId: ORIGIN_STETH_ARM_ACTION_ID,
    lineage: "custom-protocol:origin-steth-arm",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
