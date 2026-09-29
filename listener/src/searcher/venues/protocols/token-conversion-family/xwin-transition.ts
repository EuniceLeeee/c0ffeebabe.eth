import { MAX_SQRT_RATIO, MIN_SQRT_RATIO, v3SwapToState, type V3PoolState } from "../../../solver/v3-math.js";
import { MAX_UINT } from "./variants.js";
import { accrueXwinFundFee, xwinAllocationAmount, xwinMintShares, xwinRedeemBalance, xwinRedeemRatio,
  xwinSwapInput, xwinTokenValue, xwinWithdrawAfterFee, type XwinFundFeeState } from "./xwin-math.js";

const WAD = 10n ** 18n;
const uint = (n: bigint): bigint => {
  if (typeof n !== "bigint" || n < 0n || n > MAX_UINT) throw new Error("xWin uint256 overflow/underflow");
  return n;
};
const add = (a: bigint, b: bigint) => uint(uint(a) + uint(b));
const sub = (a: bigint, b: bigint) => uint(uint(a) - uint(b));
const mul = (a: bigint, b: bigint) => uint(uint(a) * uint(b));
function unit(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new Error("unsupported xWin decimals");
  return 10n ** BigInt(decimals);
}
function address(value: string): string {
  if (!/^0x[0-9a-f]{40}$/.test(value) || BigInt(value) === 0n) throw new Error("xWin non-canonical state address");
  return value;
}

export interface XwinLocalTarget {
  readonly token: string;
  readonly decimals: number;
  readonly weightBps: bigint;
  readonly priceInBase: bigint;
}
export interface XwinLocalSwapRoute {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly poolKey: string;
  readonly zeroForOne: boolean;
  readonly swapFeeBps: bigint;
  readonly oraclePrice: bigint;
  readonly slippageBps: bigint;
}
/** Same-source, runtime-verified state. The reader proves plain transfer semantics,
 * independent oracle branches, no nested strategies, single-hop V3 routes and
 * caller/fee-recipient eligibility before constructing this amount-only input. */
export interface XwinLocalFundState extends XwinFundFeeState {
  readonly blockNumber: bigint;
  readonly baseToken: string;
  readonly baseDecimals: number;
  readonly baseTokenAmt: bigint;
  readonly balances: ReadonlyMap<string, bigint>;
  readonly targets: readonly XwinLocalTarget[];
  readonly performanceFee: bigint;
  readonly watermarkUnitprice: bigint;
  readonly waived: boolean;
  readonly prevCollectionBlock: bigint;
  readonly collectionPeriod: bigint;
  readonly lockingDiscountBps: bigint | null;
  readonly swaps: readonly XwinLocalSwapRoute[];
  readonly pools: ReadonlyMap<string, V3PoolState>;
}
export interface XwinLocalSwapExecution {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly poolKey: string;
  readonly amount: bigint;
  readonly amountIn: bigint;
  readonly fee: bigint;
  readonly minimumOut: bigint;
  readonly amountOut: bigint;
}
export interface XwinLocalTransition {
  readonly amountOut: bigint;
  readonly state: XwinLocalFundState;
  readonly swaps: readonly XwinLocalSwapExecution[];
}

function balance(s: XwinLocalFundState, token: string): bigint {
  const value = s.balances.get(token);
  if (value === undefined) throw new Error("xWin missing token balance");
  return uint(value);
}
export function xwinLocalVaultValue(s: XwinLocalFundState): bigint {
  // Even the base-token 1:1 branch performs this checked multiplication in
  // _getTokenValues; cancelling it algebraically would hide uint256 overflow.
  let value = xwinTokenValue(balance(s, s.baseToken), unit(s.baseDecimals), unit(s.baseDecimals));
  for (const target of s.targets) {
    if (target.token !== s.baseToken) value = add(value, xwinTokenValue(balance(s, target.token), target.priceInBase, unit(target.decimals)));
  }
  return value;
}
export function xwinLocalUnitPrice(s: XwinLocalFundState): bigint {
  const supply = add(s.supply, s.pendingMFee);
  return supply === 0n ? unit(s.baseDecimals) : mul(xwinLocalVaultValue(s), WAD) / supply;
}

/** Isolated trial: original holdings and V3 snapshots are never mutated. Passing
 * the returned state into the next leg retains every preceding internal swap. */
