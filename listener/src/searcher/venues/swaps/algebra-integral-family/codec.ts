import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";
import { ALGEBRA_POOL_INTERFACE } from "./abi.js";

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
  if (result === undefined) {
    throw new Error(`algebra-integral request result ${id} is missing`);
  }
  if (!result.ok) {
    throw new Error(
      `algebra-integral request result ${id} is unresolved: ${result.failure}`,
    );
  }
  if (result.completion !== "returned") {
    throw new Error(
      `algebra-integral request result ${id} did not return normally`,
    );
  }
  return result;
}

function word(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: string,
  index: number,
): bigint {
  const result = requireSuccessfulResult(results, id);
  return BigInt(
    ALGEBRA_POOL_INTERFACE.decodeFunctionResult(functionName, result.data)[
      index
    ],
  );
}

export function decodeAddressResult(
  results: readonly AdapterRequestResult[],
  id: string,
  iface: ethers.Interface,
  functionName: string,
): string {
  const result = requireSuccessfulResult(results, id);
  if (!ethers.isHexString(result.data) || ethers.dataLength(result.data) !== 32) {
    throw new Error(
      `algebra-integral request result ${id} has a non-canonical address shape`,
    );
  }
  // An `address` ABI result is already the canonical hex string; it must never
  // be routed through BigInt (that would emit a decimal literal).
  const decoded = iface.decodeFunctionResult(functionName, result.data)[0];
  return canonicalAddress(String(decoded));
}

export function decodeUint16Result(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: string,
): bigint {
  const value = word(results, id, functionName, 0);
  if (value < 0n || value > 0xffffn) {
    throw new Error(
      `algebra-integral request result ${id} has invalid uint16 ${value}`,
    );
  }
  return value;
}

export function decodeUint128Result(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: string,
): bigint {
  const value = word(results, id, functionName, 0);
  if (value < 0n || value > (1n << 128n) - 1n) {
    throw new Error(
      `algebra-integral request result ${id} has invalid uint128 ${value}`,
    );
  }
  return value;
}

export function decodeInt24Result(
  results: readonly AdapterRequestResult[],
  id: string,
  functionName: string,
  minimum: number,
): number {
  const value = Number(BigInt.asIntN(24, word(results, id, functionName, 0)));
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `algebra-integral request result ${id} has invalid int24 ${value}`,
    );
  }
  return value;
}

export interface AlgebraGlobalState {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly lastFee: bigint;
  readonly pluginConfig: number;
  readonly communityFee: number;
  readonly unlocked: boolean;
}

export function decodeGlobalStateResult(
  results: readonly AdapterRequestResult[],
  id: string,
): AlgebraGlobalState {
  const result = requireSuccessfulResult(results, id);
  const decoded = ALGEBRA_POOL_INTERFACE.decodeFunctionResult(
    "globalState",
    result.data,
  );
  const sqrtPriceX96 = BigInt(decoded[0]);
  const tick = Number(BigInt.asIntN(24, BigInt(decoded[1])));
  const lastFee = BigInt(decoded[2]);
  const pluginConfig = Number(decoded[3]);
  const communityFee = Number(decoded[4]);
  const unlocked = Boolean(decoded[5]);
  if (
    sqrtPriceX96 < 0n || sqrtPriceX96 >= 1n << 160n ||
    !Number.isSafeInteger(tick) ||
    lastFee < 0n || lastFee > 0xffffn ||
    !Number.isInteger(pluginConfig) || pluginConfig < 0 || pluginConfig > 0xff ||
    !Number.isInteger(communityFee) || communityFee < 0 ||
    communityFee > 0xffff
  ) {
    throw new Error("algebra-integral globalState is non-canonical");
  }
  return Object.freeze({
    sqrtPriceX96,
    tick,
    lastFee,
    pluginConfig,
    communityFee,
    unlocked,
  });
}
