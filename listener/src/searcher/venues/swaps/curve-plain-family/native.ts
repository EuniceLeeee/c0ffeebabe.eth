import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import { runtimeExecutor, runtimeExactApproval, runtimeClearApproval,
  RUNTIME_ERC20 } from "../../runtime-execution.js";
import type { AdapterRequest } from "../../adapter-request-program.js";
import { executionData, isNativeCoin, isNativeMode, same } from "./codec.js";
import type { CurvePlainMode } from "./types.js";
import { MAX_EXECUTION_ROUNDING_RAW_UNITS, minimumExecutionOutput } from "../../../../shared/executor/amount-rounding.js";

/** Raw protocol execution only. Central route/strict issuers own ETH/WETH
 * transport. Curve retains its minimum and approval semantics; a token may
 * retain at most the common one-raw-unit rounding dust, never debit inventory.
 * The enclosing flow additionally enforces the selected 0/1 dust policy. */
export function nativeExchangeProgram(pool: string, tokenIn: string, tokenOut: string,
  i: number, j: number, mode: CurvePlainMode, actor: string, nativeIn: boolean, minimum = 1n): RuntimeAmountProgram {
  runtimeExecutor(actor, pool, tokenIn, tokenOut);
  if (!isNativeMode(mode) || same(tokenIn, tokenOut) ||
      !same(nativeIn ? tokenIn : tokenOut, ADDR.WETH) || minimum <= 0n) throw new Error("curve-plain native program binding");
  const balanceIn = RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]);
  const p = new RuntimeAmountProgram().constant(15, 0n);
  if (nativeIn) p.nativeBalance(4);
  else p.call(tokenIn, balanceIn, { static: true }).load(4, 0);
  p.math("sub", 6, 4, 0);
  if (nativeIn) p.call(tokenOut, balanceIn, { static: true }).load(5, 0);
  else { p.nativeBalance(5); runtimeExactApproval(p, tokenIn, pool); }
  p.call(pool, executionData(mode, i, j, 0n, minimum, actor),
    { patches: [{ offset: 68, reg: 0 }], ...(nativeIn ? { valueReg: 0 } : {}) });
  if (!nativeIn) runtimeClearApproval(p, tokenIn, pool);
  if (nativeIn) p.nativeBalance(1);
  else p.call(tokenIn, balanceIn, { static: true }).load(1, 0);
  p.math("sub", 1, 1, 6).constant(2, MAX_EXECUTION_ROUNDING_RAW_UNITS).math("sub", 1, 2, 1);
  if (nativeIn) p.call(tokenOut, balanceIn, { static: true }).load(1, 0);
  else p.nativeBalance(1);
  p.math("sub", 1, 1, 5).constant(2, minimum).math("sub", 1, 1, 2);
  if (!nativeIn) {
    const approval = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);
    p.call(tokenIn, approval.encodeFunctionData("allowance", [actor, pool]), { static: true }).load(1, 0).equal(1, 15);
  }
  return p;
}

export function nativeExecutionProbe(pool: string,
  quote: { i: number; j: number; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint },
  mode: CurvePlainMode, actor: string, coins: readonly string[], toleranceRawUnits = 0n): AdapterRequest {
  const caller = { kind: "executor" as const };
  const minimum = minimumExecutionOutput(quote.amountOut, toleranceRawUnits);
  const program = nativeExchangeProgram(pool, quote.tokenIn, quote.tokenOut, quote.i, quote.j,
    mode, actor, isNativeCoin(coins[quote.i]), minimum);
  return { id: `execution:${quote.i}:${quote.j}:${mode}`, kind: "effect-delta-simulation", required: false,
    executionAssetBoundary: { tokenIn: quote.tokenIn, tokenOut: quote.tokenOut,
      executionAssets: { input: isNativeCoin(coins[quote.i]) ? "native" : "erc20",
        output: isNativeCoin(coins[quote.j]) ? "native" : "erc20" }, amountIn: quote.amountIn, minimum },
    call: { caller, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(program.bytes(), quote.amountIn)) },
    overrideIntent: { caller, tokenBalances: [{ token: quote.tokenIn, amount: quote.amountIn }] },
    observeTokenBalances: [quote.tokenIn, quote.tokenOut].map(token => ({ token, account: caller })),
    observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] };
}
