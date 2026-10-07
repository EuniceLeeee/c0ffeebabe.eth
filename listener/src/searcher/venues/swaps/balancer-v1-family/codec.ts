import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
export const MAX_UINT = (1n << 256n) - 1n;
export const BONE = 10n ** 18n;
// Infrastructure provenance, never a pool-address admission list. Membership
// is reverse-read for every candidate; the supported factory creates BPools.
export const FACTORY_ADDRESS = "0x9424b1412450d0f8fc2255faf6046b98213b76bd";
export const POOL_CODE_HASH = "0x974df1c33872ba8aab782be5117ff348802441590f84ed7701d734bb9c21683e";
export const FACTORY_CODE_HASH = "0xd185d385218c275c7ed71ca8430e79bcddbe8a7058d7e9fe4a1fe06b542deb2e";
export const MODEL = "balancer-v1-finalized-bpool-0.5.12";
export const POOL = new ethers.Interface([
  "function isFinalized() view returns(bool)", "function isPublicSwap() view returns(bool)",
  "function getFinalTokens() view returns(address[])", "function getSwapFee() view returns(uint256)",
  "function getDenormalizedWeight(address) view returns(uint256)", "function getBalance(address) view returns(uint256)",
  "function calcOutGivenIn(uint256,uint256,uint256,uint256,uint256,uint256) pure returns(uint256)",
  "function calcSpotPrice(uint256,uint256,uint256,uint256,uint256) pure returns(uint256)",
  "function swapExactAmountIn(address,uint256,address,uint256,uint256) returns(uint256,uint256)",
  "function swapExactAmountOut(address,uint256,address,uint256,uint256) returns(uint256,uint256)",
  "event LOG_SWAP(address indexed caller,address indexed tokenIn,address indexed tokenOut,uint256 tokenAmountIn,uint256 tokenAmountOut)",
]);
export const FACTORY = new ethers.Interface(["function isBPool(address) view returns(bool)"]);
export const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"]);
export const lower = (s: string) => ethers.getAddress(s).toLowerCase();
export const same = (a: string, b: string) => lower(a) === lower(b);
export function nonzero(s: string): string {
  const a = lower(s); if (a === ethers.ZeroAddress) throw new Error("balancer-v1 zero address"); return a;
}
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("balancer-v1 malformed uint256"); return BigInt(data);
}
export function bool(data: string): boolean {
  const n = uint(data); if (n > 1n) throw new Error("balancer-v1 noncanonical boolean"); return n === 1n;
}
export function members(data: string): readonly string[] {
  const result = POOL.decodeFunctionResult("getFinalTokens", data);
  if (POOL.encodeFunctionResult("getFinalTokens", result).toLowerCase() !== data.toLowerCase()) throw new Error("balancer-v1 noncanonical members");
  const tokens = [...result[0]].map(nonzero);
  if (tokens.length < 2 || tokens.length > 8 || new Set(tokens).size !== tokens.length) throw new Error("balancer-v1 invalid members");
  return Object.freeze(tokens);
}
export const call = (id: string, to: string, data: string): AdapterRequest => ({ id, kind: "eth-call", to, data, completion: "return-data" });
export function sourceEqual(a: CanonicalSource, b: CanonicalSource): void {
  if (!Number.isSafeInteger(a.number) || a.number < 0 || !Number.isSafeInteger(a.generation) || a.generation < 0 ||
      !ethers.isHexString(a.hash, 32) || a.number !== b.number || a.generation !== b.generation || a.hash.toLowerCase() !== b.hash.toLowerCase()) {
    throw new Error("balancer-v1 foreign source");
  }
}
export function validateResults(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource): CanonicalSource {
  if (results.length !== ids.length || new Set(results.map(r => r.id)).size !== ids.length || results.some(r => !ids.includes(r.id))) {
    throw new Error("balancer-v1 missing/duplicate/unexpected results");
  }
  const source = expected ?? results[0]?.source;
  if (!source) throw new Error("balancer-v1 missing source");
  sourceEqual(source, source); for (const r of results) sourceEqual(r.source, source);
  return Object.freeze({ ...source });
}
export function returned(results: readonly AdapterRequestResult[], id: string): string {
  const found = results.filter(r => r.id === id);
  if (found.length !== 1 || !found[0].ok || found[0].completion !== "returned") throw new Error(`balancer-v1 unresolved ${id}`);
  return found[0].data;
}
export function checked(n: bigint): bigint {
  if (typeof n !== "bigint" || n < 0n || n > MAX_UINT) throw new Error("balancer-v1 uint256 overflow"); return n;
}
