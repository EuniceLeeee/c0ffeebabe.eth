import { ethers } from "ethers";
import { encodeSetField2, encodeCall, encodeClearState, concatBytes } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

/**
 * Morpho flash loan callback: onMorphoFlashLoan(uint256, bytes)
 * field2 = 4(sel) + 32(uint256) + 32(bytes offset) + 32(bytes length) = 100
 */
const FIELD2 = 100;

const iface = new ethers.Interface([
  "function flashLoan(address token, uint256 assets, bytes data)",
]);

export const morphoFlashAdapter: ActionAdapter = {
  id: "morpho-flash",
  isWrapper: true,
  field2Offset: FIELD2,

  encode(node: ResolvedPlanNode, _executor: string, innerScript: Uint8Array) {
    const calldata = iface.encodeFunctionData("flashLoan", [
      node.tokenIn,
      node.amount,
      innerScript,
    ]);
    return concatBytes(
      encodeSetField2(FIELD2),
      encodeCall(node.target, ethers.getBytes(calldata)),
      encodeClearState(),
    );
  },

  matchTrace(target: string, selector: string) {
    return (
      target.toLowerCase() === MORPHO.toLowerCase() &&
      selector === "0xe0232b42"
    );
  },
};
