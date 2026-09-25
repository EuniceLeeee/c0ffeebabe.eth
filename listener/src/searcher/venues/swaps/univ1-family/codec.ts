import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";

export const MAX_UINT = (1n << 256n) - 1n;
export const MAX_VALUE = (1n << 96n) - 1n;
export const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";
// Verified Vyper 0.1.0b4 implementation linked by both cached exchange pages.
// Infrastructure provenance, NOT an exchange admission list. This is the
// Anyswap V1 fork with an additional ceil(input/1000) issuer fee. Canonical
// Uniswap V1 and arbitrary ABI-compatible implementations are not inferred.
export const IMPLEMENTATION = "0x575ba30c7b77fa0eebd34cc5416538323c4e5612";
export const MODEL = "anyswap-v1-issuer-fee-001";
export const POOL = new ethers.Interface([
  "function tokenAddress() view returns(address)", "function factoryAddress() view returns(address)",
  "function issuer() view returns(address)",
  "function ethToTokenSwapInput(uint256 min_tokens,uint256 deadline) payable returns(uint256)",
  "function ethToTokenSwapOutput(uint256 tokens_bought,uint256 deadline) payable returns(uint256)",
  "function tokenToEthSwapInput(uint256 tokens_sold,uint256 min_eth,uint256 deadline) returns(uint256)",
  "function tokenToEthSwapOutput(uint256 eth_bought,uint256 max_tokens,uint256 deadline) returns(uint256)",
  "function getEthToTokenInputPrice(uint256) view returns(uint256)",
  "function getTokenToEthInputPrice(uint256) view returns(uint256)",
  "event TokenPurchase(address indexed buyer,uint256 indexed eth_sold,uint256 indexed tokens_bought)",
  "event EthPurchase(address indexed buyer,uint256 indexed tokens_sold,uint256 indexed eth_bought)",
]);
export const FACTORY = new ethers.Interface(["function getExchange(address) view returns(address)", "function getToken(address) view returns(address)"]);
export const TOKEN = new ethers.Interface(["function decimals() view returns(uint256)", "function balanceOf(address) view returns(uint256)"]);
export const WRAP = new ethers.Interface(["function withdraw(uint256)", "function deposit() payable"]);
export const BALANCE = new ethers.Interface(["function getEthBalance(address) view returns(uint256)"]);
export const lower = (s: string) => ethers.getAddress(s).toLowerCase();
export const same = (a: string, b: string) => lower(a) === lower(b);
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("univ1 malformed uint256");
  return BigInt(data);
}
export function address(data: string): string {
  const n = uint(data);
  if (n >= 1n << 160n) throw new Error("univ1 noncanonical address");
  return lower(ethers.toBeHex(n, 20));
}
export function poolAddress(data: string): string {
  // The proven Vyper clone always returns 4096 bytes. Only the first ABI word
  // is meaningful; the remainder includes old calldata, not canonical padding.
  if (!ethers.isHexString(data, 32) && !ethers.isHexString(data, 4096)) throw new Error("univ1 malformed clone return");
  return address(data.slice(0, 66));
}
export const call = (id: string, to: string, data: string): AdapterRequest => ({ id, kind: "eth-call", to, data, completion: "return-data" });
export function sourceEqual(a: CanonicalSource, b: CanonicalSource): void {
  if (!Number.isSafeInteger(a.number) || a.number < 0 || !Number.isSafeInteger(a.generation) || a.generation < 0 ||
      !ethers.isHexString(a.hash, 32) || a.number !== b.number || a.generation !== b.generation || a.hash.toLowerCase() !== b.hash.toLowerCase()) {
    throw new Error("univ1 foreign source");
  }
}
export function validateResults(results: readonly AdapterRequestResult[], ids: readonly string[], expected?: CanonicalSource): CanonicalSource {
  if (results.length !== ids.length || new Set(results.map(r => r.id)).size !== ids.length || results.some(r => !ids.includes(r.id))) {
    throw new Error("univ1 missing/duplicate/unexpected results");
  }
  const source = expected ?? results[0]?.source;
  if (!source) throw new Error("univ1 missing source");
  sourceEqual(source, source);
  for (const r of results) sourceEqual(r.source, source);
  return Object.freeze({ ...source });
}
export function returned(results: readonly AdapterRequestResult[], id: string): string {
  const found = results.filter(r => r.id === id);
  if (found.length !== 1 || !found[0].ok || found[0].completion !== "returned") throw new Error(`univ1 unresolved ${id}`);
  return found[0].data;
}
export function cloneImplementation(code: string): string | null {
  // Historical Vyper create_with_code_of runtime: DELEGATECALL / ISZERO /
  // PC / JUMPI deliberately traps a failed delegatecall; success returns the
  // fixed 4096-byte buffer. Match observed bytecode, not a modern revert stub.
  // Exact shape excludes storage-dispatched/upgradable proxies and extra code.
  const m = /^0x366000600037611000600036600073([0-9a-f]{40})5af41558576110006000f3$/i.exec(code);
  return m ? lower(`0x${m[1]}`) : null;
}
export function checked(n: bigint): bigint {
  if (n < 0n || n > MAX_UINT) throw new Error("univ1 uint256 overflow");
  return n;
}
