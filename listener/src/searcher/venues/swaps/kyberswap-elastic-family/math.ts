import { MAX_TICK, MIN_TICK, MAX_SQRT_RATIO, MIN_SQRT_RATIO, getSqrtRatioAtTick } from
  "../../../solver/v3-math.js";
import {
  KYSWAP_FEE_UNITS,
  KYSWAP_MAX_TICK_DISTANCE,
  KYSWAP_TWO_FEE_UNITS,
  KYSWAP_TWO_POW_96,
} from "./abi.js";
import type { KyberSwapPoolState, KyberSwapTickState } from "./types.js";

const UINT128_MAX = (1n << 128n) - 1n;
// Local computation bound only; the central request-round/deadline limits still
// bound missing tick reads. Exhaustion is never a partial successful quote.
export const KYSWAP_MAX_QUOTE_STEPS = 4096;

export type KyberSwapInputOutcome =
  | { readonly ok: false; readonly refusal: string; readonly missingTick?: number }
  | { readonly ok: true; readonly quote: KyberSwapStepQuote & {
      readonly steps: number; readonly crossedTicks: readonly number[];
    } };

/** Pool.swap exact-input loop, including its 480-tick temporary boundaries,
 * per-step reinvestment fees and signed base-liquidity changes. Missing chain
 * state requests another existing central round, never constant-liquidity
 * extrapolation. Fee-growth/RTokens bookkeeping does not change reinvestL. */
export function quoteExactInput(input: {
  readonly state: KyberSwapPoolState;
  readonly isToken0: boolean;
  readonly amountIn: bigint;
  readonly ticks: ReadonlyMap<number, KyberSwapTickState>;
}): KyberSwapInputOutcome {
  const {state, isToken0, amountIn, ticks} = input;
  const fail = (refusal: string): KyberSwapInputOutcome => ({ok: false, refusal});
  if (amountIn <= 0n || amountIn >= 1n << 255n) return fail("invalid-exact-input");
  if (state.locked || state.baseL + state.reinvestL === 0n) return fail("no-active-liquidity");
  let sqrtP = state.sqrtP, currentTick = state.currentTick;
  let baseL = state.baseL, reinvestL = state.reinvestL;
  let nextTick = isToken0 ? state.nearestCurrentTick : state.nextTick;
  if (nextTick === null) return fail("tick-boundary-unavailable");
  const limit = isToken0 ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  if (isToken0 ? sqrtP <= limit : sqrtP >= limit) return fail("price-limit-not-movable");
  let remaining = amountIn, returned = 0n, targetTick = nextTick;
  const crossedTicks: number[] = [];
  for (let step = 1; step <= KYSWAP_MAX_QUOTE_STEPS; step++) {
    const liquidity = baseL + reinvestL;
    if (baseL < 0n || reinvestL < 0n || liquidity > UINT128_MAX) return fail("liquidity-overflow");
    if (liquidity === 0n) return fail("no-active-liquidity");
    targetTick = isToken0 ? Math.max(nextTick, currentTick - KYSWAP_MAX_TICK_DISTANCE)
      : Math.min(nextTick, currentTick + KYSWAP_MAX_TICK_DISTANCE);
    const nextSqrtP = getSqrtRatioAtTick(targetTick);
    const target = isToken0 ? (nextSqrtP < limit ? limit : nextSqrtP)
      : (nextSqrtP > limit ? limit : nextSqrtP);
    if (isToken0 ? target > sqrtP : target < sqrtP) return fail("tick-list-price-inconsistent");
    const start = sqrtP;
    let used = 0n, deltaL = 0n;
    if (start !== target) {
      const reach = calcReachAmountExactInput(liquidity, start, target, state.feeUnits, isToken0);
      used = reach > remaining ? remaining : reach;
      if (reach > remaining) {
        deltaL = estimateIncrementalLiquidity(used, start, state.feeUnits, isToken0);
        sqrtP = calcFinalPrice(used, liquidity, deltaL, start, isToken0);
      } else {
        sqrtP = target;
        deltaL = calcIncrementalLiquidity(used, liquidity, start, target, isToken0);
      }
      let output = calcReturnedAmountExactInput(liquidity, start, sqrtP, deltaL, isToken0);
      if (output === 1n) output = 0n;
      if (output > 0n) return fail("invalid-output-sign");
      remaining -= used;
      returned += output;
      reinvestL += deltaL;
      if (reinvestL > UINT128_MAX) return fail("liquidity-overflow");
    }
    if (sqrtP === nextSqrtP) {
      currentTick = isToken0 ? targetTick - 1 : targetTick;
      if (targetTick === nextTick) {
        const tick = ticks.get(nextTick);
        if (!tick) return {ok: false, refusal: "crossing-state-unavailable", missingTick: nextTick};
        if (tick.tick !== nextTick || (isToken0 ? tick.previous >= nextTick : tick.next <= nextTick)) {
          return fail("tick-list-inconsistent");
        }
        baseL += isToken0 ? -tick.liquidityNet : tick.liquidityNet;
        if (baseL < 0n || baseL > UINT128_MAX) return fail("liquidity-overflow");
        crossedTicks.push(nextTick);
        nextTick = isToken0 ? tick.previous : tick.next;
      }
    } else if (remaining !== 0n) {
      return fail("price-limit-partial-fill");
    }
    if (remaining === 0n) {
      if (returned >= 0n) return fail("no-representable-output");
      return {ok: true, quote: Object.freeze({amountIn, amountOut: -returned,
        sqrtPAfter: sqrtP, deltaL: reinvestL - state.reinvestL, targetTick,
        steps: step, crossedTicks: Object.freeze(crossedTicks)})};
    }
    if (sqrtP === limit) return fail("price-limit-partial-fill");
  }
  return fail("quote-step-budget-exhausted");
}

/** SwapMath.calcIncrementalLiquidity for a reached temporary/initialized tick.
 * Unlike a partial step, the fee comes from rounded reserve conservation. */
export function calcIncrementalLiquidity(amount: bigint, liquidity: bigint,
  currentSqrtP: bigint, nextSqrtP: bigint, isToken0: boolean): bigint {
  const before = isToken0 ? mulDivFloor(liquidity, KYSWAP_TWO_POW_96, currentSqrtP)
    : mulDivFloor(liquidity, currentSqrtP, KYSWAP_TWO_POW_96);
  const after = isToken0 ? mulDivFloor(nextSqrtP, before + amount, KYSWAP_TWO_POW_96)
    : mulDivFloor(before + amount, KYSWAP_TWO_POW_96, nextSqrtP);
  return after > liquidity ? after - liquidity : 0n;
}

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
