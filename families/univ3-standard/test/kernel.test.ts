import assert from "node:assert/strict";
import test from "node:test";
import { decodePositiveInt24Word, decodeUint24Word } from "../src/kernel/codec.ts";
import { verifyUniV3Identity } from "../src/kernel/identity.ts";
import { Q96, computeSwapStep, getAmount0Delta, getAmount1Delta, getNextSqrtPriceFromInput, getSqrtRatioAtTick, nextInitializedTickWithinOneWord, v3SwapToState } from "../src/kernel/math.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

test("tick and delta arithmetic matches independent boundary identities", () => {
  assert.equal(getSqrtRatioAtTick(0), Q96);
  assert.equal(getSqrtRatioAtTick(-887272), 4295128739n);
  assert.equal(getSqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  assert.equal(getAmount1Delta(Q96, 2n * Q96, 7n, false), 7n);
  assert.equal(getAmount0Delta(Q96, 2n * Q96, 10n, false), 5n);
  assert.throws(() => getSqrtRatioAtTick(887273), /range/);
});

test("swap step conserves exact input including fee", () => {
  const step = computeSwapStep(Q96, getSqrtRatioAtTick(-60), 10n ** 18n, 10n ** 12n, 3_000n);
  assert.ok(step.amountIn > 0n && step.amountOut > 0n && step.feeAmount > 0n);
  assert.ok(step.amountIn + step.feeAmount <= 10n ** 12n);
  assert.throws(() => computeSwapStep(Q96, Q96 - 1n, 1n, 1n, 1_000_000n), /feePips/);
});

test("token1 input advances sqrt price by amount times Q96 divided by liquidity", () => {
  const liquidity = 1_000n;
  const amountIn = 100n;
  assert.equal(getNextSqrtPriceFromInput(Q96, liquidity, amountIn, false), Q96 + amountIn * Q96 / liquidity);
});

test("bitmap selection does not invent an unwarmed word or tick", () => {
  const bitmap = new Map([[0, (1n << 3n) | (1n << 9n)]]);
  assert.deepEqual(nextInitializedTickWithinOneWord(bitmap, 8, 1, true), [3, true]);
  assert.deepEqual(nextInitializedTickWithinOneWord(bitmap, 3, 1, false), [9, true]);
  assert.throws(() => nextInitializedTickWithinOneWord(new Map(), 0, 1, true), /not available/);
});

test("an exact initialized-tick boundary crosses before consuming input in both directions", () => {
  const base = {
    sqrtPriceX96: getSqrtRatioAtTick(0),
    liquidity: 1_000_000n,
    fee: 3_000n,
    tickSpacing: 1,
    ticks: new Map([[0, 100_000n]]),
  };
  const down = v3SwapToState({
    ...base,
    tick: 0,
    tickBitmap: new Map([[-1, 0n], [0, 1n]]),
  }, true, 1_000n);
  assert.ok(down.amountOut > 0n);
  assert.ok(down.state.tick < 0);
  assert.equal(down.state.liquidity, 900_000n);

  const up = v3SwapToState({
    ...base,
    tick: -1,
    tickBitmap: new Map([[0, 1n]]),
  }, false, 1_000n);
  assert.ok(up.amountOut > 0n);
  assert.ok(up.state.tick >= 0);
  assert.equal(up.state.liquidity, 1_100_000n);
});

test("codec widths and reverse identity fields are load-bearing", () => {
  assert.equal(decodeUint24Word(word(500n)), 500n);
  assert.equal(decodePositiveInt24Word(word(60n)), 60);
  assert.throws(() => decodeUint24Word(word(1n << 24n)), /uint24/);
  const facts = { pool: address("5"), factory: address("6"), token0: address("1"), token1: address("2"), fee: 500n, tickSpacing: 10, reversePool: address("5") };
  assert.equal(verifyUniV3Identity(facts).status, "verified");
  assert.equal(verifyUniV3Identity({ ...facts, reversePool: address("7") }).status, "chain-proven-rejected");
  assert.equal(verifyUniV3Identity({ ...facts, token0: address("3"), token1: address("2") }).status, "chain-proven-rejected");
});
