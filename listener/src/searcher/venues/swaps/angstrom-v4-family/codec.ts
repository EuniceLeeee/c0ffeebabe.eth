import { ethers } from "ethers";
import type { V4PoolKey } from "../../../planner/token-graph.js";
import type {
  AdapterRequestResult,
  CanonicalSource,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import { normalizeV4PoolKey, v4PoolId } from "../univ4-common.js";

export const ANGSTROM_INITIALIZE_PATTERN_ID =
  "angstrom-v4-pool-initialize";
export const ANGSTROM_SWAP_CALL_PATTERN_ID = "angstrom-v4-adapter-swap-call";
export const ANGSTROM_SWAP_LOG_PATTERN_ID = "angstrom-v4-manager-swap-log";

export function canonicalAddress(value: string): string {
  return ethers.getAddress(value);
}

export function sameAddress(left: string, right: string): boolean {
  return canonicalAddress(left) === canonicalAddress(right);
}

export function canonicalPoolId(value: string): string {
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`angstrom-v4 poolId must be bytes32, got ${value}`);
  }
  return value.toLowerCase();
}

export function canonicalPoolKey(value: V4PoolKey): V4PoolKey {
  const key = normalizeV4PoolKey(value, "strict angstrom-v4 PoolKey");
  if (BigInt(key.currency0) >= BigInt(key.currency1)) {
    throw new Error("angstrom-v4 PoolKey requires currency0 < currency1");
  }
  if (
    sameAddress(key.currency0, ethers.ZeroAddress) ||
    sameAddress(key.currency1, ethers.ZeroAddress)
  ) {
    throw new Error("angstrom-v4 official adapter excludes native currency");
  }
  return Object.freeze({ ...key });
}

export function assertPoolKeyIdentity(poolId: string, key: V4PoolKey): void {
  if (canonicalPoolId(poolId) !== v4PoolId(key)) {
    throw new Error("angstrom-v4 PoolKey reverse binding does not match poolId");
  }
}

export function poolKeyProjection(key: V4PoolKey) {
  return {
    currency0: key.currency0,
    currency1: key.currency1,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
  };
}

export function poolKeyFingerprint(key: V4PoolKey): string {
  return hashCanonical(poolKeyProjection(key));
}

export function requireSuccessfulResult(
  results: readonly AdapterRequestResult[],
  id: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  const result = results.find((candidate) => candidate.id === id);
  if (result === undefined) {
    throw new Error(`angstrom-v4 request result ${id} is missing`);
  }
  if (!result.ok) {
    throw new Error(
      `angstrom-v4 request result ${id} is unresolved: ${result.failure}`,
    );
  }
  if (result.completion !== "returned") {
    throw new Error(`angstrom-v4 request result ${id} did not return normally`);
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
    throw new Error("angstrom-v4 request results came from different sources");
  }
}

export function requireCodeHash(
  results: readonly AdapterRequestResult[],
  id: string,
): string {
  const result = requireSuccessfulResult(results, id);
  if (!ethers.isHexString(result.data) || ethers.dataLength(result.data) === 0) {
    throw new Error(`angstrom-v4 identity ${id} returned empty or malformed code`);
  }
  return ethers.keccak256(result.data);
}

export function decodeStorageAddress(word: bigint, label: string): string {
  if (word < 0n || word >= (1n << 256n)) {
    throw new Error(`angstrom-v4 ${label} does not fit one storage word`);
  }
  return canonicalAddress(ethers.dataSlice(ethers.toBeHex(word, 32), 12));
}
