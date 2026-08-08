import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_INTERFACE,
} from "../univ2-abi.js";
export {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_TOPIC,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SWAP_SELECTOR,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_TOPIC,
} from "../univ2-abi.js";

export const UNIV2_PAIR_CREATED_PATTERN_ID = "univ2-pair-created";
export const UNIV2_SWAP_CALL_PATTERN_ID = "univ2-pair-swap-call";
export const UNIV2_SWAP_LOG_PATTERN_ID = "univ2-pair-swap-log";
export const UNIV2_SYNC_LOG_PATTERN_ID = "univ2-pair-sync-log";

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function sameAddress(left: string, right: string): boolean {
  return canonicalAddress(left) === canonicalAddress(right);
}

export function requireSuccessfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`univ2 request result ${id} is missing`);
  if (!result.ok) {
    throw new Error(`univ2 request result ${id} is unresolved: ${result.failure}`);
  }
  if (result.completion !== "returned") {
    throw new Error(`univ2 request result ${id} did not return normally`);
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
    throw new Error(`univ2 request result ${id} has a non-canonical address shape`);
  }
  return canonicalAddress(String(
    iface.decodeFunctionResult(functionName, result.data)[0],
  ));
}

export function decodeReservesResult(
  results: readonly AdapterRequestResult[],
  id: string,
): {
  readonly source: Extract<AdapterRequestResult, { readonly ok: true }>["source"];
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockTimestampLast: number;
} {
  const result = requireSuccessfulResult(results, id);
  if (!ethers.isHexString(result.data) || ethers.dataLength(result.data) !== 96) {
    throw new Error(`univ2 request result ${id} has a non-canonical reserves shape`);
  }
  const decoded = UNIV2_PAIR_INTERFACE.decodeFunctionResult(
    "getReserves",
    result.data,
  );
  const reserve0 = BigInt(decoded[0]);
  const reserve1 = BigInt(decoded[1]);
  const blockTimestampLast = Number(decoded[2]);
  if (!Number.isSafeInteger(blockTimestampLast) || blockTimestampLast < 0) {
    throw new Error(`univ2 request result ${id} has an invalid timestamp`);
  }
  return Object.freeze({
    source: result.source,
    reserve0,
    reserve1,
    blockTimestampLast,
  });
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value).toLowerCase();
}
