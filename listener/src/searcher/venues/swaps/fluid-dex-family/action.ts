import { fluidDexSwapAdapter } from "../../../../adapters/fluid-dex.js";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { bindFamilyOwnedAction } from "../../family-owned-action.js";
import { fluidDexRawProgram } from "./raw-execution.js";

export const fluidDexFamilyOwnedAction = bindFamilyOwnedAction({
  action: {
    ...fluidDexSwapAdapter,
    encode(node, executor, inner) {
      if (node.amount <= 0n || node.amount > ethers.MaxUint256 || node.children.length || inner.length) {
        throw new Error("fluid-dex quoted execution shape");
      }
      const program = fluidDexRawProgram({
        pool: node.target, tokenIn: node.tokenIn, tokenOut: node.tokenOut, executor,
        swap0To1: node.params.swap0to1 as boolean,
        nativeInput: node.params.nativeInput as boolean,
        nativeOutput: node.params.nativeOutput as boolean,
        minimum: node.params.amountOutMin as bigint,
      });
      return runtimeProgramScript(program.bytes(), node.amount);
    },
  },
  descriptor: {
    adapterId: "fluid-dex-swap",
    lineage: "fluid-dex",
    edgeKind: "swap",
    action: "swap",
    canSendValue: true,
    leavesStandingPositionDefault: false,
  },
});
