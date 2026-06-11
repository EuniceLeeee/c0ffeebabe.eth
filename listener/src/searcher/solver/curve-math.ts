/**
 * Local Curve stableswap math — computes get_dy off-chain from warmed pool
 * state, replacing the per-quote eth_call to the pool's get_dy. This is the
 * "local compute" half of path B: warm the pool state once, then quote
 * in-process (µs, parallelizable) instead of an RPC round-trip per amount.
 *
 * This file covers OLD-STYLE plain stableswap (e.g. 3pool):
 *   - static rate multipliers (xp = balance * rate / 1e18)
 *   - static swap fee
 *   - Ann = A * N   (no A_PRECISION term)
 *
 * stableswap-ng (dynamic fee + stored_rates + A_PRECISION) is a distinct
 * variant handled separately. Correctness is pinned by curve-math-equiv.ts:
 * local get_dy MUST equal the on-chain get_dy for real pool state, to the wei.
 */

const FEE_DENOMINATOR = 10n ** 10n;
const PRECISION = 10n ** 18n;

export interface CurvePlainState {
  /** Amplification coefficient as returned by the pool's A(). */
  A: bigint;
  /** Swap fee, denominator 1e10. */
  fee: bigint;
  /** Raw on-chain balances, one per coin. */
  balances: bigint[];
  /** Rate multipliers; xp[k] = balances[k] * rates[k] / 1e18. */
  rates: bigint[];
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** Stableswap invariant D via Newton iteration (old-style, Ann = A * N). */
export function getD(xp: bigint[], amp: bigint): bigint {
  const n = BigInt(xp.length);
  let s = 0n;
  for (const x of xp) s += x;
  if (s === 0n) return 0n;

  let d = s;
  const ann = amp * n;
  for (let i = 0; i < 255; i++) {
    let dP = d;
    for (const x of xp) dP = (dP * d) / (x * n);
    const dPrev = d;
    d = ((ann * s + dP * n) * d) / ((ann - 1n) * d + (n + 1n) * dP);
    if (absDiff(d, dPrev) <= 1n) return d;
  }
  return d;
}

/** Solve for the new balance y of coin j given coin i set to x. */
function getY(i: number, j: number, x: bigint, xp: bigint[], amp: bigint): bigint {
  const n = BigInt(xp.length);
  const d = getD(xp, amp);
  const ann = amp * n;

  let c = d;
  let sum = 0n;
  for (let k = 0; k < xp.length; k++) {
    let xk: bigint;
    if (k === i) xk = x;
    else if (k !== j) xk = xp[k];
    else continue;
    sum += xk;
    c = (c * d) / (xk * n);
  }
  c = (c * d) / (ann * n);
  const b = sum + d / ann;

  let y = d;
  for (let k = 0; k < 255; k++) {
    const yPrev = y;
    y = (y * y + c) / (2n * y + b - d);
    if (absDiff(y, yPrev) <= 1n) return y;
  }
  return y;
}

/**
 * Local equivalent of the pool's get_dy(i, j, dx) for old-style plain
 * stableswap. Returns the output amount of coin j for `dx` of coin i.
 */
export function curvePlainGetDy(
  state: CurvePlainState,
  i: number,
  j: number,
  dx: bigint,
): bigint {
  const { A, fee, balances, rates } = state;
  const xp = balances.map((bal, k) => (bal * rates[k]) / PRECISION);
  const x = xp[i] + (dx * rates[i]) / PRECISION;
  const y = getY(i, j, x, xp, A);
  const dy = ((xp[j] - y - 1n) * PRECISION) / rates[j];
  const feeAmt = (fee * dy) / FEE_DENOMINATOR;
  return dy - feeAmt;
}

// ─── stableswap-ng ────────────────────────────────────────────
// Differs from old-style plain in three ways: an A_PRECISION term in D/y, a
// dynamic fee scaled by offpeg_fee_multiplier, and dynamic stored_rates (so
// xp uses live rates, not static multipliers). The fee is applied in xp units
// BEFORE de-scaling by rates (the opposite order from plain).

const A_PRECISION = 100n;

export interface CurveNgState {
  /** Amplification as returned by A() — human-readable, pre-A_PRECISION. */
  A: bigint;
  /** Base swap fee, denominator 1e10. */
  fee: bigint;
  /** offpeg_fee_multiplier (drives the dynamic fee), denominator 1e10. */
  offpegFeeMultiplier: bigint;
  /** Raw on-chain balances. */
  balances: bigint[];
  /** Live stored_rates(); xp[k] = balances[k] * rates[k] / 1e18. */
  rates: bigint[];
}

/** Invariant D for ng pools (Ann = A*A_PRECISION*N, with A_PRECISION terms). */
function getDNg(xp: bigint[], ampPrec: bigint): bigint {
  const n = BigInt(xp.length);
  let s = 0n;
  for (const x of xp) s += x;
  if (s === 0n) return 0n;

  let d = s;
  const ann = ampPrec * n; // ampPrec = A * A_PRECISION
  for (let i = 0; i < 255; i++) {
    let dP = d;
    for (const x of xp) dP = (dP * d) / (x * n);
    const dPrev = d;
    d =
      (((ann * s) / A_PRECISION + dP * n) * d) /
      (((ann - A_PRECISION) * d) / A_PRECISION + (n + 1n) * dP);
    if (absDiff(d, dPrev) <= 1n) return d;
  }
  return d;
}

/** Solve for y on an ng pool (A_PRECISION-scaled c and b terms). */
function getYNg(i: number, j: number, x: bigint, xp: bigint[], ampPrec: bigint): bigint {
  const n = BigInt(xp.length);
  const d = getDNg(xp, ampPrec);
  const ann = ampPrec * n;

  let c = d;
  let sum = 0n;
  for (let k = 0; k < xp.length; k++) {
    let xk: bigint;
    if (k === i) xk = x;
    else if (k !== j) xk = xp[k];
    else continue;
    sum += xk;
    c = (c * d) / (xk * n);
  }
  c = (c * d * A_PRECISION) / (ann * n);
  const b = sum + (d * A_PRECISION) / ann;

  let y = d;
  for (let k = 0; k < 255; k++) {
    const yPrev = y;
    y = (y * y + c) / (2n * y + b - d);
    if (absDiff(y, yPrev) <= 1n) return y;
  }
  return y;
}

/** Dynamic fee: amplified near the peg edges by offpeg_fee_multiplier. */
function dynamicFee(xpi: bigint, xpj: bigint, fee: bigint, offpeg: bigint): bigint {
  if (offpeg <= FEE_DENOMINATOR) return fee;
  const xps2 = (xpi + xpj) * (xpi + xpj);
  return (
    (offpeg * fee) /
    (((offpeg - FEE_DENOMINATOR) * 4n * xpi * xpj) / xps2 + FEE_DENOMINATOR)
  );
}

/** Local equivalent of an ng pool's get_dy(i, j, dx). */
export function curveNgGetDy(
  state: CurveNgState,
  i: number,
  j: number,
  dx: bigint,
): bigint {
  const { A, fee, offpegFeeMultiplier, balances, rates } = state;
  const ampPrec = A * A_PRECISION;
  const xp = balances.map((bal, k) => (bal * rates[k]) / PRECISION);
  const x = xp[i] + (dx * rates[i]) / PRECISION;
  const y = getYNg(i, j, x, xp, ampPrec);
  const dy = xp[j] - y - 1n;
  const feeRate = dynamicFee((xp[i] + x) / 2n, (xp[j] + y) / 2n, fee, offpegFeeMultiplier);
  const feeAmt = (feeRate * dy) / FEE_DENOMINATOR;
  return ((dy - feeAmt) * PRECISION) / rates[j];
}
