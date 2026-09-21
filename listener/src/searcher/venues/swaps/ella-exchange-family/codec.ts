import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";

export const UNIT = 10n ** 18n, MAX_UINT = (1n << 256n) - 1n;
// Source: verified EllaExchangeService, solc 0.6.0 / optimizer 200. Compiled
// executable bytes (including the embedded child runtime) match the chain.
// These authenticate implementations, never individual pool/factory addresses.
export const EXCHANGE_CODE_HASH = "0x8594ea55b8367287ced36b1a73006c77397b7b0940ff3f8da685799b4d301067";
export const FACTORY_CODE_HASH = "0x1b4336dddecfd3e095180b0e518cdbf1944c67e1b77dfbe1340801379e79db8d";
export const POOL = new ethers.Interface([
  "function tokenPrice() view returns(uint256)", "function swapBase1() payable", "function swap1(uint256)",
  "event Bought(uint256 price,uint256 grossOut,uint256 amountIn,address exchange,bool isBuy,uint256 timestamp)",
]);
export const FEES = new ethers.Interface(["function getFees() view returns(uint256)",
  "function getSystemCut() view returns(uint256)", "function getFeesAddress() view returns(address)"]);
export const TOKEN = new ethers.Interface(["function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)"]);
export const ORACLE = new ethers.Interface(["function aggregator() view returns(address)"]);
// Existing deployed read-only infrastructure, not instance admission authority.
export const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const BALANCE = new ethers.Interface(["function getEthBalance(address) view returns(uint256)"]);
export const lower = (value: string) => ethers.getAddress(value).toLowerCase();
export const same = (a: string, b: string) => lower(a) === lower(b);
export const call = (id: string, to: string, data: string): AdapterRequest =>
  ({ id, kind: "eth-call", to, data, completion: "return-data" });
export const storage = (id: string, address: string, slot: number): AdapterRequest =>
  ({ id, kind: "get-storage", address, slot: ethers.toBeHex(slot, 32) });
export function uint(data: string): bigint {
  if (!ethers.isHexString(data, 32)) throw new Error("ella malformed uint256");
  return BigInt(data);
}
export function address(data: string): string {
  const word = uint(data);
  if (word >= 1n << 160n) throw new Error("ella malformed address");
  return ethers.getAddress(ethers.toBeHex(word, 20));
}
export function returned(results: readonly AdapterRequestResult[], id: string) {
  const matches = results.filter(r => r.id === id);
  if (matches.length !== 1) throw new Error(`ella missing/duplicate result ${id}`);
  const read = matches[0];
  if (!read.ok || read.completion !== "returned") throw new Error(`ella unresolved read ${id}`);
  return read;
}
export function assertSource(a: CanonicalSource, b: CanonicalSource): void {
  if (a.number !== b.number || a.hash.toLowerCase() !== b.hash.toLowerCase() || a.generation !== b.generation) {
    throw new Error("ella mixed source evidence");
  }
}
export function resultSource(results: readonly AdapterRequestResult[]): CanonicalSource {
  if (!results.length) throw new Error("ella missing source");
  const source = results[0].source;
  for (const read of results) assertSource(read.source, source);
  return source;
}
export function mul(a: bigint, b: bigint): bigint {
  const out = a * b;
  if (a < 0n || b < 0n || out > MAX_UINT) throw new Error("ella checked multiplication overflow");
  return out;
}
