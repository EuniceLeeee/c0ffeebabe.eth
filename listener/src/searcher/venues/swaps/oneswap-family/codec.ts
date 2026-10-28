import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";
// Verified implementation/factory behavior identities, never pool admission lists.
export const IMPLEMENTATION_HASH = "0xc52fb497f537ad9cd34c67b27a1dca7b5d31f13a78b6e004b7ee1101af0171d1";
export const FACTORY_HASH = "0x73f0f18337ad08b19811b3b3d69bc37db992676fc2f6c573df728f628b8968f5";
export const LIMIT112 = 1n << 112n;
export const ORDER_LIMIT = 64;
export const POOL = new ethers.Interface([
  "function stock() returns(address)", "function money() returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function getBooked() view returns(uint112,uint112,uint32)",
  "function getOrderList(bool,uint32,uint32) view returns(uint256[])",
  "function addMarketOrder(address,address,uint112) payable returns(uint256)",
  "event NewMarketOrder(uint256)", "event DealWithPool(uint256)", "event OrderChanged(uint256)",
]);
export const FACTORY = new ethers.Interface([
  "function pairLogic() view returns(address)", "function feeBPS() view returns(uint32)",
  "function getTokensFromPair(address) view returns(address,address)",
  "function tokensToPair(address,address,bool) view returns(address)",
]);
export const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)", "function decimals() view returns(uint8)"]);
export const WRAP = new ethers.Interface(["function withdraw(uint256)", "function deposit() payable"]);
export const NATIVE = new ethers.Interface(["function getEthBalance(address) view returns(uint256)"]);
export const lower = (s: string) => ethers.getAddress(s).toLowerCase();
export const normalizedToken = (s: string) => lower(s) === ethers.ZeroAddress ? WETH : lower(s);
export const call = (id: string, to: string, data: string): AdapterRequest => ({ id, kind: "eth-call", to, data, completion: "return-data" });
export const code = (id: string, address: string): AdapterRequest => ({ id, kind: "get-code", address });
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("oneswap malformed uint");
  return BigInt(data);
}
export function address(data: string): string {
  const n = uint(data);
  if (n >= 1n << 160n) throw new Error("oneswap noncanonical address");
  return lower(ethers.toBeHex(n, 20));
}
export function checked(n: bigint, limit = 1n << 256n): bigint {
  if (n < 0n || n >= limit) throw new Error("oneswap amount overflow/underflow");
  return n;
}
export function sourceEqual(a: CanonicalSource, b: CanonicalSource): void {
  if (!Number.isSafeInteger(a.number) || a.number < 0 || !Number.isSafeInteger(a.generation) || a.generation < 0 ||
      !ethers.isHexString(a.hash, 32) || a.number !== b.number || a.generation !== b.generation || lowerHash(a.hash) !== lowerHash(b.hash)) throw new Error("oneswap foreign source");
}
const lowerHash = (s: string) => s.toLowerCase();
export function resultsSource(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource): CanonicalSource {
  if (results.length !== ids.length || new Set(results.map(r => r.id)).size !== ids.length || results.some(r => !ids.includes(r.id))) throw new Error("oneswap incomplete results");
  const source = expected ?? results[0]?.source;
  if (!source) throw new Error("oneswap missing source");
  results.forEach(r => sourceEqual(r.source, source)); sourceEqual(source, source);
  return Object.freeze({ ...source });
}
export function returned(results: readonly AdapterRequestResult[], id: string): string {
  const rows = results.filter(r => r.id === id);
  if (rows.length !== 1 || !rows[0].ok || rows[0].completion !== "returned") throw new Error(`oneswap unresolved ${id}`);
  return rows[0].data;
}
