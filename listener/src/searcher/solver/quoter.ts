import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { V4PoolKey } from "../planner/token-graph.js";
import type { PoolStateCache } from "./pool-state-cache.js";

/**
 * Quoter — per-protocol amountOut estimation on the current fork state.
 * Returns "what would amountIn give you if you swapped right now".
 *
 * Used by amount-propagation to chain swap amounts through a path,
 * which then feeds solver's binary-search over flashAmount.
 *
 * Curve / UniV3 have on-chain quoters. Protocols without an exact quote or
 * dry-run path fail-fast here instead of emitting placeholder amounts.
 */

const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// ── Curve ──────────────────────────────────────────────────────

const curveIface = new ethers.Interface([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
]);
const curveIfaceUint = new ethers.Interface([
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
]);
const curveIfaceIntCoins = new ethers.Interface([
  "function coins(int128 i) view returns (address)",
]);

const curveCoinsCache = new Map<string, string[]>();

async function curveCoins(state: StateBackend, pool: string): Promise<string[]> {
  const key = pool.toLowerCase();
  const cached = curveCoinsCache.get(key);
  if (cached) return cached;
  const coins: string[] = [];
  for (let i = 0; i < 8; i++) {
    const addr = await curveCoinAt(state, pool, i);
    if (!addr) {
      break;
    }
    coins.push(addr.toLowerCase());
  }
  if (coins.length === 0) throw new Error(`curve pool ${pool} exposed no coins`);
  curveCoinsCache.set(key, coins);
  return coins;
}

async function curveCoinAt(
  state: StateBackend,
  pool: string,
  index: number,
): Promise<string | null> {
  for (const iface of [curveIface, curveIfaceIntCoins]) {
    try {
      const data = iface.encodeFunctionData("coins", [BigInt(index)]);
      const result = await state.call({ to: pool, data });
      if (!result || result === "0x") continue;
      const addr = ethers.getAddress("0x" + result.slice(-40));
      if (addr === ethers.ZeroAddress) return null;
      return addr;
    } catch {
      // Try the next common Curve ABI shape.
    }
  }
  return null;
}

function findIndex(coins: string[], token: string): number {
  const t = token.toLowerCase();
  const idx = coins.indexOf(t);
  if (idx < 0) throw new Error(`token ${token} not in curve pool coins [${coins.join(",")}]`);
  return idx;
}

/** Look up (i, j) indices for a Curve pool given tokenIn/tokenOut. Cached. */
export async function resolveCurveIndices(
  state: StateBackend,
  pool: string,
  tokenIn: string,
  tokenOut: string,
): Promise<[number, number]> {
  const coins = await curveCoins(state, pool);
  return [findIndex(coins, tokenIn), findIndex(coins, tokenOut)];
}

async function quoteCurve(
  state: StateBackend,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const coins = await curveCoins(state, pool);
  const i = findIndex(coins, tokenIn);
  const j = findIndex(coins, tokenOut);

  // Try int128 signature first (most pools)
  try {
    const data = curveIface.encodeFunctionData("get_dy", [
      BigInt(i),
      BigInt(j),
      amountIn,
    ]);
    const result = await state.call({ to: pool, data });
    return BigInt(result);
  } catch {
    // Fallback to uint256 signature (newer pools)
    const data = curveIfaceUint.encodeFunctionData("get_dy", [
      BigInt(i),
      BigInt(j),
      amountIn,
    ]);
    const result = await state.call({ to: pool, data });
    return BigInt(result);
  }
}

// ── UniV3 (QuoterV2) ───────────────────────────────────────────

const poolFeeIface = new ethers.Interface([
  "function fee() view returns (uint24)",
]);
const quoterV2Iface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

async function quoteUniV3(
  state: StateBackend,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const feeResult = await state.call({
    to: pool,
    data: poolFeeIface.encodeFunctionData("fee"),
  });
  const fee = Number(BigInt(feeResult));

  const data = quoterV2Iface.encodeFunctionData("quoteExactInputSingle", [
    {
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0n,
    },
  ]);
  const result = await state.call({ to: UNIV3_QUOTER_V2, data });
  const decoded = quoterV2Iface.decodeFunctionResult(
    "quoteExactInputSingle",
    result,
  );
  return BigInt(decoded[0]);
}

// ── PSM (Sky/Maker stable swap, 1:1 with decimal scaling) ──────

const psmIface = new ethers.Interface([
  "function tin() view returns (uint256)",
  "function tout() view returns (uint256)",
]);
const WAD = 10n ** 18n;
const PSM_TO18 = 10n ** 12n;

async function readPSMFee(
  state: StateBackend,
  target: string,
  fee: "tin" | "tout",
): Promise<bigint> {
  try {
    const result = await state.call({
      to: target,
      data: psmIface.encodeFunctionData(fee),
    });
    const decoded = psmIface.decodeFunctionResult(fee, result);
    return BigInt(decoded[0]);
  } catch {
    return 0n;
  }
}

