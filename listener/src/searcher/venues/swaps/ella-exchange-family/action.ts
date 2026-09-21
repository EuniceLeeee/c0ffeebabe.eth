import { ethers } from "ethers";
import { encodeCall, encodeCallValue } from "../../../../encoder.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { MAX_UINT, POOL } from "./codec.js";

function action(buy: boolean) {
  const id = buy ? "ella-buy-token" : "ella-sell-token", name = buy ? "swapBase1" : "swap1";
  return bindFamilyOwnedAction({ action: { id, isWrapper: false, field2Offset: null,
    encode(node, _executor, inner) {
      if (node.amount <= 0n || node.amount > MAX_UINT || node.children.length || inner.length || Object.keys(node.params).length) {
        throw new Error("ella invalid swap action");
      }
      const data = ethers.getBytes(POOL.encodeFunctionData(name, buy ? [] : [node.amount]));
      return buy ? encodeCallValue(node.target, node.amount, data) : encodeCall(node.target, data);
    },
    matchTrace: (_target, selector) => selector.toLowerCase() === POOL.getFunction(name)!.selector,
  }, descriptor: { adapterId: id, lineage: "custom-swap:ella-exchange", edgeKind: "swap", action: "swap",
    canSendValue: buy, leavesStandingPositionDefault: false } });
}
export const ellaBuyAction = action(true), ellaSellAction = action(false);
