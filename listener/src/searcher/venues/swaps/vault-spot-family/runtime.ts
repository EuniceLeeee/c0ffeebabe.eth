import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExecutor } from "../../runtime-execution.js";
import { ABI, address, amount } from "./codec.js";
export function swapProgram(vault: string, tokenIn: string, tokenOut: string, executor: string, minimum: bigint) {
  const v = address(vault), a = address(tokenIn), b = address(tokenOut), actor = runtimeExecutor(executor, v, a, b);
  if (new Set([v, a, b]).size !== 3) throw new Error("vault-spot aliased swap");
  amount(minimum, true);
  const p = new RuntimeAmountProgram().constant(15, 1n).math("sub", 14, 0, 15)
    .call(a, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(1, 0)
    .call(b, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(2, 0).nativeBalance(3)
    .call(a, ABI.encodeFunctionData("balanceOf", [v]), { static: true }).load(4, 0)
    .call(v, ABI.encodeFunctionData("tokenBalances", [a]), { static: true }).load(5, 0).equal(4, 5)
    .call(a, ABI.encodeFunctionData("transfer", [v, 0n]), { patches: [{ offset: 36, reg: 0 }] })
    .call(a, ABI.encodeFunctionData("balanceOf", [v]), { static: true }).load(6, 0)
    .math("sub", 6, 6, 4).equal(6, 0)
    .call(v, ABI.encodeFunctionData("swap", [a, b, actor])).load(8, 0)
    .call(a, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("sub", 7, 1, 6).equal(7, 0)
    .call(b, ABI.encodeFunctionData("balanceOf", [actor]), { static: true }).load(6, 0)
    .math("sub", 7, 6, 2).equal(7, 8).math("sub", 14, 7, 15)
    .constant(9, minimum).math("sub", 14, 7, 9)
    .call(v, ABI.encodeFunctionData("tokenBalances", [a]), { static: true }).load(5, 0)
    .call(a, ABI.encodeFunctionData("balanceOf", [v]), { static: true }).load(6, 0).equal(5, 6)
    .nativeBalance(6).equal(3, 6);
  return p;
}
