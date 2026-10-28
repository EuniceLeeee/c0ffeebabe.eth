import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { assertSource, callRequest, codeRequest } from "../standard-family/common.js";
export { assertSource, callRequest as call, codeRequest as code };
export const Q96 = 1n << 96n, WAD = 10n ** 18n, BPS = 10000n;
export const ABI = new ethers.Interface([
  "function debond(uint256,address[],uint8[])", "function totalSupply() view returns(uint256)",
  "function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)",
  "function getAllAssets() view returns(tuple(address token,uint256 weighting,uint256 basePriceUSDX96,address c1,uint256 q1)[])",
  "function isAsset(address) view returns(bool)", "function indexType() view returns(uint8)",
  "function DEBOND_FEE() view returns(uint256)", "function lpStakingPool() view returns(address)",
  "function indexFund() view returns(address)",
  "event Debond(address indexed wallet,uint256 amountDebonded)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export function address(value: string): string {
  const a = ethers.getAddress(value).toLowerCase();
  if (a === ethers.ZeroAddress) throw new Error("peapods zero address");
  return a;
}
export function uint(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > ethers.MaxUint256) throw new Error("peapods invalid uint256");
  return value;
}
export function sourceValid(s: CanonicalSource): void {
  if (!Number.isSafeInteger(s.number) || s.number < 0 || !/^0x[0-9a-f]{64}$/i.test(s.hash) ||
      !Number.isSafeInteger(s.generation) || s.generation < 0) throw new Error("peapods invalid source");
}
export function decode(name: string, data: string) {
  const result = ABI.decodeFunctionResult(name, data);
  if (ABI.encodeFunctionResult(name, result).toLowerCase() !== data.toLowerCase()) throw new Error("peapods noncanonical ABI");
  return result;
}
export function rows(results: readonly AdapterRequestResult[], requests: readonly AdapterRequest[], expected?: CanonicalSource) {
  const source = results[0]?.source, ids = requests.map(r => r.id), values = new Map<string, string>();
  if (!source || results.length !== ids.length || new Set(ids).size !== ids.length) throw new Error("peapods missing/duplicate results");
  sourceValid(source); if (expected) assertSource(source, expected);
  for (const r of results) {
    if (!r.ok) throw new RequiredAdapterRequestError(r);
    assertSource(r.source, source);
    if (!ids.includes(r.id) || values.has(r.id) || r.completion !== "returned") throw new Error("peapods unavailable result " + r.id);
    values.set(r.id, r.data);
  }
  return { source, get(id: string): string { const v = values.get(id); if (v === undefined) throw new Error("peapods missing " + id); return v; } };
}
