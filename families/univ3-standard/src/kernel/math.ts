const RESOLUTION = 96n;
export const Q96 = 1n << RESOLUTION;
const MAX_UINT160 = (1n << 160n) - 1n;
const MASK256 = (1n << 256n) - 1n;
const MAX_UINT256 = MASK256;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

function positive(value: bigint, label: string): void {
  if (value <= 0n) throw new RangeError(`${label} must be positive`);
}

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (a < 0n || b < 0n) throw new RangeError("mulDiv inputs must be non-negative");
  positive(denominator, "denominator");
  return a * b / denominator;
}

export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const floor = mulDiv(a, b, denominator);
  return a * b % denominator === 0n ? floor : floor + 1n;
}

function divRoundingUp(a: bigint, b: bigint): bigint {
  positive(b, "divisor");
  return a / b + (a % b === 0n ? 0n : 1n);
}

export function getAmount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  positive(a, "sqrt ratio A"); positive(b, "sqrt ratio B");
  if (liquidity < 0n) throw new RangeError("liquidity must be non-negative");
  if (a > b) [a, b] = [b, a];
  const numerator1 = liquidity << RESOLUTION;
  const numerator2 = b - a;
  return roundUp ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a) : mulDiv(numerator1, numerator2, b) / a;
}

export function getAmount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  positive(a, "sqrt ratio A"); positive(b, "sqrt ratio B");
  if (liquidity < 0n) throw new RangeError("liquidity must be non-negative");
  if (a > b) [a, b] = [b, a];
  return roundUp ? mulDivRoundingUp(liquidity, b - a, Q96) : mulDiv(liquidity, b - a, Q96);
}

function nextFromAmount0(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  if (amount === 0n) return sqrtP;
  const numerator = liquidity << RESOLUTION;
  if (add) return mulDivRoundingUp(numerator, sqrtP, numerator + amount * sqrtP);
  const product = amount * sqrtP;
  if (product >= numerator) throw new RangeError("amount0 removes all liquidity value");
  return mulDivRoundingUp(numerator, sqrtP, numerator - product);
}

function nextFromAmount1(sqrtP: bigint, liquidity: bigint, amount: bigint, add: boolean): bigint {
  const quotient = amount <= MAX_UINT160
    ? (add ? (amount << RESOLUTION) / liquidity : divRoundingUp(amount << RESOLUTION, liquidity))
    : (add ? mulDiv(amount, Q96, liquidity) : mulDivRoundingUp(amount, Q96, liquidity));
  if (!add && quotient >= sqrtP) throw new RangeError("amount1 removes all price value");
  return add ? sqrtP + quotient : sqrtP - quotient;
}

export function getNextSqrtPriceFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  positive(sqrtP, "sqrt price"); positive(liquidity, "liquidity");
  if (amountIn < 0n) throw new RangeError("amountIn must be non-negative");
  return zeroForOne ? nextFromAmount0(sqrtP, liquidity, amountIn, true) : nextFromAmount1(sqrtP, liquidity, amountIn, true);
}

export function getNextSqrtPriceFromOutput(sqrtP: bigint, liquidity: bigint, amountOut: bigint, zeroForOne: boolean): bigint {
  positive(sqrtP, "sqrt price"); positive(liquidity, "liquidity");
  if (amountOut < 0n) throw new RangeError("amountOut must be non-negative");
  return zeroForOne ? nextFromAmount1(sqrtP, liquidity, amountOut, false) : nextFromAmount0(sqrtP, liquidity, amountOut, false);
}

export interface SwapStep { readonly sqrtRatioNextX96: bigint; readonly amountIn: bigint; readonly amountOut: bigint; readonly feeAmount: bigint }

