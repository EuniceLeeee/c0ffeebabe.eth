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

/**
 * FluidDex swapInWithCallback — WRAPPER but v3.0 UNSUPPORTED.
 *
 * dexCallback(address, uint256) has no bytes payload for BotVM script.
 * Mechanism for how BotVM handles this is unclear.
 */
export const fluidDexSwapAdapter: ActionAdapter = {
  id: "fluid-dex-swap",
  isWrapper: true,
  field2Offset: null,

  encode() {
    throw new Error("fluid-dex-swap not supported in v3.0: dexCallback has no bytes payload");
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0xbe17c79c";
  },
};
