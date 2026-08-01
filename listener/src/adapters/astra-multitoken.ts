import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter } from "../types.js";

const astraMultiTokenIface = new ethers.Interface([
  "function change(address fromToken,address toToken,uint256 amount,uint256 minReturn) returns (uint256)",
]);
const changeSelector = astraMultiTokenIface
  .getFunction("change")!.selector.toLowerCase();

/** Low-level BotVM encoder for AstraMultiToken's exact-in change surface. */
export const astraMultiTokenChangeActionAdapter = Object.freeze({
  id: "astra-multitoken-change",
  isWrapper: false,
  field2Offset: null,
  descriptor: Object.freeze({
    adapterId: "astra-multitoken-change",
    lineage: "custom-protocol:astra-multitoken",
    edgeKind: "protocol",
    action: "convert",
    canSendValue: false,
    leavesStandingPositionDefault: false,
  }),

  encode(node, _executor, _innerScript) {
    const minAmountOut = node.params.minAmountOut;
    if (typeof minAmountOut !== "bigint" || minAmountOut <= 0n) {
      throw new Error(
        "AstraMultiToken change requires positive bigint minAmountOut",
      );
    }
    if (
      !node.tokenOut ||
      node.tokenIn.toLowerCase() === node.tokenOut.toLowerCase() ||
      node.amount <= 0n
    ) {
      throw new Error("AstraMultiToken change requires a positive distinct pair");
    }
    const calldata = astraMultiTokenIface.encodeFunctionData("change", [
      node.tokenIn,
      node.tokenOut,
      node.amount,
      minAmountOut,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target, selector) {
    return selector.toLowerCase() === changeSelector;
  },
} satisfies ActionAdapter);
