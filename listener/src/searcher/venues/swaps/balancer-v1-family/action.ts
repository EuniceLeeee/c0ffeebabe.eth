import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { checked, nonzero, POOL } from "./codec.js";
import { ACTION } from "./manifest.js";
import { swapProgram } from "./runtime.js";
export const action = bindFamilyOwnedAction({
  action: { id: ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      const pool = nonzero(node.target), tokenIn = nonzero(node.tokenIn), tokenOut = nonzero(node.tokenOut), actor = nonzero(executor);
      checked(node.amount);
      if (node.adapterId !== ACTION || node.amount <= 0n || tokenIn === tokenOut || tokenIn === pool || tokenOut === pool ||
          inner.length || node.children.length || typeof node.params.minAmountOut !== "bigint" || checked(node.params.minAmountOut) === 0n ||
          typeof node.params.executor !== "string" || nonzero(node.params.executor) !== actor) throw new Error("balancer-v1 invalid swap action");
      return runtimeProgramScript(swapProgram(pool, tokenIn, tokenOut, actor, node.params.minAmountOut).bytes(), node.amount);
    },
    matchTrace: (_target, selector) => selector.toLowerCase() === POOL.getFunction("swapExactAmountIn")!.selector,
  },
  descriptor: { adapterId: ACTION, lineage: "custom-swap:balancer-v1", edgeKind: "swap", action: "swap",
    canSendValue: false, leavesStandingPositionDefault: false },
});
