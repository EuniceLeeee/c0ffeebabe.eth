import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ABI, amount } from "./codec.js";
import { swapProgram } from "./runtime.js";
import { ACTION } from "./manifest.js";
export const action = bindFamilyOwnedAction({ action: { id: ACTION, isWrapper: false, field2Offset: null,
  encode(n, executor, inner) {
    amount(n.amount); amount(n.params.minAmountOut as bigint, true);
    if (n.adapterId !== ACTION || n.children.length || inner.length || Object.keys(n.params).length !== 1) throw new Error("vault-spot invalid action");
    return runtimeProgramScript(swapProgram(n.target, n.tokenIn, n.tokenOut, executor, n.params.minAmountOut as bigint).bytes(), n.amount);
  },
  matchTrace: (_target, selector) => selector.toLowerCase() === ABI.getFunction("swap")!.selector,
}, descriptor: { adapterId: ACTION, lineage: "custom-swap:vault-spot", edgeKind: "swap", action: "swap",
  canSendValue: false, leavesStandingPositionDefault: false } });
