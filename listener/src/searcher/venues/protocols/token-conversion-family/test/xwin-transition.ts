import assert from "node:assert/strict";
import { test } from "node:test";
import { getSqrtRatioAtTick, MIN_TICK, v3SwapToState, type V3PoolState } from "../../../../solver/v3-math.js";
import { MAX_UINT } from "../variants.js";
import { quoteXwinTransition, xwinLocalUnitPrice, xwinLocalVaultValue, type XwinLocalFundState } from "../xwin-transition.js";

const BASE = "0x0000000000000000000000000000000000000001";
const TARGET = "0x0000000000000000000000000000000000000002";
const POOL = "0x0000000000000000000000000000000000000003";
const WAD = 10n ** 18n;
function fixture(): XwinLocalFundState {
  const pool: V3PoolState = { sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, liquidity: 10n ** 24n,
    fee: 3000n, tickSpacing: 60, tickBitmap: new Map([[-1, 0n], [0, 0n], [1, 0n]]), ticks: new Map(), unlocked: true };
  return {
    supply: 1000n * WAD, pendingMFee: 0n, managerFee: 200n, blocksPerDay: 7200n,
    lastManagerFeeCollection: 100n, blockNumber: 100n, baseToken: BASE, baseDecimals: 18,
    baseTokenAmt: 500n * WAD, balances: new Map([[BASE, 500n * WAD], [TARGET, 500n * WAD]]),
    targets: [
      { token: TARGET, decimals: 18, weightBps: 5000n, priceInBase: WAD },
      { token: BASE, decimals: 18, weightBps: 5000n, priceInBase: WAD },
    ],
    performanceFee: 2000n, watermarkUnitprice: WAD, waived: false,
    prevCollectionBlock: 1n, collectionPeriod: 1000n, lockingDiscountBps: null,
    swaps: [
      { tokenIn: BASE, tokenOut: TARGET, poolKey: POOL, zeroForOne: true, swapFeeBps: 30n, oraclePrice: WAD, slippageBps: 100n },
      { tokenIn: TARGET, tokenOut: BASE, poolKey: POOL, zeroForOne: false, swapFeeBps: 30n, oraclePrice: WAD, slippageBps: 100n },
    ], pools: new Map([[POOL, pool]]),
  };
}

test("xWin local deposit uses internal V3 output and sequential withdrawal consumes the post-swap pool", () => {
  const original = fixture(), saved = structuredClone(original);
  const deposited = quoteXwinTransition(original, "deposit", 10n * WAD);
  const bought = v3SwapToState(original.pools.get(POOL)!, true, 4985n * WAD / 1000n);
  assert.equal(deposited.swaps.length, 1);
  assert.equal(deposited.swaps[0].amount, 5n * WAD);
  assert.equal(deposited.swaps[0].fee, 15n * WAD / 1000n);
  assert.equal(deposited.swaps[0].amountOut, bought.amountOut);
  assert.equal(deposited.amountOut, 5n * WAD + bought.amountOut);
  assert.equal(deposited.state.balances.get(BASE), 505n * WAD);
  assert.equal(deposited.state.baseTokenAmt, 505n * WAD);
  assert.equal(deposited.state.balances.get(TARGET), 500n * WAD + bought.amountOut);
  assert.deepEqual(deposited.state.pools.get(POOL), bought.state);
  const withdrawn = quoteXwinTransition(deposited.state, "withdraw", deposited.amountOut);
  assert.equal(withdrawn.swaps.length, 1);
  const sold = withdrawn.swaps[0];
  const sequential = v3SwapToState(bought.state, false, sold.amountIn);
  const incorrectlyReset = v3SwapToState(original.pools.get(POOL)!, false, sold.amountIn);
  assert.equal(sold.amountOut, sequential.amountOut);
  assert.notEqual(sold.amountOut, incorrectlyReset.amountOut, "resetting pool state loses preceding swap impact");
  assert.deepEqual(withdrawn.state.pools.get(POOL), sequential.state);
  assert.equal(withdrawn.state.supply, original.supply);
  assert.equal(withdrawn.state.pendingMFee, 0n);
  assert.ok(withdrawn.amountOut > 0n && withdrawn.amountOut < 10n * WAD);
  assert.deepEqual(original, saved, "neither trial mutates source state");
  assert.equal(deposited.state.pools.get(POOL)!.sqrtPriceX96, bought.state.sqrtPriceX96, "next leg does not mutate prior result");
  deposited.state.pools.get(POOL)!.tickBitmap.set(1, 123n);
  assert.deepEqual(original, saved, "returned bitmap is an isolated copy too");
});

