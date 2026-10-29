import { ethers } from "ethers";
import { encodeCall } from "../../../../encoder.js";
import type { ActionAdapter } from "../../../../types.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { ORIGIN_OUSD_VAULT_INTERFACE } from "./codec.js";

/**
 * Family-owned action for the vault mint. The only authority the plan supplies
 * is the input amount; the callee is the verified vault proxy and the mint
 * credits the executor (msg.sender), exactly like the observed sample tx.
 */
const originOusdMintActionAdapter: ActionAdapter = {
  id: "origin-ousd-mint",
  isWrapper: false,
  field2Offset: null,
  encode(node, executor, inner) {
    if (
      inner.length !== 0 ||
      node.children.length !== 0 ||
      node.amount <= 0n ||
      node.amount >= 1n << 256n
    ) {
      throw new Error("Origin OUSD invalid mint action");
    }
    const caller = ethers.getAddress(executor);
    if (caller === ethers.ZeroAddress) {
      throw new Error("Origin OUSD mint executor is the zero address");
    }
    return encodeCall(node.target, ethers.getBytes(
      ORIGIN_OUSD_VAULT_INTERFACE.encodeFunctionData("mint", [node.amount]),
    ));
  },
  matchTrace: (_target, selector) =>
    ORIGIN_OUSD_VAULT_INTERFACE.getFunction("mint")!.selector === selector,
};

export const originOusdFamilyOwnedAction = bindFamilyOwnedAction({
  action: originOusdMintActionAdapter,
  descriptor: {
    adapterId: "origin-ousd-mint",
    lineage: "custom-protocol:origin-ousd",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  },
});
