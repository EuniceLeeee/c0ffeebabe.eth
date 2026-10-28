import {
  ALGEBRA_FEE_DENOMINATOR,
  ALGEBRA_MAX_SQRT_RATIO,
  ALGEBRA_MAX_TICK,
  ALGEBRA_MIN_SQRT_RATIO,
  ALGEBRA_MIN_TICK,
  ALGEBRA_Q96,
} from "./abi.js";

const UINT256_MAX = (1n << 256n) - 1n;
const UINT160_MAX = (1n << 160n) - 1n;
const RESOLUTION = 96n;

/**
 * Algebra Integral 1.2.1 swap math, ported from the deployed sources
 * (`PriceMovementMath`, `TokenDeltaMath`, `SwapCalculation`). It is
 * deliberately the pool's own arithmetic and rounding, not a UniV3
 * approximation: the family-local contract test reproduces four observed
 * `AlgebraPool.Swap` events exactly (amounts AND post price) with the
 * `overrideFee` those events carry.
 *
 * Only the single-in-range step is modelled. When the requested input would
 * reach the next initialized tick the swap is DECLINED instead of being
 * approximated: `SwapCalculation._calculateSwap` reloads liquidity at every
 * crossed tick from the pool's tick tree, which this family does not read.
 */

export type AlgebraRangeQuote =
  | {
      readonly status: "quoted";
      readonly amountOut: bigint;
      readonly sqrtPriceX96After: bigint;
    }
  | { readonly status: "declined"; readonly reason: string };

export interface AlgebraRangeStep {
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  /** Executed fee in hundredths of a bip (1e-6): `overrideFee + pluginFee`,
   * or `globalState.lastFee + pluginFee` when no override is returned. */
  readonly fee: bigint;
  /** Target price that must not be reached: the next initialized tick. */
  readonly targetSqrtPriceX96: bigint;
  readonly tickSpacing: number;
}

export function quoteAlgebraExactInput(
  step: AlgebraRangeStep,
  zeroForOne: boolean,
  amountIn: bigint,
): AlgebraRangeQuote {
  if (amountIn <= 0n) {
    return Object.freeze({ status: "declined" as const, reason: "non-positive input" });
  }
  if (step.sqrtPriceX96 === 0n) {
    return Object.freeze({
      status: "declined" as const,
      reason: "pool is not initialized (zero sqrt price)",
    });
  }
  if (step.liquidity === 0n) {
    return Object.freeze({
      status: "declined" as const,
      reason: "pool has zero active liquidity",
    });
  }
  if (
    step.sqrtPriceX96 <= ALGEBRA_MIN_SQRT_RATIO ||
    step.sqrtPriceX96 >= ALGEBRA_MAX_SQRT_RATIO
  ) {
    return Object.freeze({
      status: "declined" as const,
      reason: "price sits on the range boundary",
    });
  }
  if (
    (zeroForOne && step.targetSqrtPriceX96 >= step.sqrtPriceX96) ||
    (!zeroForOne && step.targetSqrtPriceX96 <= step.sqrtPriceX96)
  ) {
    return Object.freeze({
      status: "declined" as const,
      reason: "next initialized tick is not on the swap's price side",
    });
  }
  if (step.fee < 0n || step.fee >= ALGEBRA_FEE_DENOMINATOR) {
    return Object.freeze({
      status: "declined" as const,
      reason: `executed fee ${step.fee} is outside the Denominator-bounded range`,
    });
  }

  // PriceMovementMath.movePriceTowardsTarget, exact-input branch:
  // amountAvailableAfterFee = mulDiv(amount, FEE_DENOMINATOR - fee, FEE_DENOMINATOR)
  const afterFee = mulDiv(
    amountIn,
    ALGEBRA_FEE_DENOMINATOR - step.fee,
    ALGEBRA_FEE_DENOMINATOR,
  );
  const inputToTarget = zeroForOne
    ? token0Delta(step.targetSqrtPriceX96, step.sqrtPriceX96, step.liquidity, true)
    : token1Delta(step.sqrtPriceX96, step.targetSqrtPriceX96, step.liquidity, true);
  if (afterFee >= inputToTarget) {
    // The swap reaches (and would cross) the next initialized tick.
    return Object.freeze({
      status: "declined" as const,
      reason: "input crosses the next initialized tick; multi-range liquidity is not modelled",
    });
  }

  const sqrtPriceX96After = getNewPriceAfterInput(
    step.sqrtPriceX96,
    step.liquidity,
    afterFee,
    zeroForOne,
  );
  const amountOut = zeroForOne
    ? token1Delta(sqrtPriceX96After, step.sqrtPriceX96, step.liquidity, false)
    : token0Delta(step.sqrtPriceX96, sqrtPriceX96After, step.liquidity, false);
  return Object.freeze({
    status: "quoted" as const,
    amountOut,
    sqrtPriceX96After,
  });
}

