import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExactApproval, runtimeClearApproval } from "../../runtime-execution.js";
import { VAULT, SWAP_AMOUNT_OFFSET, swapData } from "./codec.js";
const ALLOWANCE = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);
/** Both emitters use the same temporary-approval policy. Check actual allowance,
 * not optional ERC20 return bytes; ineffective false returns must not leave a
 * standing grant or let the Vault draw more than this trial's input. */
export function swapProgram(poolId: string, tokenIn: string, tokenOut: string, executor: string, minOut: bigint) {
  const p = new RuntimeAmountProgram().constant(1, 255n).math("shr", 2, 0, 1).constant(3, 0n).equal(2, 3);
  const allowance = ALLOWANCE.encodeFunctionData("allowance", [executor, VAULT]);
  runtimeExactApproval(p, tokenIn, VAULT);
  p.call(tokenIn, allowance, { static: true }).load(4, 0).equal(4, 0);
  p.call(VAULT, swapData(poolId, tokenIn, tokenOut, 0n, minOut, executor), { patches: [{ offset: SWAP_AMOUNT_OFFSET, reg: 0 }] });
  runtimeClearApproval(p, tokenIn, VAULT);
  p.call(tokenIn, allowance, { static: true }).load(4, 0).equal(4, 3);
  return p;
}
