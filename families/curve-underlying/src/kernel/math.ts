const FEE_DENOMINATOR = 10n ** 10n;
const PRECISION = 10n ** 18n;
const A_PRECISION = 100n;

function abs(a: bigint, b: bigint): bigint { return a > b ? a - b : b - a; }
function validateVector(values: readonly bigint[], label: string): void {
  if (values.length < 2) throw new RangeError(`${label} must contain at least two coins`);
  if (values.some(value => value <= 0n)) throw new RangeError(`${label} values must be positive`);
}
function validatePair(i: number, j: number, length: number): void {
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= length || j >= length || i === j) throw new RangeError("invalid coin indices");
}

export function getD(xp: readonly bigint[], amp: bigint): bigint {
  validateVector(xp, "xp"); if (amp <= 0n) throw new RangeError("amp must be positive");
  const n = BigInt(xp.length), sum = xp.reduce((a, b) => a + b, 0n);
  let d = sum; const ann = amp * n;
  for (let iteration = 0; iteration < 255; iteration += 1) {
    let dP = d; for (const x of xp) dP = dP * d / (x * n);
    const previous = d;
    d = (ann * sum + dP * n) * d / ((ann - 1n) * d + (n + 1n) * dP);
    if (abs(d, previous) <= 1n) return d;
  }
  throw new Error("plain invariant did not converge");
}

function getY(i: number, j: number, x: bigint, xp: readonly bigint[], amp: bigint): bigint {
  const n = BigInt(xp.length), d = getD(xp, amp), ann = amp * n;
  let c = d, sum = 0n;
  for (let k = 0; k < xp.length; k += 1) { if (k === j) continue; const value = k === i ? x : xp[k]!; sum += value; c = c * d / (value * n); }
  c = c * d / (ann * n); const b = sum + d / ann; let y = d;
  for (let iteration = 0; iteration < 255; iteration += 1) { const previous = y; y = (y * y + c) / (2n * y + b - d); if (abs(y, previous) <= 1n) return y; }
  throw new Error("plain y did not converge");
}

export interface CurvePlainState { readonly A: bigint; readonly fee: bigint; readonly balances: readonly bigint[]; readonly rates: readonly bigint[] }
export function curvePlainGetDy(state: CurvePlainState, i: number, j: number, dx: bigint): bigint {
  validatePair(i, j, state.balances.length); validateVector(state.balances, "balances"); validateVector(state.rates, "rates");
  if (state.rates.length !== state.balances.length) throw new RangeError("rate count mismatch");
  if (state.A <= 0n || dx < 0n || state.fee < 0n || state.fee >= FEE_DENOMINATOR) throw new RangeError("invalid amount, amplification, or fee");
  if (dx === 0n) return 0n;
  const xp = state.balances.map((balance, index) => balance * state.rates[index]! / PRECISION);
  const x = xp[i]! + dx * state.rates[i]! / PRECISION;
  const y = getY(i, j, x, xp, state.A);
  const dy = (xp[j]! - y - 1n) * PRECISION / state.rates[j]!;
  return dy - state.fee * dy / FEE_DENOMINATOR;
}

function getDNg(xp: readonly bigint[], ampPrec: bigint): bigint {
  const n = BigInt(xp.length), sum = xp.reduce((a, b) => a + b, 0n); let d = sum; const ann = ampPrec * n;
  for (let iteration = 0; iteration < 255; iteration += 1) { let dP = d; for (const x of xp) dP = dP * d / (x * n); const previous = d; d = ((ann * sum / A_PRECISION + dP * n) * d) / (((ann - A_PRECISION) * d) / A_PRECISION + (n + 1n) * dP); if (abs(d, previous) <= 1n) return d; }
  throw new Error("ng invariant did not converge");
}
function getYNg(i: number, j: number, x: bigint, xp: readonly bigint[], ampPrec: bigint): bigint {
  const n = BigInt(xp.length), d = getDNg(xp, ampPrec), ann = ampPrec * n; let c = d, sum = 0n;
  for (let k = 0; k < xp.length; k += 1) { if (k === j) continue; const value = k === i ? x : xp[k]!; sum += value; c = c * d / (value * n); }
  c = c * d * A_PRECISION / (ann * n); const b = sum + d * A_PRECISION / ann; let y = d;
  for (let iteration = 0; iteration < 255; iteration += 1) { const previous = y; y = (y * y + c) / (2n * y + b - d); if (abs(y, previous) <= 1n) return y; }
  throw new Error("ng y did not converge");
}
function dynamicFee(x: bigint, y: bigint, fee: bigint, offpeg: bigint): bigint {
  if (offpeg <= FEE_DENOMINATOR) return fee;
  const sumSquared = (x + y) ** 2n;
  return offpeg * fee / (((offpeg - FEE_DENOMINATOR) * 4n * x * y) / sumSquared + FEE_DENOMINATOR);
}
export interface CurveNgState extends CurvePlainState { readonly offpegFeeMultiplier: bigint }
export function curveNgGetDy(state: CurveNgState, i: number, j: number, dx: bigint): bigint {
  validatePair(i, j, state.balances.length); validateVector(state.balances, "balances"); validateVector(state.rates, "rates");
  if (state.rates.length !== state.balances.length || state.A <= 0n || state.offpegFeeMultiplier < 0n || dx < 0n || state.fee < 0n || state.fee >= FEE_DENOMINATOR) throw new RangeError("invalid ng state");
  if (dx === 0n) return 0n;
  const xp = state.balances.map((balance, index) => balance * state.rates[index]! / PRECISION), x = xp[i]! + dx * state.rates[i]! / PRECISION;
  const y = getYNg(i, j, x, xp, state.A * A_PRECISION), dy = xp[j]! - y - 1n;
  const feeRate = dynamicFee((xp[i]! + x) / 2n, (xp[j]! + y) / 2n, state.fee, state.offpegFeeMultiplier);
  return (dy - feeRate * dy / FEE_DENOMINATOR) * PRECISION / state.rates[j]!;
}
