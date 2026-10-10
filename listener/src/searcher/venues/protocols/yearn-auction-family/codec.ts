import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { assertSource, callRequest, codeRequest } from "../standard-family/common.js";
export { assertSource, callRequest as call, codeRequest as code };
export const WAD = 10n ** 18n;
export const PROBE_RECEIVER = "0x00000000000000000000000000000000000a11ce";
export const NEED = "getAmountNeeded(address,uint256)";
export const TAKE = "take(address,uint256)";
export const TAKES = ["take(address)", TAKE, "take(address,uint256,address)", "take(address,uint256,address,bytes)"] as const;
export const ABI = new ethers.Interface([
  "function version() view returns(string)", "function want() view returns(address)", "function receiver() view returns(address)",
  "function auctions(address) view returns(uint64,uint64,uint128)", "function available(address) view returns(uint256)",
  "function getAllEnabledAuctions() view returns(address[])", "function getAmountNeeded(address,uint256) view returns(uint256)",
  "function take(address) returns(uint256)", "function take(address,uint256) returns(uint256)",
  "function take(address,uint256,address) returns(uint256)", "function take(address,uint256,address,bytes) returns(uint256)",
  "function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)",
  "event AuctionEnabled(address indexed from,address indexed to)", "event AuctionKicked(address indexed from,uint256 available)",
  "event AuctionSettled(address indexed from)", "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export function address(value: string): string {
  const a = ethers.getAddress(value).toLowerCase(); if (a === ethers.ZeroAddress) throw new Error("Yearn auction zero address"); return a;
}
export function uint(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > ethers.MaxUint256) throw new Error("Yearn auction uint256 bounds"); return value;
}
export function decode(name: string, data: string) {
  const result = ABI.decodeFunctionResult(name, data);
  if (ABI.encodeFunctionResult(name, result).toLowerCase() !== data.toLowerCase()) throw new Error("Yearn auction noncanonical ABI"); return result;
}
export function scales(d: { wantDecimals: number; soldDecimals: number }) {
  if (![d.wantDecimals, d.soldDecimals].every(n => Number.isInteger(n) && n >= 0 && n <= 18)) throw new Error("Yearn auction decimals");
  const sold = 10n ** BigInt(18 - d.soldDecimals), want = 10n ** BigInt(18 - d.wantDecimals);
  return { sold, want, denominator: WAD * want, priceProbe: 10n ** BigInt(d.soldDecimals) * want };
}
export function rows(results: readonly AdapterRequestResult[], requests: readonly AdapterRequest[], expected?: CanonicalSource) {
  const source = results[0]?.source, ids = requests.map(r => r.id), values = new Map<string, string>();
  if (!source || !Number.isSafeInteger(source.number) || source.number < 0 || !/^0x[0-9a-f]{64}$/i.test(source.hash) ||
      results.length !== ids.length || new Set(ids).size !== ids.length) throw new Error("Yearn auction source/results");
  if (expected) assertSource(source, expected);
  for (const r of results) {
    if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, source);
    if (!ids.includes(r.id) || values.has(r.id) || r.completion !== "returned") throw new Error("Yearn auction unavailable " + r.id);
    values.set(r.id, r.data);
  }
  return { source, get(id: string): string { const v = values.get(id); if (v === undefined) throw new Error("Yearn auction missing " + id); return v; } };
}
