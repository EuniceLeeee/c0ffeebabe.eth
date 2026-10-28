import { ethers } from "ethers";
import { address } from "./codec.js";
import type { ProxyBinding } from "./types.js";
// Exact verified Solidity 0.6.12 proxy runtime, with only its five immutable
// words variable. This proves appended ProxyData and factory-selected delegatecall.
// No storage-dispatched or ABI-compatible proxy is inferred to share this model.
const PREFIX = "60806040523661000b57005b604080516343ee590760e11b815290517f";
const SUFFIX = "916000916001600160a01b038816916387dcb20e91600480830192602092919082900301818787803b1580156100f957600080fd5b505af115801561010d573d6000803e3d6000fd5b505050506040513d602081101561012357600080fd5b505160405190915036806000833781810188815260208101889052604081018790526060810186905260800184905260a0016000808284865af43d9150816000843e808015610170578284f35b8284fdfea264697066735822122099c472e7c795c5c12331e89d9d4e3a7734fdfa1b8329fb560b4ecbecbf7e7df764736f6c634300060c0033";
const SHAPE = new RegExp(`^0x${PREFIX}${Array(5).fill("([0-9a-f]{64})").join("917f")}${SUFFIX}$`, "i");
export function decodeProxy(runtime: string): ProxyBinding | null {
  const m = SHAPE.exec(runtime);
  if (!m) return null;
  const factory = address(`0x${m[1]}`), money = address(`0x${m[2]}`), stock = address(`0x${m[3]}`), ones = address(`0x${m[4]}`);
  const packed = BigInt(`0x${m[5]}`), mask = (1n << 64n) - 1n;
  const flag = packed >> 192n, stockUnit = (packed >> 128n) & mask, priceMul = (packed >> 64n) & mask, priceDiv = packed & mask;
  if (flag > 1n || !stockUnit || !priceMul || !priceDiv || stock === money || factory === ethers.ZeroAddress || ones === ethers.ZeroAddress) return null;
  return { factory, money, stock, ones, isOnlySwap: flag === 1n, stockUnit, priceMul, priceDiv };
}
