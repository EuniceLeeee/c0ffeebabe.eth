import { ethers } from "ethers";
import { canonicalAddress } from "./codec.js";
import { decodeLegacyFactoryCoins } from "./legacy-factory.js";

// The V1 factory owns pool_data populated only by deploy_metapool. Unlike the
// later factory it has no get_base_pool getter and is not in MetaRegistry.
export const CURVE_V1_FACTORY = ethers.getAddress("0xfd6f33a0509ec67defc500755322abd9df1bd5b8");
export const CURVE_V1_FACTORY_CODE_HASH = "0x5461dc0d8c266670a5479a18d78991b1fa0f4b0fe3c4d6f9492b09698b440276";
export const CURVE_V1_FACTORY_LOOKUP = "get_coins+get_underlying_coins" as const;
export const CURVE_V1_FACTORY_INTERFACE = new ethers.Interface([
  "function get_coins(address pool) view returns (address[2])",
  "function get_underlying_coins(address pool) view returns (address[8])",
]);

export function assertV1FactoryCode(code: string): void {
  if (!ethers.isHexString(code) || ethers.keccak256(code).toLowerCase() !== CURVE_V1_FACTORY_CODE_HASH) {
    throw new Error("curve-underlying V1 factory is not the bound runtime");
  }
}
export function decodeV1FactoryWrappedCoins(data: string): readonly string[] {
  if (!ethers.isHexString(data, 64)) throw new Error("curve-underlying invalid V1 wrapped coins");
  const decoded = CURVE_V1_FACTORY_INTERFACE.decodeFunctionResult("get_coins", data);
  if (CURVE_V1_FACTORY_INTERFACE.encodeFunctionResult("get_coins", decoded).toLowerCase() !== data.toLowerCase()) {
    throw new Error("curve-underlying noncanonical V1 wrapped coins");
  }
  const coins = Array.from(decoded[0] as readonly string[], canonicalAddress);
  if (coins.every(coin => coin === ethers.ZeroAddress)) return Object.freeze(coins);
  if (coins.includes(ethers.ZeroAddress) || coins[0] === coins[1]) {
    throw new Error("curve-underlying ambiguous V1 wrapped coins");
  }
  return Object.freeze(coins);
}
export function decodeV1FactoryRegistration(wrappedData: string, underlyingData: string) {
  const wrappedCoins = decodeV1FactoryWrappedCoins(wrappedData);
  const coins = decodeLegacyFactoryCoins(underlyingData);
  if (wrappedCoins[0] === ethers.ZeroAddress ? coins.length !== 0
    : coins.length < 2 || coins[0] !== wrappedCoins[0]) {
    throw new Error("curve-underlying V1 registration topology mismatch");
  }
  return { wrappedCoins, coins };
}
