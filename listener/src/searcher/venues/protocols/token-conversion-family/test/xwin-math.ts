import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_UINT } from "../variants.js";
import { accrueXwinFundFee, xwinAllocationAmount, xwinMintShares, xwinRedeemBalance, xwinRedeemRatio, xwinSwapInput, xwinTokenValue, xwinWithdrawAfterFee } from "../xwin-math.js";
const WAD = 10n ** 18n;
test("xWin manager dilution preserves per-block floor and block-number accrual", () => {
  const s = { supply: WAD, pendingMFee: 1n, managerFee: 200n, blocksPerDay: 7200n, lastManagerFeeCollection: 100n };
  const perBlock = ((s.supply + 1n) * 10000n / 9800n - (s.supply + 1n)) / (7200n * 365n);
  const next = accrueXwinFundFee(s, 110n);
  assert.equal(next.pendingMFee, 1n + 10n * perBlock);
  assert.equal(next.lastManagerFeeCollection, 110n);
  assert.deepEqual(accrueXwinFundFee(next, 110n), next);
  assert.equal(s.pendingMFee, 1n, "trial does not mutate original state");
  assert.throws(() => accrueXwinFundFee(s, 99n), /underflow/);
  assert.equal(accrueXwinFundFee({ ...s, supply: 0n, pendingMFee: 0n, blocksPerDay: 0n }, 110n).lastManagerFeeCollection, 110n);
  assert.throws(() => accrueXwinFundFee({ ...s, blocksPerDay: 0n }, 110n), /division/);
});
test("xWin shares value all post-swap holdings, not deposit amount divided by NAV", () => {
  assert.equal(xwinAllocationAmount(3333n, 10n), 3n);
  assert.equal(xwinTokenValue(100000001n, 62000000000n, 100000000n), 62000000620n);
  assert.equal(xwinMintShares(11000000n, 10n * WAD, 1000000n, 6), WAD);
  assert.equal(xwinMintShares(3n, 0n, 0n, 6), 3n * 10n ** 12n);
  assert.throws(() => xwinMintShares(9n, 10n * WAD, 1n, 6), /underflow/);
  assert.equal(xwinRedeemBalance(xwinRedeemRatio(1n, 3n), 3n), 0n, "two floors are intentional");
});
test("xWin performance fee uses post-sale pre-burn NAV and exact duration/discount floors", () => {
  const state = { performanceFee: 2000n, unitPriceAfterSales: 1200000n, watermarkUnitprice: 1000000n,
    waived: false, blockNumber: 150n, prevCollectionBlock: 100n, collectionPeriod: 100n, lockingDiscountBps: 2500n };
  assert.deepEqual(xwinWithdrawAfterFee(1000000n, WAD, state), { amountOut: 985000n, fee: 15000n });
  assert.equal(xwinWithdrawAfterFee(1000000n, WAD, { ...state, blockNumber: 300n }).fee, 30000n);
  assert.equal(xwinWithdrawAfterFee(1000000n, WAD, { ...state, waived: true, collectionPeriod: 0n }).fee, 0n);
  assert.throws(() => xwinWithdrawAfterFee(1000000n, WAD, { ...state, collectionPeriod: 0n }), /division/);
  assert.throws(() => xwinWithdrawAfterFee(1n, WAD, state), /underflow/);
});
test("xWin swap fee precedes slippage, retaining Solidity rounding and checked arithmetic", () => {
  assert.deepEqual(xwinSwapInput(101n, 100n, 7n, 3333n, 10n), { amountIn: 100n, fee: 1n, minimumOut: 46n });
  assert.equal(xwinSwapInput(1n, 0n, 1n, 1n, 1n).minimumOut, 1n);
  assert.throws(() => xwinSwapInput(MAX_UINT, 1n, 2n, 0n, 1n), /overflow/);
  assert.equal(xwinSwapInput(100n, 0n, 1n, 10001n, 1n).minimumOut, 0n);
  assert.throws(() => xwinSwapInput(10000n, 0n, 1n, 10001n, 1n), /underflow/);
});
