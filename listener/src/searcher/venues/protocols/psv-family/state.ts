import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { ABI, WAD, address, call, code, decode, implementationWord, rows, slot, uint } from "./codec.js";
import { proveImplementation, proveProxy } from "./runtime-shape.js";
import type { Binding, Direction, State } from "./types.js";
export const requirements = { transports: ["get-code", "get-storage", "eth-call"] as const };
export const surfaceNames = ["GEM", "STABLE", "gemToWad", "stableToWad"] as const;
export const dynamicNames = ["paused", "tin", "tout", "treasury", "maxPerTransaction", "maxPerBlock", "getRemainingBlockCapacity", "getReserves"] as const;
export const surfaceRequests = (target: string) => [code("proxy-code", target), slot("implementation-slot", target),
  ...surfaceNames.map(fn => call(fn, target, ABI.encodeFunctionData(fn)))];
export const dynamicRequests = (target: string) => dynamicNames.map(fn => call(fn, target, ABI.encodeFunctionData(fn)));
export const dependencyRequests = (d: Pick<Binding, "implementation" | "gem" | "stable">) => [code("implementation-code", d.implementation),
  ...["gem", "stable"].flatMap(k => { const key = k as "gem" | "stable"; return [code(k + "-code", d[key]), call(k + "-decimals", d[key], ABI.encodeFunctionData("decimals"))]; })];
export const stateRequests = (d: Binding) => [...surfaceRequests(d.target), ...dependencyRequests(d), ...dynamicRequests(d.target)];
export function dynamic(get: (id: string) => string, source: CanonicalSource): State {
  const value = (fn: string) => decode(fn, get(fn))[0]; const reserves = decode("getReserves", get("getReserves"));
  const tin = uint(value("tin")), tout = uint(value("tout"));
  if (tin > WAD / 10n || tout > WAD / 10n) throw new Error("PSV invalid fee");
  return { source, paused: value("paused"), tin, tout, treasury: address(value("treasury")),
    maxPerTransaction: uint(value("maxPerTransaction")), maxPerBlock: uint(value("maxPerBlock")), remaining: uint(value("getRemainingBlockCapacity")),
    stableReserve: uint(reserves[0]), gemReserve: uint(reserves[1]) };
}
export function decodeState(d: Binding, results: readonly AdapterRequestResult[], source?: CanonicalSource): State {
  const r = rows(results, stateRequests(d), source);
  if (proveProxy(r.get("proxy-code")) !== d.proxyCodeHash || implementationWord(r.get("implementation-slot")) !== d.implementation ||
      proveImplementation(r.get("implementation-code"), d.implementation) !== d.implementationCodeHash) throw new Error("PSV implementation binding changed");
  for (const [key, fn, codeKey, decimalsKey] of [["gem", "GEM", "gemCodeHash", "gemDecimals"], ["stable", "STABLE", "stableCodeHash", "stableDecimals"]] as const) {
    if (address(decode(fn, r.get(fn))[0]) !== d[key] || ethers.keccak256(r.get(key + "-code")) !== d[codeKey] ||
        decode("decimals", r.get(key + "-decimals"))[0] !== BigInt(d[decimalsKey]) ||
        decode(key + "ToWad", r.get(key + "ToWad"))[0] !== 10n ** BigInt(18 - d[decimalsKey])) throw new Error("PSV asset binding changed");
  }
  return dynamic(r.get, r.source);
}
export const amountWad = (d: Binding, direction: Direction, amount: bigint) => uint(uint(amount) * 10n ** BigInt(18 - (direction === "sell-gem" ? d.gemDecimals : d.stableDecimals)));
// Raw mid's fee-paying reference. Amount-sensitive Exact uses the on-chain
// recipient-specific preview, never this rate times the requested input.
export function formula(d: Binding, s: State, direction: Direction, amount: bigint, exempt = false) {
  const wad = amountWad(d, direction, amount), scale = 10n ** BigInt(18 - (direction === "sell-gem" ? d.stableDecimals : d.gemDecimals));
  const fee = exempt ? 0n : uint(wad * (direction === "sell-gem" ? s.tout : s.tin)) / WAD / scale;
  const gross = wad / scale; return { amountOut: gross - fee, fee };
}
export function assertCapacity(d: Binding, s: State, direction: Direction, amount: bigint, output: bigint, fee: bigint) {
  const wad = amountWad(d, direction, amount); uint(output); uint(fee);
  if (!amount || !output || s.paused || (s.maxPerTransaction > 0n && wad > s.maxPerTransaction) ||
      (s.maxPerBlock > 0n && wad > s.remaining) || uint(output + fee) > (direction === "sell-gem" ? s.stableReserve : s.gemReserve))
    throw new Error("PSV paused, zero output, reserve or rate capacity unavailable");
}
