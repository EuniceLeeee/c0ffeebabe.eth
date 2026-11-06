// Integer primitives from the verified xWinAllocations/xWinStrategyWithFee and
// xWinSwapV3 sources. Not a quote implementation: callers must first prove the
// dependency runtimes, read same-source state and apply actual internal swaps.
import { MAX_UINT } from "./variants.js";
const WAD = 10n ** 18n;
const BPS = 10_000n;
function uint(value: bigint): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT) throw new Error("xWin uint256 overflow/underflow");
  return value;
}
const add = (a: bigint, b: bigint) => uint(uint(a) + uint(b));
const sub = (a: bigint, b: bigint) => uint(uint(a) - uint(b));
const mul = (a: bigint, b: bigint) => uint(uint(a) * uint(b));
function div(a: bigint, b: bigint): bigint {
  uint(a); uint(b);
  if (b === 0n) throw new Error("xWin division by zero");
  return a / b;
}
export interface XwinFundFeeState {
  readonly supply: bigint;
  readonly pendingMFee: bigint;
  readonly managerFee: bigint;
  readonly blocksPerDay: bigint;
  readonly lastManagerFeeCollection: bigint;
}
export function accrueXwinFundFee(s: XwinFundFeeState, blockNumber: bigint): XwinFundFeeState {
  const elapsed = sub(blockNumber, s.lastManagerFeeCollection);
  const supply = add(s.supply, s.pendingMFee);
  // Solidity updates lastManagerFeeCollection even for an empty fund, before
  // dividing by blocksPerDay. Preserve both floors and this early return.
  if (supply === 0n) return { ...s, lastManagerFeeCollection: blockNumber };
  const annualShares = sub(div(mul(supply, BPS), sub(BPS, s.managerFee)), supply);
  const perBlock = div(annualShares, mul(s.blocksPerDay, 365n));
  return { ...s, pendingMFee: add(s.pendingMFee, mul(elapsed, perBlock)), lastManagerFeeCollection: blockNumber };
}
export function xwinAllocationAmount(weightBps: bigint, unallocatedBase: bigint): bigint {
  return div(mul(weightBps, unallocatedBase), BPS);
}
export function xwinTokenValue(balance: bigint, priceInBaseUnits: bigint, tokenUnit: bigint): bigint {
  return div(mul(balance, priceInBaseUnits), tokenUnit);
}
export function xwinMintShares(vaultAfter: bigint, fundSupply: bigint, unitPriceBefore: bigint, baseDecimals: number): bigint {
  if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 18) throw new Error("unsupported xWin decimals");
  uint(fundSupply);
  if (fundSupply === 0n) return mul(vaultAfter, 10n ** BigInt(18 - baseDecimals));
  return sub(div(mul(vaultAfter, WAD), unitPriceBefore), fundSupply);
}
export function xwinRedeemRatio(shares: bigint, fundSupply: bigint): bigint {
  return div(mul(shares, WAD), fundSupply);
}
export function xwinRedeemBalance(ratio: bigint, balance: bigint): bigint {
  return div(mul(ratio, balance), WAD);
}
export interface XwinPerformanceFeeState {
  readonly performanceFee: bigint;
  readonly unitPriceAfterSales: bigint;
  readonly watermarkUnitprice: bigint;
  readonly waived: boolean;
  readonly blockNumber: bigint;
  readonly prevCollectionBlock: bigint;
  readonly collectionPeriod: bigint;
  readonly lockingDiscountBps: bigint | null;
}
export function xwinWithdrawAfterFee(amountOut: bigint, shares: bigint, s: XwinPerformanceFeeState): { amountOut: bigint; fee: bigint } {
  uint(amountOut); uint(s.performanceFee);
  if (s.performanceFee === 0n) return { amountOut, fee: 0n };
  uint(s.unitPriceAfterSales); uint(s.watermarkUnitprice);
  if (s.unitPriceAfterSales <= s.watermarkUnitprice || s.waived) return { amountOut, fee: 0n };
  const elapsed = sub(s.blockNumber, s.prevCollectionBlock);
  uint(s.collectionPeriod);
  const duration = elapsed > s.collectionPeriod ? s.collectionPeriod : elapsed;
  const profit = div(div(mul(mul(sub(s.unitPriceAfterSales, s.watermarkUnitprice), shares), duration), s.collectionPeriod), WAD);
  let fee = div(mul(profit, s.performanceFee), BPS);
  if (s.lockingDiscountBps !== null) fee = sub(fee, div(mul(fee, s.lockingDiscountBps), BPS));
  return { amountOut: sub(amountOut, fee), fee };
}
export function xwinSwapInput(amount: bigint, feeBps: bigint, price: bigint, slippageBps: bigint, tokenUnit: bigint) {
  const fee = div(mul(amount, feeBps), BPS);
  const amountIn = sub(amount, fee);
  const grossQuote = mul(amountIn, price);
  // Subtract the floored haircut before dividing by input token precision.
  const minimumOut = div(sub(grossQuote, div(mul(grossQuote, slippageBps), BPS)), tokenUnit);
  return { amountIn, fee, minimumOut };
}
