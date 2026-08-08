import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";

export const UNIV3_POOL_CREATED_PATTERN_ID = "univ3-pool-created";
export const UNIV3_SWAP_CALL_PATTERN_ID = "univ3-pool-swap-call";
export const UNIV3_SWAP_LOG_PATTERN_ID = "univ3-pool-swap-log";
export const PANCAKE_V3_SWAP_LOG_PATTERN_ID = "pancake-v3-pool-swap-log";
export const UNIV3_INITIALIZE_LOG_PATTERN_ID = "univ3-pool-initialize-log";
export const UNIV3_MINT_LOG_PATTERN_ID = "univ3-pool-mint-log";
export const UNIV3_BURN_LOG_PATTERN_ID = "univ3-pool-burn-log";

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value).toLowerCase();
}

export function sameAddress(left: string, right: string): boolean {
  return lowerAddress(left) === lowerAddress(right);
}

export function requireSuccessfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`univ3 request result ${id} is missing`);
  if (!result.ok) {
    throw new Error(`univ3 request result ${id} is unresolved: ${result.failure}`);
  }
  if (result.completion !== "returned") {
    throw new Error(`univ3 request result ${id} did not return normally`);
  }
  return result;
}

export function decodeAddressResult(
  results: readonly AdapterRequestResult[],
  id: string,
  iface: ethers.Interface,
  functionName: string,
): string {
  const result = requireSuccessfulResult(results, id);
  if (!ethers.isHexString(result.data) || ethers.dataLength(result.data) !== 32) {
    throw new Error(`univ3 request result ${id} has a non-canonical address shape`);
  }
  return canonicalAddress(String(
    iface.decodeFunctionResult(functionName, result.data)[0],
  ));
}

export function decodeUint24Result(
  results: readonly AdapterRequestResult[],
  id: string,
  iface: ethers.Interface,
  functionName: string,
): bigint {
  const result = requireSuccessfulResult(results, id);
  const value = BigInt(iface.decodeFunctionResult(functionName, result.data)[0]);
  if (value < 0n || value > 0xff_ffffn) {
    throw new Error(`univ3 request result ${id} has invalid uint24 ${value}`);
  }
  return value;
}

export function decodePositiveInt24Result(
  results: readonly AdapterRequestResult[],
  id: string,
  iface: ethers.Interface,
  functionName: string,
): number {
  const result = requireSuccessfulResult(results, id);
  const value = Number(iface.decodeFunctionResult(functionName, result.data)[0]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7f_ffff) {
    throw new Error(`univ3 request result ${id} has invalid tick spacing ${value}`);
  }
  return value;
}
