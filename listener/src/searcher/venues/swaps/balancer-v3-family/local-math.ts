// SPDX-License-Identifier: GPL-3.0-or-later
// Exact-in semantics from the five pinned Solidity builds in model-templates.ts.
// FixedPoint/LogExp use the official integer reference; no floating-point math.
// See local-math/UPSTREAM-LICENSE.txt for source attribution and licenses.
import type { BalancerLocalModel } from "./local-model.js";
import { MathSol, WAD } from "./local-math/fixed-point.js";

const UINT256_MAX = (1n << 256n) - 1n;
const AMP_PRECISION = 1000n;
const MIN_WEIGHT = 10n ** 16n;
const MAX_IN_RATIO = 3n * 10n ** 17n;

export interface BalancerScaledExactIn {
  readonly model: BalancerLocalModel;
  readonly balances: readonly bigint[];
  readonly indexIn: number;
  readonly indexOut: number;
  /** Scaled18 token input AFTER the Vault's rounded-up swap fee. */
  readonly amountIn: bigint;
  readonly weights?: readonly bigint[];
  /** getAmplificationParameter().value, already multiplied by AMP_PRECISION. */
  readonly amp?: bigint;
  /** Weighted v2 getMinTokenBalances(), in scaled18 units. */
  readonly minTokenBalances?: readonly bigint[];
}

function uint(value: bigint): bigint {
  if (value < 0n || value > UINT256_MAX) throw new Error("balancer-v3 local uint256 overflow/underflow");
  return value;
}
const add = (a: bigint, b: bigint) => uint(a + b);
const sub = (a: bigint, b: bigint) => uint(a - b);
const mul = (a: bigint, b: bigint) => uint(a * b);
function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("balancer-v3 local division by zero");
  return a / b;
}
const ceilDiv = (a: bigint, b: bigint) => {
  if (b === 0n) throw new Error("balancer-v3 local division by zero");
  return a === 0n ? 0n : 1n + (a - 1n) / b;
};
const converged = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 1n;

// StableMath.computeInvariant: each checked Solidity operation is preserved,
// including intermediate multiplication before division (BigInt must not hide
// an on-chain overflow). The loop and integer rounding match all three builds.
function stableInvariant(amp: bigint, balances: readonly bigint[]): bigint {
  const n = BigInt(balances.length), sum = balances.reduce(add, 0n), ann = mul(amp, n);
  if (sum === 0n) return 0n;
  let invariant = sum;
  for (let iteration = 0; iteration < 255; iteration++) {
    let product = invariant;
    for (const balance of balances) product = div(mul(product, invariant), mul(balance, n));
    const previous = invariant;
    invariant = div(
      mul(add(div(mul(ann, sum), AMP_PRECISION), mul(product, n)), invariant),
      add(div(mul(sub(ann, AMP_PRECISION), invariant), AMP_PRECISION), mul(add(n, 1n), product)),
    );
    if (converged(invariant, previous)) return invariant;
  }
  throw new Error("balancer-v3 StableInvariantDidNotConverge");
}

function stableBalance(amp: bigint, balances: readonly bigint[], invariant: bigint, index: number): bigint {
  const n = BigInt(balances.length), ann = mul(amp, n);
  let sum = balances[0], product = mul(balances[0], n);
  for (let j = 1; j < balances.length; j++) {
    product = div(mul(mul(product, balances[j]), n), invariant);
    sum = add(sum, balances[j]);
  }
  sum = sub(sum, balances[index]);
  const square = mul(invariant, invariant);
  const c = mul(ceilDiv(mul(square, AMP_PRECISION), mul(ann, product)), balances[index]);
  const b = add(sum, div(mul(invariant, AMP_PRECISION), ann));
  let balance = ceilDiv(add(square, c), add(invariant, b));
  for (let iteration = 0; iteration < 255; iteration++) {
    const previous = balance;
    balance = ceilDiv(add(mul(balance, balance), c), sub(add(mul(balance, 2n), b), invariant));
    if (converged(balance, previous)) return balance;
  }
  throw new Error("balancer-v3 StableComputeBalanceDidNotConverge");
}

