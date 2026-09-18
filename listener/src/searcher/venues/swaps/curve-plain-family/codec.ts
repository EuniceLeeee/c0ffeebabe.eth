import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import type { CurveIndexAbi, CurvePlainMode } from "./types.js";

// Infrastructure proof source, never a pool admission list.
export const CURVE_METAREGISTRY = ethers.getAddress("0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC");
export const META = new ethers.Interface([
  "function get_registry_handlers_from_pool(address) view returns (address[10])",
  "function get_coins(address) view returns (address[8])",
]);
export const POOL = new ethers.Interface([
  "function coins(uint256) view returns (address)",
  "function balances(uint256) view returns (uint256)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
]);
export const UINT_POOL = new ethers.Interface([
  "function get_dy(uint256,uint256,uint256) view returns (uint256)",
]);
export const SIGNED_GETTERS = new ethers.Interface([
  "function coins(int128) view returns (address)",
  "function balances(int128) view returns (uint256)",
]);
export const GETTER_ABIS = Object.freeze(["uint256", "int128"] as const);
export function getterPool(abi: CurveIndexAbi): ethers.Interface {
  switch (abi) {
    case "uint256": return POOL;
    case "int128": return SIGNED_GETTERS;
    default: throw new Error("curve-plain unsupported getter ABI");
  }
}
export function getterReadId(kind: "coin" | "balance", abi: CurveIndexAbi, index: number): string {
  return `${kind}${abi === "int128" ? "-int128" : ""}:${index}`;
}
export const quotePool = (abi: CurveIndexAbi): ethers.Interface => abi === "int128" ? POOL : UINT_POOL;
export const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);
export const EXECUTION = Object.freeze({
  received: new ethers.Interface(["function exchange_received(int128,int128,uint256,uint256,address) returns (uint256)"]),
  "received-no-receiver": new ethers.Interface(["function exchange_received(int128,int128,uint256,uint256) returns (uint256)"]),
  exchange: new ethers.Interface(["function exchange(int128,int128,uint256,uint256) returns (uint256)"]),
  "received-uint": new ethers.Interface(["function exchange_received(uint256,uint256,uint256,uint256,address) returns (uint256)"]),
});
export const INT_MODES = Object.freeze(["received", "received-no-receiver", "exchange"] as const);
export const MODES: readonly CurvePlainMode[] = Object.freeze([...INT_MODES, "received-uint"]);
export const hasReceiver = (mode: CurvePlainMode): boolean => mode === "received" || mode === "received-uint";
export const MAX_UINT = (1n << 256n) - 1n;
export const lower = (value: string): string => ethers.getAddress(value).toLowerCase();
export const same = (a: string, b: string): boolean => lower(a) === lower(b);
export const validIndex = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < 8;
export function selector(mode: CurvePlainMode): `0x${string}` {
  return EXECUTION[mode].getFunction(mode === "exchange" ? "exchange" : "exchange_received")!.selector as `0x${string}`;
}
export function executionData(mode: CurvePlainMode, i: number, j: number, dx: bigint, minDy: bigint, receiver: string): string {
  return EXECUTION[mode].encodeFunctionData(mode === "exchange" ? "exchange" : "exchange_received",
    hasReceiver(mode) ? [i, j, dx, minDy, receiver] : [i, j, dx, minDy]);
}
export function call(id: string, to: string, data: string): AdapterRequest {
  return { id, kind: "eth-call", to, data, completion: "return-or-revert-data" };
}
export function result(results: readonly AdapterRequestResult[], id: string) {
  const matches = results.filter(item => item.id === id);
  if (matches.length !== 1) throw new Error(`curve-plain missing/duplicate result ${id}`);
  const found = matches[0];
  if (!found.ok) throw new Error(`curve-plain unresolved ${id}: ${found.failure}`);
  return found;
}
export function returned(results: readonly AdapterRequestResult[], id: string) {
  const found = result(results, id);
  if (found.completion !== "returned") throw new Error(`curve-plain ${id} reverted`);
  return found;
}
export function uint(data: string): bigint {
  return BigInt(scalarWord(data, "uint"));
}
export function address(data: string): string {
  const word = scalarWord(data, "address");
  if (word.slice(2, 26) !== "0".repeat(24)) {
    throw new Error("curve-plain noncanonical address return");
  }
  return ethers.getAddress(`0x${word.slice(26)}`);
}
function scalarWord(data: string, label: string): string {
  // Some Curve proxies append returndata. ABI scalar decoding consumes the
  // first full word, never the tail; truncated or non-byte data stays invalid.
  if (!ethers.isHexString(data, true) || data.length < 66) {
    throw new Error(`curve-plain noncanonical ${label} return`);
  }
  return data.slice(0, 66);
}
export function addressArray(data: string, length: number): readonly string[] {
  if (!ethers.isHexString(data, length * 32)) throw new Error("curve-plain noncanonical address array");
  const out: string[] = [];
  let padded = false;
  for (let i = 0; i < length; i++) {
    const value = address(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
    if (value === ethers.ZeroAddress) { padded = true; continue; }
    if (padded || out.some(prior => same(prior, value))) throw new Error("curve-plain noncontiguous/duplicate address array");
    out.push(value);
  }
  return Object.freeze(out);
}
export function assertSource(actual: CanonicalSource, expected: CanonicalSource): void {
  if (actual.number !== expected.number || actual.generation !== expected.generation || lowerHash(actual.hash) !== lowerHash(expected.hash)) {
    throw new Error("curve-plain foreign source");
  }
}
function lowerHash(hash: string): string {
  if (!ethers.isHexString(hash, 32)) throw new Error("curve-plain malformed source hash");
  return hash.toLowerCase();
}
export function resultSource(results: readonly AdapterRequestResult[]): CanonicalSource {
  const source = results[0]?.source;
  if (!source) throw new Error("curve-plain empty result set");
  for (const item of results) assertSource(item.source, source);
  return source;
}
export function probeAmount(decimals: number, balance: bigint): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || balance <= 0n) {
    throw new Error("curve-plain invalid scale/liquidity");
  }
  const unit = 10n ** BigInt(decimals);
  const cap = balance / 1_000_000n;
  return cap < 1n ? 1n : unit < cap ? unit : cap;
}
