import { MaxUint256 } from "ethers";
import type { DeclarativeMathModel, MathValue } from "./declarative-math.js";
import { MAX_SQRT_RATIO, MIN_SQRT_RATIO, v3SwapToState, type V3PoolState } from "../solver/v3-math.js";
import { readUniV3State } from "./swaps/univ3-family/state-reader.js";
import { UNIV3_CANONICAL_FACTORY } from "./swaps/univ3-abi.js";

const MAX_UINT = MaxUint256;
const WAD = 10n ** 18n;
const BPS = 10_000n;
const ZERO = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// Shared pure data helpers. Every value here comes from a JSON invocation;
// nothing performs transport, scheduling or reads. These entries are local
// amount models only, the sanctioned `math` module surface.
// ---------------------------------------------------------------------------
function record(value: MathValue, fields: readonly string[], label: string): Readonly<Record<string, MathValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error(`${label} must be a plain object`);
  const row = value as Record<string, MathValue>;
  const keys = Reflect.ownKeys(row);
  if (keys.some(key => typeof key !== "string" || !fields.includes(key)) || fields.some(key => !Object.hasOwn(row, key)))
    throw new Error(`${label} has missing or unknown fields`);
  return row;
}
function bigint(value: MathValue | undefined, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_UINT) throw new Error(`${label} must be a uint256`);
  return value;
}
function integer(value: MathValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe integer`);
  return value;
}
function flag(value: MathValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function address(value: MathValue | undefined, label: string, allowZero = false): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${label} must be an address`);
  const lower = value.toLowerCase();
  if (!allowZero && lower === ZERO) throw new Error(`${label} must not be the zero address`);
  return lower;
}
function checked(value: bigint, label: string): bigint {
  if (value < 0n || value > MAX_UINT) throw new Error(`${label} uint256 overflow`);
  return value;
}
function array(value: MathValue | undefined, label: string): readonly MathValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function mapValue(value: MathValue | undefined, label: string): ReadonlyMap<MathValue, MathValue> {
  if (!(value instanceof Map)) throw new Error(`${label} must be a Map`);
  return value as ReadonlyMap<MathValue, MathValue>;
}
function canonical(value: MathValue): MathValue {
  if (value === null || ["string", "boolean", "bigint"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("conversion model number is not a safe integer");
    return value;
  }
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [canonical(key) as never, canonical(item)])) as unknown as MathValue;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]));
  throw new Error("conversion model value is not finite data");
}

// ---------------------------------------------------------------------------
// BTB Bear local quote. The transfer-tax override is never applied: mint/redeem
// use _mint/_burn. Capacity is the only bound.
// ---------------------------------------------------------------------------
export interface BearState { readonly source: unknown; readonly supply: bigint; readonly backing: bigint }

function bearState(value: MathValue): BearState {
  const row = record(value, ["source", "supply", "backing"], "bear state");
  return Object.freeze({ source: row.source, supply: bigint(row.supply, "bear supply"), backing: bigint(row.backing, "bear backing") });
}
function bearQuote(value: MathValue): MathValue {
  const row = record(value, ["state", "direction", "amountIn"], "bear quote input");
  const state = bearState(row.state!);
  const direction = String(row.direction);
  const amountIn = bigint(row.amountIn, "bear amountIn");
  if (amountIn === 0n) throw new Error("bear conversion requires positive input");
  const capacity = direction === "mint" ? MAX_UINT - (state.supply > state.backing ? state.supply : state.backing)
    : direction === "redeem" ? (state.supply < state.backing ? state.supply : state.backing)
    : (() => { throw new Error("invalid bear conversion direction"); })();
  if (amountIn > capacity) throw new Error("bear conversion capacity exceeded");
  const delta = direction === "mint" ? amountIn : -amountIn;
  return { amountOut: amountIn, supply: checked(state.supply + delta, "bear supply"), backing: checked(state.backing + delta, "bear backing") };
}
export const bearQuoteMathModel: DeclarativeMathModel = {
  id: "token-conversion:bear", version: 1,
  validateInput(value) { bearQuote(value); },
  evaluate(value) { return canonical(bearQuote(value)); },
  validateOutput(value) {
    const row = record(value, ["amountOut", "supply", "backing"], "bear quote output");
    bigint(row.amountOut, "bear amountOut"); bigint(row.supply, "bear supply"); bigint(row.backing, "bear backing");
  },
};

