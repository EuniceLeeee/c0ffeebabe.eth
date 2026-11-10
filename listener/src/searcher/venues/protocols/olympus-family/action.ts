import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import type { ActionAdapter } from "../../../../types.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { MAX_UINT256 } from "../standard-family/common.js";
import { OLYMPUS_INTERFACE, olympusQuote } from "./codec.js";

// `unstake` takes (recipient, gOHM amount, trigger, rebasing). The staking
// contract burns gOHM from msg.sender, so the action receives no allowance
// requirement. The quoted index is carried only to reproduce the verified
// output math in the encoded plan; it is not an amount input.
const olympusActionAdapter: ActionAdapter = {
  id: "olympus-unstake",
  isWrapper: false,
  field2Offset: null,
  encode(node, executor, inner) {
    const index = node.params.index;
    const quotedAmountOut = node.params.quotedAmountOut;
    if (
      typeof index !== "bigint" || index <= 0n ||
      typeof quotedAmountOut !== "bigint" || quotedAmountOut <= 0n ||
      node.amount <= 0n || node.amount > MAX_UINT256 ||
      inner.length !== 0 || node.children.length !== 0 ||
      olympusQuote(node.amount, index) !== quotedAmountOut
    ) {
      throw new Error("Olympus invalid unstake action");
    }
    return encodeCall(node.target, ethers.getBytes(
      OLYMPUS_INTERFACE.encodeFunctionData("unstake",
        [executor, node.amount, false, false]),
    ));
  },
  matchTrace(_target, selector) {
    return selector === OLYMPUS_INTERFACE.getFunction("unstake")!.selector;
  },
};

export const olympusFamilyOwnedAction = bindFamilyOwnedAction({
  action: olympusActionAdapter,
  descriptor: {
    adapterId: "olympus-unstake",
    lineage: "custom-protocol:olympus",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
