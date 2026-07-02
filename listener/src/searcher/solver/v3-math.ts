/**
 * Local Uniswap V3 swap math — a bigint port of v3-core's SwapMath +
 * SqrtPriceMath. This is the per-step engine; the cross-tick loop that drives
 * it (TickMath + TickBitmap + tick data) lives alongside in the v3 quote path.
 *
 * Solidity guards intermediate values against uint256 overflow; JS bigint is
 * arbitrary-precision so we drop those guards and keep only the rounding
 * semantics (mulDiv vs mulDivRoundingUp, divRoundingUp), which is what makes
 * the result bit-exact vs the on-chain QuoterV2. Verified against the official
 * v3-core SwapMath.spec.ts vectors in test/v3-math.ts.
 */

const RESOLUTION = 96n;
const Q96 = 1n << 96n;
const MAX_UINT160 = (1n << 160n) - 1n;

// ── FullMath / UnsafeMath ──────────────────────────────────────
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const result = (a * b) / denominator;
  return (a * b) % denominator > 0n ? result + 1n : result;
}

function divRoundingUp(x: bigint, y: bigint): bigint {
  return x / y + (x % y > 0n ? 1n : 0n);
}

// ── SqrtPriceMath ──────────────────────────────────────────────
/** amount0 between two sqrt prices for a given liquidity (liquidity > 0). */
export function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  const numerator1 = liquidity << RESOLUTION;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), sqrtRatioAX96)
    : mulDiv(numerator1, numerator2, sqrtRatioBX96) / sqrtRatioAX96;
}

/** amount1 between two sqrt prices for a given liquidity (liquidity > 0). */
export function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  return roundUp
    ? mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96)
    : mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
}

function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << RESOLUTION;
  if (add) {
    const product = amount * sqrtPX96;
    if (product / amount === sqrtPX96) {
      const denominator = numerator1 + product;
      if (denominator >= numerator1) return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
    }
    return divRoundingUp(numerator1, numerator1 / sqrtPX96 + amount);
  }
  const product = amount * sqrtPX96;
  const denominator = numerator1 - product;
  return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
}

function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean,
): bigint {
  if (add) {
    const quotient = amount <= MAX_UINT160 ? (amount << RESOLUTION) / liquidity : mulDiv(amount, Q96, liquidity);
    return sqrtPX96 + quotient;
  }
  const quotient =
    amount <= MAX_UINT160 ? divRoundingUp(amount << RESOLUTION, liquidity) : mulDivRoundingUp(amount, Q96, liquidity);
  return sqrtPX96 - quotient;
}

export function getNextSqrtPriceFromInput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

export function getNextSqrtPriceFromOutput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountOut: bigint,
  zeroForOne: boolean,
): bigint {
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
}

// ── SwapMath.computeSwapStep ───────────────────────────────────
export interface SwapStep {
  sqrtRatioNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

export function computeSwapStep(
  sqrtRatioCurrentX96: bigint,
  sqrtRatioTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: bigint,
): SwapStep {
  const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
  const exactIn = amountRemaining >= 0n;

  let sqrtRatioNextX96: bigint;
  let amountIn = 0n;
  let amountOut = 0n;

  if (exactIn) {
    const amountRemainingLessFee = mulDiv(amountRemaining, 1_000_000n - feePips, 1_000_000n);
    amountIn = zeroForOne
      ? getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);
    sqrtRatioNextX96 =
      amountRemainingLessFee >= amountIn
        ? sqrtRatioTargetX96
        : getNextSqrtPriceFromInput(sqrtRatioCurrentX96, liquidity, amountRemainingLessFee, zeroForOne);
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);
    sqrtRatioNextX96 =
      -amountRemaining >= amountOut
        ? sqrtRatioTargetX96
        : getNextSqrtPriceFromOutput(sqrtRatioCurrentX96, liquidity, -amountRemaining, zeroForOne);
  }

  const max = sqrtRatioTargetX96 === sqrtRatioNextX96;

  if (zeroForOne) {
    amountIn = max && exactIn ? amountIn : getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
  } else {
    amountIn = max && exactIn ? amountIn : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
  }

  if (!exactIn && amountOut > -amountRemaining) amountOut = -amountRemaining;

  let feeAmount: bigint;
  if (exactIn && sqrtRatioNextX96 !== sqrtRatioTargetX96) {
    feeAmount = amountRemaining - amountIn;
  } else {
    feeAmount = mulDivRoundingUp(amountIn, feePips, 1_000_000n - feePips);
  }

  return { sqrtRatioNextX96, amountIn, amountOut, feeAmount };
}

