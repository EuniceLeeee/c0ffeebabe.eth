import { RuntimeAmountProgram } from "../../../../adapters/runtime-amount-program.js";
import { runtimeExactApproval, runtimeClearApproval, runtimeExecutor } from "../../runtime-execution.js";
import { MAX_UINT, POOL, TOKEN } from "./codec.js";
/** ABI/receipt policy shared by the specified-input and quote-free emitters.
 * r0 is the only input amount. No allowance sentinel or old inventory sweep.
 * BPool enforces its native max-in/spot-price/math guards at execution time. */
export function swapProgram(pool: string, tokenIn: string, tokenOut: string, executor: string, minOut: bigint): RuntimeAmountProgram {
  runtimeExecutor(executor, pool, tokenIn, tokenOut);
  const p = new RuntimeAmountProgram();
  p.call(tokenIn, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(1, 0)
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(2, 0);
  runtimeExactApproval(p, tokenIn, pool);
  p.call(pool, POOL.encodeFunctionData("swapExactAmountIn", [tokenIn, 0n, tokenOut, minOut, MAX_UINT]), { patches: [{ offset: 36, reg: 0 }] });
  runtimeClearApproval(p, tokenIn, pool);
  p.constant(3, 0n)
    .call(tokenIn, TOKEN.encodeFunctionData("allowance", [executor, pool]), { static: true }).load(4, 0).equal(4, 3)
    .call(tokenIn, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(4, 0)
    .math("sub", 4, 1, 4).equal(4, 0)
    .call(tokenOut, TOKEN.encodeFunctionData("balanceOf", [executor]), { static: true }).load(5, 0)
    .math("sub", 5, 5, 2).constant(6, minOut).math("sub", 7, 5, 6);
  return p;
}
