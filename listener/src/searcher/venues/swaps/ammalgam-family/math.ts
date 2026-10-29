import {
  BIPS_Q64,
  BUFFER,
  BUFFER_NUMERATOR,
  FEE_N,
  FEE_SLOPE_Q64,
  MAX_QUADRATIC_FEE_BIPS,
  MAX_QUADRATIC_FEE_Q64,
  MIN_FEE_Q64,
  TWO_Q64,
} from "./codec.js";

/**
 * Reference implementation of the Ammalgam pair's swap invariant, transcribed
 * from the verified source (AmmalgamPair.sol `swap` / `calculateBalanceAfterFees`,
 * QuadraticSwapFees.sol, Convert.sol). It is used to derive a quote and to
 * cross-check the runtime program; the runtime program is the executable copy.
 *
 * Model (all values are raw token units, exactly as the pair sees them):
 *   amountIn  = netBalanceIn  - (reserveIn  - amountInOut)   // pair measures it
 *   amountOut = requested output, limited by
 *   balanceAfterFeesIn * balanceAfterFeesOut >= adjustedReserveIn * adjustedReserveOut
 * where netBalance = token.balanceOf(pair) + BORROW - DEPOSIT (Ammalgam's
 * `getNetBalances`) and adjustedReserve applies the depleted-asset buffer.
 *
 * The family models the non-depleted branch of the pair invariant; `quotable`
 * rejects the depleted regime instead of approximating it.
 */

const mulDiv = (x: bigint, y: bigint, z: bigint): bigint => (x * y) / z;

function quadraticFeeQ64(input: bigint, currentReserve: bigint, referenceReserve: bigint): bigint {
  return mulDiv(FEE_SLOPE_Q64, input + 2n * (currentReserve - referenceReserve), referenceReserve);
}

function linearFeeQ64(input: bigint, currentReserve: bigint, referenceReserve: bigint): bigint {
  return MAX_QUADRATIC_FEE_BIPS *
    (TWO_Q64 - mulDiv(referenceReserve, MAX_QUADRATIC_FEE_Q64, FEE_N * (input + 2n * (currentReserve - referenceReserve))));
}

/** QuadraticSwapFees.calculateSwapFeeBipsQ64 (fee in Q64 bips). */
export function swapFeeQ64(input: bigint, currentReserve: bigint, referenceReserve: bigint): bigint {
  if (input <= 0n || currentReserve <= 0n || referenceReserve <= 0n) {
    throw new Error("ammalgam fee inputs must be positive");
  }
  const currentReserveAfterSwap = input + currentReserve;
  let fee = 0n;
  if (currentReserve >= referenceReserve) {
    fee = currentReserveAfterSwap + currentReserve > referenceReserve * 4n
      ? linearFeeQ64(input, currentReserve, referenceReserve)
      : quadraticFeeQ64(input, currentReserve, referenceReserve);
  } else if (currentReserveAfterSwap > referenceReserve) {
    const pastBy = currentReserveAfterSwap - referenceReserve;
    const pastFee = pastBy > 2n * referenceReserve
      ? linearFeeQ64(pastBy, referenceReserve, referenceReserve)
      : quadraticFeeQ64(pastBy, referenceReserve, referenceReserve);
    fee = mulDiv(pastFee, pastBy, input);
  }
  return fee > MIN_FEE_Q64 ? fee : MIN_FEE_Q64;
}

/** AmmalgamPair.calculateBalanceAfterFees in the non-depleted branch. */
export function balanceAfterFeesQ64(
  amountIn: bigint,
  balance: bigint,
  reserve: bigint,
  referenceReserve: bigint,
): bigint {
  const fee = swapFeeQ64(amountIn, reserve, referenceReserve);
  return (balance * BIPS_Q64 - amountIn * fee) / BIPS_Q64;
}

/** Convert.calculateReserveAdjustmentsForMissingAssets with the swap buffer. */
export function adjustedReserve(reserve: bigint, missing: bigint): bigint {
  return reserve * BUFFER < missing * BUFFER_NUMERATOR
    ? (reserve - missing) * BUFFER_NUMERATOR
    : reserve;
}

export function isDepleted(reserve: bigint, missing: bigint): boolean {
  return reserve * BUFFER < missing * BUFFER_NUMERATOR;
}

export interface QuoteInput {
  readonly amountIn: bigint;
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly referenceIn: bigint;
  /** Net balance of the input token before the trader's transfer. */
  readonly netIn: bigint;
  /** Net balance of the output token before the pair releases output. */
  readonly netOut: bigint;
  readonly missingIn: bigint;
  readonly missingOut: bigint;
}

/**
 * Largest output the pair accepts for `amountIn` under the non-depleted
 * invariant. The trader pre-transfers `amountIn`, so the pair's measured input
 * equals `amountIn` when `netIn === reserveIn` (the pair's own assumption,
 * checked by callers and by the runtime program).
 */
export function quoteAmountOut(input: QuoteInput): bigint {
  if (input.amountIn <= 0n) throw new Error("ammalgam quote needs a positive input");
  if (input.netIn !== input.reserveIn || input.netOut !== input.reserveOut) {
    throw new Error("ammalgam net balance does not match reserve");
  }
  if (isDepleted(input.reserveIn, input.missingIn) || isDepleted(input.reserveOut, input.missingOut)) {
    throw new Error("ammalgam depleted reserve is not modelled");
  }
  const balanceIn = input.netIn + input.amountIn;
  const balanceAfterFeesIn = balanceAfterFeesQ64(
    input.amountIn, balanceIn, input.reserveIn, input.referenceIn,
  );
  if (balanceAfterFeesIn <= 0n) throw new Error("ammalgam swap fee consumes the input");
  const product = adjustedReserve(input.reserveIn, input.missingIn) *
    adjustedReserve(input.reserveOut, input.missingOut);
  const requiredOutBalance = (product + balanceAfterFeesIn - 1n) / balanceAfterFeesIn;
  if (requiredOutBalance >= input.netOut) throw new Error("ammalgam output exceeds pair liquidity");
  return input.netOut - requiredOutBalance;
}
