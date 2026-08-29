import assert from "node:assert/strict";
import test from "node:test";
import {
  UNIV3_SEARCH_SELECTORS,
  decodeUniV3Fee,
  decodeUniV3Liquidity,
  decodeUniV3Quoter,
  decodeUniV3Slot0,
  decodeUniV3Tick,
  decodeUniV3TickBitmap,
  decodeUniV3TickSpacing,
  encodeUniV3QuoterCall,
  encodeUniV3StateCall,
  factoryBoundUniV3Quoter,
} from "../src/search-codec.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const words = (...values: (bigint | string)[]) => `0x${values.map(value => typeof value === "bigint" ? word(value) : value).join("")}`;
const signed = (value: bigint) => word(value < 0n ? (1n << 256n) + value : value);

const canonicalFactory = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const canonicalQuoter = "0x61ffe014ba17989e743c5f6cb21bf9697530b21e";

test("UniV3 search calls encode signed ticks and the factory-bound Quoter V2 tuple", () => {
  const pool = address("a");
  const bitmap = encodeUniV3StateCall("tickBitmap", pool, -1);
  assert.equal(bitmap.data, `0x${UNIV3_SEARCH_SELECTORS.tickBitmap.slice(2)}${signed(-1n)}`);
  const tick = encodeUniV3StateCall("ticks", pool, -600);
  assert.equal(tick.data, `0x${UNIV3_SEARCH_SELECTORS.ticks.slice(2)}${signed(-600n)}`);
  const quote = encodeUniV3QuoterCall({ quoter: canonicalQuoter, tokenIn: address("1"), tokenOut: address("2"), amountIn: "123", fee: "3000" });
  assert.equal(quote.target, canonicalQuoter);
  assert.equal(quote.data.slice(0, 10), UNIV3_SEARCH_SELECTORS.quoteExactInputSingle);
  assert.equal(quote.data.length, 2 + 8 + 64 * 5);
  assert.equal(factoryBoundUniV3Quoter(canonicalFactory), canonicalQuoter);
  assert.equal(factoryBoundUniV3Quoter(address("f")), null);
});

test("UniV3 search decodes signed and width-constrained ABI tuples", () => {
  const slot0 = decodeUniV3Slot0(words(1n << 96n, -600n < 0n ? (1n << 256n) - 600n : 600n, 2n, 3n, 4n, 5n, 1n));
  assert.deepEqual(slot0, { sqrtPriceX96: 1n << 96n, tick: -600 });
  assert.equal(decodeUniV3Liquidity(words(100n)), 100n);
  assert.equal(decodeUniV3Fee(words(3000n)), 3000n);
  assert.equal(decodeUniV3TickSpacing(words(60n)), 60);
  assert.equal(decodeUniV3TickBitmap(words((1n << 255n) + 1n)), (1n << 255n) + 1n);
  const decodedTick = decodeUniV3Tick(words(10n, signed(-20n), 0n, 0n, signed(-5n), 0n, 0n, 1n));
  assert.deepEqual(decodedTick, { liquidityNet: -20n, initialized: true });
  assert.equal(decodeUniV3Quoter(words(987n, 0n, 0n, 123n)), 987n);
});

test("UniV3 search rejects malformed ABI widths, signed ranges, and booleans", () => {
  assert.throws(() => decodeUniV3Slot0(words(1n)), /exactly 7/);
  assert.throws(() => decodeUniV3Liquidity(words(1n << 128n)), /uint128/);
  assert.throws(() => decodeUniV3Fee(words(1n << 24n)), /uint24/);
  assert.throws(() => decodeUniV3TickSpacing(words(0n)), /positive int24/);
  assert.throws(() => encodeUniV3StateCall("tickBitmap", address("a"), 1 << 15), /int16/);
  assert.throws(() => encodeUniV3StateCall("ticks", address("a"), -(1 << 23) - 1), /int24/);
  assert.throws(() => decodeUniV3Slot0(words(1n << 160n, 0n, 0n, 0n, 0n, 0n, 1n)), /sqrtPriceX96/);
  assert.throws(() => decodeUniV3Slot0(words(1n, 0n, 0n, 0n, 0n, 0n, 2n)), /bool/);
  assert.throws(() => decodeUniV3Tick(words(10n, signed(1n << 127n), 0n, 0n, 0n, 0n, 0n, 2n)), /liquidityNet|bool/);
  assert.throws(() => decodeUniV3Quoter(words(987n)), /exactly 4/);
  assert.throws(() => decodeUniV3Fee(`0x${"0".repeat(63)}g`), /raw even-length/);
});
