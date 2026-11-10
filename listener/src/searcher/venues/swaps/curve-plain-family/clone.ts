import { ethers } from "ethers";
import { isNativeCoin, lower } from "./codec.js";

// Curve factory clone runtime (51 bytes). This is deliberately NOT the generic
// EIP-1167 template: the factory proxy copies a fixed 0x1000-byte calldata
// window and returns 0x1000 bytes, so it never matches 363d3d...5af43d...:
//   36 6000 6000 37 611000 6000 36 6000 73 <impl> 5a f4 602c 57 6000 80 fd
//   5b 611000 6000 f3
const CLONE_PREFIX = "3660006000376110006000366000";
const CLONE_SUFFIX = "5af4602c57600080fd5b6110006000f3";
export const CLONE_RUNTIME_BYTES = 51;

// Implementation runtime class for the Curve factory clone that backs
// 0xBd184cD60AF678633b3072FD0B47b5D4b7a072f3 (noteUSD). This is a code-hash
// class pin, never an address allowlist: the proxy template above carries the
// implementation address, but admission requires the delegated runtime at the
// identity source block to hash to this exact class.
// Source: eth_getCode(0x5F890841f657d90E081bAbdB532A05996Af79Fe6, 26244837)
// = 24,407-byte Vyper runtime, keccak256:
export const CLONE_IMPLEMENTATION_CLASS_HASH =
  "0x260a286cc14e91f4a2d4a966e2e5f5030543a7d2f090a623f5fa15ba174a50f3";

// Direct-coin state surface read through the proxy. `lp_token` and `base_pool`
// are intentionally probed even though this implementation does not expose
// them: their chain-proven revert is the self-LP / no-underlying-domain fact.
export const CLONE_POOL = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function lp_token() view returns (address)",
  "function base_pool() view returns (address)",
]);
export const READ_FEE_DENOMINATOR = 10_000_000_000n;

export interface CloneRuntime {
  readonly implementation: string;
  readonly codeHash: string;
}

/** Exact Curve factory clone template, with the implementation address read
 * out of the runtime rather than supplied by the candidate or an allowlist. */
export function cloneImplementation(runtime: string): CloneRuntime | null {
  if (!ethers.isHexString(runtime) || runtime.length !== 2 + CLONE_RUNTIME_BYTES * 2) return null;
  const body = runtime.slice(2).toLowerCase();
  if (!body.startsWith(CLONE_PREFIX) || !body.endsWith(CLONE_SUFFIX) ||
      body.slice(CLONE_PREFIX.length, CLONE_PREFIX.length + 2) !== "73") return null;
  const implementation = body.slice(CLONE_PREFIX.length + 2, CLONE_PREFIX.length + 2 + 40);
  if (!/^[0-9a-f]{40}$/.test(implementation) || implementation === "0".repeat(40)) return null;
  return Object.freeze({ implementation: ethers.getAddress(`0x${implementation}`),
    codeHash: ethers.keccak256(runtime) });
}

/** Build the observed template for tests/evidence; not an admission input. */
export function cloneRuntime(implementation: string): string {
  if (!ethers.isAddress(implementation)) throw new Error("curve-plain clone implementation address");
  return `0x${CLONE_PREFIX}73${lower(implementation).slice(2)}${CLONE_SUFFIX}`;
}

/** Exactly two distinct, non-native ERC20 coins. The direct `coins(uint256)`
 * surface (not the signed alias) is required separately by the identity. */
export function cloneCoinDomain(coins: readonly string[]): boolean {
  return coins.length === 2 &&
    new Set(coins.map(coin => lower(coin))).size === 2 &&
    coins.every(coin => ethers.isAddress(coin) && coin !== ethers.ZeroAddress && !isNativeCoin(coin));
}
