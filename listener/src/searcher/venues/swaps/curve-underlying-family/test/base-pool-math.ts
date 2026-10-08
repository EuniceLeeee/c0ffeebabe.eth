import assert from "node:assert/strict";
import test from "node:test";
import {
  classicBaseExchangeAmount,
  classicBaseMintAmount,
  type ClassicBasePoolState,
} from "../base-pool-math.js";

// Offline regression only. These public values were copied from:
// logs/family-runtime-acceptance/curve-underlying-nine-diagnosis.json
// and independently checked against runtime-program callTrace mint arguments /
// output deltas in single-block-26138094/candidate/curve-underlying-dual-attempt3.json.
// Source N=26138094, hash=0xa3f4d9edbb29d2dd2e4b437dee5f73f135d7eef242a31efc379f0cd687e5da0e.
// Attempt3 SHA256=4629d3a6ff8049f12fa8314d75cc09c73601534b3a1bd18bd1c3ddcc831c430b.
// Base reference blob=04d170189a1b5ddfecfc0af9ea3fe23eb0840423.
// This test neither reexecutes EVM nor proves deployed bytecode/source identity.
const PINNED: ClassicBasePoolState = Object.freeze({
  balances: Object.freeze([
    48584016423561599164952509n,
    47983845606201n,
    63151726663480n,
  ]),
  precisions: Object.freeze([1n, 10n ** 12n, 10n ** 12n]),
  amplification: 4000n,
  fee: 1500000n,
  lpTotalSupply: 153602243283618865987372153n,
});

const MINT_RECEIPTS = [
  ["DAI P", 0, 5215439882447199582n, 5015417355582850964n],
  ["DAI 10P", 0, 52154398824471995820n, 50154163934550920172n],
  ["USDC P", 1, 5216204n, 5016166834399038532n],
  ["USDC 10P", 1, 52162040n, 50161666415796898242n],
  ["USDT P", 2, 5216514n, 5016176328748590927n],
  ["USDT 10P", 2, 52165140n, 50161758476245313940n],
] as const;

for (const [label, index, input, expectedMint] of MINT_RECEIPTS) {
  test("saved actual LP mint: " + label, () => {
    assert.equal(classicBaseMintAmount(PINNED, index, input), expectedMint);
  });
}

const EXCHANGE_RECEIPTS = [
  ["DAI 10P -> USDT", 0, 52154398824471995820n, 52149952n, 52149953n],
  ["USDC P -> USDT", 1, 5216204n, 5215777n, 5215778n],
  ["USDC 10P -> USDT", 1, 52162040n, 52157776n, 52157777n],
] as const;

for (const [label, index, input, expectedActual, oldViewQuote] of EXCHANGE_RECEIPTS) {
  test("saved actual exchange: " + label, () => {
    const actual = classicBaseExchangeAmount(PINNED, index, 2, input);
    assert.equal(actual, expectedActual);
    assert.equal(oldViewQuote - actual, 1n, "must not reuse get_dy rounding order");
  });
}

// Synthetic fixtures, NOT additional historical/EVM evidence.
const BALANCED: ClassicBasePoolState = Object.freeze({
  balances: Object.freeze([10n ** 24n, 10n ** 12n, 10n ** 12n]),
  precisions: Object.freeze([1n, 10n ** 12n, 10n ** 12n]),
  amplification: 2000n,
  fee: 4000000n,
  lpTotalSupply: 3n * 10n ** 24n,
});
const BALANCED_SWAPS = [
  [1n, 999599999500449776n],
  [100n, 99959995004497950869n],
  [1000n, 999599500449525711807n],
] as const;
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    if (i === j) continue;
    test("synthetic balanced direction " + i + " -> " + j + ", three amounts", () => {
      for (const [humanInput, normalizedExpected] of BALANCED_SWAPS) {
        const input = humanInput * 10n ** 18n / BALANCED.precisions[i];
        assert.equal(
          classicBaseExchangeAmount(BALANCED, i, j, input),
          normalizedExpected / BALANCED.precisions[j],
        );
      }
    });
  }
}

test("synthetic balanced single-coin deposits preserve per-coin raw fee rounding", () => {
  const expected = [99980000334342089921n, 99979999334508647383n, 99979999334508647383n];
  for (let i = 0; i < 3; i++) {
    assert.equal(
      classicBaseMintAmount(BALANCED, i, 100n * 10n ** 18n / BALANCED.precisions[i]),
      expected[i],
    );
  }
});

test("zero input returns zero for every valid deposit and exchange direction", () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(classicBaseMintAmount(PINNED, i, 0n), 0n);
    for (let j = 0; j < 3; j++) {
      if (i !== j) assert.equal(classicBaseExchangeAmount(PINNED, i, j, 0n), 0n);
    }
  }
});

