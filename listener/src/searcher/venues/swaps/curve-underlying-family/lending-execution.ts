import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor, runtimeExactApproval, runtimeClearApproval, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { LENDING_ABI } from "./lending.js";

export const CURVE_UNDERLYING_LENDING_ACTION = "curve-exchange-underlying-lending";
const APPROVAL = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);

/** Legacy wrappers check min_dy before redemption and again after redemption.
 * Their final receipt can include existing pool cash, so the caller's minimum
 * belongs on its own balance delta, not on the intermediate pool amount. */
export function underlyingLendingProgram(pool: string, tokenIn: string, tokenOut: string,
  i: number, j: number, actor: string, minimum = 1n) {
  runtimeExecutor(actor, pool, tokenIn, tokenOut);
  if (![i, j].every(n => Number.isInteger(n) && n >= 0 && n < 4) || i === j ||
      ethers.getAddress(tokenIn) === ethers.getAddress(tokenOut) || minimum < 0n || minimum > ethers.MaxUint256)
    throw new Error("curve-underlying invalid lending program");
  const balance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]);
  const p = new RuntimeAmountProgram().constant(15, 0n).constant(2, 1n).math("sub", 1, 0, 2);
  p.call(tokenIn, balance, { static: true }).load(4, 0);
  p.math("sub", 6, 4, 0); // Isolate the current input from existing inventory.
  p.call(tokenOut, balance, { static: true }).load(5, 0).nativeBalance(7);
  runtimeExactApproval(p, tokenIn, pool);
  p.call(pool, LENDING_ABI.encodeFunctionData("exchange_underlying", [i, j, 0n, 1n]),
    { patches: [{ offset: 68, reg: 0 }] });
  runtimeClearApproval(p, tokenIn, pool);
  p.call(tokenIn, balance, { static: true }).load(1, 0).equal(1, 6);
  p.call(tokenOut, balance, { static: true }).load(1, 0)
    .math("sub", 1, 1, 5).constant(2, minimum > 0n ? minimum : 1n).math("sub", 1, 1, 2);
  p.nativeBalance(1).equal(1, 7);
  p.call(tokenIn, APPROVAL.encodeFunctionData("allowance", [actor, pool]), { static: true }).load(1, 0).equal(1, 15);
  return p;
}
