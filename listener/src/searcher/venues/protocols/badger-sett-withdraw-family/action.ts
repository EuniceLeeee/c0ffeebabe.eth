import { encodeRuntimeAmountNode } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { address, uint, VAULT } from "./codec.js";
import { ACTION } from "./manifest.js";
export const action = bindFamilyOwnedAction({
  action: { id: ACTION, isWrapper: false, field2Offset: null,
    encode(node, executor, inner) {
      const actor = address(executor), target = address(node.target), asset = address(node.tokenOut);
      if (node.adapterId !== ACTION || address(node.tokenIn) !== target || !uint(node.amount) ||
          new Set([actor, target, asset]).size !== 3 || Object.keys(node.params).length !== 1)
        throw new Error("badger-sett invalid action");
      const encoded = encodeRuntimeAmountNode(node, inner);
      if (!encoded) throw new Error("badger-sett missing fixed-amount withdrawal program");
      return encoded;
    },
    matchTrace: (_target, selector) => selector === VAULT.getFunction("withdraw")!.selector },
  descriptor: { adapterId: ACTION, lineage: "custom-protocol:badger-sett-withdraw", edgeKind: "protocol",
    action: "redeem", canSendValue: false, leavesStandingPositionDefault: false },
});