// ---------------------------------------------------------------------------
// xWin local fund model. Ported 1:1 from xwin-math.ts / xwin-transition.ts.
// ---------------------------------------------------------------------------
const add = (a: bigint, b: bigint) => checked(checked(a, "xWin add") + checked(b, "xWin add"), "xWin add");
const sub = (a: bigint, b: bigint) => {
  const result = checked(a, "xWin sub") - checked(b, "xWin sub");
  if (result < 0n) throw new Error("xWin uint256 underflow");
  return result;
};
const mul = (a: bigint, b: bigint) => checked(checked(a, "xWin mul") * checked(b, "xWin mul"), "xWin mul");
function div(a: bigint, b: bigint): bigint {
  checked(a, "xWin div"); checked(b, "xWin div");
  if (b === 0n) throw new Error("xWin division by zero");
  return a / b;
}
function unit(decimals: number): bigint { return 10n ** BigInt(decimals); }

export interface XwinFundFeeState {
  readonly supply: bigint;
  readonly pendingMFee: bigint;
  readonly managerFee: bigint;
  readonly blocksPerDay: bigint;
  readonly lastManagerFeeCollection: bigint;
}
function accrueXwinFundFee(s: XwinFundFeeState, blockNumber: bigint): XwinFundFeeState {
  const elapsed = sub(blockNumber, s.lastManagerFeeCollection);
  const supply = add(s.supply, s.pendingMFee);
  if (supply === 0n) return { ...s, lastManagerFeeCollection: blockNumber };
  const annualShares = sub(div(mul(supply, BPS), sub(BPS, s.managerFee)), supply);
  const perBlock = div(annualShares, mul(s.blocksPerDay, 365n));
  return { ...s, pendingMFee: add(s.pendingMFee, mul(elapsed, perBlock)), lastManagerFeeCollection: blockNumber };
}
function xwinAllocationAmount(weightBps: bigint, unallocatedBase: bigint): bigint {
  return div(mul(weightBps, unallocatedBase), BPS);
}
function xwinTokenValue(balance: bigint, priceInBaseUnits: bigint, tokenUnit: bigint): bigint {
  return div(mul(balance, priceInBaseUnits), tokenUnit);
}
function xwinMintShares(vaultAfter: bigint, fundSupply: bigint, unitPriceBefore: bigint, baseDecimals: number): bigint {
  if (!Number.isInteger(baseDecimals) || baseDecimals < 0 || baseDecimals > 18) throw new Error("unsupported xWin decimals");
  checked(fundSupply, "xWin supply");
  if (fundSupply === 0n) return mul(vaultAfter, 10n ** BigInt(18 - baseDecimals));
  return sub(div(mul(vaultAfter, WAD), unitPriceBefore), fundSupply);
}
function xwinRedeemRatio(shares: bigint, fundSupply: bigint): bigint { return div(mul(shares, WAD), fundSupply); }
function xwinRedeemBalance(ratio: bigint, balance: bigint): bigint { return div(mul(ratio, balance), WAD); }
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
function xwinWithdrawAfterFee(amountOut: bigint, shares: bigint, s: XwinPerformanceFeeState): { amountOut: bigint; fee: bigint } {
  checked(amountOut, "xWin amountOut"); checked(s.performanceFee, "xWin performanceFee");
  if (s.performanceFee === 0n) return { amountOut, fee: 0n };
  checked(s.unitPriceAfterSales, "xWin unitPriceAfterSales"); checked(s.watermarkUnitprice, "xWin watermark");
  if (s.unitPriceAfterSales <= s.watermarkUnitprice || s.waived) return { amountOut, fee: 0n };
  const elapsed = sub(s.blockNumber, s.prevCollectionBlock);
  checked(s.collectionPeriod, "xWin collectionPeriod");
  const duration = elapsed > s.collectionPeriod ? s.collectionPeriod : elapsed;
  const profit = div(div(mul(mul(sub(s.unitPriceAfterSales, s.watermarkUnitprice), shares), duration), s.collectionPeriod), WAD);
  let fee = div(mul(profit, s.performanceFee), BPS);
  if (s.lockingDiscountBps !== null) fee = sub(fee, div(mul(fee, s.lockingDiscountBps), BPS));
  return { amountOut: sub(amountOut, fee), fee };
}
function xwinSwapInput(amount: bigint, feeBps: bigint, price: bigint, slippageBps: bigint, tokenUnit: bigint) {
  const fee = div(mul(amount, feeBps), BPS);
  const amountIn = sub(amount, fee);
  const grossQuote = mul(amountIn, price);
  const minimumOut = div(sub(grossQuote, div(mul(grossQuote, slippageBps), BPS)), tokenUnit);
  return { amountIn, fee, minimumOut };
}

