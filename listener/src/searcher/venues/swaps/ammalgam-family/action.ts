import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { SWAP_SELECTOR, address, amount } from "./codec.js";
import { ACTION } from "./manifest.js";
import { swapProgram } from "./runtime.js";

export const action = bindFamilyOwnedAction({
  action: {
    id: ACTION,
    isWrapper: false,
    field2Offset: null,
    encode(node, executor, inner) {
      const params = node.params;
      amount(node.amount);
      if (node.adapterId !== ACTION || node.children.length !== 0 || inner.length !== 0 ||
          typeof params.minimum !== "bigint" || params.minimum <= 0n ||
          typeof params.xForY !== "boolean" ||
          typeof params.tokenX !== "string" || typeof params.tokenY !== "string") {
        throw new Error("ammalgam invalid action");
      }
      const tokenX = address(params.tokenX), tokenY = address(params.tokenY);
      if (tokenX === tokenY ||
          address(node.tokenIn) !== (params.xForY ? tokenX : tokenY) ||
          address(node.tokenOut) !== (params.xForY ? tokenY : tokenX)) {
        throw new Error("ammalgam action direction mismatch");
      }
      return runtimeProgramScript(swapProgram({
        pair: node.target,
        tokenX,
        tokenY,
        xForY: params.xForY,
        executor,
        recipient: executor,
        minimum: params.minimum,
      }).bytes(), node.amount);
    },
    matchTrace: (_target, selector) => selector.toLowerCase() === SWAP_SELECTOR,
  },
  descriptor: {
    adapterId: ACTION,
    lineage: "custom-swap:ammalgam",
    edgeKind: "swap",
    action: "swap",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
