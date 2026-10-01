import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSqrtRatioAtTick as sqrt, getTickAtSqrtRatio,
  MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO,
} from "../../../../solver/v3-math.js";
import { quoteV4Local, type UniV4LocalState } from "../local-math.js";

const Q96 = 1n << 96n;
const U128 = (1n << 128n) - 1n;
const I128 = (1n << 127n) - 1n;
const U256 = (1n << 256n) - 1n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;

function fixture(
  patch: Partial<UniV4LocalState> = {},
  initialized: readonly (readonly [number, bigint])[] = [],
): UniV4LocalState {
  const spacing = patch.tickSpacing ?? 1;
  const words = new Map<number, bigint>(Array.from({ length: 9 }, (_, i) => [i - 4, 0n]));
  for (const [tick] of initialized) {
    assert.equal(Math.abs(tick % spacing), 0);
    const compressed = Math.floor(tick / spacing), word = Math.floor(compressed / 256);
    const bit = compressed - word * 256;
    words.set(word, (words.get(word) ?? 0n) | (1n << BigInt(bit)));
  }
  return Object.freeze({ sqrtPriceX96: Q96, tick: 0, liquidity: 10n ** 18n,
    protocolFee: 0n, lpFee: 3_000n, tickSpacing: spacing,
    tickBitmap: words, ticks: new Map(initialized), ...patch });
}

// Independent closed-form segment oracle, not another cross-tick walker.
// Use a single rational denominator rather than production's nested FullMath.
function between(a: bigint, b: bigint, l: bigint, currency0: boolean, up: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  const n = currency0 ? l * Q96 * (b - a) : l * (b - a);
  const d = currency0 ? a * b : Q96;
  return up ? ceil(n, d) : n / d;
}

function segment(a: bigint, b: bigint, l: bigint, down: boolean, fee: bigint) {
  const net = between(a, b, l, down, true);
  return { gross: net + ceil(net * fee, 1_000_000n - fee), out: between(a, b, l, !down, false) };
}

function tail(p: bigint, l: bigint, gross: bigint, down: boolean, fee: bigint) {
  const net = gross * (1_000_000n - fee) / 1_000_000n;
  const price = down ? ceil(l * Q96 * p, l * Q96 + net * p) : p + net * Q96 / l;
  return { price, out: between(p, price, l, !down, false) };
}

function quote(s: UniV4LocalState, down: boolean, amount: bigint) {
  const result = quoteV4Local(s, down, amount);
  assert.ok(result, "expected full local quote, not fallback");
  assert.equal(result.amountConsumed, amount);
  return result;
}

