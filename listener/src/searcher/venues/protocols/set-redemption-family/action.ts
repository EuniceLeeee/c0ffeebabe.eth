import { getBytes } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { encodeRuntimeAmountNode } from "../../../../adapters/runtime-amount-program.js";
import { address, MODULE, uint } from "./codec.js";
import { ACTION, LEGACY_ACTION } from "./manifest.js";
import { CORE } from "./legacy.js";
export const action = bindFamilyOwnedAction({ action: { id: ACTION, isWrapper: false, field2Offset: null,
  encode(node, executor, inner) {
    const set = address(node.tokenIn), module = address(node.target), recipient = address(executor); address(node.tokenOut); uint(node.amount);
    if (node.adapterId !== ACTION || !node.amount || node.children.length || inner.length || Object.keys(node.params).length ||
      new Set([set, module, recipient, address(node.tokenOut)]).size !== 4) throw new Error("set-redemption invalid action");
    // redeem burns caller's Set directly; no allowance or component routing.
    return encodeCall(module, getBytes(MODULE.encodeFunctionData("redeem", [set, node.amount, recipient])));
  }, matchTrace: (_target, selector) => selector === MODULE.getFunction("redeem")!.selector },
  descriptor: { adapterId: ACTION, lineage: "custom-protocol:set-redemption", edgeKind: "protocol", action: "redeem", canSendValue: false, leavesStandingPositionDefault: false },
});
export const legacyAction = bindFamilyOwnedAction({ action: { id: LEGACY_ACTION, isWrapper: false, field2Offset: null,
  encode(node, executor, inner) {
    const addresses = [node.tokenIn, node.tokenOut, node.target, executor].map(address);
    if (node.adapterId !== LEGACY_ACTION || new Set(addresses).size !== 4 ||
        Object.keys(node.params).length !== 1 || typeof node.params.runtimeAmountProgram !== "string") throw new Error("set-legacy invalid action");
    const result = encodeRuntimeAmountNode(node, inner);
    if (!result) throw new Error("set-legacy quoted runtime program required");
    return result;
  }, matchTrace: (_target, selector) => selector === CORE.getFunction("redeemAndWithdrawTo")!.selector },
  descriptor: { adapterId: LEGACY_ACTION, lineage: "custom-protocol:set-redemption:legacy-core", edgeKind: "protocol", action: "redeem", canSendValue: false, leavesStandingPositionDefault: false },
});
