import { ethers } from "ethers";
import type { UnifiedObservation } from "../../adapter-family-plugin.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../adapter-request-program.js";
import { assertSameSource, canonicalAddress, requireSuccessfulResult, sameAddress } from "./codec.js";
import type { CurveUnderlyingLegacyPlainBinding } from "./types.js";

// Vyper 0.1.0b17 four-coin implementation, USE_LENDING=[false,false,false,false].
// This identifies executable semantics, not pool membership. Registry reverse
// identity and both on-chain coin arrays remain mandatory.
export const LEGACY_PLAIN_CODE_HASH = "0x106e99a4bbc1496b2de7bcd09b6db6343e2a1a67a646327528406a465c3f87b4";
export const LEGACY_PLAIN_ABI = new ethers.Interface([
  "function coins(int128) view returns(address)",
  "function underlying_coins(int128) view returns(address)",
  "function balances(int128) view returns(uint256)",
  "function A() view returns(uint256)",
  "function fee() view returns(uint256)",
  "function admin_fee() view returns(uint256)",
]);
// Bound Vyper layout: arrays each occupy one storage root. The runtime reads
// PUSH1 0x0f / SLOAD at 5080, 11030, 17269; kill/unkill write at 21430/21476.
export const LEGACY_PLAIN_KILLED_SLOT = ethers.toBeHex(15, 32);
const CONTROL_SELECTORS = new Set(["kill_me()", "unkill_me()"].map(s => ethers.id(s).slice(0, 10)));
export const acceptLegacyPlainControlCall = (observation: UnifiedObservation): boolean =>
  observation.kind === "call" && CONTROL_SELECTORS.has(observation.data.slice(0, 10).toLowerCase());
const PRECISIONS = Object.freeze([1n, 10n ** 12n, 10n ** 12n, 1n]);
const ONE = 10n ** 18n, MAX = (1n << 256n) - 1n;
const call = (id: string, pool: string, name: string, args: readonly unknown[] = []): AdapterRequest =>
  ({ id, kind: "eth-call", to: pool, data: LEGACY_PLAIN_ABI.encodeFunctionData(name, args), completion: "return-data" });

export function hasLegacyPlainModel(code: string): boolean {
  return ethers.isHexString(code) && code !== "0x" && ethers.keccak256(code) === LEGACY_PLAIN_CODE_HASH;
}
export function legacyPlainBindingRequests(code: string, pool: string): readonly AdapterRequest[] {
  return hasLegacyPlainModel(code) ? [0, 1, 2, 3].flatMap(i => [
    call(`legacy-plain-coin:${i}`, pool, "coins", [i]),
    call(`legacy-plain-underlying:${i}`, pool, "underlying_coins", [i]),
  ]) : [];
}
export function decodeLegacyPlainBinding(code: string, coins: readonly string[],
  results: readonly AdapterRequestResult[]): CurveUnderlyingLegacyPlainBinding | undefined {
  if (!hasLegacyPlainModel(code)) return undefined;
  if (coins.length !== 4) throw new Error("legacy plain requires four reverse-registered coins");
  const reads = legacyPlainBindingRequests(code, ethers.ZeroAddress).map(r => requireSuccessfulResult(results, r.id));
  assertSameSource(reads);
  for (let i = 0; i < 4; i++) {
    for (const name of ["coins", "underlying_coins"]) {
      const id = name === "coins" ? `legacy-plain-coin:${i}` : `legacy-plain-underlying:${i}`;
      const value = LEGACY_PLAIN_ABI.decodeFunctionResult(name, requireSuccessfulResult(results, id).data)[0];
      if (!sameAddress(canonicalAddress(value), coins[i])) throw new Error("legacy plain coin topology differs from registry");
    }
  }
  return Object.freeze({ kind: "legacy-plain-four-no-lending", poolCodeHash: LEGACY_PLAIN_CODE_HASH });
}
export function assertLegacyPlainBinding(binding: CurveUnderlyingLegacyPlainBinding): void {
  if (binding.kind !== "legacy-plain-four-no-lending" || binding.poolCodeHash !== LEGACY_PLAIN_CODE_HASH)
    throw new Error("unknown legacy plain semantics");
}
export function legacyPlainQuoteRequests(pool: string): readonly AdapterRequest[] {
  return [
    { id: "legacy-plain-code", kind: "get-code", address: pool },
    call("legacy-plain-A", pool, "A"), call("legacy-plain-fee", pool, "fee"),
    call("legacy-plain-admin-fee", pool, "admin_fee"),
    { id: "legacy-plain-killed", kind: "get-storage", address: pool, slot: LEGACY_PLAIN_KILLED_SLOT },
    ...[0, 1, 2, 3].map(i => call(`legacy-plain-balance:${i}`, pool, "balances", [i])),
  ];
}
export interface LegacyPlainState {
  readonly balances: readonly bigint[]; readonly amplification: bigint; readonly fee: bigint;
  readonly adminFee: bigint; readonly killed: boolean;
}
export function decodeLegacyPlainState(binding: CurveUnderlyingLegacyPlainBinding, source: CanonicalSource,
  results: readonly AdapterRequestResult[]): LegacyPlainState {
  assertLegacyPlainBinding(binding);
  const reads = legacyPlainQuoteRequests(ethers.ZeroAddress).map(r => requireSuccessfulResult(results, r.id));
  assertSameSource(reads);
  for (const read of reads) if (read.source.number !== source.number || read.source.hash.toLowerCase() !== source.hash.toLowerCase() ||
    read.source.generation !== source.generation) throw new Error("legacy plain foreign source");
  if (!hasLegacyPlainModel(reads[0].data)) throw new Error("legacy plain runtime changed");
  const scalar = (name: string, id: string) => BigInt(LEGACY_PLAIN_ABI.decodeFunctionResult(name, requireSuccessfulResult(results, id).data)[0]);
  const killed = requireSuccessfulResult(results, "legacy-plain-killed").data;
  if (!/^0x[0-9a-fA-F]{64}$/.test(killed) || BigInt(killed) > 1n) throw new Error("legacy plain invalid killed state");
  return { amplification: scalar("A", "legacy-plain-A"), fee: scalar("fee", "legacy-plain-fee"),
    adminFee: scalar("admin_fee", "legacy-plain-admin-fee"), killed: BigInt(killed) === 1n,
    balances: [0, 1, 2, 3].map(i => scalar("balances", `legacy-plain-balance:${i}`)) };
}
function u(value: bigint): bigint {
  if (value < 0n || value > MAX) throw new Error("legacy plain uint256 overflow/underflow");
  return value;
}
const add = (a: bigint, b: bigint) => u(a + b);
const sub = (a: bigint, b: bigint) => u(a - b);
const mul = (a: bigint, b: bigint) => u(a * b);
const div = (a: bigint, b: bigint) => {
  if (b === 0n) throw new Error("legacy plain division by zero");
  return a / b;
};
const near = (a: bigint, b: bigint) => a > b ? a - b <= 1n : b - a <= 1n;

