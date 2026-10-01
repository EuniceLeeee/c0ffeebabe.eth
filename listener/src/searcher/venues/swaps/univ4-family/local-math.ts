import {
  MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO, MIN_TICK,
  getSqrtRatioAtTick, getTickAtSqrtRatio, nextInitializedTickWithinOneWord,
} from "../../../solver/v3-math.js";

export interface UniV4LocalState {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly protocolFee: bigint;
  readonly lpFee: bigint;
  readonly tickSpacing: number;
  /** Explicitly read words, including known-zero words. Absence is NOT zero. */
  readonly tickBitmap: ReadonlyMap<number, bigint>;
  /** Verified initialized tick -> liquidityNet (gross/coverage checked by reader). */
  readonly ticks: ReadonlyMap<number, bigint>;
}

const Q96 = 1n << 96n;
const UINT128_MAX = (1n << 128n) - 1n;
const INT128_MAX = (1n << 127n) - 1n;
const INT128_MIN = -(1n << 127n);
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const FEE_SCALE = 1_000_000n;

function uint(value: bigint, max: bigint): boolean {
  return typeof value === "bigint" && value >= 0n && value <= max;
}

function ceilDiv(n: bigint, d: bigint): bigint {
  return n / d + (n % d === 0n ? 0n : 1n);
}

// v4-core 46c6834698c48bc4a463a86d8420f4eb1d7f3b75, SqrtPriceMath.
// Under uint160 prices/uint128 liquidity these FullMath quotients fit uint256;
// their products may legitimately exceed uint256 (FullMath uses 512 bits).
function delta(a: bigint, b: bigint, liquidity: bigint, currency0: boolean, up: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  if (currency0) {
    const n = (liquidity << 96n) * (b - a);
    return up ? ceilDiv(ceilDiv(n, b), a) : (n / b) / a;
  }
  const n = liquidity * (b - a);
  return up ? ceilDiv(n, Q96) : n / Q96;
}

function nextPrice(price: bigint, liquidity: bigint, amount: bigint, zeroForOne: boolean): bigint | null {
  if (liquidity === 0n) return null;
  if (amount === 0n) return price;
  let next: bigint;
  if (zeroForOne) {
    const numerator = liquidity << 96n;
    const product = amount * price;
    const denominator = numerator + product;
    if (product <= UINT256_MAX && denominator <= UINT256_MAX) {
      next = ceilDiv(numerator * price, denominator);
    } else {
      // Solidity selects this less precise expression on product OR sum overflow.
      // BigInt's product/amount == price is not an overflow check.
      const alternate = numerator / price + amount;
      if (alternate > UINT256_MAX) return null;
      next = ceilDiv(numerator, alternate);
    }
  } else {
    next = price + (amount * Q96) / liquidity;
  }
  return next > 0n && next <= UINT160_MAX ? next : null;
}

/**
 * Full exact-input, no-hook V4 math over source-verified coverage. Null means
 * use the original full-amount Quoter, never combine a partial local result.
 * Pool/SwapMath semantics: v4-core 46c6834698c48bc4a463a86d8420f4eb1d7f3b75.
 * Only tick primitives are shared with V3, not its step or full-swap wrapper.
 * No source reads, authority issuance, manager-capacity check or cache lives here.
 */
