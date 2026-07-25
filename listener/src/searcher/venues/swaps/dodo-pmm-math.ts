/**
 * Exact bigint port of DODO V2 PMMPricing/DODOMath.
 *
 * The operation order intentionally follows the official Solidity libraries.
 * Every intermediate is checked as uint256. Two expressions have materially
 * different behavior across deployed DODO bytecode generations; those return
 * `needs-onchain-quote` so the block-scan capability can issue a real query
 * instead of guessing which implementation is behind the pool.
 */

export const DODO_DECIMAL_ONE = 10n ** 18n;
export const DODO_DECIMAL_ONE2 = 10n ** 36n;
export const DODO_UINT256_MAX = (1n << 256n) - 1n;

export type DodoRState = 0 | 1 | 2;

export interface DodoPmmState {
  readonly i: bigint;
  readonly K: bigint;
  readonly B: bigint;
  readonly Q: bigint;
  readonly B0: bigint;
  readonly Q0: bigint;
  readonly R: DodoRState;
}

export type DodoPmmAmbiguityReason =
  | "legacy-numerator-zero"
  | "solidity-overflow-semantics";

export type DodoPmmQuoteResult =
  | {
    readonly status: "quote";
    readonly amountOut: bigint;
    readonly grossAmountOut: bigint;
    readonly lpFee: bigint;
    readonly mtFee: bigint;
  }
  | {
    readonly status: "needs-onchain-quote";
    readonly reason: DodoPmmAmbiguityReason;
  };

type DodoRawQuoteResult =
  | { readonly status: "quote"; readonly amountOut: bigint }
  | {
    readonly status: "needs-onchain-quote";
    readonly reason: DodoPmmAmbiguityReason;
  };

export function quoteDodoPmmExactInput(input: {
  readonly state: DodoPmmState;
  readonly sellBase: boolean;
  readonly payAmount: bigint;
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
}): DodoPmmQuoteResult {
  const { state, sellBase, payAmount, lpFeeRate, mtFeeRate } = input;
  validatePmmState(state);
  checkedUint(payAmount, "pay amount");
  checkedUint(lpFeeRate, "LP fee rate");
  checkedUint(mtFeeRate, "MT fee rate");
  if (lpFeeRate > DODO_DECIMAL_ONE || mtFeeRate > DODO_DECIMAL_ONE) {
    throw new Error("dodo PMM fee rate exceeds one");
  }

  const raw = sellBase
    ? sellBaseToken(state, payAmount)
    : sellQuoteToken(state, payAmount);
  if (raw.status !== "quote") return raw;

  // DODO subtracts these independently. Combining the rates first changes
  // rounding by one wei for some outputs.
  const lpFee = decimalMulFloor(raw.amountOut, lpFeeRate);
  const mtFee = decimalMulFloor(raw.amountOut, mtFeeRate);
  const amountOut = checkedSub(
    checkedSub(raw.amountOut, lpFee, "gross output - LP fee"),
    mtFee,
    "gross output - MT fee",
  );
  return Object.freeze({
    status: "quote",
    amountOut,
    grossAmountOut: raw.amountOut,
    lpFee,
    mtFee,
  });
}

export function checkedDodoInput(
  currentInput: bigint,
  transferAmount: bigint,
  pool: string,
): bigint {
  try {
    return checkedAdd(currentInput, transferAmount, "current input + transfer");
  } catch (error) {
    throw new Error(
      `dodo-v2 effective input overflow for pool ${pool}: ${errorMessage(error)}`,
    );
  }
}

function sellBaseToken(
  state: DodoPmmState,
  payBaseAmount: bigint,
): DodoRawQuoteResult {
  if (state.R === 0) {
    return solveTrade(state.Q0, state.Q0, payBaseAmount, state.i, state.K);
  }
  if (state.R === 1) {
    const backToOnePayBase = checkedSub(
      state.B0,
      state.B,
      "ABOVE_ONE B0-B",
    );
    const backToOneReceiveQuote = checkedSub(
      state.Q,
      state.Q0,
      "ABOVE_ONE Q-Q0",
    );
    if (payBaseAmount < backToOnePayBase) {
      const quoted = generalIntegrate(
        state.B0,
        checkedAdd(state.B, payBaseAmount, "B+payBase"),
        state.B,
        state.i,
        state.K,
      );
      return quoted.status === "quote"
        ? quoteResult(minBigint(quoted.amountOut, backToOneReceiveQuote))
        : quoted;
    }
    if (payBaseAmount === backToOnePayBase) {
      return quoteResult(backToOneReceiveQuote);
    }
    const afterCrossing = solveTrade(
      state.Q0,
      state.Q0,
      checkedSub(payBaseAmount, backToOnePayBase, "payBase-backToOne"),
      state.i,
      state.K,
    );
    return addQuote(backToOneReceiveQuote, afterCrossing);
  }
  return solveTrade(state.Q0, state.Q, payBaseAmount, state.i, state.K);
}

