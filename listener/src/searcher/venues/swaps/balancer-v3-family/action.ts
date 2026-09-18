import { ethers } from "ethers";
import { erc20ApproveAdapter } from "../../../../adapters/erc20.js";
import { concatBytes, encodeCall } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ROUTER, ROUTER_ABI, PERMIT2, PERMIT2_ABI, MAX_INPUT, MAX_UINT, MAX_EXPIRATION, nonzero, same } from "./codec.js";

export const ROUTER_ACTION = "balancer-v3-router-swap";

// The deployed Router owns unlock -> swap -> Permit2 transfer/settle -> sendTo.
// It passes Vault.swap's actual returned amountOut to sendTo, not a stale quote.
// BotVM CALL discards return data, so direct unlock + fixed sendTo cannot do this.
export const balancerV3RouterAction = bindFamilyOwnedAction({
  action: {
    id: ROUTER_ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      nonzero(executor); nonzero(node.tokenIn); nonzero(node.tokenOut);
      if (node.adapterId !== ROUTER_ACTION || !same(node.target, ROUTER) ||
          same(node.tokenIn, node.tokenOut) || typeof node.amount !== "bigint" || node.amount <= 0n || node.amount > MAX_INPUT ||
          inner.length !== 0 || node.children.length !== 0 || typeof node.params.pool !== "string" ||
          typeof node.params.minAmountOut !== "bigint" || node.params.minAmountOut < 0n || node.params.minAmountOut > MAX_UINT) {
        throw new Error("balancer-v3 invalid Router swap action");
      }
      nonzero(node.params.pool);
      const approve = (amount: bigint) => erc20ApproveAdapter.encode({ adapterId: "erc20-approve", target: node.tokenIn,
        tokenIn: node.tokenIn, tokenOut: node.tokenIn, amount, params: { spender: PERMIT2, amount }, children: [] }, executor, new Uint8Array());
      const permit = (amount: bigint) => encodeCall(PERMIT2, ethers.getBytes(PERMIT2_ABI.encodeFunctionData("approve",
        [node.tokenIn, ROUTER, amount, amount === 0n ? 0n : MAX_EXPIRATION])));
      return concatBytes(
        approve(0n), approve(node.amount), permit(node.amount),
        encodeCall(ROUTER, ethers.getBytes(ROUTER_ABI.encodeFunctionData("swapSingleTokenExactIn",
          [node.params.pool, node.tokenIn, node.tokenOut, node.amount, node.params.minAmountOut, MAX_UINT, false, "0x"]))),
        // Clear both approvals even for tokens/Permit2's max-allowance sentinel
        // that do not decrement allowance during transferFrom. No standing grant.
        permit(0n), approve(0n),
      );
    },
    matchTrace: (target, selector) => same(target, ROUTER) && selector === ROUTER_ABI.getFunction("swapSingleTokenExactIn")!.selector,
  },
  descriptor: { adapterId: ROUTER_ACTION, lineage: "balancer-v3", edgeKind: "swap", action: "swap",
    canSendValue: false, leavesStandingPositionDefault: false },
});
