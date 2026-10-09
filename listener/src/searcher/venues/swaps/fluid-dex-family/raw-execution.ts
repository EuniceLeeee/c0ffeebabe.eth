import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeClearApproval, runtimeExactApproval, runtimeExecutor } from "../../runtime-execution.js";
import { FLUID_DEX_INTERFACE, sameAddress } from "./codec.js";

/** Both interfaces emit the raw protocol operation. Native conversion and
 * independent graph-asset inventory checks belong to the central issuer. */
export function fluidDexRawProgram(input: {
  pool: string; tokenIn: string; tokenOut: string; executor: string;
  swap0To1: boolean; nativeInput: boolean; nativeOutput: boolean; minimum: bigint;
}): RuntimeAmountProgram {
  const actor = runtimeExecutor(input.executor, input.pool, input.tokenIn, input.tokenOut);
  if (typeof input.swap0To1 !== "boolean" || typeof input.nativeInput !== "boolean" ||
      typeof input.nativeOutput !== "boolean" || input.nativeInput && input.nativeOutput ||
      typeof input.minimum !== "bigint" || input.minimum < 0n || input.minimum > ethers.MaxUint256 ||
      [input.pool, input.tokenIn, input.tokenOut].some(address => sameAddress(address, ethers.ZeroAddress)) ||
      sameAddress(input.tokenIn, input.tokenOut)) {
    throw new Error("fluid-dex raw execution parameters");
  }
  const program = new RuntimeAmountProgram();
  if (!input.nativeInput) runtimeExactApproval(program, input.tokenIn, input.pool);
  program.call(input.pool, FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [
    input.swap0To1, 0n, input.minimum, actor,
  ]), { patches: [{ offset: 36, reg: 0 }], ...(input.nativeInput ? { valueReg: 0 } : {}) });
  if (!input.nativeInput) runtimeClearApproval(program, input.tokenIn, input.pool);
  return program;
}
