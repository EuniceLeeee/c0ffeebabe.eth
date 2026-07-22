import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter } from "../types.js";

const depositIface = new ethers.Interface([
  "function depositAsset(address asset,uint256 depositAmount,uint256 minRec,address referral)",
]);
const selector = depositIface.getFunction("depositAsset")!.selector;

/** Low-level BotVM encoder for Eigenpie's depositAsset execution surface. */
export const eigenpieDepositActionAdapter: ActionAdapter = {
  id: "eigenpie-deposit-asset",
  isWrapper: false,
  field2Offset: null,

  encode(node, _executor, _innerScript) {
    const minAmountOut = node.params.minAmountOut;
    if (typeof minAmountOut !== "bigint" || minAmountOut < 0n) {
      throw new Error("Eigenpie deposit requires bigint minAmountOut");
    }
    const calldata = depositIface.encodeFunctionData("depositAsset", [
      node.tokenIn,
      node.amount,
      minAmountOut,
      ethers.ZeroAddress,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target, callSelector) {
    return callSelector.toLowerCase() === selector.toLowerCase();
  },
};