// ── TickMath / BitMath / TickBitmap ────────────────────────────
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MASK256 = (1n << 256n) - 1n;
const MAX_UINT256 = MASK256;

/** sqrtPriceX96 at a given tick (v3-core TickMath, magic constants). */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) throw new Error("T");
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if (absTick & 0x2n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if (absTick & 0x4n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if (absTick & 0x8n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if (absTick & 0x10n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if (absTick & 0x20n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if (absTick & 0x40n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if (absTick & 0x80n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if (absTick & 0x100n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if (absTick & 0x200n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if (absTick & 0x400n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if (absTick & 0x800n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if (absTick & 0x1000n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if (absTick & 0x2000n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if (absTick & 0x4000n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if (absTick & 0x8000n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if (absTick & 0x10000n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if (absTick & 0x20000n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if (absTick & 0x40000n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if (absTick & 0x80000n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 → Q128.96, rounding up.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function mostSignificantBit(x: bigint): number {
  let r = 0;
  if (x >= 0x100000000000000000000000000000000n) { x >>= 128n; r += 128; }
  if (x >= 0x10000000000000000n) { x >>= 64n; r += 64; }
  if (x >= 0x100000000n) { x >>= 32n; r += 32; }
  if (x >= 0x10000n) { x >>= 16n; r += 16; }
  if (x >= 0x100n) { x >>= 8n; r += 8; }
  if (x >= 0x10n) { x >>= 4n; r += 4; }
  if (x >= 0x4n) { x >>= 2n; r += 2; }
  if (x >= 0x2n) r += 1;
  return r;
}

function leastSignificantBit(x: bigint): number {
  let r = 255;
  if ((x & ((1n << 128n) - 1n)) > 0n) r -= 128; else x >>= 128n;
  if ((x & ((1n << 64n) - 1n)) > 0n) r -= 64; else x >>= 64n;
  if ((x & ((1n << 32n) - 1n)) > 0n) r -= 32; else x >>= 32n;
  if ((x & ((1n << 16n) - 1n)) > 0n) r -= 16; else x >>= 16n;
  if ((x & ((1n << 8n) - 1n)) > 0n) r -= 8; else x >>= 8n;
  if ((x & 0xfn) > 0n) r -= 4; else x >>= 4n;
  if ((x & 0x3n) > 0n) r -= 2; else x >>= 2n;
  if ((x & 0x1n) > 0n) r -= 1;
  return r;
}

function position(tick: number): [number, number] {
  return [tick >> 8, ((tick % 256) + 256) % 256];
}

/**
 * Next initialized tick within one word (or the word boundary). `tickBitmap`
 * maps wordPos → 256-bit bitmap. Throws a typed missing-word signal if the
 * needed word isn't warmed, so the cache can fetch that exact word and retry.
 */
export class V3MissingBitmapWordError extends Error {
  constructor(readonly word: number) {
    super(`bitmap word ${word} not warmed`);
    this.name = "V3MissingBitmapWordError";
  }
}

function nextInitializedTickWithinOneWord(
  tickBitmap: Map<number, bigint>,
  tick: number,
  tickSpacing: number,
  lte: boolean,
): [number, boolean] {
  const compressed = Math.floor(tick / tickSpacing);
  if (lte) {
    const [word, bit] = position(compressed);
    const bitmap = tickBitmap.get(word);
    if (bitmap === undefined) throw new V3MissingBitmapWordError(word);
    const mask = 2n * (1n << BigInt(bit)) - 1n;
    const masked = bitmap & mask;
    const initialized = masked !== 0n;
    const next = initialized
      ? (compressed - (bit - mostSignificantBit(masked))) * tickSpacing
      : (compressed - bit) * tickSpacing;
    return [next, initialized];
  }
  const [word, bit] = position(compressed + 1);
  const bitmap = tickBitmap.get(word);
  if (bitmap === undefined) throw new V3MissingBitmapWordError(word);
  const mask = MASK256 ^ ((1n << BigInt(bit)) - 1n); // all 1s at/left of bit
  const masked = bitmap & mask;
  const initialized = masked !== 0n;
  const next = initialized
    ? (compressed + 1 + (leastSignificantBit(masked) - bit)) * tickSpacing
    : (compressed + 1 + (255 - bit)) * tickSpacing;
  return [next, initialized];
}

// ── Cross-tick exact-input swap (v3-core UniswapV3Pool.swap) ───
export interface V3PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  observationIndex?: number;
  observationCardinality?: number;
  observationCardinalityNext?: number;
  feeProtocol?: number;
  unlocked?: boolean;
  fee: bigint; // feePips (e.g. 100 = 0.01%)
  tickSpacing: number;
  tickBitmap: Map<number, bigint>; // wordPos → bitmap
  ticks: Map<number, bigint>; // tick → liquidityNet
}

export interface V3SwapResult {
  amountOut: bigint;
  state: V3PoolState;
}

/**
 * Local exact-input swap; returns amountOut plus the post-swap live state.
 * Walks initialized ticks via the warmed bitmap, computeSwapStep per segment,
 * adjusting liquidity by liquidityNet when crossing. Throws (→ caller falls
 * back to eth_call) if the swap reaches an un-warmed bitmap word.
 */
export function v3SwapToState(state: V3PoolState, zeroForOne: boolean, amountIn: bigint): V3SwapResult {
  const sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  let amountRemaining = amountIn;
  let amountCalculated = 0n;
  let sqrtPriceX96 = state.sqrtPriceX96;
  let tick = state.tick;
  let liquidity = state.liquidity;

  while (amountRemaining > 0n && sqrtPriceX96 !== sqrtPriceLimitX96) {
    let [tickNext, initialized] = nextInitializedTickWithinOneWord(
      state.tickBitmap,
      tick,
      state.tickSpacing,
      zeroForOne,
    );
    if (tickNext < MIN_TICK) tickNext = MIN_TICK;
    else if (tickNext > MAX_TICK) tickNext = MAX_TICK;

    const sqrtPriceNextX96 = getSqrtRatioAtTick(tickNext);
    const reachesLimit = zeroForOne
      ? sqrtPriceNextX96 < sqrtPriceLimitX96
      : sqrtPriceNextX96 > sqrtPriceLimitX96;
    const target = reachesLimit ? sqrtPriceLimitX96 : sqrtPriceNextX96;

    const stepResult = computeSwapStep(sqrtPriceX96, target, liquidity, amountRemaining, state.fee);
    sqrtPriceX96 = stepResult.sqrtRatioNextX96;
    amountRemaining -= stepResult.amountIn + stepResult.feeAmount;
    amountCalculated -= stepResult.amountOut;

    if (sqrtPriceX96 === sqrtPriceNextX96) {
      // crossed into the next tick
      if (initialized) {
        let liquidityNet = state.ticks.get(tickNext) ?? 0n;
        if (zeroForOne) liquidityNet = -liquidityNet;
        liquidity += liquidityNet;
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else {
      // swap consumed the remaining input within this tick — loop will exit
      break;
    }
  }

  return {
    amountOut: -amountCalculated,
    state: {
      ...state,
      sqrtPriceX96,
      tick,
      liquidity,
    },
  };
}

/**
 * Local exact-input swap; returns amountOut. Kept as the original quote-facing
 * API and implemented through v3SwapToState so callers that need post-state can
 * share the same bit-exact loop.
 */
export function v3SwapExactInput(state: V3PoolState, zeroForOne: boolean, amountIn: bigint): bigint {
  return v3SwapToState(state, zeroForOne, amountIn).amountOut;
}
