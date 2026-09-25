import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { MOONISWAP_ACTION, POOL, assertUint, lower, nonzero, swapData } from "./codec.js";

// This action only encodes the ERC20/ERC20 variant. Net token receipt remains
// independently measured by execution acceptance and mandatory final simulation.
export const mooniswapAction = bindFamilyOwnedAction({
  action: {
    id: MOONISWAP_ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      nonzero(node.target); nonzero(executor); assertUint(node.amount, true);
      if (node.adapterId !== MOONISWAP_ACTION || lower(node.target) === lower(executor) || node.children.length || inner.length ||
          typeof node.params.minAmountOut !== "bigint") throw new Error("mooniswap invalid swap action");
      const data = swapData(node.tokenIn, node.tokenOut, node.amount, node.params.minAmountOut, executor);
      return encodeCall(node.target, ethers.getBytes(data));
    },
    matchTrace: (_target, selector) => selector.toLowerCase() === POOL.getFunction("swapFor")!.selector,
  },
  descriptor: { adapterId: MOONISWAP_ACTION, lineage: "custom-swap:mooniswap", edgeKind: "swap", action: "swap",
    canSendValue: false, leavesStandingPositionDefault: false },
});
