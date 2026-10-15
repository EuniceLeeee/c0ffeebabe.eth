import { ethers } from "ethers";
import { buildSubscriptCalldata } from "../../../../shared/executor/botvm-program-entry.js";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { executionOutputMatches, minimumExecutionOutput } from "../../../../shared/executor/amount-rounding.js";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { sameAddress } from "./codec.js";
import { underlyingNativeAliasProgram, underlyingNativeAssets } from "./native.js";
import type { CurveUnderlyingNativeAlias, CurveUnderlyingVerifiedDirection } from "./types.js";

// An isolated probe destination, never a pool admission list or a payer override.
export const UNDERLYING_PROBE_RECEIVER = ethers.getAddress("0x000000000000000000000000000000000000f182");
const caller = { kind: "executor" as const };
export function underlyingRecipientProbe(pool: string, coins: readonly string[], alias: CurveUnderlyingNativeAlias,
  quote: CurveUnderlyingVerifiedDirection, actor: string, tolerance: bigint): AdapterRequest {
  const assets = underlyingNativeAssets({ coins, nativeAlias: alias }, quote);
  if (assets?.output === "native") throw new Error("curve-underlying raw native output belongs to executor");
  const minimum = minimumExecutionOutput(quote.behaviorProbeAmountOut, tolerance);
  const program = underlyingNativeAliasProgram(pool, quote.tokenIn, quote.tokenOut, quote.i, quote.j,
    actor, assets?.input === "native", false, minimum > 0n ? minimum : 1n, 0n, UNDERLYING_PROBE_RECEIVER);
  return { id: `recipient-execution:${quote.i}:${quote.j}`, kind: "effect-delta-simulation", required: false,
    call: { caller, executionMode: "executor-program", to: actor,
      data: buildSubscriptCalldata(runtimeProgramScript(program.bytes(), quote.behaviorProbeAmountIn)) },
    overrideIntent: { caller, ...(assets?.input === "native" ? { nativeBalanceWei: quote.behaviorProbeAmountIn }
      : { tokenBalances: [{ token: quote.tokenIn, amount: quote.behaviorProbeAmountIn }] }) },
    observeTokenBalances: [caller, UNDERLYING_PROBE_RECEIVER].flatMap(account =>
      [quote.tokenIn, quote.tokenOut].map(token => ({ token, account }))),
    observe: ["return-data", "revert-data", "token-delta", "native-delta", "logs"] };
}
export function provesUnderlyingRecipient(results: readonly AdapterRequestResult[], quote: CurveUnderlyingVerifiedDirection,
  alias: CurveUnderlyingNativeAlias, actor: string, tolerance: bigint): boolean {
  const reads = results.filter(r => r.id === `recipient-execution:${quote.i}:${quote.j}`);
  if (reads.length !== 1) throw new Error("curve-underlying missing/duplicate recipient result");
  const read = reads[0];
  if (!read.ok || read.completion !== "returned" || read.data !== "0x") return false;
  const rows = read.effects?.tokenDeltas, native = read.effects?.nativeDeltas;
  const nativeIn = quote.i === alias.nativeIndex;
  if (rows?.length !== 4 || native?.length !== 1 || !sameAddress(native[0].account, actor) ||
      native[0].delta !== (nativeIn ? -quote.behaviorProbeAmountIn : 0n)) return false;
  return [actor, UNDERLYING_PROBE_RECEIVER].every(account => [quote.tokenIn, quote.tokenOut].every(token => {
    const cells = rows.filter(row => sameAddress(row.account, account) && sameAddress(row.token, token));
    if (cells.length !== 1) return false;
    if (sameAddress(account, UNDERLYING_PROBE_RECEIVER) && sameAddress(token, quote.tokenOut))
      return cells[0].delta > 0n && executionOutputMatches(cells[0].delta, quote.behaviorProbeAmountOut, tolerance);
    return cells[0].delta === (!nativeIn && sameAddress(account, actor) && sameAddress(token, quote.tokenIn)
      ? -quote.behaviorProbeAmountIn : 0n);
  }));
}
