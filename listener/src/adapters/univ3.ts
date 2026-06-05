import { ethers } from "ethers";
import {
  encodeSetField2,
  encodeCall,
  encodeClearState,
  concatBytes,
} from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

/**
 * UniV3 swap callback: uniswapV3SwapCallback(int256, int256, bytes)
 * field2 = 4(sel) + 32(int256) + 32(int256) + 32(bytes offset) + 32(bytes length) = 132
 */
const FIELD2 = 132;

const iface = new ethers.Interface([
  "function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data)",
]);

export const univ3Adapter: ActionAdapter = {
  id: "univ3-swap",
  isWrapper: true,
  field2Offset: FIELD2,

  encode(node: ResolvedPlanNode, executor: string, innerScript: Uint8Array) {
    const zeroForOne = node.params.zeroForOne as boolean;
    const amountSpecified = node.params.amountSpecified as bigint;
    const sqrtPriceLimit = node.params.sqrtPriceLimit as bigint;
    // innerScript = callback sub-script (executed when V3 calls back BotVM)
    const calldata = iface.encodeFunctionData("swap", [
      executor, // receiver rewrite
      zeroForOne,
      amountSpecified,
      sqrtPriceLimit,
      innerScript,
    ]);
    return concatBytes(
      encodeSetField2(FIELD2),
      encodeCall(node.target, ethers.getBytes(calldata)),
      encodeClearState(),
    );
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x128acb08"; // swap(address,bool,int256,uint160,bytes)
  },
};
