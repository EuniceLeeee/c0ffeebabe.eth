import { ethers } from "ethers";
import { ADDR } from "../../../../shared/constants/addresses.js";
import type { V4PoolKey } from "../../../planner/token-graph.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  normalizeV4PoolKey,
  rejectNativeWethV4Pool,
  v4PoolId,
} from "../univ4-common.js";

export const UNIV4_INITIALIZE_PATTERN_ID = "univ4-pool-initialize";
export const UNIV4_SWAP_CALL_PATTERN_ID = "univ4-manager-swap-call";
export const UNIV4_SWAP_LOG_PATTERN_ID = "univ4-manager-swap-log";
export const UNIV4_MODIFY_LIQUIDITY_PATTERN_ID =
  "univ4-manager-modify-liquidity";
export const UNIV4_POOL_SURFACE_PATTERN_ID = "univ4-pool-surface";

/**
 * One id per discovery pattern a UniV4-shaped Family declares. A family must
 * own its ids: the landed-event registry keys shared event surfaces by id, so
 * two families observing the same topics (standard univ4 vs the fee-hook
 * family) must never reuse another family's pattern ids.
 */
export interface UniV4PatternIds {
  readonly initialize: string;
  readonly swapCall: string;
  readonly swapLog: string;
  readonly modifyLiquidity: string;
  readonly poolSurface: string;
}

export const UNIV4_PATTERN_IDS: UniV4PatternIds = Object.freeze({
  initialize: UNIV4_INITIALIZE_PATTERN_ID,
  swapCall: UNIV4_SWAP_CALL_PATTERN_ID,
  swapLog: UNIV4_SWAP_LOG_PATTERN_ID,
  modifyLiquidity: UNIV4_MODIFY_LIQUIDITY_PATTERN_ID,
  poolSurface: UNIV4_POOL_SURFACE_PATTERN_ID,
});

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function lowerAddress(value: string): string {
  return canonicalAddress(value).toLowerCase();
}

export function sameAddress(left: string, right: string): boolean {
  return lowerAddress(left) === lowerAddress(right);
}

export function canonicalPoolId(value: string): string {
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`univ4 poolId must be bytes32, got ${value}`);
  }
  return value.toLowerCase();
}

export function canonicalPoolKey(value: V4PoolKey): V4PoolKey {
  const key = normalizeV4PoolKey(value, "strict univ4 PoolKey");
  if (BigInt(key.currency0) >= BigInt(key.currency1)) {
    throw new Error("strict univ4 PoolKey requires currency0 < currency1");
  }
  rejectNativeWethV4Pool(key, "strict univ4 PoolKey");
  return Object.freeze({ ...key });
}

export function assertPoolKeyIdentity(
  poolId: string,
  poolKey: V4PoolKey,
): void {
  if (canonicalPoolId(poolId) !== v4PoolId(poolKey)) {
    throw new Error("univ4 PoolKey reverse binding does not match poolId");
  }
}

export function graphCurrency(currency: string): string {
  return sameAddress(currency, ethers.ZeroAddress)
    ? canonicalAddress(ADDR.WETH)
    : canonicalAddress(currency);
}

export function poolKeyProjection(poolKey: V4PoolKey) {
  return {
    currency0: poolKey.currency0,
    currency1: poolKey.currency1,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: poolKey.hooks,
  };
}

export function poolKeyFingerprint(poolKey: V4PoolKey): string {
  return hashCanonical(poolKeyProjection(poolKey));
}

export function requireSuccessfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`univ4 request result ${id} is missing`);
  if (!result.ok) {
    throw new Error(`univ4 request result ${id} is unresolved: ${result.failure}`);
  }
  if (result.completion !== "returned") {
    throw new Error(`univ4 request result ${id} did not return normally`);
  }
  return result;
}

export function assertSameSource(
  left: CanonicalSource,
  right: CanonicalSource,
): void {
  if (
    left.number !== right.number ||
    left.hash.toLowerCase() !== right.hash.toLowerCase() ||
    left.generation !== right.generation
  ) {
    throw new Error("univ4 request results came from different sources");
  }
}

export function requireCodeHash(
  results: readonly AdapterRequestResult[],
  id: string,
): string {
  const result = requireSuccessfulResult(results, id);
  if (!ethers.isHexString(result.data) || ethers.dataLength(result.data) === 0) {
    throw new Error(`univ4 identity ${id} returned empty or malformed code`);
  }
  return ethers.keccak256(result.data);
}
