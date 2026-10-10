import { encodeRuntimeAmountNode } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ABI, address, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
export const action = bindFamilyOwnedAction({ action: { id: ACTION, isWrapper: false, field2Offset: null,
  encode(node, executor, inner) {
    if (node.adapterId !== ACTION || !uint(node.amount) || new Set([executor, node.target, node.tokenIn, node.tokenOut].map(address)).size !== 4 ||
        Object.keys(node.params).length !== 1) throw new Error("PSV invalid action");
    const encoded = encodeRuntimeAmountNode(node, inner); if (!encoded) throw new Error("PSV missing amount program"); return encoded;
  }, matchTrace: (_target, selector) => ["sellGem", "buyGem"].some(fn => selector === ABI.getFunction(fn)!.selector) },
  descriptor: { adapterId: ACTION, lineage: "custom-protocol:psv", edgeKind: "protocol", action: "convert", canSendValue: false, leavesStandingPositionDefault: false },
});
