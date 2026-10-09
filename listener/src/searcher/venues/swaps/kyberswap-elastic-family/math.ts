import { MAX_TICK, MIN_TICK, getSqrtRatioAtTick } from
  "../../../solver/v3-math.js";
import {
  KYSWAP_FEE_UNITS,
  KYSWAP_MAX_TICK_DISTANCE,
  KYSWAP_TWO_FEE_UNITS,
  KYSWAP_TWO_POW_96,
} from "./abi.js";
import type { KyberSwapPoolState } from "./types.js";

/**
 * Faithful port of the verified pool's `SwapMath` (`contracts/libraries/
 * SwapMath.sol`, solc 0.8.9) restricted to the EXACT-INPUT paths this family
 * routes. Every expression below cites the source comment it implements; the
 * fee is charged inside the step (`swapFeeUnits` against `FEE_UNITS = 100000`)
 * and the step's liquidity is `baseL + reinvestL`, exactly as `Pool.swap`
 * passes it. Nothing here reads a quoted amount or an off-chain point price.
 */
function mulDivFloor(left: bigint, right: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("kyberswap elastic division by zero");
  return (left * right) / denominator;
}

function mulDivCeiling(
  left: bigint,
  right: bigint,
  denominator: bigint,
): bigint {
  if (denominator === 0n) throw new Error("kyberswap elastic division by zero");
  const product = left * right;
  return product === 0n ? 0n : (product - 1n) / denominator + 1n;
}

export type KyberSwapStepRefusal =
  | "no-active-liquidity"
  | "price-limit-not-movable"
  | "input-reaches-next-initialized-tick"
  | "no-representable-output"
  | "tick-boundary-unavailable";

export interface KyberSwapStepQuote {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly sqrtPAfter: bigint;
  readonly deltaL: bigint;
  readonly targetTick: number;
}

export type KyberSwapStepOutcome =
  | { readonly ok: true; readonly quote: KyberSwapStepQuote }
  | { readonly ok: false; readonly refusal: KyberSwapStepRefusal };

/**
 * The step target tick the pool itself derives:
 *   `nextTick = nearestCurrentTick` and, when the price moves up,
 *   `nextTick = initializedTicks[nextTick].next` (`_getInitialSwapData`).
 * A single step never travels further than `MAX_TICK_DISTANCE` (480) ticks
 * (`Pool.swap` caps `tempNextTick` by it), so the target is capped the same way.
 */
export function stepTargetTick(
  state: KyberSwapPoolState,
  isToken0: boolean,
): number | null {
  if (isToken0) {
    const capped = Math.max(
      state.nearestCurrentTick,
      state.currentTick - KYSWAP_MAX_TICK_DISTANCE,
    );
    return capped < MIN_TICK ? null : capped;
  }
  if (state.nextTick === null) return null;
  const capped = Math.min(
    state.nextTick,
    state.currentTick + KYSWAP_MAX_TICK_DISTANCE,
  );
  return capped > MAX_TICK ? null : capped;
}

/**
 * Exact-input quote for the FIRST swap step only. When the specified input is
 * enough to reach the next initialized tick the pool crosses a range and the
 * post-crossing liquidity is not part of this round's evidence, so the quote is
 * refused instead of being extrapolated.
 */