export function quoteV4Local(
  state: UniV4LocalState,
  zeroForOne: boolean,
  amountIn: bigint,
): { amountOut: bigint; amountConsumed: bigint; state: UniV4LocalState; initializedTicksCrossed: number } | null {
  if (typeof zeroForOne !== "boolean" || !uint(amountIn, INT128_MAX) || amountIn === 0n ||
      !uint(state.sqrtPriceX96, UINT160_MAX) || state.sqrtPriceX96 < MIN_SQRT_RATIO ||
      state.sqrtPriceX96 >= MAX_SQRT_RATIO || !uint(state.liquidity, UINT128_MAX) ||
      !Number.isSafeInteger(state.tick) || state.tick < MIN_TICK || state.tick >= MAX_TICK ||
      !Number.isSafeInteger(state.tickSpacing) || state.tickSpacing < 1 || state.tickSpacing > 32_767 ||
      !uint(state.protocolFee, (1n << 24n) - 1n) || !uint(state.lpFee, FEE_SCALE)) return null;

  // Downward crossing can leave tick=t-1 at exactly sqrt(t), including empty
  // word boundaries. Equality at the upper edge is legitimate; anything else
  // outside this interval is inconsistent source state.
  const upper = getSqrtRatioAtTick(state.tick + 1);
  if (state.sqrtPriceX96 < getSqrtRatioAtTick(state.tick) || state.sqrtPriceX96 > upper ||
      (state.sqrtPriceX96 === upper && (state.tick + 1) % state.tickSpacing !== 0)) return null;
  const fee0 = state.protocolFee & 0xfffn;
  const fee1 = state.protocolFee >> 12n;
  if (fee0 > 1_000n || fee1 > 1_000n) return null;
  const protocol = zeroForOne ? fee0 : fee1;
  const fee = protocol + state.lpFee - (protocol * state.lpFee) / FEE_SCALE;
  // 100% exact-input is a canonical special case, explicitly outside our model.
  if (fee >= FEE_SCALE) return null;

  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  if (zeroForOne ? state.sqrtPriceX96 <= limit : state.sqrtPriceX96 >= limit) return null;
  let price = state.sqrtPriceX96, tick = state.tick, liquidity = state.liquidity;
  let remaining = amountIn, amountOut = 0n, initializedTicksCrossed = 0;
  // Each nonterminal iteration crosses an initialized tick or a word boundary.
  // No speculative coverage or arbitrary reduced quote/search cap.
  const maxSteps = state.tickBitmap.size + state.ticks.size + 2;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 2) return null;
  for (let steps = 0; remaining > 0n && price !== limit; steps++) {
    if (steps >= maxSteps) return null;
    const oldPrice = price, oldTick = tick, oldRemaining = remaining;
    const compressed = Math.floor(tick / state.tickSpacing) + (zeroForOne ? 0 : 1);
    const word = state.tickBitmap.get(Math.floor(compressed / 256));
    if (word === undefined || !uint(word, UINT256_MAX)) return null;
    // This helper only reads .get; its legacy Map type does not require mutation.
    const [rawNext, initialized] = nextInitializedTickWithinOneWord(
      state.tickBitmap as Map<number, bigint>, tick, state.tickSpacing, zeroForOne,
    );
    let net = 0n;
    if (initialized) {
      const knownNet = state.ticks.get(rawNext);
      if (rawNext < MIN_TICK || rawNext > MAX_TICK || knownNet === undefined ||
          typeof knownNet !== "bigint" || knownNet < INT128_MIN || knownNet > INT128_MAX ||
          (zeroForOne && knownNet === INT128_MIN)) return null;
      net = knownNet;
    }
    const nextTick = Math.max(MIN_TICK, Math.min(MAX_TICK, rawNext));
    const boundary = getSqrtRatioAtTick(nextTick);
    const target = zeroForOne ? (boundary < limit ? limit : boundary) : (boundary > limit ? limit : boundary);
    const lessFee = (remaining * (FEE_SCALE - fee)) / FEE_SCALE;
    const needed = delta(price, target, liquidity, zeroForOne, true);
    let consumed: bigint;
    if (lessFee >= needed) {
      price = target;
      consumed = needed + ceilDiv(needed * fee, FEE_SCALE - fee);
    } else {
      const next = nextPrice(price, liquidity, lessFee, zeroForOne);
      if (next === null) return null;
      price = next;
      // V4 does NOT recompute input from rounded terminal price (V3 does).
      // amountIn=lessFee and feeAmount=remaining-lessFee consume all remaining.
      consumed = remaining;
    }
    if (zeroForOne ? price < target || price > oldPrice : price > target || price < oldPrice) return null;
    const output = delta(oldPrice, price, liquidity, !zeroForOne, false);
    if (consumed > remaining || output > INT128_MAX - amountOut) return null;
    remaining -= consumed;
    amountOut += output;
    if (price === boundary) {
      if (initialized) {
        liquidity += zeroForOne ? -net : net;
        if (!uint(liquidity, UINT128_MAX)) return null;
        initializedTicksCrossed++;
      }
      tick = zeroForOne ? nextTick - 1 : nextTick;
    } else if (price !== oldPrice) {
      tick = getTickAtSqrtRatio(price);
    }
    if (remaining === oldRemaining && price === oldPrice && tick === oldTick) return null;
  }
  if (remaining !== 0n) return null; // Includes coverage/price-limit partial fills.
  return Object.freeze({
    amountOut, amountConsumed: amountIn, initializedTicksCrossed,
    // Swap never changes bitmap or liquidityNet; immutable coverage is shared,
    // while every independent amount trial owns fresh scalar state.
    state: Object.freeze({ ...state, sqrtPriceX96: price, tick, liquidity }),
  });
}