/** `PriceMovementMath.getNewPriceAfterInput`. */
function getNewPriceAfterInput(
  price: bigint,
  liquidity: bigint,
  amount: bigint,
  zeroForOne: boolean,
): bigint {
  if (price === 0n || liquidity === 0n) {
    throw new Error("algebra-integral price math requires a live pool");
  }
  if (amount === 0n) return price;
  const liquidityShifted = BigInt(liquidity) << RESOLUTION;
  if (zeroForOne) {
    // zeroToOne == fromInput: rounding up.
    const product = amount * price;
    if (product <= UINT256_MAX) {
      const denominator = liquidityShifted + product;
      if (denominator <= UINT256_MAX && denominator >= liquidityShifted) {
        return mulDivRoundingUp(liquidityShifted, price, denominator);
      }
    }
    return divRoundingUp(liquidityShifted, (liquidityShifted / price) + amount);
  }
  // One for zero: floor, with the deployed uint160 shortcut for the shift.
  const delta = amount <= UINT160_MAX
    ? (amount << RESOLUTION) / liquidity
    : mulDiv(amount, ALGEBRA_Q96, liquidity);
  return price + delta;
}

/** `TokenDeltaMath.getToken0Delta`. */
function token0Delta(
  priceLower: bigint,
  priceUpper: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const priceDelta = priceUpper - priceLower;
  if (priceDelta >= priceUpper || priceLower === 0n) {
    throw new Error("algebra-integral token0 delta requires ordered prices");
  }
  const liquidityShifted = BigInt(liquidity) << RESOLUTION;
  if (roundUp) {
    return divRoundingUp(
      mulDivRoundingUp(priceDelta, liquidityShifted, priceUpper),
      priceLower,
    );
  }
  return mulDiv(priceDelta, liquidityShifted, priceUpper) / priceLower;
}

/** `TokenDeltaMath.getToken1Delta`. */
function token1Delta(
  priceLower: bigint,
  priceUpper: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (priceUpper < priceLower) {
    throw new Error("algebra-integral token1 delta requires ordered prices");
  }
  const priceDelta = priceUpper - priceLower;
  return roundUp
    ? mulDivRoundingUp(priceDelta, liquidity, ALGEBRA_Q96)
    : mulDiv(priceDelta, liquidity, ALGEBRA_Q96);
}

function mulDiv(left: bigint, right: bigint, denominator: bigint): bigint {
  assertUint256(left * right + denominator - 1n);
  return (left * right) / denominator;
}

function mulDivRoundingUp(
  left: bigint,
  right: bigint,
  denominator: bigint,
): bigint {
  const product = left * right;
  assertUint256(product + denominator - 1n);
  return product % denominator === 0n
    ? product / denominator
    : (product / denominator) + 1n;
}

function divRoundingUp(numerator: bigint, denominator: bigint): bigint {
  return numerator % denominator === 0n
    ? numerator / denominator
    : (numerator / denominator) + 1n;
}

function assertUint256(value: bigint): void {
  if (value < 0n || value > UINT256_MAX) {
    throw new Error("algebra-integral fixed-point math overflowed uint256");
  }
}

/**
 * `TickMath.getSqrtRatioAtTick`, the standard bounded implementation. Used only
 * to turn the pool's own `prevTickGlobal`/`nextTickGlobal` into the price target
 * of the single modelled step.
 */
export function sqrtRatioAtTick(tick: number): bigint {
  if (
    !Number.isSafeInteger(tick) ||
    tick < ALGEBRA_MIN_TICK ||
    tick > ALGEBRA_MAX_TICK
  ) {
    throw new Error(`algebra-integral tick ${tick} is out of range`);
  }
  const absolute = BigInt(Math.abs(tick));
  let ratio = absolute & 0x1n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const steps: readonly (readonly [bigint, bigint])[] = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, magic] of steps) {
    if ((absolute & bit) !== 0n) ratio = (ratio * magic) >> 128n;
  }
  if (tick > 0) ratio = UINT256_MAX / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
