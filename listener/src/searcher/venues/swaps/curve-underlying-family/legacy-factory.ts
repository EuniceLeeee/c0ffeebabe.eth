import { ethers } from "ethers";
import { canonicalAddress } from "./codec.js";

// Historical Curve factory: the getters read its pool_data registration.
// This is an infrastructure identity source, never a pool-address allowlist.
export const CURVE_LEGACY_FACTORY = ethers.getAddress("0xB9fC157394Af804a3578134A6585C0dc9cc990d4");
export const CURVE_LEGACY_FACTORY_INTERFACE = new ethers.Interface([
  "function get_base_pool(address pool) view returns (address)",
  "function get_underlying_coins(address pool) view returns (address[8])",
]);
export const CURVE_LEGACY_FACTORY_LOOKUP = "get_base_pool+get_underlying_coins" as const;

export function decodeLegacyFactoryBasePool(data: string): string {
  if (!ethers.isHexString(data, 32)) throw new Error("curve-underlying invalid factory base pool");
  const decoded = CURVE_LEGACY_FACTORY_INTERFACE.decodeFunctionResult("get_base_pool", data);
  if (CURVE_LEGACY_FACTORY_INTERFACE.encodeFunctionResult("get_base_pool", decoded).toLowerCase() !== data.toLowerCase()) {
    throw new Error("curve-underlying noncanonical factory base pool");
  }
  return canonicalAddress(String(decoded[0]));
}

export function decodeLegacyFactoryCoins(data: string): readonly string[] {
  if (!ethers.isHexString(data, 8 * 32)) throw new Error("curve-underlying invalid factory coins");
  const decoded = CURVE_LEGACY_FACTORY_INTERFACE.decodeFunctionResult("get_underlying_coins", data);
  if (CURVE_LEGACY_FACTORY_INTERFACE.encodeFunctionResult("get_underlying_coins", decoded).toLowerCase() !== data.toLowerCase()) {
    throw new Error("curve-underlying noncanonical factory coins");
  }
  const coins: string[] = [];
  let ended = false;
  const seen = new Set<string>();
  for (const value of decoded[0] as readonly string[]) {
    const coin = canonicalAddress(value);
    if (coin === ethers.ZeroAddress) { ended = true; continue; }
    if (ended || seen.has(coin.toLowerCase())) throw new Error("curve-underlying ambiguous factory coin indices");
    seen.add(coin.toLowerCase());
    coins.push(coin);
  }
  return Object.freeze(coins);
}
