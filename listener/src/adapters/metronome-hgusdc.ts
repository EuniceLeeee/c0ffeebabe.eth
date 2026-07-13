import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function executePath(bytes path, uint256[] amounts, address receiver)",
]);

/**
 * Metronome's permissionless msUSD -> frxUSD -> hgUSDC exit path.
 *
 * hgUSDC cannot be redeemed directly by our executor: its external frxUSD
 * share burns are authorized through this router. The bytes below are the
 * protocol path, while `amounts[0]` remains dynamic for solver-sized routes.
 * The plan builder pre-transfers msUSD to the Curve pool because executePath
 * begins with exchange_received and does not pull the input from the caller.
 */
export const METRONOME_HGUSDC_PATH =
  "0x0102060067010000010201000246000103040500ff0000000000000000000000" +
  "9a9e2e70919c75d80aaaa1d483c46cdbb8ac4d1b" +
  "ab5eb14c09d416f0ac63661e57edb7aecdb9befa" +
  "4f95c5ba0c7c69fb2f9340e190ccee890b3bd87c" +
  "cacd6fd266af91b8aed52accc382b4e165586e29" +
  "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

export const metronomeHgUsdcExitAdapter: ActionAdapter = {
  id: "metronome-hgusdc-exit",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, _executor: string, _inner: Uint8Array) {
    const calldata = iface.encodeFunctionData("executePath", [
      METRONOME_HGUSDC_PATH,
      [node.amount],
      ethers.ZeroAddress,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(target: string, selector: string) {
    return target.toLowerCase() === "0x365084b05fa7d5028346bd21d842ed0601bab5b8" &&
      selector === "0xcb70e273";
  },
};
