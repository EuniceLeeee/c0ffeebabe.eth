import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import { assertExecutionRounding, MAX_EXECUTION_ROUNDING_RAW_UNITS, minimumExecutionOutput } from "../../../../shared/executor/amount-rounding.js";
import { runtimeExecutor, runtimeExactApproval, runtimeClearApproval, RUNTIME_ERC20 } from "../../runtime-execution.js";
import type { AdapterRequest } from "../../adapter-request-program.js";
import { CURVE_UNDERLYING_UINT_INTERFACE, sameAddress } from "./codec.js";
import type { CurveUnderlyingDescriptor, CurveUnderlyingNativeAlias, CurveUnderlyingVerifiedDirection } from "./types.js";

export const CURVE_UNDERLYING_NATIVE_ACTION = "curve-exchange-underlying-uint-native";
export const CURVE_UNDERLYING_NATIVE_QUOTE = new ethers.Interface([
  "function get_dy(uint256,uint256,uint256) view returns (uint256)",
]);
const APPROVAL = new ethers.Interface(["function allowance(address,address) view returns(uint256)"]);

export function underlyingNativeAssets(descriptor: Pick<CurveUnderlyingDescriptor, "coins" | "nativeAlias">,
  direction: { i: number; j: number }) {
  const alias = descriptor.nativeAlias;
  if (!alias) return undefined;
  if (!ethers.isHexString(alias.poolCodeHash, 32)) throw new Error("curve-underlying invalid uint alias code binding");
  if (alias.nativeIndex === null) {
    if (descriptor.coins.some(coin => sameAddress(coin, ADDR.WETH)))
      throw new Error("curve-underlying ERC20 alias cannot hide a native WETH index");
    return undefined;
  }
  if (!Number.isInteger(alias.nativeIndex) || alias.nativeIndex < 0 || alias.nativeIndex >= descriptor.coins.length ||
      !sameAddress(descriptor.coins[alias.nativeIndex], ADDR.WETH))
    throw new Error("curve-underlying invalid native alias binding");
  if (direction.i !== alias.nativeIndex && direction.j !== alias.nativeIndex) return undefined;
  return { input: direction.i === alias.nativeIndex ? "native" as const : "erc20" as const,
    output: direction.j === alias.nativeIndex ? "native" as const : "erc20" as const };
}

/** Emits only the raw protocol operation. The shared issuer owns ETH/WETH
 * conversion; both quoted and runtime paths retain exact approval cleanup,
 * current-input isolation and independent raw-output minimum checks. */
export function underlyingNativeAliasProgram(pool: string, tokenIn: string, tokenOut: string,
  i: number, j: number, actor: string, nativeIn: boolean, nativeOut: boolean, minimum = 1n,
  inputToleranceRawUnits = MAX_EXECUTION_ROUNDING_RAW_UNITS) {
  runtimeExecutor(actor, pool, tokenIn, tokenOut);
  assertExecutionRounding(inputToleranceRawUnits);
  if (![i, j].every(n => Number.isInteger(n) && n >= 0 && n < 8) || i === j || sameAddress(tokenIn, tokenOut) ||
      (nativeIn && nativeOut) || (nativeIn && !sameAddress(tokenIn, ADDR.WETH)) ||
      (nativeOut && !sameAddress(tokenOut, ADDR.WETH)) || minimum < 0n || minimum > ethers.MaxUint256)
    throw new Error("curve-underlying native alias program binding");
  const balance = RUNTIME_ERC20.encodeFunctionData("balanceOf", [actor]);
  const p = new RuntimeAmountProgram().constant(15, 0n);
  if (nativeIn) p.nativeBalance(4); else p.call(tokenIn, balance, { static: true }).load(4, 0);
  p.math("sub", 6, 4, 0);
  if (nativeOut) p.nativeBalance(5); else p.call(tokenOut, balance, { static: true }).load(5, 0);
  if (!nativeIn) runtimeExactApproval(p, tokenIn, pool);
  p.call(pool, CURVE_UNDERLYING_UINT_INTERFACE.encodeFunctionData("exchange_underlying", [i, j, 0n, minimum]),
    { patches: [{ offset: 68, reg: 0 }], ...(nativeIn ? { valueReg: 0 } : {}) });
  if (!nativeIn) runtimeClearApproval(p, tokenIn, pool);
  if (nativeIn) p.nativeBalance(1); else p.call(tokenIn, balance, { static: true }).load(1, 0);
  p.math("sub", 7, 4, 1).constant(2, 1n).math("sub", 7, 7, 2);
  p.math("sub", 1, 1, 6).constant(2, inputToleranceRawUnits).math("sub", 1, 2, 1);
  if (nativeOut) p.nativeBalance(1); else p.call(tokenOut, balance, { static: true }).load(1, 0);
  p.math("sub", 1, 1, 5).constant(2, minimum).math("sub", 1, 1, 2);
  if (!nativeIn) p.call(tokenIn, APPROVAL.encodeFunctionData("allowance", [actor, pool]), { static: true }).load(1, 0).equal(1, 15);
  return p;
}

export function underlyingNativeAliasProbe(pool: string, coins: readonly string[], alias: CurveUnderlyingNativeAlias,
  quote: CurveUnderlyingVerifiedDirection, actor: string, tolerance = 0n): AdapterRequest {
  const executionAssets = underlyingNativeAssets({ coins, nativeAlias: alias }, quote);
  const minimum = minimumExecutionOutput(quote.behaviorProbeAmountOut, tolerance);
  const program = underlyingNativeAliasProgram(pool, quote.tokenIn, quote.tokenOut, quote.i, quote.j, actor,
    executionAssets?.input === "native", executionAssets?.output === "native", minimum, tolerance);
  const caller = { kind: "executor" as const };
  return { id: `native-execution:${quote.i}:${quote.j}`, kind: "effect-delta-simulation", required: false,
    ...(executionAssets ? { executionAssetBoundary: { tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, executionAssets,
      amountIn: quote.behaviorProbeAmountIn, minimum } } : {}),
    call: { caller, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(program.bytes(), quote.behaviorProbeAmountIn)) },
    overrideIntent: { caller, tokenBalances: [{ token: quote.tokenIn, amount: quote.behaviorProbeAmountIn }] },
    observeTokenBalances: [quote.tokenIn, quote.tokenOut].map(token => ({ token, account: caller })),
    observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] };
}
