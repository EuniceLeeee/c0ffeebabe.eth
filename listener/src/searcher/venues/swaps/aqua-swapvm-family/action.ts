import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ABI, amount, address } from "./codec.js";
import { swapProgram } from "./runtime.js";
import { ACTION } from "./manifest.js";
import type { Binding } from "./types.js";
export const action = bindFamilyOwnedAction({ action: { id: ACTION, isWrapper: false, field2Offset: null,
  encode(n, executor, inner) {
    amount(n.amount); amount(n.params.minAmountOut as bigint, true);
    if (typeof n.params.binding !== "string" || (n.params.i !== 0n && n.params.i !== 1n)) throw new Error("aqua invalid binding");
    const b = JSON.parse(n.params.binding) as Binding, i = Number(n.params.i);
    if (n.adapterId !== ACTION || n.children.length || inner.length || Object.keys(n.params).sort().join() !== "binding,i,minAmountOut" ||
        (i !== 0 && i !== 1) || address(n.target) !== b.router || address(n.tokenIn) !== b.tokens[i] || address(n.tokenOut) !== b.tokens[1-i])
      throw new Error("aqua invalid action");
    return runtimeProgramScript(swapProgram(b, i, executor, n.params.minAmountOut as bigint).bytes(), n.amount);
  }, matchTrace: (_target, selector) => selector.toLowerCase() === ABI.getFunction("swap")!.selector,
}, descriptor: { adapterId: ACTION, lineage: "custom-swap:aqua-swapvm", edgeKind: "swap", action: "swap",
  canSendValue: false, leavesStandingPositionDefault: false } });
