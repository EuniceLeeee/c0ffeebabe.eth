import { ethers } from "ethers";
import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { ABI, NEED, WAD, address, call, code, decode, rows, scales, uint } from "./codec.js";
import { cloneImplementation, proveImplementation } from "./runtime-shape.js";
import type { Binding, State } from "./types.js";
export const requirements = { transports: ["get-code", "eth-call"] as const };
export const surfaceRequests = (target: string, sold: string) => [code("clone-code", target),
  call("want", target, ABI.encodeFunctionData("want")), call("version", target, ABI.encodeFunctionData("version")),
  call("auction", target, ABI.encodeFunctionData("auctions", [sold]))];
export const dependencyRequests = (d: Pick<Binding, "implementation" | "want" | "sold">) => [code("implementation-code", d.implementation),
  ...["want", "sold"].flatMap(key => { const k = key as "want" | "sold"; return [code(k + "-code", d[k]), call(k + "-decimals", d[k], ABI.encodeFunctionData("decimals"))]; })];
export const dynamicRequests = (d: Binding) => [call("receiver", d.target, ABI.encodeFunctionData("receiver")),
  call("available", d.target, ABI.encodeFunctionData("available", [d.sold])),
  call("raw-price", d.target, ABI.encodeFunctionData(NEED, [d.sold, scales(d).priceProbe]))];
export const stateRequests = (d: Binding) => [...surfaceRequests(d.target, d.sold), ...dependencyRequests(d), ...dynamicRequests(d)];
export function decodeState(d: Binding, results: readonly AdapterRequestResult[], source?: CanonicalSource): State {
  const r = rows(results, stateRequests(d), source);
  if (cloneImplementation(r.get("clone-code")) !== d.implementation || ethers.keccak256(r.get("clone-code")) !== d.cloneCodeHash ||
      proveImplementation(r.get("implementation-code")) !== d.implementationCodeHash || address(decode("want", r.get("want"))[0]) !== d.want ||
      decode("version", r.get("version"))[0] !== "1.0.4" || decode("auctions", r.get("auction"))[1] !== scales(d).sold)
    throw new Error("Yearn auction binding changed");
  for (const k of ["want", "sold"] as const) if (ethers.keccak256(r.get(k + "-code")) !== d[`${k}CodeHash`] ||
      decode("decimals", r.get(k + "-decimals"))[0] !== BigInt(d[`${k}Decimals`])) throw new Error("Yearn auction asset binding changed");
  const receiver = address(decode("receiver", r.get("receiver"))[0]);
  if ([d.target, d.implementation, d.want, d.sold].includes(receiver)) throw new Error("Yearn auction aliased receiver");
  const rawPrice = uint(decode(NEED, r.get("raw-price"))[0]);
  // This exact-price probe deliberately has a bounded arithmetic domain. Do
  // not silently substitute the truncated public price() when it overflows.
  uint(scales(d).denominator * rawPrice);
  return { source: r.source, receiver, rawPrice, available: uint(decode("available", r.get("available"))[0]) };
}
export function cost(d: Pick<Binding, "wantDecimals" | "soldDecimals">, rawPrice: bigint, output: bigint): bigint {
  const s = scales(d); return uint(uint(uint(output) * s.sold) * uint(rawPrice)) / WAD / s.want;
}
/** Invert the source's floor, not a point quote. Input is a maximum budget. */
export function quoteBudget(d: Pick<Binding, "wantDecimals" | "soldDecimals">, s: Pick<State, "rawPrice" | "available">, budget: bigint) {
  uint(budget); uint(s.available); uint(s.rawPrice); const scale = scales(d);
  if (!budget || !s.available || s.rawPrice < scale.want) throw new Error("Yearn auction inactive, empty or zero budget");
  uint(scale.denominator * s.rawPrice);
  const maximum = uint(uint(uint(budget + 1n) * scale.denominator) - 1n) / uint(scale.sold * s.rawPrice);
  const amountOut = maximum < s.available ? maximum : s.available, spent = cost(d, s.rawPrice, amountOut);
  if (!amountOut || !spent || spent > budget) throw new Error("Yearn auction no positive payable output");
  return { amountOut, spent };
}
