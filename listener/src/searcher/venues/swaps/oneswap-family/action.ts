import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { checked, LIMIT112, lower, normalizedToken, POOL } from "./codec.js";
import { ACTION } from "./manifest.js";
import { executionProgram } from "./runtime-execution.js";
export const action = bindFamilyOwnedAction({
  action: { id: ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      const p = node.params;
      checked(node.amount, LIMIT112);
      if (node.adapterId !== ACTION || !node.amount || inner.length || node.children.length || typeof p.rawIn !== "string" || typeof p.rawOut !== "string" ||
          typeof p.factory !== "string" || typeof p.implementation !== "string" || typeof p.executor !== "string" || lower(p.executor) !== lower(executor) ||
          typeof p.minimum !== "bigint" || p.minimum <= 0n || normalizedToken(p.rawIn) !== lower(node.tokenIn) || normalizedToken(p.rawOut) !== lower(node.tokenOut))
        throw new Error("oneswap invalid action");
      return runtimeProgramScript(executionProgram({ pool: node.target, rawIn: p.rawIn, rawOut: p.rawOut,
        factory: p.factory, implementation: p.implementation, executor, minimum: p.minimum }), node.amount);
    },
    matchTrace: (_target, selector) => selector.toLowerCase() === POOL.getFunction("addMarketOrder")!.selector,
  },
  descriptor: { adapterId: ACTION, lineage: "custom-swap:oneswap", edgeKind: "swap", action: "swap", canSendValue: true, leavesStandingPositionDefault: false },
});
