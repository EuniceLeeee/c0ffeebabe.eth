import { ethers } from "ethers";
import { PRECISIONS, uint } from "./codec.js";
import type { State } from "./types.js";
// Behavior-class proofs, not pool-address gates. Verified Vyper sources were
// recompiled byte-for-byte (pool 0.3.1 / LP 0.2.16, Berlin). Both runtimes use
// storage, not embedded coin/pool addresses; each instance still needs registry
// reverse binding, the LP minter relation and actual mint/burn/receipt behavior.
export const POOL_HASH = "0x304e2199bfe57413d95a53efb2f3df8ed69be12f7df5770b874c9b3a30d9cafd";
export const LP_HASH = "0x247dbc76a2d4e734c1121ac9aad92399cec0e3b7edfa24c33042c8c71a3c9883";
export const KILLED_SLOT = 18;
export function proveCode(code: string, expected: string): string {
  if (!ethers.isHexString(code, true) || ethers.keccak256(code) !== expected) throw new Error("curve-lp unsupported runtime class"); return expected;
}
const add = (a: bigint, b: bigint) => uint(a + b), sub = (a: bigint, b: bigint) => uint(a - b), mul = (a: bigint, b: bigint) => uint(a * b);
const div = (a: bigint, b: bigint) => { if (!b) throw new Error("curve-lp zero divisor"); return uint(a) / uint(b); };
const distance = (a: bigint, b: bigint) => a > b ? a - b : b - a;
export function invariant(balances: readonly [bigint, bigint], amp: bigint): bigint {
  const xp = balances.map((b, i) => div(mul(10n ** 18n * PRECISIONS[i], uint(b)), 10n ** 18n));
  const sum = add(xp[0], xp[1]); if (!sum) return 0n;
  const ann = mul(uint(amp), 2n); let d = sum;
  for (let k = 0; k < 255; k++) { const prior = d; let p = d;
    for (const x of xp) p = div(mul(p, d), mul(x, 2n));
    d = div(mul(add(div(mul(ann, sum), 100n), mul(p, 2n)), d), add(div(mul(sub(ann, 100n), d), 100n), mul(3n, p)));
    if (distance(d, prior) <= 1n) return d;
  }
  throw new Error("curve-lp invariant did not converge");
}
/** Source add_liquidity path, NOT calc_token_amount (which excludes fees).
 * Initial multi-coin bootstrap is intentionally outside one-input conversion. */
export function mintQuote(s: Pick<State, "balances" | "amp" | "fee" | "totalSupply" | "killed">, index: number, amount: bigint): bigint {
  if ((index !== 0 && index !== 1) || !uint(amount) || s.killed || !uint(s.totalSupply) || s.balances.some(b => b <= 0n) ||
      !uint(s.amp) || uint(s.fee) > 5n * 10n ** 9n) throw new Error("curve-lp no mint capacity");
  const d0 = invariant(s.balances, s.amp), next: [bigint, bigint] = [...s.balances]; next[index] = add(next[index], amount);
  const d1 = invariant(next, s.amp); if (d1 <= d0) throw new Error("curve-lp input below mint resolution");
  const fee = div(mul(s.fee, 2n), 4n);
  for (let i = 0; i < 2; i++) { const ideal = div(mul(d1, s.balances[i]), d0);
    next[i] = sub(next[i], div(mul(fee, distance(ideal, next[i])), 10n ** 10n)); }
  const out = div(mul(s.totalSupply, sub(invariant(next, s.amp), d0)), d0);
  if (!out) throw new Error("curve-lp zero minted output"); return out;
}