/** Mirrors the bound implementation's _exchange, including +1 in get_D,
 * no -1 in get_y output, and fee before output precision conversion. */
export function quoteLegacyPlain(state: LegacyPlainState, i: number, j: number, amountIn: bigint): bigint {
  if (![i, j].every(n => Number.isInteger(n) && n >= 0 && n < 4) || i === j ||
    state.balances.length !== 4) throw new Error("legacy plain invalid direction/state");
  u(amountIn); u(state.amplification); u(state.fee); u(state.adminFee);
  if (state.amplification === 0n || state.fee > 10n ** 10n) throw new Error("legacy plain invalid A/fee");
  if (amountIn === 0n) return 0n;
  if (state.killed) throw new Error("legacy plain pool is killed");
  if (state.adminFee > 5n * 10n ** 9n) throw new Error("legacy plain invalid admin fee");
  // Retain exchange_underlying's outer multiplication even when rate_i is ONE.
  const dx = div(mul(amountIn, ONE), ONE);
  const rates = PRECISIONS.map(p => mul(p, ONE));
  const xp = state.balances.map((balance, k) => div(mul(rates[k], u(balance)), ONE));
  const sum = xp.reduce(add, 0n), ann = mul(state.amplification, 4n);
  let D = sum;
  if (sum === 0n) throw new Error("legacy plain empty invariant");
  for (let iteration = 0; iteration < 255; iteration++) {
    let dp = D;
    for (const balance of xp) dp = div(mul(dp, D), add(mul(balance, 4n), 1n));
    const previous = D;
    D = div(mul(add(mul(ann, sum), mul(dp, 4n)), D),
      add(mul(sub(ann, 1n), D), mul(5n, dp)));
    if (near(D, previous)) break;
    if (iteration === 254) throw new Error("legacy plain invariant did not converge");
  }
  const x = add(xp[i], div(mul(dx, rates[i]), ONE));
  let c = D, partial = 0n;
  for (let k = 0; k < 4; k++) {
    if (k === j) continue;
    const value = k === i ? x : xp[k];
    partial = add(partial, value);
    c = div(mul(c, D), mul(value, 4n));
  }
  c = div(mul(c, D), mul(ann, 4n));
  const b = add(partial, div(D, ann));
  let y = D;
  for (let iteration = 0; iteration < 255; iteration++) {
    const previous = y;
    y = div(add(mul(y, y), c), sub(add(mul(2n, y), b), D));
    if (near(y, previous)) break;
    if (iteration === 254) throw new Error("legacy plain output did not converge");
  }
  const dy = sub(xp[j], y);
  const fee = div(mul(dy, state.fee), 10n ** 10n);
  const adminFee = div(mul(fee, state.adminFee), 10n ** 10n);
  // These storage writes can revert even when the final output fits uint256.
  div(mul(x, ONE), rates[i]);
  div(mul(add(y, sub(fee, adminFee)), ONE), rates[j]);
  const output = div(mul(sub(dy, fee), ONE), rates[j]);
  return div(mul(output, ONE), ONE);
}