export function computeSwapStep(current: bigint, target: bigint, liquidity: bigint, remaining: bigint, feePips: bigint): SwapStep {
  positive(current, "current sqrt ratio"); positive(target, "target sqrt ratio"); positive(liquidity, "liquidity");
  if (feePips < 0n || feePips >= 1_000_000n) throw new RangeError("feePips out of range");
  const zeroForOne = current >= target;
  const exactIn = remaining >= 0n;
  let amountIn = 0n;
  let amountOut = 0n;
  let next: bigint;
  if (exactIn) {
    const lessFee = mulDiv(remaining, 1_000_000n - feePips, 1_000_000n);
    amountIn = zeroForOne ? getAmount0Delta(target, current, liquidity, true) : getAmount1Delta(current, target, liquidity, true);
    next = lessFee >= amountIn ? target : getNextSqrtPriceFromInput(current, liquidity, lessFee, zeroForOne);
  } else {
    amountOut = zeroForOne ? getAmount1Delta(target, current, liquidity, false) : getAmount0Delta(current, target, liquidity, false);
    next = -remaining >= amountOut ? target : getNextSqrtPriceFromOutput(current, liquidity, -remaining, zeroForOne);
  }
  const max = next === target;
  if (zeroForOne) {
    amountIn = max && exactIn ? amountIn : getAmount0Delta(next, current, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount1Delta(next, current, liquidity, false);
  } else {
    amountIn = max && exactIn ? amountIn : getAmount1Delta(current, next, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount0Delta(current, next, liquidity, false);
  }
  if (!exactIn && amountOut > -remaining) amountOut = -remaining;
  const feeAmount = exactIn && !max ? remaining - amountIn : mulDivRoundingUp(amountIn, feePips, 1_000_000n - feePips);
  return Object.freeze({ sqrtRatioNextX96: next, amountIn, amountOut, feeAmount });
}

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError("tick out of range");
  const abs = BigInt(Math.abs(tick));
  let ratio = abs & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const factors = [0xfff97272373d413259a46990580e213an,0xfff2e50f5f656932ef12357cf3c7fdccn,0xffe5caca7e10e4e61c3624eaa0941cd0n,0xffcb9843d60f6159c9db58835c926644n,0xff973b41fa98c081472e6896dfb254c0n,0xff2ea16466c96a3843ec78b326b52861n,0xfe5dee046a99a2a811c461f1969c3053n,0xfcbe86c7900a88aedcffc83b479aa3a4n,0xf987a7253ac413176f2b074cf7815e54n,0xf3392b0822b70005940c7a398e4b70f3n,0xe7159475a2c29b7443b29c7fa6e889d9n,0xd097f3bdfd2022b8845ad8f792aa5825n,0xa9f746462d870fdf8a65dc1f90e061e5n,0x70d869a156d2a1b890bb3df62baf32f7n,0x31be135f97d08fd981231505542fcfa6n,0x9aa508b5b7a84e1c677de54f3e99bc9n,0x5d6af8dedb81196699c329225ee604n,0x2216e584f5fa1ea926041bedfe98n,0x48a170391f7dc42444e8fa2n] as const;
  for (let bit = 1; bit <= factors.length; bit += 1) if (abs & (1n << BigInt(bit))) ratio = ratio * factors[bit - 1]! >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function msb(value: bigint): number { if (value <= 0n) throw new RangeError("msb requires positive value"); return value.toString(2).length - 1; }
function lsb(value: bigint): number { if (value <= 0n) throw new RangeError("lsb requires positive value"); let bit = 0; while ((value & 1n) === 0n) { value >>= 1n; bit += 1; } return bit; }
function position(tick: number): readonly [number, number] { return [tick >> 8, ((tick % 256) + 256) % 256]; }

export class MissingBitmapWordError extends Error {
  readonly word: number;
  constructor(word: number) {
    super(`bitmap word ${word} not available`);
    this.name = "MissingBitmapWordError";
    this.word = word;
  }
}

export function nextInitializedTickWithinOneWord(bitmap: ReadonlyMap<number, bigint>, tick: number, spacing: number, lte: boolean): readonly [number, boolean] {
  if (!Number.isInteger(spacing) || spacing <= 0) throw new RangeError("tick spacing must be positive");
  const compressed = Math.floor(tick / spacing);
  const [word, bit] = position(lte ? compressed : compressed + 1);
  const bits = bitmap.get(word);
  if (bits === undefined) throw new MissingBitmapWordError(word);
  if (bits < 0n || bits > MASK256) throw new RangeError("bitmap word exceeds uint256");
  if (lte) {
    const masked = bits & (2n * (1n << BigInt(bit)) - 1n);
    return masked === 0n ? [(compressed - bit) * spacing, false] : [(compressed - (bit - msb(masked))) * spacing, true];
  }
  const masked = bits & (MASK256 ^ ((1n << BigInt(bit)) - 1n));
  return masked === 0n ? [(compressed + 1 + 255 - bit) * spacing, false] : [(compressed + 1 + lsb(masked) - bit) * spacing, true];
}

export interface V3PoolState { readonly sqrtPriceX96: bigint; readonly tick: number; readonly liquidity: bigint; readonly fee: bigint; readonly tickSpacing: number; readonly tickBitmap: ReadonlyMap<number, bigint>; readonly ticks: ReadonlyMap<number, bigint> }
export interface V3SwapResult { readonly amountOut: bigint; readonly state: V3PoolState }

export function v3SwapToState(state: V3PoolState, zeroForOne: boolean, amountIn: bigint): V3SwapResult {
  if (amountIn < 0n) throw new RangeError("amountIn must be non-negative");
  let remaining = amountIn, calculated = 0n, sqrtPriceX96 = state.sqrtPriceX96, tick = state.tick, liquidity = state.liquidity;
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  while (remaining > 0n && sqrtPriceX96 !== limit) {
    let [nextTick, initialized] = nextInitializedTickWithinOneWord(state.tickBitmap, tick, state.tickSpacing, zeroForOne);
    nextTick = Math.max(MIN_TICK, Math.min(MAX_TICK, nextTick));
    const nextPrice = getSqrtRatioAtTick(nextTick);
    const target = zeroForOne ? (nextPrice < limit ? limit : nextPrice) : (nextPrice > limit ? limit : nextPrice);
    const step = computeSwapStep(sqrtPriceX96, target, liquidity, remaining, state.fee);
    const crossesInitializedTickAtCurrentPrice = initialized
      && sqrtPriceX96 === nextPrice
      && step.sqrtRatioNextX96 === sqrtPriceX96;
    if (
      !crossesInitializedTickAtCurrentPrice
      && (step.sqrtRatioNextX96 === sqrtPriceX96 || step.amountIn + step.feeAmount <= 0n)
    ) throw new Error("v3 swap made no progress");
    sqrtPriceX96 = step.sqrtRatioNextX96; remaining -= step.amountIn + step.feeAmount; calculated += step.amountOut;
    if (sqrtPriceX96 === nextPrice) {
      if (initialized) { let delta = state.ticks.get(nextTick); if (delta === undefined) throw new Error(`initialized tick ${nextTick} has no liquidity fact`); if (zeroForOne) delta = -delta; liquidity += delta; if (liquidity <= 0n) throw new RangeError("liquidity exhausted at tick"); }
      tick = zeroForOne ? nextTick - 1 : nextTick;
    } else break;
  }
  return Object.freeze({ amountOut: calculated, state: Object.freeze({ ...state, sqrtPriceX96, tick, liquidity }) });
}

export function v3SwapExactInput(state: V3PoolState, zeroForOne: boolean, amountIn: bigint): bigint { return v3SwapToState(state, zeroForOne, amountIn).amountOut; }
