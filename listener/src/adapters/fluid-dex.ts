import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

/**
 * FluidDex liquidate — LEAF adapter.
 *
 * BotVM calls DEX Vault.liquidate(). Internally, DEX Vault handles
 * FluidLiquidity.operate() + liquidityCallback. BotVM never receives callback.
 *
 * Verified via callTracer: TX1 (0xb44a), TX3 (0x7f33).
 */
const liquidateIface = new ethers.Interface([
  "function liquidate(uint256 col, uint256 debt, address to, bool absorb)",
]);

export const fluidDexLiquidateAdapter: ActionAdapter = {
  id: "fluid-dex-liquidate",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const col = node.params.col as bigint;
    const debt = node.params.debt as bigint;
    const absorb = (node.params.absorb as boolean) ?? false;
    // Receiver rewrite: always use executor
    const calldata = liquidateIface.encodeFunctionData("liquidate", [
      col,
      debt,
      executor,
      absorb,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x8433ea22";
  },
};

const swapInIface = new ethers.Interface([
  "function swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_) payable returns (uint256 amountOut_)",
]);

/**
 * FluidDex plain swapIn — LEAF adapter.
 *
 * The pool pulls ERC20 input with transferFrom, so the solver emits an approve
 * before this call (same shape as Curve plain exchange).
 */
export const fluidDexSwapAdapter: ActionAdapter = {
  id: "fluid-dex-swap",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const swap0to1 = node.params.swap0to1;
    if (typeof swap0to1 !== "boolean") {
      throw new Error("fluid-dex-swap missing boolean swap0to1 param");
    }
    const amountOutMin = BigInt((node.params.amountOutMin as bigint | undefined) ?? 0n);
    const calldata = swapInIface.encodeFunctionData("swapIn", [
      swap0to1,
      node.amount,
      amountOutMin,
      executor,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x2668dfaa";
  },
};