for (const down of [true, false]) {
  const direction = down ? "zero-for-one" : "one-for-zero";
  test(`${direction}: integer full-input vector in a wide word`, () => {
    const s = fixture({ liquidity: 2n * 10n ** 18n, lpFee: 600n, tickSpacing: 32_767 });
    const result = quote(s, down, 10n ** 18n);
    assert.equal(result.amountOut, 666399946655997866n);
    assert.equal(result.initializedTicksCrossed, 0);
    const expected = tail(Q96, s.liquidity, 10n ** 18n, down, 600n);
    assert.equal(result.state.sqrtPriceX96, expected.price);
    assert.equal(result.state.tick, getTickAtSqrtRatio(expected.price));
  });

  test(`${direction}: crosses two initialized ticks with signed liquidity`, () => {
    const sign = down ? -1 : 1, l = 1_000_000_000_000n;
    const t1 = sign * 20, t2 = sign * 40;
    const s = fixture({ liquidity: l, tickSpacing: 10 }, [
      [t1, down ? -l / 4n : l / 4n], [t2, down ? l / 4n : -l / 4n],
    ]);
    const first = segment(Q96, sqrt(t1), l, down, s.lpFee);
    const second = segment(sqrt(t1), sqrt(t2), l * 5n / 4n, down, s.lpFee);
    const rest = 100_000n, end = tail(sqrt(t2), l, rest, down, s.lpFee);
    const result = quote(s, down, first.gross + second.gross + rest);
    assert.equal(result.amountOut, first.out + second.out + end.out);
    assert.equal(result.initializedTicksCrossed, 2);
    assert.equal(result.state.liquidity, l);
    assert.equal(result.state.sqrtPriceX96, end.price);
    assert.equal(result.state.tick, getTickAtSqrtRatio(end.price));
  });

  test(`${direction}: exact boundary consumption still crosses and updates liquidity`, () => {
    const t = down ? -10 : 10, l = 1_000_000_000_000n;
    const s = fixture({ liquidity: l, tickSpacing: 10 }, [[t, down ? -100n : 100n]]);
    const expected = segment(Q96, sqrt(t), l, down, s.lpFee);
    const result = quote(s, down, expected.gross);
    assert.equal(result.amountOut, expected.out);
    assert.equal(result.state.sqrtPriceX96, sqrt(t));
    assert.equal(result.state.tick, down ? t - 1 : t);
    assert.equal(result.state.liquidity, l + 100n);
    assert.equal(result.initializedTicksCrossed, 1);
  });

  test(`${direction}: zero-liquidity start travels to verified liquidity`, () => {
    const t = down ? -20 : 20, l = 1_000_000_000_000n;
    const s = fixture({ liquidity: 0n }, [[t, down ? -l : l]]);
    const amount = 100_000_000n, expected = tail(sqrt(t), l, amount, down, s.lpFee);
    const result = quote(s, down, amount);
    assert.equal(result.amountOut, expected.out);
    assert.equal(result.state.sqrtPriceX96, expected.price);
    assert.equal(result.state.liquidity, l);
    assert.equal(result.initializedTicksCrossed, 1);
  });

  test(`${direction}: zero-liquidity gap across an empty word`, () => {
    const sign = down ? -1 : 1, l = 1_000_000n;
    const s = fixture({ liquidity: l }, [[sign * 20, down ? l : -l], [sign * 300, down ? -2n * l : 2n * l]]);
    const first = segment(Q96, sqrt(sign * 20), l, down, s.lpFee);
    const end = tail(sqrt(sign * 300), 2n * l, 100n, down, s.lpFee);
    const result = quote(s, down, first.gross + 100n);
    assert.equal(result.amountOut, first.out + end.out);
    assert.equal(result.state.sqrtPriceX96, end.price);
    assert.equal(result.state.liquidity, 2n * l);
    assert.equal(result.initializedTicksCrossed, 2);
  });

  test(`${direction}: rounds fees separately at every empty-word boundary`, () => {
    const s = fixture({ liquidity: 1_000n, tick: 100, sqrtPriceX96: sqrt(100) });
    const boundaries = down ? [0, -256, -512] : [255, 511, 767];
    let p = s.sqrtPriceX96, gross = 0n, out = 0n;
    for (const tick of boundaries) {
      const step = segment(p, sqrt(tick), s.liquidity, down, s.lpFee);
      gross += step.gross; out += step.out; p = sqrt(tick);
    }
    const end = tail(p, s.liquidity, 7n, down, s.lpFee);
    const result = quote(s, down, gross + 7n);
    assert.equal(result.amountOut, out + end.out);
    assert.equal(result.state.sqrtPriceX96, end.price);
    assert.equal(result.initializedTicksCrossed, 0);
    assert.notEqual(result.amountOut, tail(s.sqrtPriceX96, s.liquidity, gross + 7n, down, s.lpFee).out,
      "skipping empty words would change the quote");
  });

  test(`${direction}: price-limit partial fill falls back, exact fill does not`, () => {
    const tick = down ? MIN_TICK + 10 : MAX_TICK - 10;
    const price = sqrt(tick), limit = down ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
    const word = Math.floor((Math.floor(tick / 32_767) + (down ? 0 : 1)) / 256);
    const s = fixture({ tick, sqrtPriceX96: price, liquidity: 1n, lpFee: 0n, tickSpacing: 32_767,
      tickBitmap: new Map([[word, 0n]]) });
    const expected = segment(price, limit, 1n, down, 0n);
    const result = quote(s, down, expected.gross);
    assert.equal(result.amountOut, expected.out);
    assert.equal(result.state.sqrtPriceX96, limit);
    assert.equal(quoteV4Local(s, down, expected.gross + 1n), null);
    assert.equal(quoteV4Local(result.state, down, 1n), null);
  });

  test(`${direction}: source-liquidity underflow and overflow fall back`, () => {
    const t = down ? -1 : 1;
    const under = fixture({ liquidity: 1n }, [[t, down ? 2n : -2n]]);
    assert.equal(quoteV4Local(under, down, 1_000n), null);
    const over = fixture({ liquidity: U128 }, [[t, down ? -1n : 1n]]);
    const amount = segment(Q96, sqrt(t), U128, down, over.lpFee).gross;
    assert.ok(amount <= I128);
    assert.equal(quoteV4Local(over, down, amount), null);
  });
}

