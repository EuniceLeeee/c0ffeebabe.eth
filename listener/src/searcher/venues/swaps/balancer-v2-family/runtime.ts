import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExactApproval, runtimeClearApproval, RUNTIME_ERC20 } from "../../runtime-execution.js";
import { VAULT, SWAP_AMOUNT_OFFSET, swapData } from "./codec.js";
const ALLOWANCE = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);
/** Both emitters use the same temporary-approval policy. Check actual allowance,
 * not optional ERC20 return bytes; ineffective false returns must not leave a
 * standing grant or let the Vault draw more than this trial's input. */
export function swapProgram(poolId: string, tokenIn: string, tokenOut: string, executor: string, minOut: bigint, recipient?: string) {
  const p = new RuntimeAmountProgram().constant(1, 255n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3);
  // The original self-recipient encoding stays unchanged. An explicit receiver
  // is checked against actual debit/credit, not Vault's returned amount alone.
  const balance = (owner: string) => RUNTIME_ERC20.encodeFunctionData("balanceOf", [owner]);
  if (recipient) p.constant(15, 1n).math("sub", 9, 0, 15)
    .call(tokenIn, balance(executor), { static: true }).load(5, 0)
    .call(tokenOut, balance(recipient), { static: true }).load(6, 0).nativeBalance(7);
  const allowance = ALLOWANCE.encodeFunctionData("allowance", [executor, VAULT]);
  runtimeExactApproval(p, tokenIn, VAULT);
  p.call(tokenIn, allowance, { static: true }).load(4, 0).equal(4, 0);
  p.call(VAULT, swapData(poolId, tokenIn, tokenOut, 0n, minOut, executor, recipient), { patches: [{ offset: SWAP_AMOUNT_OFFSET, reg: 0 }] });
  if (recipient) p.load(8, 0);
  runtimeClearApproval(p, tokenIn, VAULT);
  p.call(tokenIn, allowance, { static: true }).load(4, 0).equal(4, 3);
  if (recipient) p.call(tokenIn, balance(executor), { static: true }).load(9, 0)
    .math("sub", 9, 5, 9).equal(9, 0)
    .call(tokenOut, balance(recipient), { static: true }).load(9, 0)
    .math("sub", 9, 9, 6).equal(9, 8).math("sub", 10, 9, 15)
    .constant(10, minOut).math("sub", 10, 9, 10).nativeBalance(9).equal(9, 7);
  return p;
}
