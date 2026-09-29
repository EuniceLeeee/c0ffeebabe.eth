import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSameSource, callRequest, codeRequest, requireRuntimeCode, returnedResult, successfulResult } from "../standard-family/common.js";
import { provePlainConversionAssetRuntime } from "./asset-runtime.js";
import { ABI, MAX_UINT, positiveAmount, proveBearRuntime } from "./variants.js";
import type { ConversionDescriptor, Direction } from "./types.js";

export interface BearState { readonly source: CanonicalSource; readonly supply: bigint; readonly backing: bigint }
export function bearStateRequests(prefix: string, d: ConversionDescriptor) {
  return [codeRequest(`${prefix}-code`, d.target), codeRequest(`${prefix}-asset-code`, d.asset),
    callRequest(`${prefix}-stats`, d.target, ABI.encodeFunctionData("getStats"))];
}
export function decodeBearState(prefix: string, d: ConversionDescriptor, results: readonly AdapterRequestResult[]): BearState {
  if (d.variant !== "btb-bear-v1") throw new Error("bear state received another conversion variant");
  const source = assertSameSource(results.map(r => successfulResult(results, r.id)));
  if (proveBearRuntime(requireRuntimeCode(results, `${prefix}-code`), d.target, d.asset) !== d.codeHash)
    throw new Error("conversion runtime changed");
  if (provePlainConversionAssetRuntime(requireRuntimeCode(results, `${prefix}-asset-code`), d.asset) !== d.assetCodeHash)
    throw new Error("conversion asset runtime changed");
  const stats = ABI.decodeFunctionResult("getStats", returnedResult(results, `${prefix}-stats`).data);
  return { source, backing: BigInt(stats[0]), supply: BigInt(stats[1]) };
}
export function bearCapacity(s: BearState, direction: Direction): bigint {
  for (const value of [s.supply, s.backing])
    if (typeof value !== "bigint" || value < 0n || value > MAX_UINT) throw new Error("invalid bear uint256 state");
  if (direction === "mint") return MAX_UINT - (s.supply > s.backing ? s.supply : s.backing);
  if (direction === "redeem") return s.supply < s.backing ? s.supply : s.backing;
  throw new Error("invalid bear conversion direction");
}
export function quoteBear(s: BearState, direction: Direction, amountIn: bigint): bigint {
  positiveAmount(amountIn);
  if (amountIn > bearCapacity(s, direction)) throw new Error("bear conversion capacity exceeded");
  // mint uses _mint, redeem uses _burn: neither calls the 1% transfer override.
  // Funds/allowance arrive from the route; final execution still verifies them.
  return amountIn;
}