async function quotePSM(
  state: StateBackend,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const usdc = ADDR.USDC.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();
  const sellsGem = tIn === usdc && tOut === dai;
  const buysGem = tIn === dai && tOut === usdc;
  if (!sellsGem && !buysGem) {
    throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
  }
  const [tin, tout] = await Promise.all([
    readPSMFee(state, target, "tin"),
    readPSMFee(state, target, "tout"),
  ]);
  if (sellsGem) {
    const gemAmt18 = amountIn * PSM_TO18;
    const fee = gemAmt18 * tin / WAD;
    return gemAmt18 - fee;
  }
  if (buysGem) {
    const gemAmt18 = amountIn * WAD / (WAD + tout);
    return gemAmt18 / PSM_TO18;
  }
  throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
}

// -- wstETH (Lido fixed-rate wrap/unwrap views) -----------------

const wstETHIface = new ethers.Interface([
  "function getWstETHByStETH(uint256 _stETHAmount) view returns (uint256)",
  "function getStETHByWstETH(uint256 _wstETHAmount) view returns (uint256)",
]);

async function quoteWstETH(
  state: StateBackend,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const steth = ADDR.STETH.toLowerCase();
  const wsteth = ADDR.WSTETH.toLowerCase();
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();

  if (tIn === steth && tOut === wsteth) {
    const data = wstETHIface.encodeFunctionData("getWstETHByStETH", [amountIn]);
    const result = await state.call({ to: target, data });
    const decoded = wstETHIface.decodeFunctionResult("getWstETHByStETH", result);
    return BigInt(decoded[0]);
  }
  if (tIn === wsteth && tOut === steth) {
    const data = wstETHIface.encodeFunctionData("getStETHByWstETH", [amountIn]);
    const result = await state.call({ to: target, data });
    const decoded = wstETHIface.decodeFunctionResult("getStETHByWstETH", result);
    return BigInt(decoded[0]);
  }
  throw new Error(`wstETH only supports stETH<->wstETH, got ${tokenIn} -> ${tokenOut}`);
}

// ── UniV2 (constant-product) ──────────────────────────────────

const univ2Iface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
]);

async function quoteUniV2(
  state: StateBackend,
  pool: string,
  tokenIn: string,
  _tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const t0Result = await state.call({
    to: pool,
    data: univ2Iface.encodeFunctionData("token0"),
  });
  const token0 = ethers.getAddress("0x" + t0Result.slice(-40));
  const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase();

  const reservesResult = await state.call({
    to: pool,
    data: univ2Iface.encodeFunctionData("getReserves"),
  });
  const decoded = univ2Iface.decodeFunctionResult("getReserves", reservesResult);
  const [r0, r1] = [BigInt(decoded[0]), BigInt(decoded[1])];
  const [reserveIn, reserveOut] = zeroForOne ? [r0, r1] : [r1, r0];

  // UniV2 constant-product with 0.3% fee
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

// ── UniV4 (V4Quoter) ─────────────────────────────────────────

export const uniV4QuoterIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

const MAX_UINT128 = (1n << 128n) - 1n;

async function quoteUniV4(
  state: StateBackend,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
): Promise<bigint> {
  const data = encodeUniV4QuoteExactInputSingle(tokenIn, tokenOut, amountIn, poolKey);
  const result = await state.call({ to: ADDR.UNISWAP_V4_QUOTER, data });
  const decoded = uniV4QuoterIface.decodeFunctionResult("quoteExactInputSingle", result);
  return BigInt(decoded[0]);
}

export function encodeUniV4QuoteExactInputSingle(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
): string {
  if (!poolKey) {
    throw new Error(`V4 quoter: missing PoolKey for ${tokenIn} -> ${tokenOut}`);
  }
  if (amountIn < 0n || amountIn > MAX_UINT128) {
    throw new Error(`V4 quoter: exactAmount does not fit uint128: ${amountIn}`);
  }
  const key = normalizeV4PoolKey(poolKey);
  const inCurrency = normalizeV4Currency(tokenIn, "tokenIn");
  const outCurrency = normalizeV4Currency(tokenOut, "tokenOut");
  const zeroForOne = v4ZeroForOne(key, inCurrency, outCurrency);
  return uniV4QuoterIface.encodeFunctionData("quoteExactInputSingle", [
    {
      poolKey: key,
      zeroForOne,
      exactAmount: amountIn,
      hookData: "0x",
    },
  ]);
}

export function normalizeV4PoolKey(poolKey: V4PoolKey): V4PoolKey {
  return {
    currency0: normalizeV4Currency(poolKey.currency0, "currency0"),
    currency1: normalizeV4Currency(poolKey.currency1, "currency1"),
    fee: uint24(poolKey.fee, "fee"),
    tickSpacing: int24(poolKey.tickSpacing, "tickSpacing"),
    hooks: normalizeV4Currency(poolKey.hooks, "hooks"),
  };
}

function v4ZeroForOne(key: V4PoolKey, tokenIn: string, tokenOut: string): boolean {
  rejectNativeWethV4Pool(key, "V4 quoter");
  const realIn = realV4Currency(tokenIn, key, "tokenIn");
  const realOut = realV4Currency(tokenOut, key, "tokenOut");
  validateV4CurrencyPair(realIn, realOut, key, "V4 quoter");
  const c0 = key.currency0.toLowerCase();
  const c1 = key.currency1.toLowerCase();
  const tIn = realIn.toLowerCase();
  const tOut = realOut.toLowerCase();
  if (tIn === c0 && tOut === c1) return true;
  if (tIn === c1 && tOut === c0) return false;
  throw new Error(
    `V4 quoter: tokens ${tokenIn} -> ${tokenOut} do not match PoolKey ` +
      `${key.currency0} / ${key.currency1}`,
  );
}

function normalizeV4Currency(value: string, field: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`V4 quoter: ${field} must be an address or 0x0, got ${value}`);
  }
}

