import { GENERIC_CALLS } from "./generic.js";
import { encodeRuntimeAmountNode } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ABI, FUNCTIONS, address, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
import { NG_CALLS } from "./ng.js";
export const action = bindFamilyOwnedAction({ action: { id: ACTION, isWrapper: false, field2Offset: null,
  encode(node, executor, inner) { if (node.adapterId !== ACTION || !uint(node.amount) || Object.keys(node.params).length !== 1 ||
      node.tokenIn.toLowerCase() === node.tokenOut.toLowerCase() || [node.target, node.tokenIn, node.tokenOut].map(address).includes(address(executor))) throw new Error("curve-lp invalid action");
    const result = encodeRuntimeAmountNode(node, inner); if (!result) throw new Error("curve-lp missing program"); return result; },
  matchTrace: (_target, selector) => [...FUNCTIONS.map(fn => ABI.getFunction(fn)!.selector), ...NG_CALLS.map(v => v.abi.getFunction(v.fn)!.selector), ...GENERIC_CALLS.map(v => v.abi.getFunction(v.fn)!.selector)].includes(selector) },
  descriptor: { adapterId: ACTION, lineage: "custom-protocol:curve-lp", edgeKind: "protocol", action: "convert", canSendValue: true, leavesStandingPositionDefault: false },
});
