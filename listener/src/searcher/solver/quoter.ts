import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";

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

function quotePSM(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): bigint {
  const usdc = ADDR.USDC.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();
  if (tIn === usdc && tOut === dai) {
    return amountIn * 10n ** 12n;
  }
  if (tIn === dai && tOut === usdc) {
    return amountIn / 10n ** 12n;
  }
  throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
}

// ── UniV4 / Fluid exact quote gates ─────────────────────────────

function quoteUniV4(): bigint {
  throw new Error("unsupported exact quote: univ4-unlock requires dry-run quoter");
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
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  switch (adapterId) {
    case "curve-exchange":
    case "curve-exchange-nr":
    case "curve-exchange-plain":
    case "curve-exchange-received-uint":
      return quoteCurve(state, target, tokenIn, tokenOut, amountIn);
    case "univ3-swap":
      return quoteUniV3(state, target, tokenIn, tokenOut, amountIn);
    case "univ4-unlock":
      return quoteUniV4();
    case "psm":
      return quotePSM(tokenIn, tokenOut, amountIn);
    case "fluid-vault":
      return quoteFluidVault();
    default:
      throw new Error(`no quoter for adapter ${adapterId}`);
  }
}
