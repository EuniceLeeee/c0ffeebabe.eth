import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function sellGem(address usr, uint256 gemAmt)",
]);

export const psmAdapter: ActionAdapter = {
  id: "psm",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    // receiver rewrite: usr = executor
    const calldata = iface.encodeFunctionData("sellGem", [
      executor,
      node.amount,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    // sellGem(address,uint256)
    return selector === "0x95991276";
  },
};