export interface XwinLocalTarget { readonly token: string; readonly decimals: number; readonly weightBps: bigint; readonly priceInBase: bigint }
export interface XwinLocalSwapRoute { readonly tokenIn: string; readonly tokenOut: string; readonly poolKey: string;
  readonly zeroForOne: boolean; readonly swapFeeBps: bigint; readonly oraclePrice: bigint; readonly slippageBps: bigint }
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
  readonly tokenIn: string; readonly tokenOut: string; readonly poolKey: string; readonly amount: bigint;
  readonly amountIn: bigint; readonly fee: bigint; readonly minimumOut: bigint; readonly amountOut: bigint;
}
export interface XwinLocalTransition {
  readonly amountOut: bigint; readonly state: XwinLocalFundState; readonly swaps: readonly XwinLocalSwapExecution[];
}
function balance(s: XwinLocalFundState, token: string): bigint {
  const value = s.balances.get(token);
  if (value === undefined) throw new Error("xWin missing token balance");
  return checked(value, "xWin balance");
}
function xwinLocalVaultValue(s: XwinLocalFundState): bigint {
  let value = xwinTokenValue(balance(s, s.baseToken), unit(s.baseDecimals), unit(s.baseDecimals));
  for (const target of s.targets) {
    if (target.token !== s.baseToken) value = add(value, xwinTokenValue(balance(s, target.token), target.priceInBase, unit(target.decimals)));
  }
  return value;
}
function xwinLocalUnitPrice(s: XwinLocalFundState): bigint {
  const supply = add(s.supply, s.pendingMFee);
  return supply === 0n ? unit(s.baseDecimals) : mul(xwinLocalVaultValue(s), WAD) / supply;
}
/** Same transition as the TS family model: isolated copies of the balance and
 * pool maps, complete tick validation and no source mutation. */
