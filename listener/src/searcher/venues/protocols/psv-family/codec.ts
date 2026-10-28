import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { RequiredAdapterRequestError } from "../../adapter-request-failure.js";
import { assertSource, callRequest, codeRequest } from "../standard-family/common.js";
export { assertSource, callRequest as call, codeRequest as code };
export const WAD = 10n ** 18n;
export const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const PROBE_RECEIVER = "0x00000000000000000000000000000000000a11ce";
export const ABI = new ethers.Interface([
  "function GEM() view returns(address)", "function STABLE() view returns(address)",
  "function gemToWad() view returns(uint256)", "function stableToWad() view returns(uint256)",
  "function tin() view returns(uint256)", "function tout() view returns(uint256)",
  "function treasury() view returns(address)", "function paused() view returns(bool)",
  "function maxPerTransaction() view returns(uint256)", "function maxPerBlock() view returns(uint256)",
  "function getRemainingBlockCapacity() view returns(uint256)", "function getReserves() view returns(uint256,uint256)",
  "function whitelist(address) view returns(bool)", "function decimals() view returns(uint8)",
  "function previewSellGem(uint256,address) view returns(uint256,uint256)",
  "function previewBuyGem(uint256,address) view returns(uint256,uint256)",
  "function sellGem(address,uint256) returns(uint256)", "function buyGem(address,uint256) returns(uint256)",
  "function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
  "event Swap(address indexed sender,address indexed recipient,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,uint256 fee)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export function address(value: string): string {
  const a = ethers.getAddress(value).toLowerCase(); if (a === ethers.ZeroAddress) throw new Error("PSV zero address"); return a;
}
export function uint(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > ethers.MaxUint256) throw new Error("PSV invalid uint256"); return value;
}
export function decode(name: string, data: string) {
  const r = ABI.decodeFunctionResult(name, data);
  if (ABI.encodeFunctionResult(name, r).toLowerCase() !== data.toLowerCase()) throw new Error("PSV noncanonical ABI"); return r;
}
export const slot = (id: string, target: string): AdapterRequest => ({ id, kind: "get-storage", address: target, slot: SLOT });
export function implementationWord(data: string): string {
  if (!/^0x0{24}[0-9a-f]{40}$/i.test(data)) throw new Error("PSV malformed implementation word"); return address("0x" + data.slice(-40));
}
export function rows(results: readonly AdapterRequestResult[], requests: readonly AdapterRequest[], expected?: CanonicalSource) {
  const source = results[0]?.source, ids = requests.map(r => r.id), values = new Map<string, string>();
  if (!source || !Number.isSafeInteger(source.number) || source.number < 0 || !/^0x[0-9a-f]{64}$/i.test(source.hash) ||
      results.length !== ids.length || new Set(ids).size !== ids.length) throw new Error("PSV invalid source/results");
  if (expected) assertSource(source, expected);
  for (const r of results) {
    if (!r.ok) throw new RequiredAdapterRequestError(r); assertSource(r.source, source);
    if (!ids.includes(r.id) || values.has(r.id) || r.completion !== "returned") throw new Error("PSV unavailable " + r.id);
    values.set(r.id, r.data);
  }
  return { source, get(id: string): string { const v = values.get(id); if (v === undefined) throw new Error("PSV missing " + id); return v; } };
}
