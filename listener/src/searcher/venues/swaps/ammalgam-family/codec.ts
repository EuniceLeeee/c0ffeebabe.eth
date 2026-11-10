import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import {
  assertSameSource,
  assertSource,
  callRequest,
  codeRequest,
  returnedResult,
} from "../../protocols/standard-family/common.js";
import type { Binding } from "./types.js";

/**
 * Verified runtime profile.
 *
 * Both hashes are the deployed runtime code of the sample pair's beacon proxy
 * and of the beacon implementation, cross-checked against the Sourcify
 * `AmmalgamPair.sol` / `PairBeaconProxy.sol` runtime matches. They are runtime
 * profiles, not an instance allowlist: every pair admitted through this family
 * must expose this exact proxy and implementation code.
 */
export const PROXY_CODE_HASH = "0xe3b889bc11084bf4064b8062e4e7fbc36046436c9837f3e1ea3f4a0459f187bd";
export const IMPLEMENTATION_CODE_HASH = "0x9e85aaed826aa52993f59cf877d060efaee072dea6f14dc3354cf0d6596f98ca";

/** OpenZeppelin BeaconProxy beacon slot observed on the deployed proxy. */
export const PROXY_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
/** ERC-1967 implementation slot (beacon proxy caches the implementation here). */
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
export const UINT256_MAX = ethers.MaxUint256;

/** Ammalgam token-controller token-type indices. */
export const DEPOSIT_X = 1;
export const DEPOSIT_Y = 2;
export const BORROW_X = 4;
export const BORROW_Y = 5;
export const ASSET_COUNT = 6;

/** Verified constants from AmmalgamPair / QuadraticSwapFees / constants.sol. */
export const BIPS = 10_000n;
/** 10000 bips in Q64. */
export const BIPS_Q64 = 0x27100000000000000000n;
/** `N_TIMES_BIPS_Q64_PER_PERCENT`: 20 * 100 * Q64, the quadratic fee slope. */
export const FEE_SLOPE_Q64 = 0x7d00000000000000000n;
/** QuadraticSwapFees.MIN_FEE_Q64: one tenth of a basis point. */
export const MIN_FEE_Q64 = 0x1999999999999999n;
export const MAX_QUADRATIC_FEE_BIPS = 4_000n;
/** `MAX_QUADRATIC_FEE_PERCENT * Q64`. */
export const MAX_QUADRATIC_FEE_Q64 = 0x280000000000000000n;
/** 2 * Q64. */
export const TWO_Q64 = 0x20000000000000000n;
export const FEE_N = 20n;
export const BUFFER = 19n;
export const BUFFER_NUMERATOR = 20n;
export const INTEREST_PERIOD_FOR_SWAP = 86_399n;

export const PAIR = new ethers.Interface([
  "function getReserves() view returns (uint112 reserveXAssets,uint112 reserveYAssets,uint32 lastUpdateTimestamp)",
  "function referenceReserves() view returns (uint112 referenceReserveX,uint112 referenceReserveY)",
  "function totalAssetsAndShares(bool withInterest) view returns (uint112[6] allAssets,uint112[6] allShares)",
  "function underlyingTokens() view returns (address tokenX,address tokenY)",
  "function externalLiquidity() view returns (uint112)",
  "function swap(uint256 amountXOut,uint256 amountYOut,address to,bytes data)",
  "event Swap(address indexed sender,uint256 amountXIn,uint256 amountYIn,uint256 amountXOut,uint256 amountYOut,address indexed to)",
  "event Sync(uint256 reserveXAssets,uint256 reserveYAssets)",
]);

export const BEACON = new ethers.Interface(["function implementation() view returns (address)"]);

export const TOKEN = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

export const SWAP_EVENT = PAIR.getEvent("Swap")!;
export const SYNC_EVENT = PAIR.getEvent("Sync")!;
export const SWAP_SELECTOR = PAIR.getFunction("swap")!.selector;
export const SWAP_TOPIC = SWAP_EVENT.topicHash;

export function address(value: string): string {
  const out = ethers.getAddress(value).toLowerCase();
  if (out === ZERO_ADDRESS) throw new Error("ammalgam zero address");
  return out;
}

export function amount(value: bigint, zero = false): bigint {
  if (typeof value !== "bigint" || value < (zero ? 0n : 1n) || value > UINT256_MAX) {
    throw new Error("ammalgam uint256 amount");
  }
  return value;
}

/** Stable instance identity: one pair address, ordered by the pair's own tokens. */
export const key = (binding: Pick<Binding, "pair" | "tokenX" | "tokenY">) =>
  `${binding.pair}:${binding.tokenX}:${binding.tokenY}`;

export const bindingKey = (pair: string) => address(pair);

export function storageRequest(id: string, address_: string, slot: string): AdapterRequest {
  return { id, kind: "get-storage", address: ethers.getAddress(address_), slot };
}

export function call(id: string, to: string, fn: string, args: readonly unknown[] = []): AdapterRequest {
  return callRequest(id, to, PAIR.encodeFunctionData(fn, args));
}

export function tokenCall(id: string, to: string, fn: string, args: readonly unknown[] = []): AdapterRequest {
  return callRequest(id, to, TOKEN.encodeFunctionData(fn, args));
}

export function beaconCall(id: string, to: string): AdapterRequest {
  return callRequest(id, to, BEACON.encodeFunctionData("implementation"));
}

export function code(id: string, addr: string): AdapterRequest {
  return codeRequest(id, addr);
}

export function sourceOf(
  results: readonly AdapterRequestResult[],
  expected?: CanonicalSource,
): CanonicalSource {
  if (new Set(results.map(result => result.id)).size !== results.length) {
    throw new Error("ammalgam duplicate result id");
  }
  const source = assertSameSource(results.map(result => returnedResult(results, result.id)));
  if (expected) assertSource(source, expected);
  return source;
}

/** Decode one ABI result and reject any non-canonical re-encoding. */
export function read(
  results: readonly AdapterRequestResult[],
  id: string,
  iface: ethers.Interface,
  fn: string,
): ethers.Result {
  const data = returnedResult(results, id).data;
  const decoded = iface.decodeFunctionResult(fn, data);
  if (iface.encodeFunctionResult(fn, decoded).toLowerCase() !== data.toLowerCase()) {
    throw new Error(`ammalgam noncanonical ${id} return`);
  }
  return decoded;
}

export function storageWord(results: readonly AdapterRequestResult[], id: string): string {
  const data = returnedResult(results, id).data;
  if (!ethers.isHexString(data, 32)) throw new Error(`ammalgam non-word storage ${id}`);
  return data.toLowerCase();
}

export function storageAddress(results: readonly AdapterRequestResult[], id: string): string {
  const word = storageWord(results, id);
  if (BigInt(word) >= 1n << 160n) throw new Error(`ammalgam non-address storage ${id}`);
  return ethers.toBeHex(BigInt(word), 20).toLowerCase();
}

export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("ammalgam malformed uint");
  return BigInt(data);
}