test("zero fee and full fee boundaries retain integer output semantics", () => {
  const noFee = { ...BALANCED, fee: 0n };
  assert.equal(classicBaseExchangeAmount(noFee, 0, 1, 100n * 10n ** 18n), 99999995n);
  assert.ok(classicBaseMintAmount(noFee, 0, 100n * 10n ** 18n) >
    classicBaseMintAmount(BALANCED, 0, 100n * 10n ** 18n));
  assert.equal(classicBaseExchangeAmount({ ...BALANCED, fee: 10n ** 10n }, 0, 1, 10n ** 18n), 0n);
});

test("input state is not mutated or retained between quotes", () => {
  const state = structuredClone(PINNED);
  const before = structuredClone(state);
  const first = classicBaseMintAmount(state, 0, MINT_RECEIPTS[0][2]);
  classicBaseExchangeAmount(state, 1, 2, 5216204n);
  assert.deepEqual(state, before);
  const changed = { ...state, fee: state.fee * 2n };
  assert.notEqual(classicBaseMintAmount(changed, 0, MINT_RECEIPTS[0][2]), first);
  assert.equal(classicBaseMintAmount(state, 0, MINT_RECEIPTS[0][2]), first);
});

test("invalid indices fail, including on zero input", () => {
  for (const index of [-1, 3, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
    for (const input of [0n, 1n]) {
      assert.throws(() => classicBaseMintAmount(PINNED, index, input), /invalid token index/);
      assert.throws(() => classicBaseExchangeAmount(PINNED, index, 1, input), /invalid token index/);
      assert.throws(() => classicBaseExchangeAmount(PINNED, 0, index, input), /invalid token index/);
    }
  }
  assert.throws(() => classicBaseExchangeAmount(PINNED, 1, 1, 0n), /indices must differ/);
});

function rejectsState(state: ClassicBasePoolState): void {
  for (const input of [0n, 1n]) {
    assert.throws(() => classicBaseMintAmount(state, 0, input), /classic base pool:/);
    assert.throws(() => classicBaseExchangeAmount(state, 0, 1, input), /classic base pool:/);
  }
}

test("malformed, sparse, zero and negative state fails closed", () => {
  for (const patch of [
    { balances: [], precisions: [] },
    { balances: [1n], precisions: [1n] },
    { precisions: [1n, 1n] },
    { balances: [0n, 1n, 1n] },
    { balances: [0n, 0n, 0n] },
    { balances: [-1n, 1n, 1n] },
    { balances: new Array<bigint>(3) },
    { precisions: new Array<bigint>(3) },
    { precisions: [0n, 1n, 1n] },
    { precisions: [-1n, 1n, 1n] },
    { amplification: 0n },
    { amplification: -1n },
    { lpTotalSupply: 0n },
    { lpTotalSupply: -1n },
    { fee: -1n },
    { fee: 10000000001n },
    { fee: 1 as unknown as bigint },
  ]) rejectsState({ ...PINNED, ...patch });
});

test("uint256 inputs and intermediates reject overflow instead of BigInt extrapolation", () => {
  const max = (1n << 256n) - 1n;
  for (const input of [-1n, max + 1n]) {
    assert.throws(() => classicBaseMintAmount(PINNED, 0, input), /uint256/);
    assert.throws(() => classicBaseExchangeAmount(PINNED, 0, 1, input), /uint256/);
  }
  for (const patch of [
    { balances: [max + 1n, 1n, 1n] },
    { precisions: [max + 1n, 1n, 1n] },
    { amplification: max + 1n },
    { lpTotalSupply: max + 1n },
    { fee: max + 1n },
    { balances: [max, 1n, 1n], precisions: [2n, 1n, 1n] },
  ]) rejectsState({ ...PINNED, ...patch });
  for (const state of [
    { ...BALANCED, amplification: max },
    { ...BALANCED, balances: [10n ** 38n, 10n ** 38n, 10n ** 38n], precisions: [1n, 1n, 1n] },
  ]) {
    assert.throws(() => classicBaseMintAmount(state, 0, 1n), /uint256/);
    assert.throws(() => classicBaseExchangeAmount(state, 0, 1, 1n), /uint256/);
  }
  assert.throws(() => classicBaseMintAmount(BALANCED, 0, max), /uint256/);
  assert.throws(() => classicBaseExchangeAmount(BALANCED, 0, 1, max), /uint256/);
  assert.throws(() => classicBaseExchangeAmount(BALANCED, 1, 0, max), /uint256/);
  assert.throws(() => classicBaseMintAmount({ ...BALANCED, lpTotalSupply: max }, 0, 10n ** 18n), /uint256/);
});

test("nonconvergent invariant throws rather than returning the final iterate", () => {
  const state: ClassicBasePoolState = {
    balances: [540000000000000000n, 267000000000n, 872000n],
    precisions: [1n, 1n, 1n],
    amplification: 11n,
    fee: 1500000n,
    lpTotalSupply: 10n ** 18n,
  };
  assert.throws(() => classicBaseMintAmount(state, 0, 1n), /invariant did not converge/);
  assert.throws(() => classicBaseExchangeAmount(state, 0, 1, 1n), /invariant did not converge/);
});
