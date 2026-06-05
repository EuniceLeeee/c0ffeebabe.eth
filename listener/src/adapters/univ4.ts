import { ethers } from "ethers";
import {
  encodeSetField2,
  encodeCall,
  encodeClearState,
  encodeReturn,
  concatBytes,
} from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

/**
 * UniV4 unlockCallback: unlockCallback(bytes)
 * field2 = 4(sel) + 32(bytes offset) + 32(bytes length) = 68
 */
const V4_UNLOCK_FIELD2 = 68;

const unlockIface = new ethers.Interface([
  "function unlock(bytes data)",
]);

const swapIface = new ethers.Interface([
  "function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData)",
]);

const takeIface = new ethers.Interface([
  "function take(address token, address to, uint256 amount)",
]);

const settleIface = new ethers.Interface([
  "function settle()",
]);

const syncIface = new ethers.Interface([
  "function sync(address token)",
]);

/**
 * UniV4 unlock — WRAPPER.
 * Must append encodeReturn(abi.encode("")) at end of innerScript.
 * unlockCallback must return bytes, otherwise V4 reverts.
 */
export const univ4UnlockAdapter: ActionAdapter = {
  id: "univ4-unlock",
  isWrapper: true,
  field2Offset: V4_UNLOCK_FIELD2,

  encode(node: ResolvedPlanNode, _executor: string, innerScript: Uint8Array) {
    // V4 RETURN: unlockCallback must return bytes. Append RETURN opcode.
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const returnData = ethers.getBytes(abiCoder.encode(["string"], [""]));
    const fullInnerScript = concatBytes(innerScript, encodeReturn(returnData));

    const calldata = unlockIface.encodeFunctionData("unlock", [fullInnerScript]);
    return concatBytes(
      encodeSetField2(V4_UNLOCK_FIELD2),
      encodeCall(node.target, ethers.getBytes(calldata)),
      encodeClearState(),
    );
  },

  matchTrace(target: string, selector: string) {
    return selector === "0x48c89491"; // unlock(bytes)
  },
};

/** UniV4 swap — LEAF inside unlock callback */
export const univ4SwapAdapter: ActionAdapter = {
  id: "univ4-swap",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const key = {
      currency0: node.params.currency0 as string,
      currency1: node.params.currency1 as string,
      fee: Number(node.params.fee as bigint),
      tickSpacing: Number(node.params.tickSpacing as bigint),
      hooks: node.params.hooks as string,
    };
    const params = {
      zeroForOne: node.params.zeroForOne as boolean,
      amountSpecified: node.params.amountSpecified as bigint,
      sqrtPriceLimitX96: node.params.sqrtPriceLimit as bigint,
    };
    const calldata = swapIface.encodeFunctionData("swap", [key, params, "0x"]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, _selector: string) {
    return false; // matched via parent unlock, not standalone
  },
};

/** UniV4 take — LEAF inside unlock callback */
export const univ4TakeAdapter: ActionAdapter = {
  id: "univ4-take",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const currency = (node.params.currency as string) || node.tokenOut;
    const calldata = takeIface.encodeFunctionData("take", [
      currency,
      executor, // receiver rewrite
      node.amount,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace() { return false; },
};

/** UniV4 sync — LEAF inside unlock callback */
export const univ4SyncAdapter: ActionAdapter = {
  id: "univ4-sync",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const currency = (node.params.currency as string) || node.tokenIn;
    const calldata = syncIface.encodeFunctionData("sync", [currency]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace() { return false; },
};

/** UniV4 settle — LEAF inside unlock callback */
export const univ4SettleAdapter: ActionAdapter = {
  id: "univ4-settle",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const calldata = settleIface.encodeFunctionData("settle");
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace() { return false; },
};
