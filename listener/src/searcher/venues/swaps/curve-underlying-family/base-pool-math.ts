/**
 * Integer arithmetic for initialized, old-style fixed-precision base pools.
 * amplification is A(), with Ann = A * N (no A_PRECISION); precisions multiply
 * raw balances into xp (e.g. [1, 1e12, 1e12] for an 18/6/6-decimal base pool).
 *
 * The caller must bind the implementation semantics and same-source state.
 * This is NOT an NG, lending/rate-bearing, metapool, or universal Curve model.
 */
export interface ClassicBasePoolState {
  readonly balances: readonly bigint[];
  readonly precisions: readonly bigint[];
  readonly amplification: bigint;
  readonly fee: bigint;
  readonly lpTotalSupply: bigint;
}

const FEE_DENOMINATOR = 10n ** 10n;
const RATE_SCALE = 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_ITERATIONS = 255;

/** Actual single-coin add_liquidity mint, not fee-free calc_token_amount. */
export function classicBaseMintAmount(
  state: ClassicBasePoolState,
  tokenIndex: number,
  amountIn: bigint,
): bigint {
  const xp = validateState(state);
  validateIndex(tokenIndex, xp.length);
  uint(amountIn, "amountIn");
  if (amountIn === 0n) return 0n;

  const n = BigInt(xp.length);
  const depositFee = mul(state.fee, n) / (4n * (n - 1n));
  const d0 = invariant(xp, state.amplification);
  const nextBalances = [...state.balances];
  nextBalances[tokenIndex] = add(nextBalances[tokenIndex], amountIn);
  const d1 = invariant(normalize(nextBalances, state.precisions), state.amplification);
  if (d1 <= d0) fail("deposit must increase invariant");

  // Fee rounding is per coin, in RAW balance units, before recomputing D2.
  // The full fee is removed here; admin_fee only affects stored pool balances.
  const adjusted = nextBalances.map((balance, index) => {
    const ideal = mul(d1, state.balances[index]) / d0;
    const fee = mul(depositFee, distance(ideal, balance)) / FEE_DENOMINATOR;
    return sub(balance, fee);
  });
  const d2 = invariant(normalize(adjusted, state.precisions), state.amplification);
  return mul(state.lpTotalSupply, sub(d2, d0)) / d0;
}

/** Actual exchange output: subtract the fee in xp, THEN convert to raw units. */
export function classicBaseExchangeAmount(
  state: ClassicBasePoolState,
  i: number,
  j: number,
  amountIn: bigint,
): bigint {
  const xp = validateState(state);
  validateIndex(i, xp.length);
  validateIndex(j, xp.length);
  if (i === j) fail("exchange indices must differ");
  uint(amountIn, "amountIn");
  if (amountIn === 0n) return 0n;

  const x = add(xp[i], rateNormalized(amountIn, state.precisions[i]));
  const d = invariant(xp, state.amplification);
  const y = solveY(xp, state.amplification, i, j, x, d);
  const dy = sub(sub(xp[j], y), 1n);
  const fee = mul(dy, state.fee) / FEE_DENOMINATOR;
  return mul(sub(dy, fee), RATE_SCALE) / mul(state.precisions[j], RATE_SCALE);
}

function validateState(state: ClassicBasePoolState): bigint[] {
  if (!Array.isArray(state.balances) || !Array.isArray(state.precisions) ||
      state.balances.length < 2 ||
      state.balances.length !== state.precisions.length) {
    fail("matching balance/precision vectors with at least two coins required");
  }
  positive(state.amplification, "amplification");
  positive(state.lpTotalSupply, "lpTotalSupply");
  if (uint(state.fee, "fee") > FEE_DENOMINATOR) fail("fee exceeds denominator");
  return normalize(state.balances, state.precisions);
}

function normalize(balances: readonly bigint[], precisions: readonly bigint[]): bigint[] {
  // An indexed loop also rejects sparse input arrays.
  const xp: bigint[] = [];
  for (let i = 0; i < balances.length; i++) {
    xp.push(rateNormalized(positive(balances[i], "balance"), positive(precisions[i], "precision")));
  }
  return xp;
}

function rateNormalized(amount: bigint, precision: bigint): bigint {
  // Vyper evaluates amount * RATES / 1e18 with checked uint256 intermediates.
  // Cancelling the scale algebraically would incorrectly admit overflow inputs.
  return mul(amount, mul(precision, RATE_SCALE)) / RATE_SCALE;
}

// Same old-style integer recurrence as solver/curve-math.ts::getD, but bounded
// failure is explicit: the shared helper returns its last unconverged iterate.
function invariant(xp: readonly bigint[], amplification: bigint): bigint {
  const n = BigInt(xp.length);
  const sum = xp.reduce((total, value) => add(total, value), 0n);
  const ann = mul(amplification, n);
  let d = sum;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let product = d;
    for (const value of xp) product = mul(product, d) / mul(value, n);
    const previous = d;
    d = mul(add(mul(ann, sum), mul(product, n)), d) /
      add(mul(sub(ann, 1n), d), mul(n + 1n, product));
    if (distance(d, previous) <= 1n) return positive(d, "invariant");
  }
  return fail("invariant did not converge");
}

function solveY(
  xp: readonly bigint[],
  amplification: bigint,
  i: number,
  j: number,
  x: bigint,
  d: bigint,
): bigint {
  const n = BigInt(xp.length);
  const ann = mul(amplification, n);
  let c = d;
  let sum = 0n;
  for (let k = 0; k < xp.length; k++) {
    if (k === j) continue;
    const value = k === i ? x : xp[k];
    sum = add(sum, value);
    c = mul(c, d) / mul(value, n);
  }
  c = mul(c, d) / mul(ann, n);
  const b = add(sum, d / ann);
  let y = d;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const previous = y;
    const denominator = positive(sub(add(mul(2n, y), b), d), "y denominator");
    y = add(mul(y, y), c) / denominator;
    if (distance(y, previous) <= 1n) return y;
  }
  return fail("y did not converge");
}

function validateIndex(index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    fail("invalid token index");
  }
}

function uint(value: bigint, label = "arithmetic"): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT256) {
    fail(label + " outside uint256 range");
  }
  return value;
}

function positive(value: bigint, label: string): bigint {
  uint(value, label);
  if (value === 0n) fail(label + " must be positive");
  return value;
}

function add(a: bigint, b: bigint): bigint { return uint(a + b); }
function sub(a: bigint, b: bigint): bigint { return uint(a - b); }
function mul(a: bigint, b: bigint): bigint { return uint(a * b); }
function distance(a: bigint, b: bigint): bigint { return a > b ? a - b : b - a; }
function fail(message: string): never { throw new RangeError("classic base pool: " + message); }
