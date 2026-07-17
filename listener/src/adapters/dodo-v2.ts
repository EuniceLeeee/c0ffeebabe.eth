import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function sellBase(address to) returns (uint256 receiveQuoteAmount)",
  "function sellQuote(address to) returns (uint256 receiveBaseAmount)",
]);

/** Direct DVM/DPP/DSP swap after the input token has been transferred to the pool. */
export const dodoV2ActionAdapter: ActionAdapter = {
  id: "dodo-v2-swap",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    if (typeof node.params.sellBase !== "boolean") {
      throw new Error("dodo-v2-swap requires boolean sellBase");
    }
    const functionName = node.params.sellBase ? "sellBase" : "sellQuote";
    return encodeCall(
      node.target,
      ethers.getBytes(iface.encodeFunctionData(functionName, [executor])),
    );
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0xbd6015b4" || selector === "0xdd93f59a";
  },
};
