import type { AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { BONE, call, checked, POOL, returned, uint, validateResults } from "./codec.js";
import { assertDescriptor, assertRoute } from "./routes.js";
import type { Descriptor, Route, State } from "./types.js";
// Source-exact BNum half-up arithmetic for native swap guards only. Positive
// amountOut is always produced by the pool's on-chain calcOutGivenIn, not bpow
// reimplemented locally. Checked intermediates preserve Solidity 0.5 bounds.
export const bmul = (a: bigint, b: bigint) => checked(checked(checked(a) * checked(b)) + BONE / 2n) / BONE;
export function bdiv(a: bigint, b: bigint): bigint {
  checked(a); checked(b); if (b === 0n) throw new Error("balancer-v1 division by zero");
  return checked(checked(a * BONE) + b / 2n) / b;
}
export function spotPrice(balanceIn: bigint, weightIn: bigint, balanceOut: bigint, weightOut: bigint, fee: bigint): bigint {
  return bmul(bdiv(bdiv(balanceIn, weightIn), bdiv(balanceOut, weightOut)), bdiv(BONE, checked(BONE - fee)));
}
export function stateRequests(d: Descriptor) {
  assertDescriptor(d);
  return d.tokens.map((t, i) => call(`balance:${i}`, d.pool, POOL.encodeFunctionData("getBalance", [t])));
}
export function decodeState(d: Descriptor, results: readonly AdapterRequestResult[], expected?: CanonicalSource): State {
  assertDescriptor(d);
  const source = validateResults(results, d.tokens.map((_, i) => `balance:${i}`), expected);
  return Object.freeze({ source, balances: Object.freeze(d.tokens.map((_, i) => uint(returned(results, `balance:${i}`)))) });
}
export function guardInput(d: Descriptor, r: Route, s: State, amountIn: bigint): void {
  assertRoute(d, r); checked(amountIn);
  if (s.balances.length !== d.tokens.length || s.balances.some(v => checked(v) === 0n)) throw new Error("balancer-v1 empty recorded balance");
  if (amountIn <= 0n || amountIn > bmul(s.balances[r.i], BONE / 2n)) throw new Error("balancer-v1 input outside MAX_IN_RATIO");
}
export function quoteData(d: Descriptor, r: Route, s: State, amountIn: bigint): string {
  guardInput(d, r, s, amountIn);
  return POOL.encodeFunctionData("calcOutGivenIn", [s.balances[r.i], d.weights[r.i], s.balances[r.j], d.weights[r.j], amountIn, d.swapFee]);
}
export function guardOutput(d: Descriptor, r: Route, s: State, amountIn: bigint, amountOut: bigint): void {
  guardInput(d, r, s, amountIn); checked(amountOut);
  if (amountOut === 0n || amountOut >= s.balances[r.j]) throw new Error("balancer-v1 no spendable output");
  const before = spotPrice(s.balances[r.i], d.weights[r.i], s.balances[r.j], d.weights[r.j], d.swapFee);
  const after = spotPrice(checked(s.balances[r.i] + amountIn), d.weights[r.i], checked(s.balances[r.j] - amountOut), d.weights[r.j], d.swapFee);
  if (after < before || before > bdiv(amountIn, amountOut)) throw new Error("balancer-v1 ERR_MATH_APPROX");
}
