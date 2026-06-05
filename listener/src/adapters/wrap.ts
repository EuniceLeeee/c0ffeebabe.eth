import { ethers } from "ethers";
import { encodeCall, encodeWethUnwrap } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

/** wstETH unwrap: wstETH.unwrap(uint256 wstETHAmount) → stETH */
const unwrapIface = new ethers.Interface([
  "function unwrap(uint256 wstETHAmount) returns (uint256)",
]);

export const wstethUnwrapAdapter: ActionAdapter = {
  id: "wsteth-unwrap",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const calldata = unwrapIface.encodeFunctionData("unwrap", [node.amount]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0xde0e9a3e";
  },
};

/** wstETH wrap: wstETH.wrap(uint256 stETHAmount) → wstETH */
const wrapIface = new ethers.Interface([
  "function wrap(uint256 stETHAmount) returns (uint256)",
]);

export const wstethWrapAdapter: ActionAdapter = {
  id: "wsteth-wrap",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const calldata = wrapIface.encodeFunctionData("wrap", [node.amount]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0xea598cb0";
  },
};

/** BotVM opcode 0x04: unwrap all WETH held by the executor. */
export const wethWithdrawAdapter: ActionAdapter = {
  id: "weth-withdraw",
  isWrapper: false,
  field2Offset: null,

  encode(_node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    return encodeWethUnwrap();
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x2e1a7d4d";
  },
};
