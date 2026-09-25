import { getBytes } from "ethers";
import { concatBytes, encodeCall } from "../../../../encoder.js";
import { erc20ApproveAdapter } from "../../../../adapters/erc20.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ABI, nonzero, positiveAmount } from "./variants.js";
import { XWIN_ABI, xwinCalldata } from "./xwin.js";
import type { Direction } from "./types.js";

function createAction(direction: Direction) {
  const id = `token-conversion-${direction}`;
  return bindFamilyOwnedAction({
    action: {
      id, isWrapper: false, field2Offset: null,
      encode(node, executor, inner) {
        nonzero(executor); nonzero(node.target); nonzero(node.tokenIn); nonzero(node.tokenOut); positiveAmount(node.amount);
        if (node.adapterId !== id || node.children.length || inner.length || !["btb-bear-v1", "xwin-allocations-v1"].includes(String(node.params.variant)) ||
            Object.keys(node.params).length !== 1 || node.tokenIn.toLowerCase() === node.tokenOut.toLowerCase() ||
            (direction === "mint" ? node.tokenOut : node.tokenIn).toLowerCase() !== node.target.toLowerCase()) throw new Error("invalid conversion action");
        const call = encodeCall(node.target, getBytes(node.params.variant === "btb-bear-v1" ? ABI.encodeFunctionData(direction, [node.amount]) : xwinCalldata(direction, node.amount)));
        if (direction === "redeem") return call;
        const approve = (amount: bigint) => erc20ApproveAdapter.encode({ adapterId: "erc20-approve", target: node.tokenIn,
          tokenIn: node.tokenIn, tokenOut: node.tokenIn, amount, params: { spender: node.target, amount }, children: [] }, executor, new Uint8Array());
        return concatBytes(approve(0n), approve(node.amount), call, approve(0n));
      },
      // A trace match nominates a call only; runtime/immutable identity is still required.
      matchTrace: (_target, selector) => selector === ABI.getFunction(direction)!.selector ||
        selector === XWIN_ABI.getFunction(direction === "mint" ? "deposit" : "withdraw")!.selector,
    },
    descriptor: { adapterId: id, lineage: "custom-protocol:token-conversion", edgeKind: "protocol", action: direction === "mint" ? "wrap" : "redeem",
      canSendValue: false, leavesStandingPositionDefault: false },
  });
}
export const mintAction = createAction("mint");
export const redeemAction = createAction("redeem");