/** Amount-sensitive pool math only. The caller owns pinned Vault state,
 * token ordering, rate/decimal scaling, fees, hook/pause/query/trade guards. */
export function quoteBalancerExactInScaled18(input: BalancerScaledExactIn): bigint {
  const { model, balances, indexIn, indexOut, amountIn } = input;
  const weighted = model === "weighted-v1" || model === "weighted-v2";
  if (!weighted && model !== "stable-v1" && model !== "stable-v2" && model !== "stable-v3") {
    throw new Error("balancer-v3 unknown local model");
  }
  if (balances.length < 2 || balances.length > (weighted ? 8 : 5) ||
      !Number.isInteger(indexIn) || !Number.isInteger(indexOut) || indexIn === indexOut ||
      indexIn < 0 || indexOut < 0 || indexIn >= balances.length || indexOut >= balances.length ||
      amountIn <= 0n || balances.some(balance => balance <= 0n)) {
    throw new Error("balancer-v3 malformed local quote inputs");
  }
  uint(amountIn); balances.forEach(uint);
  if (weighted) {
    const weights = input.weights;
    if (!weights || weights.length !== balances.length || weights.some(weight => weight < MIN_WEIGHT || weight > WAD) ||
        weights.reduce(add, 0n) !== WAD) throw new Error("balancer-v3 malformed local weights");
    const balanceIn = model === "weighted-v2" ? add(balances[indexIn], 1n) : balances[indexIn];
    const minimums = input.minTokenBalances;
    if (model === "weighted-v2") {
      if (!minimums || minimums.length !== balances.length || minimums.some(minimum => minimum < 0n || minimum > UINT256_MAX)) {
        throw new Error("balancer-v3 missing Weighted v2 minimum balances");
      }
      if (balanceIn < minimums[indexIn]) throw new Error("balancer-v3 TokenBalanceBelowMin");
    }
    if (amountIn > div(mul(balanceIn, MAX_IN_RATIO), WAD)) throw new Error("balancer-v3 MaxInRatio");
    const base = ceilDiv(mul(balanceIn, WAD), add(balanceIn, amountIn));
    const exponent = div(mul(weights[indexIn], WAD), weights[indexOut]);
    const power = MathSol.powUpFixed(base, exponent);
    const out = div(mul(balances[indexOut], MathSol.complementFixed(power)), WAD);
    if (model === "weighted-v2" && sub(balances[indexOut], out) < minimums![indexOut]) {
      throw new Error("balancer-v3 TokenBalanceBelowMin");
    }
    return uint(out);
  }
  const amp = input.amp;
  if (amp === undefined || amp < AMP_PRECISION || amp > 50000n * AMP_PRECISION) {
    throw new Error("balancer-v3 malformed local amplification");
  }
  const invariant = stableInvariant(amp, balances);
  const next = [...balances];
  next[indexIn] = add(next[indexIn], amountIn);
  const finalBalanceOut = stableBalance(amp, next, invariant, indexOut);
  const out = sub(sub(balances[indexOut], finalBalanceOut), 1n);
  if (model === "stable-v3") {
    // Match onSwap's worst pre/post balances, not merely the final ratio: a
    // corrective trade must not bypass an already invalid starting state.
    let minimum = balances.reduce((a, b) => a < b ? a : b);
    let maximum = balances.reduce((a, b) => a > b ? a : b);
    if (next[indexIn] > maximum) maximum = next[indexIn];
    const nextOut = sub(balances[indexOut], out);
    if (nextOut < minimum) minimum = nextOut;
    if (div(maximum, minimum) >= 10000n) throw new Error("balancer-v3 MaxImbalanceRatioExceeded");
  }
  return out;
}
