import { getBytes } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { address, MODULE, uint } from "./codec.js";
import { ACTION } from "./manifest.js";
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