function sellQuoteToken(
  state: DodoPmmState,
  payQuoteAmount: bigint,
): DodoRawQuoteResult {
  if (state.i === 0n) throw new Error("dodo PMM oracle price is zero");
  const reciprocal = DODO_DECIMAL_ONE2 / state.i;
  if (state.R === 0) {
    return solveTrade(state.B0, state.B0, payQuoteAmount, reciprocal, state.K);
  }
  if (state.R === 1) {
    return solveTrade(state.B0, state.B, payQuoteAmount, reciprocal, state.K);
  }

  const backToOnePayQuote = checkedSub(
    state.Q0,
    state.Q,
    "BELOW_ONE Q0-Q",
  );
  const backToOneReceiveBase = checkedSub(
    state.B,
    state.B0,
    "BELOW_ONE B-B0",
  );
  if (payQuoteAmount < backToOnePayQuote) {
    const quoted = generalIntegrate(
      state.Q0,
      checkedAdd(state.Q, payQuoteAmount, "Q+payQuote"),
      state.Q,
      reciprocal,
      state.K,
    );
    return quoted.status === "quote"
      ? quoteResult(minBigint(quoted.amountOut, backToOneReceiveBase))
      : quoted;
  }
  if (payQuoteAmount === backToOnePayQuote) {
    return quoteResult(backToOneReceiveBase);
  }
  const afterCrossing = solveTrade(
    state.B0,
    state.B0,
    checkedSub(payQuoteAmount, backToOnePayQuote, "payQuote-backToOne"),
    reciprocal,
    state.K,
  );
  return addQuote(backToOneReceiveBase, afterCrossing);
}

function generalIntegrate(
  V0: bigint,
  V1: bigint,
  V2: bigint,
  i: bigint,
  k: bigint,
): DodoRawQuoteResult {
  if (V0 <= 0n) throw new Error("dodo PMM target is zero");
  const fairAmount = checkedMul(
    i,
    checkedSub(V1, V2, "general integrate V1-V2"),
    "general integrate fair amount",
  );
  if (k === 0n) return quoteResult(fairAmount / DODO_DECIMAL_ONE);

  // DecimalMath.divFloor(V0.mul(V0).div(V1), V2), preserving
  // Solidity's exact intermediate rounding order.
  const V0V0V1 = checkedMul(V0, V0, "general integrate V0^2") / nonzero(V1);
  const V0V0V1V2 = decimalDivFloor(V0V0V1, V2);
  const penalty = decimalMulFloor(k, V0V0V1V2);
  const coefficient = checkedAdd(
    checkedSub(DODO_DECIMAL_ONE, k, "ONE-k"),
    penalty,
    "general integrate coefficient",
  );
  return quoteResult(
    checkedMul(
      coefficient,
      fairAmount,
      "general integrate coefficient*fair",
    ) / DODO_DECIMAL_ONE2,
  );
}

function solveTrade(
  V0: bigint,
  V1: bigint,
  delta: bigint,
  i: bigint,
  k: bigint,
): DodoRawQuoteResult {
  if (V0 <= 0n) throw new Error("dodo PMM target is zero");
  if (delta === 0n) return quoteResult(0n);

  if (k === 0n) {
    const fair = decimalMulFloor(i, delta);
    return quoteResult(fair > V1 ? V1 : fair);
  }

  if (k === DODO_DECIMAL_ONE) {
    const idelta = checkedMul(i, delta, "K=ONE i*delta");
    if (idelta === 0n) return quoteResult(0n);

    // Solidity 0.6 deployments deliberately probe an unchecked product and
    // use a rearranged expression on overflow. Solidity 0.8 GSP deployments
    // revert before that branch. Delegate the bytecode-dependent case.
    if (wouldMulOverflow(idelta, V1)) {
      return needsOnchainQuote("solidity-overflow-semantics");
    }
    const denominator = checkedMul(V0, V0, "K=ONE V0^2");
    const temp = checkedMul(idelta, V1, "K=ONE idelta*V1") /
      nonzero(denominator);
    return quoteResult(
      checkedMul(V1, temp, "K=ONE V1*temp") /
        checkedAdd(temp, DODO_DECIMAL_ONE, "K=ONE temp+ONE"),
    );
  }

  const part2 = checkedAdd(
    checkedMul(
      checkedMul(k, V0, "quadratic k*V0") / nonzero(V1),
      V0,
      "quadratic k*V0/V1*V0",
    ),
    checkedMul(i, delta, "quadratic i*delta"),
    "quadratic part2",
  );
  let bAbs = checkedMul(
    checkedSub(DODO_DECIMAL_ONE, k, "quadratic ONE-k"),
    V1,
    "quadratic (ONE-k)*V1",
  );
  let bSig: boolean;
  if (bAbs >= part2) {
    bAbs -= part2;
    bSig = false;
  } else {
    bAbs = part2 - bAbs;
    bSig = true;
  }
  bAbs /= DODO_DECIMAL_ONE;

  const squareRootTerm = decimalMulFloor(
    checkedMul(
      checkedSub(DODO_DECIMAL_ONE, k, "quadratic ONE-k"),
      4n,
      "quadratic 4*(ONE-k)",
    ),
    checkedMul(
      decimalMulFloor(k, V0),
      V0,
      "quadratic mulFloor(k,V0)*V0",
    ),
  );
  const squareRoot = integerSqrt(
    checkedAdd(
      checkedMul(bAbs, bAbs, "quadratic bAbs^2"),
      squareRootTerm,
      "quadratic discriminant",
    ),
  );
  const denominator = checkedMul(
    checkedSub(DODO_DECIMAL_ONE, k, "quadratic denominator ONE-k"),
    2n,
    "quadratic denominator",
  );
  const numerator = bSig
    ? checkedSub(squareRoot, bAbs, "quadratic sqrt-bAbs")
    : checkedAdd(bAbs, squareRoot, "quadratic bAbs+sqrt");
  if (bSig && numerator === 0n) {
    // The original 0.6 library returned zero through divCeil(0), while later
    // versions and GSP explicitly revert. The pool implementation decides.
    return needsOnchainQuote("legacy-numerator-zero");
  }
  const V2 = decimalDivCeil(numerator, denominator);
  return quoteResult(V2 > V1 ? 0n : V1 - V2);
}