test("xWin same-token allocation avoids swap fee and retains unallocated dust through withdraw floors", () => {
  const original = fixture();
  const baseOnly: XwinLocalFundState = { ...original, baseDecimals: 6, supply: 100n * WAD,
    balances: new Map([[BASE, 100_000_001n]]), baseTokenAmt: 99_000_000n,
    targets: [{ token: BASE, decimals: 6, weightBps: 10000n, priceInBase: 1_000_000n }],
    swaps: [], pools: new Map(), watermarkUnitprice: 1_000_000n };
  assert.equal(xwinLocalVaultValue(baseOnly), 100_000_001n);
  assert.equal(xwinLocalUnitPrice(baseOnly), 1_000_000n);
  const deposit = quoteXwinTransition(baseOnly, "deposit", 2_000_000n);
  assert.equal(deposit.amountOut, 2_000_001n * 10n ** 12n, "mint recomputes all holdings after floored pre-NAV");
  assert.equal(deposit.state.baseTokenAmt, 102_000_001n);
  assert.deepEqual(deposit.swaps, []);
  const withdrawal = quoteXwinTransition(deposit.state, "withdraw", deposit.amountOut);
  const ratio = deposit.amountOut * WAD / deposit.state.supply;
  assert.equal(withdrawal.amountOut, ratio * deposit.state.baseTokenAmt / WAD);
  assert.equal(withdrawal.state.baseTokenAmt, deposit.state.baseTokenAmt - withdrawal.amountOut);
  assert.equal(withdrawal.state.balances.get(BASE), withdrawal.state.baseTokenAmt);
  assert.deepEqual(withdrawal.swaps, []);
});

test("xWin manager dilution accrues once in a same-block sequential quote", () => {
  const original = { ...fixture(), blockNumber: 101n };
  const expectedFee = (original.supply * 10000n / 9800n - original.supply) / (7200n * 365n);
  const deposit = quoteXwinTransition(original, "deposit", 10n * WAD);
  assert.equal(deposit.state.pendingMFee, expectedFee);
  const withdrawal = quoteXwinTransition(deposit.state, "withdraw", deposit.amountOut);
  assert.equal(withdrawal.state.pendingMFee, expectedFee);
  assert.equal(withdrawal.state.lastManagerFeeCollection, 101n);
  assert.equal(withdrawal.state.supply, original.supply);
});

test("xWin performance fee uses post-sale pre-burn NAV and leaves paid fee outside fund", () => {
  const state = { ...fixture(), watermarkUnitprice: WAD / 2n, blockNumber: 100n, prevCollectionBlock: 0n, collectionPeriod: 100n };
  const free = quoteXwinTransition({ ...state, waived: true }, "withdraw", WAD);
  const paid = quoteXwinTransition(state, "withdraw", WAD);
  const beforeBurnVault = xwinLocalVaultValue(free.state) + free.amountOut;
  const postSalePrice = beforeBurnVault * WAD / state.supply;
  const fee = (postSalePrice - state.watermarkUnitprice) * WAD / WAD * 2000n / 10000n;
  assert.ok(fee > 0n);
  assert.equal(paid.amountOut, free.amountOut - fee);
  assert.deepEqual(paid.state.balances, free.state.balances, "recipient output plus external fee equals gross withdrawal");
  assert.deepEqual(paid.state.pools, free.state.pools);
});

test("xWin failed amount trials fail closed without altering original state", () => {
  const state = fixture(), saved = structuredClone(state);
  assert.throws(() => quoteXwinTransition(state, "deposit", 0n), /zero input/);
  assert.throws(() => quoteXwinTransition(state, "withdraw", state.supply + 1n), /exceeds minted supply/);
  assert.throws(() => quoteXwinTransition(state, "deposit", MAX_UINT), /overflow/);
  assert.throws(() => quoteXwinTransition({ ...state, swaps: [] }, "deposit", WAD), /missing or ambiguous/);
  assert.throws(() => quoteXwinTransition({ ...state, swaps: [...state.swaps, state.swaps[0]] }, "deposit", WAD), /missing or ambiguous/);
  assert.throws(() => quoteXwinTransition({ ...state, swaps: state.swaps.map(route => ({ ...route, slippageBps: 0n })) }, "deposit", WAD), /slippage/);
  const missing = structuredClone(state);
  missing.pools.get(POOL)!.tickBitmap.clear();
  assert.throws(() => quoteXwinTransition(missing, "deposit", WAD), /not warmed/);
  const incomplete = structuredClone(state);
  incomplete.pools.get(POOL)!.tickBitmap.set(-1, 1n);
  assert.throws(() => quoteXwinTransition(incomplete, "deposit", WAD), /incomplete V3 initialized ticks/);
  const locked = structuredClone(state);
  locked.pools.get(POOL)!.unlocked = false;
  assert.throws(() => quoteXwinTransition(locked, "deposit", WAD), /unavailable V3/);
  const nearTick = MIN_TICK + 10;
  const atLimit = { ...state, pools: new Map([[POOL, { ...state.pools.get(POOL)!, liquidity: 1n, tick: nearTick,
    sqrtPriceX96: getSqrtRatioAtTick(nearTick), tickBitmap: new Map([[-58, 0n]]) }]]) };
  assert.throws(() => quoteXwinTransition(atLimit, "deposit", WAD), /partial fill at price limit/);
  assert.throws(() => xwinLocalVaultValue({ ...state, balances: new Map([[BASE, MAX_UINT]]) }), /overflow/,
    "base-token valuation still performs Solidity's multiply before divide");
  assert.deepEqual(state, saved);
});
