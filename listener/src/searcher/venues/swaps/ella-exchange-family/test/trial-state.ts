import assert from "node:assert/strict";
import test from "node:test";
import { MAX_UINT, UNIT } from "../codec.js";
import { quoteAmountAndApply } from "../state.js";
import type { EllaState } from "../types.js";

const pool = "0x1000000000000000000000000000000000000001";
const executor = "0x1000000000000000000000000000000000000002";
const feesAddress = "0x1000000000000000000000000000000000000003";
const initial: EllaState = Object.freeze({
  source: Object.freeze({ number: 1, hash: "0x" + "01".repeat(32), generation: 1 }),
  price: UNIT, fee: UNIT / 3n, systemCut: UNIT / 2n, feesAddress,
  tokenBalance: 20n, nativeBalance: 20n, baseFeesGenerated: 7n, feesGenerated: 5n,
});
const apply = (state: EllaState, buy: boolean, amount: bigint) =>
  quoteAmountAndApply(state, buy ? "buy-token" : "sell-token", amount, pool, executor);

test("local kernel retains LP fees and advances separate buy/sell fee counters", () => {
  const buy = apply(initial, true, 10n);
  assert.equal(buy.amountOut, 7n); assert.equal(buy.systemFee, 1n);
  assert.deepEqual(buy.nextState, { ...initial, tokenBalance: 12n, nativeBalance: 30n, feesGenerated: 7n });
  const sell = apply(buy.nextState, false, 7n);
  assert.equal(sell.amountOut, 5n); assert.equal(sell.systemFee, 1n);
  assert.deepEqual(sell.nextState, { ...initial, tokenBalance: 19n, nativeBalance: 24n,
    feesGenerated: 7n, baseFeesGenerated: 8n });
  assert.equal(initial.tokenBalance, 20n); assert.equal(buy.nextState.tokenBalance, 12n);
  assert(Object.isFrozen(buy.nextState)); assert(Object.isFrozen(sell.nextState));
});

test("sequential inventory depletion rejects gross capacity and reverse trade restores it", () => {
  const first = apply(initial, true, 20n);
  assert.equal(first.nextState.tokenBalance, 3n);
  const blocked = apply(first.nextState, true, 4n);
  assert.equal(blocked.unavailableReason, "gross-output-exceeds-inventory");
  assert.equal(blocked.amountOut, 0n); assert.strictEqual(blocked.nextState, first.nextState);
  const restored = apply(first.nextState, false, 4n);
  assert.equal(restored.nextState.tokenBalance, 7n);
  assert(apply(restored.nextState, true, 4n).amountOut > 0n);
  // Two trial amounts starting from one source cannot contaminate each other.
  assert.deepEqual(apply(initial, true, 20n), first);
});

test("zero, unavailable output and checked overflow never mutate source state", () => {
  assert.strictEqual(apply(initial, true, 0n).nextState, initial);
  const rounded = { ...initial, price: 2n * UNIT };
  const zero = apply(rounded, true, 1n);
  assert.equal(zero.unavailableReason, "zero-output"); assert.strictEqual(zero.nextState, rounded);
  const counter = { ...initial, feesGenerated: MAX_UINT - 1n };
  const overflow = apply(counter, true, 10n);
  assert.equal(overflow.unavailableReason, "fee-counter-overflow"); assert.strictEqual(overflow.nextState, counter);
  assert.equal(apply({ ...initial, feesGenerated: MAX_UINT - 2n }, true, 10n).nextState.feesGenerated, MAX_UINT);
  assert.throws(() => apply(initial, true, MAX_UINT), /overflow/);
  assert.throws(() => apply({ ...initial, nativeBalance: MAX_UINT }, true, 10n), /inventory overflow/);
});

test("ordinary-transfer kernel rejects actor and fee-recipient aliases", () => {
  assert.throws(() => quoteAmountAndApply(initial, "buy-token", 10n, pool, pool), /trial actor/);
  for (const feesAddress of [pool, executor]) {
    assert.throws(() => apply({ ...initial, feesAddress }, true, 10n), /self-fee recipient/);
    assert.throws(() => apply({ ...initial, feesAddress }, false, 10n), /self-fee recipient/);
  }
});
