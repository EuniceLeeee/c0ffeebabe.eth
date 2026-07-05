import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import { ADDR } from "../shared/constants/addresses.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function sellGem(address usr, uint256 gemAmt)",
  "function buyGem(address usr, uint256 gemAmt)",
]);
const BUY_GEM_SELECTOR = ethers.id("buyGem(address,uint256)").slice(0, 10);

export const psmAdapter: ActionAdapter = {
  id: "psm",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    // receiver rewrite: usr = executor
    const tokenIn = node.tokenIn.toLowerCase();
    const tokenOut = node.tokenOut.toLowerCase();
    const usdc = ADDR.USDC.toLowerCase();
    const fn = tokenIn === usdc ? "sellGem" : tokenOut === usdc ? "buyGem" : null;
    if (fn === null) {
      throw new Error("PSM node must have USDC on one side");
    }

    const calldata = iface.encodeFunctionData(fn, [
      executor,
      node.amount,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    // sellGem(address,uint256) or buyGem(address,uint256)
    return selector === "0x95991276" || selector === BUY_GEM_SELECTOR;
  },
};
