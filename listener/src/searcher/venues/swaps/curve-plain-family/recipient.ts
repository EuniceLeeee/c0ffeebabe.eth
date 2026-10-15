import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeExactApproval, runtimeClearApproval, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { executionData, hasReceiver, isNativeMode, pullsInput, same } from "./codec.js";
import type { CurvePlainExecutionMode } from "./types.js";

/** Explicit ERC20 delivery. Default/quoted programs keep their existing policy.
 * Direct settlement consumes exactly the positive request, measures the chosen
 * receiver independently, and cannot spend old input/output/native inventory. */
export function recipientExchangeProgram(pool: string, tokenIn: string, tokenOut: string,
  i: number, j: number, mode: CurvePlainExecutionMode, executor: string, recipient: string): RuntimeAmountProgram {
  const actor = runtimeExecutor(executor, pool, tokenIn, tokenOut);
  runtimeExecutor(recipient, pool, tokenIn, tokenOut);
  if (!hasReceiver(mode) || isNativeMode(mode) || same(tokenIn, tokenOut)) throw new Error("curve-plain recipient mode");
  const external = !same(actor, recipient), pulls = pullsInput(mode);
  const balance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]);
  const received = RUNTIME_ERC20.encodeFunctionData("balanceOf", [recipient]);
  const p = new RuntimeAmountProgram().constant(15, 0n).constant(1, 1n).math("sub", 2, 0, 1)
    .nativeBalance(13)
    .call(tokenIn, balance, { static: true }).load(4, 0).math("sub", 6, 4, 0)
    .call(tokenOut, received, { static: true }).load(5, 0);
  if (external) p.call(tokenOut, balance, { static: true }).load(7, 0)
    .call(tokenIn, received, { static: true }).load(8, 0);
  if (pulls) runtimeExactApproval(p, tokenIn, pool);
  else {
    const poolBalance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [pool]);
    p.call(tokenIn, poolBalance, { static: true }).load(1, 0)
      .call(tokenIn, RUNTIME_ERC20.encodeFunctionData("transfer", [pool, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(tokenIn, poolBalance, { static: true }).load(2, 0).math("sub", 3, 2, 1);
  }
  p.call(pool, executionData(mode, i, j, 0n, 1n, recipient), { patches: [{ offset: 68, reg: pulls ? 0 : 3 }] });
  if (pulls) {
    runtimeClearApproval(p, tokenIn, pool);
    const allowance = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);
    p.call(tokenIn, allowance.encodeFunctionData("allowance", [actor, pool]), { static: true }).load(1, 0).equal(1, 15);
  }
  p.call(tokenIn, balance, { static: true }).load(1, 0).equal(1, 6)
    .call(tokenOut, received, { static: true }).load(1, 0).math("sub", 1, 1, 5)
    .constant(2, 1n).math("sub", 1, 1, 2);
  if (external) p.call(tokenOut, balance, { static: true }).load(1, 0).equal(1, 7)
    .call(tokenIn, received, { static: true }).load(1, 0).equal(1, 8);
  return p.nativeBalance(14).equal(13, 14);
}