export function quoteXwinTransition(input: XwinLocalFundState, direction: "deposit" | "withdraw", amountIn: bigint): XwinLocalTransition {
  if (checked(amountIn, "xWin amountIn") === 0n) throw new Error("xWin zero input");
  if (direction !== "deposit" && direction !== "withdraw") throw new Error("unsupported xWin direction");
  address(input.baseToken, "xWin base token"); unit(input.baseDecimals);
  if (input.baseDecimals > 18) throw new Error("unsupported xWin base decimals");
  const targetTokens = new Set<string>();
  for (const target of input.targets) {
    address(target.token, "xWin target token"); unit(target.decimals); checked(target.weightBps, "xWin weight"); checked(target.priceInBase, "xWin price");
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
    const route = routes[0]!, pool = pools.get(route.poolKey);
    if (!pool || pool.unlocked === false || pool.liquidity < 0n || pool.liquidity >= (1n << 128n) ||
        pool.sqrtPriceX96 <= MIN_SQRT_RATIO || pool.sqrtPriceX96 >= MAX_SQRT_RATIO ||
        pool.fee < 0n || pool.fee >= 1_000_000n || !Number.isInteger(pool.tickSpacing) || pool.tickSpacing <= 0) {
      throw new Error("xWin unavailable V3 pool state");
    }
    for (const [word, bitmap] of pool.tickBitmap) {
      checked(bitmap, "xWin tick bitmap");
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

// ---------------------------------------------------------------------------
// xWin local state assembly. Requests/decode/ABI stay in JSON; this model only
// turns already-decoded reads plus the canonical packed V3 state reader into the
// Map-bearing local fund state used by the trial-state cell.
// ---------------------------------------------------------------------------
interface XwinPoolBinding { key: string; token0: string; token1: string; fee: bigint; tickSpacing: number; encoded: string }
function readPools(value: MathValue): { state: Map<string, V3PoolState>; bindings: { key: string; token0: string; token1: string; fee: bigint; tickSpacing: number }[] } {
  const rows = array(value, "xWin pools");
  const state = new Map<string, V3PoolState>();
  const bindings: { key: string; token0: string; token1: string; fee: bigint; tickSpacing: number }[] = [];
  for (const item of rows) {
    const row = record(item, ["key", "token0", "token1", "fee", "tickSpacing", "encoded"], "xWin pool read");
    const key = address(row.key, "xWin pool", true);
    const existing = bindings.find(binding => binding.key === key);
    if (existing) {
      if (existing.token0 !== address(row.token0, "xWin pool token0") || existing.token1 !== address(row.token1, "xWin pool token1") ||
          existing.fee !== bigint(row.fee, "xWin pool fee") || existing.tickSpacing !== integer(row.tickSpacing, "xWin pool tick spacing"))
        throw new Error("xWin duplicate pool binding mismatch");
      continue;
    }
    const token0 = address(row.token0, "xWin pool token0");
    const token1 = address(row.token1, "xWin pool token1");
    const fee = bigint(row.fee, "xWin pool fee");
    const tickSpacing = integer(row.tickSpacing, "xWin pool tick spacing");
    if (typeof row.encoded !== "string" || !/^0x[0-9a-fA-F]+$/.test(row.encoded)) throw new Error("xWin pool state encoding");
    const pool = readUniV3State(row.encoded, { pool: key, token0, token1, fee, tickSpacing, factoryBinding: { factory: UNIV3_CANONICAL_FACTORY, reversePool: key } } as never);
    if (BigInt(`0x${row.encoded.slice(2 + 9 * 64, 2 + 10 * 64)}`) !== 1n || pool.sqrtPriceX96 === 0n) throw new Error("xWin V3 pool locked/uninitialized");
    state.set(key, { ...pool, unlocked: true });
    bindings.push({ key, token0, token1, fee, tickSpacing });
  }
  return { state, bindings };
}
export const xwinLocalStateMathModel: DeclarativeMathModel = {
  id: "token-conversion:xwin-local", version: 1,
  validateInput(value) {
    const row = record(value, ["numbers", "baseToken", "baseDecimals", "baseTokenAmt", "balances", "targets", "swaps", "pools", "blockNumber", "locked"], "xWin local input");
    bigint(row.baseTokenAmt, "xWin baseTokenAmt"); bigint(row.blockNumber, "xWin blockNumber");
    integer(row.baseDecimals, "xWin base decimals");
    array(row.balances, "xWin balances"); array(row.targets, "xWin targets"); array(row.swaps, "xWin swaps");
    array(row.pools, "xWin pools"); array(row.locked, "xWin locked");
  },
  evaluate(value) {
    const row = record(value, ["numbers", "baseToken", "baseDecimals", "baseTokenAmt", "balances", "targets", "swaps", "pools", "blockNumber", "locked"], "xWin local input");
    const baseToken = address(row.baseToken, "xWin base token");
    const baseDecimals = integer(row.baseDecimals, "xWin base decimals");
    if (baseDecimals > 18) throw new Error("unsupported xWin base decimals");
    const balances = new Map<string, bigint>();
    for (const pair of array(row.balances, "xWin balances")) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error("xWin balance row");
      balances.set(address(pair[0], "xWin balance token"), bigint(pair[1], "xWin balance"));
    }
    const targets: XwinLocalTarget[] = array(row.targets, "xWin targets").map(item => {
      const target = record(item, ["token", "decimals", "weightBps", "priceInBase"], "xWin target");
      return { token: address(target.token, "xWin target token"), decimals: integer(target.decimals, "xWin target decimals"),
        weightBps: bigint(target.weightBps, "xWin target weight"), priceInBase: bigint(target.priceInBase, "xWin target price") };
    });
    const swaps: XwinLocalSwapRoute[] = array(row.swaps, "xWin swaps").map(item => {
      const swap = record(item, ["tokenIn", "tokenOut", "poolKey", "zeroForOne", "swapFeeBps", "oraclePrice", "slippageBps"], "xWin swap");
      return { tokenIn: address(swap.tokenIn, "xWin swap tokenIn"), tokenOut: address(swap.tokenOut, "xWin swap tokenOut"),
        poolKey: address(swap.poolKey, "xWin pool key"), zeroForOne: flag(swap.zeroForOne, "xWin zeroForOne"),
        swapFeeBps: bigint(swap.swapFeeBps, "xWin swap fee"), oraclePrice: bigint(swap.oraclePrice, "xWin oracle price"),
        slippageBps: bigint(swap.slippageBps, "xWin slippage") };
    });
    const pools = readPools(row.pools);
    const numbers = record(row.numbers, ["pendingMFee", "managerFee", "performanceFee", "blocksPerDay", "lastManagerFeeCollection",
      "collectionPeriod", "prevCollectionBlock", "watermarkUnitprice", "supply"], "xWin fund numbers");
    const fund: XwinLocalFundState = {
      supply: bigint(numbers.supply, "xWin supply"), pendingMFee: bigint(numbers.pendingMFee, "xWin pendingMFee"),
      managerFee: bigint(numbers.managerFee, "xWin managerFee"), performanceFee: bigint(numbers.performanceFee, "xWin performanceFee"),
      blocksPerDay: bigint(numbers.blocksPerDay, "xWin blocksPerDay"),
      lastManagerFeeCollection: bigint(numbers.lastManagerFeeCollection, "xWin lastManagerFeeCollection"),
      collectionPeriod: bigint(numbers.collectionPeriod, "xWin collectionPeriod"),
      prevCollectionBlock: bigint(numbers.prevCollectionBlock, "xWin prevCollectionBlock"),
      watermarkUnitprice: bigint(numbers.watermarkUnitprice, "xWin watermark"),
      blockNumber: bigint(row.blockNumber, "xWin blockNumber"), baseToken, baseDecimals,
      baseTokenAmt: bigint(row.baseTokenAmt, "xWin baseTokenAmt"), balances, targets, swaps, pools: pools.state,
      waived: flag(record(row.locked, ["waived"], "xWin locked").waived, "xWin waived"), lockingDiscountBps: null,
    };
    return { fund, pools: [...pools.state].map(([key, state], index) => ({ ...pools.bindings[index]!, key, state })) } as unknown as MathValue;
  },
  validateOutput(value) {
    const row = record(value, ["fund", "pools"], "xWin local output");
    record(row.fund!, ["supply", "pendingMFee", "managerFee", "performanceFee", "blocksPerDay", "lastManagerFeeCollection",
      "collectionPeriod", "prevCollectionBlock", "watermarkUnitprice", "blockNumber", "baseToken", "baseDecimals",
      "baseTokenAmt", "balances", "targets", "swaps", "pools", "waived", "lockingDiscountBps"], "xWin fund state");
    array(row.pools, "xWin local pools");
  },
};

export const xwinQuoteMathModel: DeclarativeMathModel = {
  id: "token-conversion:xwin-quote", version: 1,
  validateInput(value) {
    const row = record(value, ["fund", "poolBindings", "poolKeys", "poolStates", "direction", "amountIn"], "xWin quote input");
    record(row.fund!, ["supply", "pendingMFee", "managerFee", "performanceFee", "blocksPerDay", "lastManagerFeeCollection",
      "collectionPeriod", "prevCollectionBlock", "watermarkUnitprice", "blockNumber", "baseToken", "baseDecimals",
      "baseTokenAmt", "balances", "targets", "swaps", "pools", "waived", "lockingDiscountBps"], "xWin quote fund");
    array(row.poolBindings, "xWin pool bindings"); array(row.poolKeys, "xWin pool keys"); array(row.poolStates, "xWin pool states");
    bigint(row.amountIn, "xWin amountIn");
  },
  evaluate(value) {
    const row = record(value, ["fund", "poolBindings", "poolKeys", "poolStates", "direction", "amountIn"], "xWin quote input");
    const fund = row.fund as unknown as XwinLocalFundState;
    const bindings = array(row.poolBindings, "xWin pool bindings").map((item, index) => {
      const binding = record(item, ["key", "token0", "token1", "fee", "tickSpacing"], `xWin pool binding ${index}`);
      return { key: address(binding.key, "xWin pool key"), token0: address(binding.token0, "xWin token0"),
        token1: address(binding.token1, "xWin token1"), fee: bigint(binding.fee, "xWin pool fee"),
        tickSpacing: readableInteger(binding.tickSpacing, "xWin tickSpacing") };
    });
    const keys = array(row.poolKeys, "xWin pool keys").map((key, index) => address(key, `xWin pool key ${index}`));
    const states = array(row.poolStates, "xWin pool states");
    if (keys.length !== states.length || keys.length !== bindings.length) throw new Error("xWin pool cell count mismatch");
    const pools = new Map(fund.pools);
    keys.forEach((key, index) => {
      const state = states[index];
      if (state === undefined || state === null) return;
      const pool = record(state, ["sqrtPriceX96", "tick", "liquidity", "fee", "tickSpacing", "tickBitmap", "ticks", "unlocked"], "xWin pool state");
      bigint(pool.sqrtPriceX96, "xWin sqrtPrice"); readableInteger(pool.tick, "xWin pool tick");
      bigint(pool.liquidity, "xWin liquidity"); bigint(pool.fee, "xWin fee");
      readableInteger(pool.tickSpacing, "xWin tickSpacing");
      if (!(pool.tickBitmap instanceof Map) || !(pool.ticks instanceof Map)) throw new Error("xWin pool maps required");
      pools.set(key, state as unknown as V3PoolState);
    });
    const direction = String(row.direction);
    if (direction !== "mint" && direction !== "redeem") throw new Error("invalid xWin conversion direction");
    const transition = quoteXwinTransition({ ...fund, pools }, direction === "mint" ? "deposit" : "withdraw", bigint(row.amountIn, "xWin amountIn"));
    const touched = new Set(transition.swaps.map(swap => swap.poolKey));
    return canonical(({
      amountOut: transition.amountOut,
      fund: transition.state,
      pools: bindings.map(binding => ({ ...binding, state: transition.state.pools.get(binding.key)!,
        touched: touched.has(binding.key) })),
      swaps: transition.swaps,
    }) as unknown as MathValue) as MathValue;
  },
  validateOutput(value) {
    const row = record(value, ["amountOut", "fund", "pools", "swaps"], "xWin quote output");
    bigint(row.amountOut, "xWin amountOut");
    array(row.pools, "xWin quote pools"); array(row.swaps, "xWin quote swaps");
  },
};
function readableInteger(value: MathValue | undefined, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new Error(`${label} must be a safe integer`);
}
