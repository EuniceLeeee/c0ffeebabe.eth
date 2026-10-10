import { encodeRuntimeAmountNode } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ABI, TAKES, address, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
export const action = bindFamilyOwnedAction({ action: { id: ACTION, isWrapper: false, field2Offset: null,
  encode(node, executor, inner) {
    if (node.adapterId !== ACTION || !uint(node.amount) || new Set([executor, node.target, node.tokenIn, node.tokenOut].map(address)).size !== 4 ||
        Object.keys(node.params).length !== 1) throw new Error("Yearn auction invalid action");
    const result = encodeRuntimeAmountNode(node, inner); if (!result) throw new Error("Yearn auction missing program"); return result;
  }, matchTrace: (_target, selector) => TAKES.some(fn => selector === ABI.getFunction(fn)!.selector) },
  descriptor: { adapterId: ACTION, lineage: "custom-protocol:yearn-auction", edgeKind: "protocol", action: "convert", canSendValue: false, leavesStandingPositionDefault: false },
});