export function quoteExactInputStep(input: {
  readonly state: KyberSwapPoolState;
  readonly isToken0: boolean;
  readonly amountIn: bigint;
}): KyberSwapStepOutcome {
  const { state, isToken0, amountIn } = input;
  const liquidity = state.baseL + state.reinvestL;
  if (amountIn <= 0n || liquidity <= 0n || state.locked) {
    return refusal("no-active-liquidity");
  }
  const targetTick = stepTargetTick(state, isToken0);
  if (targetTick === null) return refusal("tick-boundary-unavailable");
  const targetSqrtP = getSqrtRatioAtTick(targetTick);
  if (
    (isToken0 && targetSqrtP >= state.sqrtP) ||
    (!isToken0 && targetSqrtP <= state.sqrtP)
  ) {
    return refusal("price-limit-not-movable");
  }
  const reach = calcReachAmountExactInput(
    liquidity,
    state.sqrtP,
    targetSqrtP,
    state.feeUnits,
    isToken0,
  );
  // `SwapMath.computeSwapStep`: when the reach amount exceeds the specified
  // input the step stops inside the range (usedAmount = specifiedAmount).
  // Elsewhere the pool reaches the initialized tick and crosses it.
  if (reach <= amountIn) return refusal("input-reaches-next-initialized-tick");
  const deltaL = estimateIncrementalLiquidity(
    amountIn,
    state.sqrtP,
    state.feeUnits,
    isToken0,
  );
  const sqrtPAfter = calcFinalPrice(
    amountIn,
    liquidity,
    deltaL,
    state.sqrtP,
    isToken0,
  );
  let returnedAmount = calcReturnedAmountExactInput(
    liquidity,
    state.sqrtP,
    sqrtPAfter,
    deltaL,
    isToken0,
  );
  if (returnedAmount === 1n) returnedAmount = 0n;
  if (returnedAmount >= 0n) return refusal("no-representable-output");
  return Object.freeze({
    ok: true as const,
    quote: Object.freeze({
      amountIn,
      amountOut: -returnedAmount,
      sqrtPAfter,
      deltaL,
      targetTick,
    }),
  });
}

function refusal(reason: KyberSwapStepRefusal): KyberSwapStepOutcome {
  return Object.freeze({ ok: false as const, refusal: reason });
}

/**
 * `calcReachAmount` (isExactInput branch): the input needed to move the price to
 * `targetSqrtP`, with the fee denominator expressed in `TWO_FEE_UNITS`.
 */
export function calcReachAmountExactInput(
  liquidity: bigint,
  currentSqrtP: bigint,
  targetSqrtP: bigint,
  feeInFeeUnits: bigint,
  isToken0: boolean,
): bigint {
  const absPriceDiff = currentSqrtP >= targetSqrtP
    ? currentSqrtP - targetSqrtP
    : targetSqrtP - currentSqrtP;
  if (isToken0) {
    // denominator = 2 * targetSqrtP - currentSqrtP * feeInFeeUnits / FEE_UNITS
    const denominator = KYSWAP_TWO_FEE_UNITS * targetSqrtP -
      feeInFeeUnits * currentSqrtP;
    if (denominator <= 0n) throw new Error("kyberswap elastic invalid fee step");
    const numerator = mulDivFloor(
      liquidity,
      KYSWAP_TWO_FEE_UNITS * absPriceDiff,
      denominator,
    );
    return mulDivFloor(numerator, KYSWAP_TWO_POW_96, currentSqrtP);
  }
  // denominator = 2 * currentSqrtP - targetSqrtP * feeInFeeUnits / FEE_UNITS
  const denominator = KYSWAP_TWO_FEE_UNITS * currentSqrtP -
    feeInFeeUnits * targetSqrtP;
  if (denominator <= 0n) throw new Error("kyberswap elastic invalid fee step");
  const numerator = mulDivFloor(
    liquidity,
    KYSWAP_TWO_FEE_UNITS * absPriceDiff,
    denominator,
  );
  return mulDivFloor(numerator, currentSqrtP, KYSWAP_TWO_POW_96);
}

