import { ethers } from "ethers";
import { encodeCall } from "../encoder.js";
import type { ActionAdapter, ResolvedPlanNode } from "../types.js";

const iface = new ethers.Interface([
  "function operate(uint256 nftId, int256 newCol, int256 newDebt, address to)",
]);

export const fluidVaultAdapter: ActionAdapter = {
  id: "fluid-vault",
  isWrapper: false,
  field2Offset: null,

  encode(node: ResolvedPlanNode, executor: string, _inner: Uint8Array) {
    const nftId = node.params.nftId as bigint;
    const collateralDelta = node.params.collateralDelta as bigint;
    const debtDelta = node.params.debtDelta as bigint;
    // receiver rewrite: always use executor, not trace's original bot address
    const calldata = iface.encodeFunctionData("operate", [
      nftId,
      collateralDelta,
      debtDelta,
      executor,
    ]);
    return encodeCall(node.target, ethers.getBytes(calldata));
  },

  matchTrace(_target: string, selector: string) {
    return selector === "0x032d2276"; // operate(uint256,int256,int256,address)
  },
};
