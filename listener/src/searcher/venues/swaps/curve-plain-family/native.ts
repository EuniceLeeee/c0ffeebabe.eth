import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import { runtimeExecutor, runtimeExactApproval, runtimeClearApproval,
  RUNTIME_ERC20 } from "../../runtime-execution.js";
import type { AdapterRequest } from "../../adapter-request-program.js";
import { executionData, hasReceiver, isNativeCoin, isNativeMode, same } from "./codec.js";
import type { CurvePlainMode, CurvePlainExecutionMode, CurvePlainRecipientMode } from "./types.js";
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
  // Rounding dust may remain, but zero actual debit is never a swap.
  p.math("sub", 7, 4, 1).constant(2, 1n).math("sub", 7, 7, 2);
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

/** Raw native direct settlement. Common infrastructure alone unwraps input,
 * wraps measured output and delivers graph WETH. A raw native-output request
 * therefore targets the executor; no Family-local wrapper or refund path. */
export function nativeRecipientProgram(pool: string, tokenIn: string, tokenOut: string,
  i: number, j: number, mode: CurvePlainExecutionMode, executor: string, recipient: string,
  nativeIn: boolean, minimum = 1n): RuntimeAmountProgram {
  const actor = runtimeExecutor(executor, pool, tokenIn, tokenOut);
  runtimeExecutor(recipient, pool, tokenIn, tokenOut);
  if (!isNativeMode(mode) || same(tokenIn, tokenOut) || minimum <= 0n ||
      !same(nativeIn ? tokenIn : tokenOut, ADDR.WETH) ||
      (nativeIn ? !hasReceiver(mode) : !same(actor, recipient))) throw new Error("curve-plain native recipient binding");
  const external = !same(actor, recipient), balance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]);
  const received = RUNTIME_ERC20.encodeFunctionData("balanceOf", [recipient]);
  const p = new RuntimeAmountProgram().constant(15, 0n).constant(1, 1n).math("sub", 2, 0, 1);
  if (nativeIn) p.nativeBalance(4).call(tokenOut, received, { static: true }).load(5, 0);
  else p.call(tokenIn, balance, { static: true }).load(4, 0).nativeBalance(5);
  p.math("sub", 6, 4, 0);
  if (external) p.call(tokenOut, balance, { static: true }).load(7, 0)
    .call(tokenIn, received, { static: true }).load(8, 0);
  if (!nativeIn) runtimeExactApproval(p, tokenIn, pool);
  p.call(pool, executionData(mode, i, j, 0n, minimum, recipient), {
    patches: [{ offset: 68, reg: 0 }], ...(nativeIn ? { valueReg: 0 } : {}) });
  if (nativeIn) p.nativeBalance(1).equal(1, 6).call(tokenOut, received, { static: true }).load(1, 0);
  else {
    runtimeClearApproval(p, tokenIn, pool);
    const approval = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);
    p.call(tokenIn, approval.encodeFunctionData("allowance", [actor, pool]), { static: true }).load(1, 0).equal(1, 15)
      .call(tokenIn, balance, { static: true }).load(1, 0).equal(1, 6).nativeBalance(1);
  }
  p.math("sub", 1, 1, 5).constant(2, minimum).math("sub", 1, 1, 2);
  if (external) p.call(tokenOut, balance, { static: true }).load(1, 0).equal(1, 7)
    .call(tokenIn, received, { static: true }).load(1, 0).equal(1, 8);
  return p;
}

/** Probe the native-input receiver ABI with a separately funded raw native
 * call. This optional capability probe neither changes default admission nor
 * claims WETH transport; that is still tested by the shared production issuer. */
export function nativeRecipientProbe(pool: string,
  quote: { i: number; j: number; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint },
  mode: CurvePlainRecipientMode, actor: string, recipient: string, toleranceRawUnits: bigint): AdapterRequest {
  const caller = { kind: "executor" as const };
  const program = nativeRecipientProgram(pool, quote.tokenIn, quote.tokenOut, quote.i, quote.j,
    mode, actor, recipient, true, minimumExecutionOutput(quote.amountOut, toleranceRawUnits));
  return { id: `execution:${quote.i}:${quote.j}:${mode}`, kind: "effect-delta-simulation", required: false,
    call: { caller, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(program.bytes(), quote.amountIn)) },
    overrideIntent: { caller, nativeBalanceWei: quote.amountIn },
    observeTokenBalances: [
      { token: quote.tokenIn, account: caller }, { token: quote.tokenOut, account: caller },
      { token: quote.tokenIn, account: recipient }, { token: quote.tokenOut, account: recipient },
    ], observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] };
}
