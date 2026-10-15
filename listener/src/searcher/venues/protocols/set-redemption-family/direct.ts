import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { TOKEN } from "./codec.js";
/** Direct settlement is offered only for an existing unary route. The original
 * Family program enforces Core units, fee semantics and minimum actual receipt.
 * A separate VM frame keeps these snapshots independent of its registers. */
export function setDirectProgram(program: RuntimeAmountProgram, tokenIn: string, tokenOut: string,
  executor: string, recipient: string): RuntimeAmountProgram {
  const p = new RuntimeAmountProgram().constant(14, 1n).math("sub", 12, 0, 14);
  const read = (token: string, account: string, reg: number) => p.call(token,
    TOKEN.encodeFunctionData("balanceOf", [account]), { static: true }).load(reg, 0);
  read(tokenIn, executor, 1); read(tokenOut, recipient, 2); p.nativeBalance(3);
  const external = recipient.toLowerCase() !== executor.toLowerCase();
  if (external) { read(tokenOut, executor, 4); read(tokenIn, recipient, 5); }
  p.run(program.bytes(), 0, 13);
  read(tokenIn, executor, 6).math("sub", 6, 1, 6).equal(6, 0);
  read(tokenOut, recipient, 7).math("sub", 7, 7, 2).math("sub", 12, 7, 14);
  p.nativeBalance(8).equal(8, 3);
  if (external) { read(tokenOut, executor, 8).equal(8, 4); read(tokenIn, recipient, 8).equal(8, 5); }
  return p;
}