test("directional protocol fees combine once with floor, not separately rounded input fees", () => {
  const s = fixture({ protocolFee: 1_000n | (500n << 12n), tickSpacing: 32_767 });
  const amount = 10n ** 17n;
  for (const [down, combined] of [[true, 3997n], [false, 3499n]] as const) {
    const result = quote(s, down, amount);
    const equivalent = quote(fixture({ protocolFee: 0n, lpFee: combined, tickSpacing: 32_767 }), down, amount);
    assert.equal(result.amountOut, equivalent.amountOut);
    assert.equal(result.state.sqrtPriceX96, equivalent.state.sqrtPriceX96);
    assert.equal(result.amountOut, tail(Q96, s.liquidity, amount, down, combined).out);
  }
});

test("negative non-divisible tick compression floors, including word boundaries", () => {
  for (const [tick, down, word] of [[-1, true, -1], [-1, false, 0], [-2561, true, -2], [-2561, false, -1]] as const) {
    const s = fixture({ tick, sqrtPriceX96: sqrt(tick), tickSpacing: 10, tickBitmap: new Map([[word, 0n]]) });
    assert.ok(quoteV4Local(s, down, 1_000n));
    assert.equal(quoteV4Local({ ...s, tickBitmap: new Map([[word + 1, 0n]]) }, down, 1_000n), null);
  }
});

test("crossed-boundary start does not double-cross downward and recrosses on reversal", () => {
  const s = fixture({ tick: 9, sqrtPriceX96: sqrt(10), liquidity: 1_000_000_000_000n, tickSpacing: 10 }, [[10, 100n]]);
  const down = quote(s, true, 100_000n), up = quote(s, false, 100_000n);
  assert.equal(down.initializedTicksCrossed, 0);
  assert.equal(down.state.liquidity, s.liquidity);
  assert.equal(up.initializedTicksCrossed, 1);
  assert.equal(up.state.liquidity, s.liquidity + 100n);
  const reverse = quote(down.state, false, 1_000_000n);
  assert.equal(reverse.initializedTicksCrossed, 1);
  assert.equal(reverse.state.liquidity, s.liquidity + 100n);
});

test("absent word/tick never becomes zero and partial work is not published", () => {
  const s = fixture({ liquidity: 1_000_000n }, [[-20, -1_000_000n]]);
  assert.equal(quoteV4Local({ ...s, ticks: new Map() }, true, 1n), null);
  assert.equal(quoteV4Local({ ...s, tickBitmap: new Map([[0, 0n]]) }, true, 1_000n), null);
  const partial = { ...s, tickBitmap: new Map([[0, 0n], [-1, s.tickBitmap.get(-1)!]]) };
  const before = [...partial.tickBitmap];
  assert.equal(quoteV4Local(partial, true, 1_000_000n), null);
  assert.deepEqual([...partial.tickBitmap], before);
  assert.equal(partial.liquidity, 1_000_000n);
});

test("no known liquidity is not a fabricated zero quote", () => {
  assert.equal(quoteV4Local(fixture({ liquidity: 0n }), true, 1n), null);
  assert.equal(quoteV4Local(fixture({ liquidity: 0n }), false, 1n), null);
});

test("full input that genuinely rounds to zero output is distinguished from partial-fill fallback", () => {
  const s = fixture({ liquidity: U128, lpFee: 0n });
  const result = quote(s, false, 1n);
  assert.equal(result.amountOut, 0n);
  assert.equal(result.state.sqrtPriceX96, Q96);
  const feeDust = quote(fixture({ liquidity: U128, lpFee: 999_999n }), false, 1n);
  assert.equal(feeDust.amountOut, 0n);
  assert.equal(feeDust.state.tick, 0);
});