export function quoteXwinTransition(input: XwinLocalFundState, direction: "deposit" | "withdraw", amountIn: bigint): XwinLocalTransition {
  if (uint(amountIn) === 0n) throw new Error("xWin zero input");
  if (direction !== "deposit" && direction !== "withdraw") throw new Error("unsupported xWin direction");
  address(input.baseToken); unit(input.baseDecimals);
  if (input.baseDecimals > 18) throw new Error("unsupported xWin base decimals");
  const targetTokens = new Set<string>();
  for (const target of input.targets) {
    address(target.token); unit(target.decimals); uint(target.weightBps); uint(target.priceInBase);
    if (targetTokens.has(target.token)) throw new Error("xWin duplicate target");
    targetTokens.add(target.token);
    if (target.token === input.baseToken && target.decimals !== input.baseDecimals) throw new Error("xWin base decimals mismatch");
  }
  const balances = new Map(input.balances);
  const pools = new Map([...input.pools].map(([key, pool]) => [key, {
    ...pool, tickBitmap: new Map(pool.tickBitmap), ticks: new Map(pool.ticks),
  }]));
  let state: XwinLocalFundState = { ...input, ...accrueXwinFundFee(input, input.blockNumber), balances, pools };
  const swaps: XwinLocalSwapExecution[] = [];
  const move = (tokenIn: string, tokenOut: string, amount: bigint): void => {
    if (amount === 0n || tokenIn === tokenOut) return;
    const routes = input.swaps.filter(route => route.tokenIn === tokenIn && route.tokenOut === tokenOut);
    if (routes.length !== 1) throw new Error("xWin missing or ambiguous local swap route");
    const route = routes[0], pool = pools.get(route.poolKey);
    if (!pool || pool.unlocked === false || pool.liquidity < 0n || pool.liquidity >= (1n << 128n) ||
        pool.sqrtPriceX96 <= MIN_SQRT_RATIO || pool.sqrtPriceX96 >= MAX_SQRT_RATIO ||
        pool.fee < 0n || pool.fee >= 1_000_000n || !Number.isInteger(pool.tickSpacing) || pool.tickSpacing <= 0) {
      throw new Error("xWin unavailable V3 pool state");
    }
    // The shared swap loop expects decoded complete ticks. Never let its missing
    // initialized-tick default be interpreted as genuine zero liquidity delta.
    for (const [word, bitmap] of pool.tickBitmap) {
      uint(bitmap);
      for (let bits = bitmap, bit = 0; bits !== 0n; bits >>= 1n, bit++) {
        if ((bits & 1n) !== 0n && !pool.ticks.has((word * 256 + bit) * pool.tickSpacing)) throw new Error("xWin incomplete V3 initialized ticks");
      }
    }
    const decimals = tokenIn === state.baseToken ? state.baseDecimals : state.targets.find(target => target.token === tokenIn)?.decimals;
    if (decimals === undefined) throw new Error("xWin missing swap token decimals");
    const quoteInput = xwinSwapInput(amount, route.swapFeeBps, route.oraclePrice, route.slippageBps, unit(decimals));
    if (quoteInput.amountIn === 0n || quoteInput.amountIn > (1n << 255n) - 1n) throw new Error("xWin V3 input outside int256 range");
    const result = v3SwapToState(pool, route.zeroForOne, quoteInput.amountIn);
    if (result.state.sqrtPriceX96 === MIN_SQRT_RATIO + 1n || result.state.sqrtPriceX96 === MAX_SQRT_RATIO - 1n) throw new Error("xWin V3 partial fill at price limit");
    if (result.amountOut < quoteInput.minimumOut) throw new Error("xWin V3 slippage limit");
    balances.set(tokenIn, sub(balance(state, tokenIn), amount));
    balances.set(tokenOut, add(balance(state, tokenOut), result.amountOut));
    pools.set(route.poolKey, result.state);
    swaps.push({ tokenIn, tokenOut, poolKey: route.poolKey, amount, ...quoteInput, amountOut: result.amountOut });
  };
  const supply = add(state.supply, state.pendingMFee);
  let amountOut: bigint;
  if (direction === "deposit") {
    const priceBefore = xwinLocalUnitPrice(state);
    balances.set(state.baseToken, add(balance(state, state.baseToken), amountIn));
    const total = sub(balance(state, state.baseToken), state.baseTokenAmt);
    for (const target of state.targets) {
      const amount = xwinAllocationAmount(target.weightBps, total);
      move(state.baseToken, target.token, amount);
      if (target.token === state.baseToken) state = { ...state, baseTokenAmt: add(state.baseTokenAmt, amount) };
    }
    amountOut = xwinMintShares(xwinLocalVaultValue(state), supply, priceBefore, state.baseDecimals);
    state = { ...state, supply: add(state.supply, amountOut) };
  } else {
    if (amountIn > state.supply) throw new Error("xWin withdraw exceeds minted supply");
    // getUnitPrice() is evaluated by the source before selling, even though it
    // is only used by the optional event; retain its checked decimal conversion.
    mul(xwinLocalUnitPrice(state), 10n ** BigInt(18 - state.baseDecimals));
    const ratio = xwinRedeemRatio(amountIn, supply);
    const totalBase = sub(balance(state, state.baseToken), state.baseTokenAmt);
    const remained = sub(totalBase, xwinRedeemBalance(ratio, totalBase));
    for (const target of state.targets) {
      const amount = xwinRedeemBalance(ratio, target.token === state.baseToken ? state.baseTokenAmt : balance(state, target.token));
      move(target.token, state.baseToken, amount);
      if (target.token === state.baseToken) state = { ...state, baseTokenAmt: sub(state.baseTokenAmt, amount) };
    }
    const grossOut = sub(sub(balance(state, state.baseToken), state.baseTokenAmt), remained);
    const withdrawal = xwinWithdrawAfterFee(grossOut, amountIn, {
      ...state, unitPriceAfterSales: state.performanceFee === 0n ? 0n : xwinLocalUnitPrice(state),
    });
    amountOut = withdrawal.amountOut;
    balances.set(state.baseToken, sub(balance(state, state.baseToken), add(amountOut, withdrawal.fee)));
    state = { ...state, supply: sub(state.supply, amountIn) };
  }
  return { amountOut, state, swaps };
}