function decimalMulFloor(a: bigint, b: bigint): bigint {
  return checkedMul(a, b, "decimal mulFloor") / DODO_DECIMAL_ONE;
}

function decimalDivFloor(a: bigint, b: bigint): bigint {
  return checkedMul(a, DODO_DECIMAL_ONE, "decimal divFloor numerator") /
    nonzero(b);
}

function decimalDivCeil(a: bigint, b: bigint): bigint {
  const numerator = checkedMul(
    a,
    DODO_DECIMAL_ONE,
    "decimal divCeil numerator",
  );
  const divisor = nonzero(b);
  if (numerator === 0n) return 0n;
  return (numerator - 1n) / divisor + 1n;
}

function integerSqrt(value: bigint): bigint {
  checkedUint(value, "sqrt input");
  if (value < 2n) return value;
  let x0 = 1n << (BigInt(value.toString(2).length) + 1n) / 2n;
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

function checkedUint(value: bigint, label: string): bigint {
  if (value < 0n || value > DODO_UINT256_MAX) {
    throw new Error(`dodo PMM uint256 overflow: ${label}`);
  }
  return value;
}

function checkedAdd(a: bigint, b: bigint, label: string): bigint {
  checkedUint(a, `${label} lhs`);
  checkedUint(b, `${label} rhs`);
  const result = a + b;
  return checkedUint(result, label);
}

function checkedSub(a: bigint, b: bigint, label: string): bigint {
  checkedUint(a, `${label} lhs`);
  checkedUint(b, `${label} rhs`);
  if (b > a) throw new Error(`dodo PMM uint256 underflow: ${label}`);
  return a - b;
}

function checkedMul(a: bigint, b: bigint, label: string): bigint {
  checkedUint(a, `${label} lhs`);
  checkedUint(b, `${label} rhs`);
  if (a !== 0n && b > DODO_UINT256_MAX / a) {
    throw new Error(`dodo PMM uint256 overflow: ${label}`);
  }
  return a * b;
}

function wouldMulOverflow(a: bigint, b: bigint): boolean {
  checkedUint(a, "overflow probe lhs");
  checkedUint(b, "overflow probe rhs");
  return a !== 0n && b > DODO_UINT256_MAX / a;
}

function nonzero(value: bigint): bigint {
  if (value === 0n) throw new Error("dodo PMM division by zero");
  return value;
}

function validatePmmState(state: DodoPmmState): void {
  checkedUint(state.i, "state.i");
  checkedUint(state.K, "state.K");
  checkedUint(state.B, "state.B");
  checkedUint(state.Q, "state.Q");
  checkedUint(state.B0, "state.B0");
  checkedUint(state.Q0, "state.Q0");
  if (state.K > DODO_DECIMAL_ONE) {
    throw new Error("dodo PMM K exceeds one");
  }
  if (state.R !== 0 && state.R !== 1 && state.R !== 2) {
    throw new Error(`dodo PMM invalid R state ${String(state.R)}`);
  }
}

function quoteResult(amountOut: bigint): DodoRawQuoteResult {
  return Object.freeze({
    status: "quote",
    amountOut: checkedUint(amountOut, "quote output"),
  });
}

function needsOnchainQuote(
  reason: DodoPmmAmbiguityReason,
): DodoRawQuoteResult {
  return Object.freeze({ status: "needs-onchain-quote", reason });
}

function addQuote(
  prefix: bigint,
  suffix: DodoRawQuoteResult,
): DodoRawQuoteResult {
  if (suffix.status !== "quote") return suffix;
  return quoteResult(checkedAdd(prefix, suffix.amountOut, "crossing quote sum"));
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