test("100% fee, bad fee packing and malformed source scalars are unsupported", () => {
  const invalid: Partial<UniV4LocalState>[] = [
    { lpFee: 1_000_000n }, { lpFee: 1_000_001n }, { lpFee: -1n },
    { protocolFee: 1_001n }, { protocolFee: 1_001n << 12n }, { protocolFee: 1n << 24n }, { protocolFee: -1n },
    { tickSpacing: 0 }, { tickSpacing: -1 }, { tickSpacing: 32_768 }, { tickSpacing: 1.5 }, { tickSpacing: NaN },
    { tick: MIN_TICK - 1 }, { tick: MAX_TICK }, { tick: NaN }, { tick: 1.1 },
    { sqrtPriceX96: 0n }, { sqrtPriceX96: MIN_SQRT_RATIO - 1n }, { sqrtPriceX96: MAX_SQRT_RATIO },
    { sqrtPriceX96: 1n << 160n }, { sqrtPriceX96: Q96 - 1n }, { sqrtPriceX96: sqrt(1) + 1n },
    { sqrtPriceX96: sqrt(1), tickSpacing: 10 },
    { liquidity: -1n }, { liquidity: 1n << 128n },
    { tickBitmap: new Map([[0, -1n]]) }, { tickBitmap: new Map([[0, 1n << 256n]]) },
  ];
  for (const patch of invalid) assert.equal(quoteV4Local(fixture(patch), true, 1_000n), null);
  for (const amount of [0n, -1n, I128 + 1n, 1n << 256n]) assert.equal(quoteV4Local(fixture(), true, amount), null);
});

test("int128 net validation and invalid initialized bitmap ticks fail closed", () => {
  for (const net of [I128 + 1n, -(1n << 127n) - 1n, -(1n << 127n)]) {
    assert.equal(quoteV4Local(fixture({}, [[0, net]]), true, 1n), null);
  }
  const invalidTick = 887_280, spacing = 10;
  const s = fixture({ tick: MAX_TICK - 1, sqrtPriceX96: sqrt(MAX_TICK - 1), tickSpacing: spacing }, [[invalidTick, 0n]]);
  assert.equal(quoteV4Local(s, false, 1n), null);
});

test("full int128 input supported; output overflow never clips", () => {
  const s = fixture({ liquidity: U128, lpFee: 0n, tickSpacing: 32_767 });
  for (const down of [true, false]) {
    const result = quote(s, down, I128);
    assert.ok(result.amountOut > 0n && result.amountOut < I128);
  }
  const high = fixture({ tick: MAX_TICK - 1, sqrtPriceX96: sqrt(MAX_TICK - 1), liquidity: U128,
    lpFee: 0n, tickSpacing: 32_767 });
  assert.equal(quoteV4Local(high, true, 10n ** 20n), null);
});

test("uint256 product and denominator-overflow inputs are bounded, not unlimited-BigInt accepted", () => {
  const price = MAX_SQRT_RATIO - 1n, numerator = U128 * Q96;
  const s = fixture({ tick: MAX_TICK - 1, sqrtPriceX96: price, liquidity: U128, lpFee: 0n, tickSpacing: 32_767 });
  const productOverflow = U256 / price + 1n;
  const sumOverflow = (U256 - numerator) / price + 1n;
  assert.ok(productOverflow * price > U256 && productOverflow < I128);
  assert.ok(sumOverflow * price <= U256 && sumOverflow * price + numerator > U256);
  for (const input of [productOverflow, sumOverflow]) {
    const canonical = ceil(numerator, numerator / price + input);
    const unlimited = ceil(numerator * price, numerator + input * price);
    assert.notEqual(canonical, unlimited, "overflow branch has distinct rounding");
    // At this price both outputs exceed the executor int128 domain. Correct
    // branch selection is implemented, but cannot make an oversized quote valid.
    assert.ok(between(canonical, price, U128, false, false) > I128);
    assert.equal(quoteV4Local(s, true, input), null);
  }
});

test("independent amount trials never mutate source or earlier scalar post-state", () => {
  const s = fixture({}, [[-20, -100n], [20, 100n]]);
  const before = { ...s, tickBitmap: [...s.tickBitmap], ticks: [...s.ticks] };
  const a = quote(s, true, 10n ** 16n), saved = { ...a.state };
  quote(s, false, 2n * 10n ** 16n);
  assert.deepEqual(quote(s, true, 10n ** 16n), a);
  assert.deepEqual(a.state, saved);
  assert.deepEqual({ ...s, tickBitmap: [...s.tickBitmap], ticks: [...s.ticks] }, before);
  assert.notEqual(a.state, s);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.state));
  assert.equal(a.state.tickBitmap, s.tickBitmap);
  assert.equal(a.state.ticks, s.ticks);
});
