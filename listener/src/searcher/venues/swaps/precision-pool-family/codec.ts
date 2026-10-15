import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import type { Market } from "./types.js";
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";
export const FEE_DENOM = 1_000_000n;
export const MARKET_FIELDS = ["token0", "token1", "sqrtPLow", "sqrtPHigh", "fee", "hook", "feeRecipient", "creatorFeeBps"] as const;
export const POOL_FIELDS = ["factory", ...MARKET_FIELDS] as const;
export const MARKET_TYPE = "tuple(address token0,address token1,uint256 sqrtPLow,uint256 sqrtPHigh,uint256 fee,address hook,address feeRecipient,uint256 creatorFeeBps)";
export const POOL = new ethers.Interface([
  ...["factory", "token0", "token1", "hook", "feeRecipient"].map(n => `function ${n}() view returns(address)`),
  ...["sqrtPLow", "sqrtPHigh", "fee", "creatorFeeBps", "totalSupply", "hookOwed0", "hookOwed1", "creatorOwed0", "creatorOwed1"].map(n => `function ${n}() view returns(uint256)`),
  "function reserve0() view returns(uint128)", "function reserve1() view returns(uint128)",
  "function quoteExactIn(address sender,address tokenIn,uint256 amountIn) view returns(uint256 amountOut,bool fits)",
  "function swapExactIn(address tokenIn,uint256 amountIn,uint256 minOut,address to) payable returns(uint256)",
  "event Swap(address indexed tokenIn,uint256 amountIn,uint256 amountOut,address indexed to)",
  "event AddLiquidity(address indexed recipient,uint256 amount0,uint256 amount1,uint256 lp)",
  "event RemoveLiquidity(address indexed provider,uint256 lp,uint256 amount0,uint256 amount1)",
]);
export const FACTORY = new ethers.Interface([
  "function trustedExecutor() view returns(address)", "function poolCode() view returns(address)",
  "function poolInitCodeHash() view returns(bytes32)", "function isPool(address) view returns(bool)",
  `function poolFor(${MARKET_TYPE} m) view returns(address)`,
]);
export const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"]);
export const WRAP = new ethers.Interface(["function withdraw(uint256)", "function deposit() payable"]);
export const NATIVE = new ethers.Interface(["function getEthBalance(address) view returns(uint256)"]);
export const lower = (s: string) => ethers.getAddress(s).toLowerCase();
export const normalizedToken = (s: string) => lower(s) === ethers.ZeroAddress ? WETH : lower(s);
export const marketTuple = (m: Market) => MARKET_FIELDS.map(k => m[k]);
export const call = (id: string, to: string, data: string): AdapterRequest => ({ id, kind: "eth-call", to, data, completion: "return-data" });
export const code = (id: string, address: string): AdapterRequest => ({ id, kind: "get-code", address });
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("precision-pool malformed uint");
  return BigInt(data);
}
export function address(data: string): string {
  const n = uint(data);
  if (n >= 1n << 160n) throw new Error("precision-pool noncanonical address");
  return lower(ethers.toBeHex(n, 20));
}
export function checked(n: bigint, limit = 1n << 256n): bigint {
  if (n < 0n || n >= limit) throw new Error("precision-pool amount overflow/underflow");
  return n;
}
export function sourceEqual(a: CanonicalSource, b: CanonicalSource): void {
  if (!Number.isSafeInteger(a.number) || a.number < 0 || !Number.isSafeInteger(a.generation) || a.generation < 0 ||
      !ethers.isHexString(a.hash, 32) || a.number !== b.number || a.generation !== b.generation || a.hash.toLowerCase() !== b.hash.toLowerCase())
    throw new Error("precision-pool foreign source");
}
export function resultsSource(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource): CanonicalSource {
  if (results.length !== ids.length || new Set(results.map(r => r.id)).size !== ids.length || results.some(r => !ids.includes(r.id)))
    throw new Error("precision-pool incomplete results");
  const source = expected ?? results[0]?.source;
  if (!source) throw new Error("precision-pool missing source");
  results.forEach(r => sourceEqual(r.source, source)); sourceEqual(source, source);
  return Object.freeze({ ...source });
}
export function returned(results: readonly AdapterRequestResult[], id: string): string {
  const rows = results.filter(r => r.id === id);
  if (rows.length !== 1 || !rows[0].ok || rows[0].completion !== "returned") throw new Error(`precision-pool unresolved ${id}`);
  return rows[0].data;
}
export function decodeCanonical(iface: ethers.Interface, method: string, data: string) {
  const value = iface.decodeFunctionResult(method, data);
  if (iface.encodeFunctionResult(method, value).toLowerCase() !== data.toLowerCase()) throw new Error("precision-pool noncanonical return");
  return value;
}
