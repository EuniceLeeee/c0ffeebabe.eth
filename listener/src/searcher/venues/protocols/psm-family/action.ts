import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import type { ActionAdapter } from "../../../../types.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { PSM_INTERFACE, psmBuyQuote } from "./codec.js";

// Direction and gem units are issued by the Family, never guessed from a
// global token address. buyGem's argument is output gem, not input DAI.
const psmActionAdapter: ActionAdapter = {
  id: "psm", isWrapper: false, field2Offset: null,
  encode(node, executor, inner) {
    const { direction, gemAmount, fee, scale } = node.params;
    if ((direction !== "sell-gem" && direction !== "buy-gem") ||
      typeof gemAmount !== "bigint" || gemAmount <= 0n || typeof fee !== "bigint" ||
      typeof scale !== "bigint" || node.amount <= 0n || node.amount >= 1n << 256n ||
      inner.length !== 0 || node.children.length !== 0 ||
      (direction === "sell-gem" ? gemAmount !== node.amount :
        gemAmount !== psmBuyQuote(node.amount, fee, scale))) {
      throw new Error("PSM invalid directional action");
    }
    return encodeCall(node.target, ethers.getBytes(PSM_INTERFACE.encodeFunctionData(
      direction === "sell-gem" ? "sellGem" : "buyGem", [executor, gemAmount])));
  },
  matchTrace: (_target, selector) => ["sellGem", "buyGem"].some(fn =>
    PSM_INTERFACE.getFunction(fn)!.selector === selector),
};

export const psmFamilyOwnedAction = bindFamilyOwnedAction({
  action: psmActionAdapter,
  descriptor: {
    adapterId: "psm",
    lineage: "psm",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