/** `estimateIncrementalLiquidity` (isExactInput branch): the fee's deltaL. */
export function estimateIncrementalLiquidity(
  absDelta: bigint,
  currentSqrtP: bigint,
  feeInFeeUnits: bigint,
  isToken0: boolean,
): bigint {
  if (isToken0) {
    // deltaL = feeInFeeUnits * absDelta * currentSqrtP / 2
    return mulDivFloor(
      currentSqrtP,
      absDelta * feeInFeeUnits,
      KYSWAP_TWO_FEE_UNITS << 96n,
    );
  }
  // deltaL = feeInFeeUnits * absDelta / (currentSqrtP * 2)
  return mulDivFloor(
    KYSWAP_TWO_POW_96,
    absDelta * feeInFeeUnits,
    KYSWAP_TWO_FEE_UNITS * currentSqrtP,
  );
}

/** `calcFinalPrice` (isExactInput branch): the price after the partial step. */
export function calcFinalPrice(
  absDelta: bigint,
  liquidity: bigint,
  deltaL: bigint,
  currentSqrtP: bigint,
  isToken0: boolean,
): bigint {
  if (isToken0) {
    const tmp = mulDivFloor(absDelta, currentSqrtP, KYSWAP_TWO_POW_96);
    return mulDivCeiling(
      liquidity + deltaL,
      currentSqrtP,
      liquidity + tmp,
    );
  }
  const tmp = mulDivFloor(absDelta, KYSWAP_TWO_POW_96, currentSqrtP);
  return mulDivFloor(liquidity + tmp, currentSqrtP, liquidity + deltaL);
}

/** `calcReturnedAmount` (isExactInput branch). */
export function calcReturnedAmountExactInput(
  liquidity: bigint,
  currentSqrtP: bigint,
  nextSqrtP: bigint,
  deltaL: bigint,
  isToken0: boolean,
): bigint {
  if (isToken0) {
    // returnedAmount = deltaL * nextSqrtP - liquidity * (currentSqrtP - nextSqrtP)
    return mulDivCeiling(deltaL, nextSqrtP, KYSWAP_TWO_POW_96) -
      mulDivFloor(liquidity, currentSqrtP - nextSqrtP, KYSWAP_TWO_POW_96);
  }
  // returnedAmount = (liquidity + deltaL)/nextSqrtP - liquidity/currentSqrtP
  return mulDivCeiling(liquidity + deltaL, KYSWAP_TWO_POW_96, nextSqrtP) -
    mulDivFloor(liquidity, KYSWAP_TWO_POW_96, currentSqrtP);
}

/**
 * Marginal (zero-impact) exact-input conversion at the pool's current sqrt
 * price with the pool fee applied. Used for raw mid sampling only: it is never
 * a substitute for a requested input amount.
 */
export function spotQuoteExactInput(
  state: KyberSwapPoolState,
  isToken0: boolean,
  amountIn: bigint,
): bigint {
  if (amountIn <= 0n || state.sqrtP <= 0n) return 0n;
  // (sqrtP / 2^96)^2 is the marginal raw price of token0 in token1, so a
  // token0-in swap converts with that price and a token1-in swap with its
  // reciprocal.
  const priceSquared = state.sqrtP * state.sqrtP;
  const gross = isToken0
    ? mulDivFloor(amountIn, priceSquared, KYSWAP_TWO_POW_96 * KYSWAP_TWO_POW_96)
    : mulDivFloor(amountIn, KYSWAP_TWO_POW_96 * KYSWAP_TWO_POW_96, priceSquared);
  return mulDivFloor(
    gross,
    KYSWAP_FEE_UNITS - state.feeUnits,
    KYSWAP_FEE_UNITS,
  );
}

/** Virtual reserves at the current price, for mid depth reporting. */
export function virtualReserves(
  state: KyberSwapPoolState,
): { readonly token0: bigint; readonly token1: bigint } {
  const liquidity = state.baseL + state.reinvestL;
  if (liquidity <= 0n || state.sqrtP <= 0n) return { token0: 0n, token1: 0n };
  return {
    token0: mulDivFloor(liquidity, KYSWAP_TWO_POW_96, state.sqrtP),
    token1: mulDivFloor(liquidity, state.sqrtP, KYSWAP_TWO_POW_96),
  };
}
