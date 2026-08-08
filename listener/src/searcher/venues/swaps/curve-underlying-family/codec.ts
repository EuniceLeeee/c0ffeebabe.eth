import { ethers } from "ethers";
import type { AdapterRequestResult } from "../../adapter-request-program.js";

export const CURVE_METAREGISTRY = ethers.getAddress(
  "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC",
);

export const CURVE_UNDERLYING_META_INTERFACE = new ethers.Interface([
  "function get_registry_handlers_from_pool(address pool) view returns (address[10])",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
  "function get_underlying_balances(address pool) view returns (uint256[8])",
]);

export const CURVE_UNDERLYING_POOL_INTERFACE = new ethers.Interface([
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 minDy)",
]);

export const CURVE_UNDERLYING_UINT_INTERFACE = new ethers.Interface([
  "function exchange_underlying(uint256 i, uint256 j, uint256 dx, uint256 minDy)",
]);

export const CURVE_UNDERLYING_ERC20_INTERFACE = new ethers.Interface([
  "function decimals() view returns (uint8)",
]);

export const CURVE_UNDERLYING_I128_SWAP_TOPIC = ethers.id(
  "TokenExchangeUnderlying(address,int128,uint256,int128,uint256)",
).toLowerCase();
export const CURVE_UNDERLYING_UINT_SWAP_TOPIC = ethers.id(
  "TokenExchangeUnderlying(address,uint256,uint256,uint256,uint256)",
).toLowerCase();
export const CURVE_UNDERLYING_I128_SELECTOR =
  CURVE_UNDERLYING_POOL_INTERFACE.getFunction("exchange_underlying")!
    .selector.toLowerCase() as `0x${string}`;
export const CURVE_UNDERLYING_UINT_SELECTOR =
  CURVE_UNDERLYING_UINT_INTERFACE.getFunction("exchange_underlying")!
    .selector.toLowerCase() as `0x${string}`;

export const CURVE_BEHAVIOR_PROBE_AMOUNTS = Object.freeze([
  1n,
  1_000_000n,
  1_000_000_000_000_000_000n,
]);

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
    throw new Error(`curve-underlying result ${id} is missing`);
  }
  if (!result.ok) {
    throw new Error(`curve-underlying unresolved: ${result.failure}`);
  }
  if (result.completion !== "returned") {
    throw new Error(`curve-underlying ${id} unexpectedly completed by revert`);
  }
  return result;
}

export function normalizeAddressArray(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const address = canonicalAddress(value);
    if (address === ethers.ZeroAddress) break;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(address);
  }
  return Object.freeze(output);
}

export function decodeHandlers(data: string): readonly string[] {
  return normalizeAddressArray(Array.from(
    CURVE_UNDERLYING_META_INTERFACE.decodeFunctionResult(
      "get_registry_handlers_from_pool",
      data,
    )[0] as readonly string[],
    String,
  ));
}

export function decodeUnderlyingCoins(data: string): readonly string[] {
  return normalizeAddressArray(Array.from(
    CURVE_UNDERLYING_META_INTERFACE.decodeFunctionResult(
      "get_underlying_coins",
      data,
    )[0] as readonly string[],
    String,
  ));
}

export function decodeUnderlyingDecimals(data: string): readonly bigint[] {
  return Object.freeze(Array.from(
    CURVE_UNDERLYING_META_INTERFACE.decodeFunctionResult(
      "get_underlying_decimals",
      data,
    )[0] as readonly bigint[],
    BigInt,
  ));
}

export function decodeUnderlyingBalances(data: string): readonly bigint[] {
  return Object.freeze(Array.from(
    CURVE_UNDERLYING_META_INTERFACE.decodeFunctionResult(
      "get_underlying_balances",
      data,
    )[0] as readonly bigint[],
    BigInt,
  ));
}

export function decodeTokenDecimals(data: string): number {
  const value = Number(
    CURVE_UNDERLYING_ERC20_INTERFACE.decodeFunctionResult("decimals", data)[0],
  );
  if (!Number.isSafeInteger(value) || value < 0 || value > 36) {
    throw new Error(`curve-underlying token returned invalid decimals ${value}`);
  }
  return value;
}

export function decodeGetDy(data: string): bigint {
  return BigInt(
    CURVE_UNDERLYING_POOL_INTERFACE.decodeFunctionResult(
      "get_dy_underlying",
      data,
    )[0],
  );
}

export function decodeUnderlyingIndicesFromCall(data: string): {
  readonly i: number;
  readonly j: number;
} | null {
  const selector = data.slice(0, 10).toLowerCase();
  const iface = selector === CURVE_UNDERLYING_I128_SELECTOR
    ? CURVE_UNDERLYING_POOL_INTERFACE
    : selector === CURVE_UNDERLYING_UINT_SELECTOR
    ? CURVE_UNDERLYING_UINT_INTERFACE
    : null;
  if (iface === null) return null;
  const decoded = iface.decodeFunctionData("exchange_underlying", data);
  const i = Number(decoded[0]);
  const j = Number(decoded[1]);
  return Number.isSafeInteger(i) && Number.isSafeInteger(j)
    ? Object.freeze({ i, j })
    : null;
}

export function assertSameSource(
  results: readonly Extract<AdapterRequestResult, { readonly ok: true }>[],
): void {
  const first = results[0]?.source;
  if (first === undefined) throw new Error("curve-underlying result set is empty");
  for (const result of results) {
    if (
      result.source.number !== first.number ||
      result.source.generation !== first.generation ||
      result.source.hash.toLowerCase() !== first.hash.toLowerCase()
    ) {
      throw new Error("curve-underlying results came from mixed sources");
    }
  }
}
