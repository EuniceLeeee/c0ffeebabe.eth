import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function transfer(address to,uint256 amount) returns (bool)",
]);

/**
 * Family-owned low-level action: transfer the input token to itself. Native
 * payout and the following WETH wrap remain separate plan nodes.
 */
export const selfBurnNativeRedeemActionAdapter: ActionAdapter = {
  id: "self-burn-native-redeem",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode) {
    const calldata = iface.encodeFunctionData("transfer", [
      node.target,
      node.amount,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(target: string, selector: string) {
    return target.length > 0 && selector.toLowerCase() === "0xa9059cbb";
  },
};
