import { ethers } from "ethers";
import { encodeSetField2, encodeCall, encodeClearState, concatBytes } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

/**
 * UniV2 swap — WRAPPER (has uniswapV2Call callback).
 *
 * Callback: uniswapV2Call(address sender, uint256 amount0, uint256 amount1, bytes data)
 * field2 = 4(sel) + 32(address) + 32(uint256) + 32(uint256) + 32(bytes offset) + 32(bytes length) = 164
 *
 * Required for TX3 (0x7f33).
 */

const FIELD2 = 164;

const iface = new ethers.Interface([
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)",
]);

export const univ2Adapter: ActionAdapter = {
  id: "univ2-swap",
  isWrapper: true,
  field2Offset: FIELD2,

  encode(node: ResolvedPlanNode, executor: string, innerScript: Uint8Array) {
    const amount0Out = node.params.amount0Out as bigint;
    const amount1Out = node.params.amount1Out as bigint;
    const calldata = iface.encodeFunctionData("swap", [
      amount0Out,
      amount1Out,
      executor, // receiver rewrite
      innerScript, // callback data → BotVM reads via field2
    ]);
    return concatBytes(
      encodeSetField2(FIELD2),
      encodeCall(node.target, ethers.getBytes(calldata)),
      encodeClearState(),
    );
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x022c0d9f";
  },
};

// ─── UniV2 Router (leaf — router handles callback internally) ────

/**
 * UniV2 router swapExactTokensForTokens — LEAF.
 * Router does the callback handling; BotVM just calls router as a top-level swap.
 * Required for TX1 (0xb44a) and TX3 (0x7f33).
 */
const routerIface = new ethers.Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

export const univ2RouterAdapter: ActionAdapter = {
  id: "univ2-router-swap-exact-in",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const amountIn = (node.params.amountIn as bigint) ?? node.amount;
    const amountOutMin = (node.params.amountOutMin as bigint) ?? 0n;
    const path = node.params.path as string[];
    const deadline =
      (node.params.deadline as bigint) ?? BigInt(Math.floor(Date.now() / 1000) + 3600);

    const calldata = routerIface.encodeFunctionData("swapExactTokensForTokens", [
      amountIn,
      amountOutMin,
      path,
      executor, // receiver rewrite
      deadline,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x38ed1739";
  },
};

/**
 * Alternate UniV2-style router with positional pair selector `0x6c08c57e`:
 *   swapExactTokensForTokens(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address to)
 * Used by some 3rd party routers (seen in TX3).
 */
const routerAltIface = new ethers.Interface([
  "function swapExactTokensForTokens(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address to)",
]);

export const univ2RouterAltAdapter: ActionAdapter = {
  id: "univ2-router-swap-exact-in-alt",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const tokenIn = (node.params.tokenIn as string) || node.tokenIn;
    const tokenOut = (node.params.tokenOut as string) || node.tokenOut;
    const amountIn = (node.params.amountIn as bigint) ?? node.amount;
    const amountOutMin = (node.params.amountOutMin as bigint) ?? 0n;

    const calldata = routerAltIface.encodeFunctionData("swapExactTokensForTokens", [
      tokenIn,
      tokenOut,
      amountIn,
      amountOutMin,
      executor, // receiver rewrite
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x6c08c57e";
  },
};
