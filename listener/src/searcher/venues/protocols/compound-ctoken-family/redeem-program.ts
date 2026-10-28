import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { CTOKEN_INTERFACE, CT_ERC20_INTERFACE } from "./abi.js";

/** Shared quoted/runtime emitter. r0 is the only input amount. Checked VM
 * subtraction enforces thresholds; deltas exclude all pre-existing inventory. */
export function redeemProgram(market: string, underlying: string, executor: string, minimum = 1n): RuntimeAmountProgram {
  const actor = runtimeExecutor(executor, market, underlying);
  if (minimum <= 0n || minimum > ethers.MaxUint256 || ethers.getAddress(market) === ethers.getAddress(underlying)) {
    throw new Error("compound cToken invalid minimum or token pair");
  }
  const balance = CT_ERC20_INTERFACE.encodeFunctionData("balanceOf", [actor]);
  return new RuntimeAmountProgram()
    .call(market, balance, { static: true }).load(14, 0)
    .call(underlying, balance, { static: true }).load(13, 0)
    .call(market, CTOKEN_INTERFACE.encodeFunctionData("redeem", [0n]), { patches: [{ offset: 4, reg: 0 }] })
    .load(1, 0).constant(2, 0n).equal(1, 2)
    .call(market, balance, { static: true }).load(1, 0)
    .math("sub", 1, 14, 1).equal(1, 0)
    .call(underlying, balance, { static: true }).load(1, 0)
    .math("sub", 1, 1, 13).constant(2, minimum).math("sub", 2, 1, 2);
}