function realV4Currency(token: string, key: V4PoolKey, field: string): string {
  const c0 = key.currency0;
  const c1 = key.currency1;
  const t = token.toLowerCase();
  if (t === c0.toLowerCase()) return c0;
  if (t === c1.toLowerCase()) return c1;

  const c0Native = c0.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const c1Native = c1.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  if (c0Native !== c1Native && t === ADDR.WETH.toLowerCase()) {
    return c0Native ? c0 : c1;
  }

  throw new Error(
    `V4 quoter: ${field} ${token} does not match PoolKey ${c0} / ${c1}`,
  );
}

function validateV4CurrencyPair(
  realIn: string,
  realOut: string,
  key: V4PoolKey,
  context: string,
): void {
  const a = [realIn.toLowerCase(), realOut.toLowerCase()].sort().join("/");
  const b = [key.currency0.toLowerCase(), key.currency1.toLowerCase()].sort().join("/");
  if (a !== b) {
    throw new Error(
      `${context}: resolved pair ${realIn} / ${realOut} does not match PoolKey ` +
        `${key.currency0} / ${key.currency1}`,
    );
  }
}

function rejectNativeWethV4Pool(key: V4PoolKey, context: string): void {
  const c0 = key.currency0.toLowerCase();
  const c1 = key.currency1.toLowerCase();
  const weth = ADDR.WETH.toLowerCase();
  const zero = ethers.ZeroAddress.toLowerCase();
  if ((c0 === zero && c1 === weth) || (c1 === zero && c0 === weth)) {
    throw new Error(`${context}: native/WETH v4 pool not supported (ambiguous alias)`);
  }
}

function uint24(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new Error(`V4 quoter: PoolKey ${field} must be a uint24, got ${value}`);
  }
  return value;
}

function int24(value: number, field: string): number {
  if (!Number.isInteger(value) || value < -0x800000 || value > 0x7fffff) {
    throw new Error(`V4 quoter: PoolKey ${field} must be an int24, got ${value}`);
  }
  return value;
}

function quoteFluidVault(): bigint {
  throw new Error("unsupported exact quote: fluid-vault requires solver debt search");
}

// ── Dispatch ───────────────────────────────────────────────────

export async function quote(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  state: StateBackend,
  cache?: PoolStateCache,
  v4PoolKey?: V4PoolKey,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  switch (adapterId) {
    case "curve-exchange":
    case "curve-exchange-nr":
    case "curve-exchange-plain":
    case "curve-exchange-received-uint":
      // Path B: prefer warmed local math; fall back to on-chain get_dy.
      if (cache) {
        try {
          return await cache.quoteCurve(state, target, tokenIn, tokenOut, amountIn);
        } catch {
          /* fall through to eth_call */
        }
      }
      return quoteCurve(state, target, tokenIn, tokenOut, amountIn);
    case "univ3-swap":
      // Path B: prefer warmed local cross-tick math; fall back to QuoterV2.
      if (cache) {
        try {
          return await cache.quoteV3(state, target, tokenIn, tokenOut, amountIn);
        } catch {
          /* fall through to eth_call (e.g. swap crosses beyond warmed words) */
        }
      }
      return quoteUniV3(state, target, tokenIn, tokenOut, amountIn);
    case "univ2-swap":
      // Path B: prefer warmed local constant-product; fall back to on-chain reads.
      if (cache) {
        try {
          return await cache.quoteV2(state, target, tokenIn, tokenOut, amountIn);
        } catch {
          /* fall through to eth_call */
        }
      }
      return quoteUniV2(state, target, tokenIn, tokenOut, amountIn);
    case "univ4-unlock":
      return quoteUniV4(state, tokenIn, tokenOut, amountIn, v4PoolKey);
    case "psm":
      return quotePSM(state, target, tokenIn, tokenOut, amountIn);
    case "wsteth-wrap":
    case "wsteth-unwrap":
      return quoteWstETH(state, target, tokenIn, tokenOut, amountIn);
    case "fluid-vault":
      return quoteFluidVault();
    default:
      throw new Error(`no quoter for adapter ${adapterId}`);
  }
}
