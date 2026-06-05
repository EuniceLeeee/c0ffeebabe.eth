import { ethers } from "ethers";
import { encodeSetField2, encodeCall, encodeClearState, concatBytes } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

/**
 * Balancer flash loan.
 * Callback: receiveFlashLoan(IERC20[] tokens, uint256[] amounts, uint256[] feeAmounts, bytes userData)
 * field2 = 260 + 96*n where n = number of tokens.
 * Single-token flash (most common): field2 = 356.
 */

const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

const iface = new ethers.Interface([
  "function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData)",
]);

function computeField2(tokenCount: number): number {
  return 260 + 96 * tokenCount;
}

export const balancerFlashAdapter: ActionAdapter = {
  id: "balancer-flash",
  isWrapper: true,
  field2Offset: (node: ResolvedPlanNode) => {
    const tokens = node.params.tokens as string[];
    return computeField2(tokens?.length ?? 1);
  },

  encode(node: ResolvedPlanNode, executor: string, innerScript: Uint8Array) {
    const tokens = node.params.tokens as string[] ?? [node.tokenIn];
    const amounts = node.params.amounts as bigint[] ?? [node.amount];
    const field2 = computeField2(tokens.length);

    const calldata = iface.encodeFunctionData("flashLoan", [
      executor, // recipient = our BotVM
      tokens,
      amounts,
      innerScript,
    ]);
    return concatBytes(
      encodeSetField2(field2),
      encodeCall(node.target, ethers.getBytes(calldata)),
      encodeClearState(),
    );
  },

  matchTrace(target: string, selector: string) {
    return (
      target.toLowerCase() === BALANCER_VAULT.toLowerCase() &&
      selector === "0x5c38449e"
    );
  },
};
