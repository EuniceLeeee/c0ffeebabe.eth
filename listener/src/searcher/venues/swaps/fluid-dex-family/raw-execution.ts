import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeClearApproval, runtimeExactApproval, runtimeExecutor, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { FLUID_DEX_INTERFACE, FLUID_DEX_ADDRESS_DEAD, sameAddress } from "./codec.js";

/** Both interfaces emit the raw protocol operation. Native conversion and
 * independent graph-asset inventory checks belong to the central issuer. */
export function fluidDexRawProgram(input: {
  pool: string; tokenIn: string; tokenOut: string; executor: string;
  swap0To1: boolean; nativeInput: boolean; nativeOutput: boolean; minimum: bigint;
  recipient?: string; direct?: boolean;
}): RuntimeAmountProgram {
  const actor = runtimeExecutor(input.executor, input.pool, input.tokenIn, input.tokenOut);
  if (typeof input.swap0To1 !== "boolean" || typeof input.nativeInput !== "boolean" ||
      typeof input.nativeOutput !== "boolean" || input.nativeInput && input.nativeOutput ||
      typeof input.minimum !== "bigint" || input.minimum < 0n || input.minimum > ethers.MaxUint256 ||
      [input.pool, input.tokenIn, input.tokenOut].some(address => sameAddress(address, ethers.ZeroAddress)) ||
      sameAddress(input.tokenIn, input.tokenOut)) {
    throw new Error("fluid-dex raw execution parameters");
  }
  const recipient = input.recipient === undefined ? actor : ethers.getAddress(input.recipient);
  if ([ethers.ZeroAddress, FLUID_DEX_ADDRESS_DEAD, input.pool, input.tokenIn, input.tokenOut].some(a => sameAddress(a, recipient)) ||
      input.nativeOutput && !sameAddress(recipient, actor)) throw new Error("fluid-dex raw output recipient");
  const external = !sameAddress(recipient, actor);
  const balance = (token: string, owner: string, reg: number) => program
    .call(token, RUNTIME_ERC20.encodeFunctionData("balanceOf", [owner]), { static: true }).load(reg, 0);
  const program = new RuntimeAmountProgram();
  if (input.direct) {
    program.run(fluidDexRuntimeQuote(input.pool, input.swap0To1).bytes(), 0, 8, true);
    if (input.nativeInput) program.nativeBalance(1); else balance(input.tokenIn, actor, 1);
    if (input.nativeOutput) program.nativeBalance(2); else balance(input.tokenOut, recipient, 2);
    if (!input.nativeInput && !input.nativeOutput) program.nativeBalance(5);
    if (external) { balance(input.tokenOut, actor, 3); if (!input.nativeInput) balance(input.tokenIn, recipient, 4); }
  }
  if (!input.nativeInput) runtimeExactApproval(program, input.tokenIn, input.pool);
  program.call(input.pool, FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [
    input.swap0To1, 0n, input.minimum, recipient,
  ]), { patches: [{ offset: 36, reg: 0 }], ...(input.nativeInput ? { valueReg: 0 } : {}) });
  if (input.direct) program.load(9, 0).equal(9, 8);
  if (!input.nativeInput) runtimeClearApproval(program, input.tokenIn, input.pool);
  if (input.direct) {
    if (input.nativeInput) program.nativeBalance(6); else balance(input.tokenIn, actor, 6);
    program.math("sub", 6, 1, 6).equal(6, 0);
    if (input.nativeOutput) program.nativeBalance(6); else balance(input.tokenOut, recipient, 6);
    program.math("sub", 6, 6, 2).equal(6, 8);
    if (!input.nativeInput && !input.nativeOutput) program.nativeBalance(6).equal(6, 5);
    if (external) {
      balance(input.tokenOut, actor, 6).equal(6, 3);
      if (!input.nativeInput) balance(input.tokenIn, recipient, 6).equal(6, 4);
    }
  }
  return program;
}

/** ADDRESS_DEAD computes the same amount before payment/recipient effects and
 * always reverts. VM mode 2 proves rollback; this Family owns the error ABI.
 * It does not prove execution permission, payment or a future receiver credit. */
export function fluidDexRuntimeQuote(pool: string, swap0To1: boolean): RuntimeAmountProgram {
  return new RuntimeAmountProgram().constant(12, 1n).math("sub", 1, 0, 12)
    .call(pool, FLUID_DEX_INTERFACE.encodeFunctionData("swapIn", [swap0To1, 0n, 0n, FLUID_DEX_ADDRESS_DEAD]), {
      patches: [{ offset: 36, reg: 0 }], revertBytes: 36,
    }).load(1, 0).constant(2, 224n).math("shr", 1, 1, 2)
    .constant(2, BigInt(FLUID_DEX_INTERFACE.getError("FluidDexSwapResult")!.selector)).equal(1, 2)
    .load(0, 4).math("sub", 1, 0, 12);
}
