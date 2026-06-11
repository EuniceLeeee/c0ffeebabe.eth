/**
 * PoolStateCache — path B "warm once, compute locally" layer.
 *
 * On first access to a Curve pool it pulls the pool state (A / fee / balances /
 * rates, detecting plain vs stableswap-ng) in a few eth_calls, then every
 * subsequent quote for that pool is pure local math (curve-math.ts) — no RPC.
 * Within one solve (~hundreds of amount trials) this turns "an eth_call per
 * trial" into "one warm-up + N local computes".
 *
 * The cache holds fork-state-dependent balances, so it MUST be cleared whenever
 * the underlying fork advances (caller clears per hint / per fixture). On any
 * warm-up or lookup failure the caller falls back to the on-chain quoter.
 */

import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  curvePlainGetDy,
  curveNgGetDy,
  type CurvePlainState,
  type CurveNgState,
} from "./curve-math.js";
import { v3SwapExactInput, type V3PoolState } from "./v3-math.js";

const curveIface = new ethers.Interface([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function balances(uint256) view returns (uint256)",
  "function coins(uint256) view returns (address)",
  "function stored_rates() view returns (uint256[])",
]);
const erc20Iface = new ethers.Interface(["function decimals() view returns (uint8)"]);

const TICK_LENS = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573";
const V3_WORD_RADIUS = Number(process.env.SEARCHER_V3_WORD_RADIUS ?? "8");

const v3PoolIface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const tickLensIface = new ethers.Interface([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick,int128 liquidityNet,uint128 liquidityGross)[])",
]);

interface CurveCached {
  kind: "plain" | "ng";
  coins: string[]; // lowercase
  plain?: CurvePlainState;
  ng?: CurveNgState;
}

interface V3Cached {
  state: V3PoolState;
  token0: string; // lowercase
  token1: string; // lowercase
}

export class PoolStateCache {
  private curve = new Map<string, CurveCached>();
  private v3 = new Map<string, V3Cached>();
  // Pools whose warm-up threw this epoch: don't retry (would re-pay the failed
  // RPC every quote) — fall straight to eth_call until the next clear().
  private failed = new Set<string>();
  // Block to read v3 tick data at via the direct provider (the fork's block).
  private tickBlock?: number;

  /**
   * @param mainnetProvider direct RPC used ONLY for v3 tick data (bitmap +
   *   liquidityNet). anvil-over-RPC is both slow (45s/word) and wrong (returns
   *   empty) for TickLens's heavy storage walk, while a direct eth_call runs
   *   server-side in ~3s. tick liquidityNet is unchanged by a victim swap, so
   *   reading it directly at the fork's block is correct. slot0/liquidity still
   *   come from the fork (cheap single-slot reads, reflect the victim swap).
   */
  constructor(private readonly mainnetProvider?: ethers.JsonRpcProvider) {}

  /** Set the block the direct provider reads v3 tick data at (the fork block). */
  setTickBlock(block?: number): void {
    this.tickBlock = block;
  }

  /** Drop all cached state — call whenever the fork advances. */
  clear(): void {
    this.curve.clear();
    this.v3.clear();
    this.failed.clear();
  }

  /**
   * Local cross-tick exact-input quote for a Uniswap V3 pool, warming slot0 +
   * liquidity + fee + tickSpacing and the tick data (TickLens, ±V3_WORD_RADIUS
   * words) on first touch. Throws on any failure (or if the swap would cross
   * beyond the warmed words) so the caller falls back to the eth_call quoter.
   */
  async quoteV3(
    state: StateBackend,
    pool: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    const key = pool.toLowerCase();
    if (this.failed.has(key)) throw new Error(`v3 ${pool.slice(0, 10)} warm failed this epoch`);
    let cached = this.v3.get(key);
    if (!cached) {
      try {
        cached = await this.warmV3(state, pool);
      } catch (err) {
        this.failed.add(key);
        console.log(
          `[poolcache] v3 warm failed ${pool.slice(0, 10)} → eth_call fallback: ` +
            `${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
        );
        throw err;
      }
      this.v3.set(key, cached);
      console.log(
        `[poolcache] warmed univ3 ${pool.slice(0, 10)} (${cached.state.ticks.size} ticks, ` +
          `±${V3_WORD_RADIUS} words)`,
      );
    }
    const zeroForOne = tokenIn.toLowerCase() === cached.token0;
    return v3SwapExactInput(cached.state, zeroForOne, amountIn);
  }

  /**
   * Local-math get_dy for a Curve pool, warming state on first touch.
   * Throws on any failure so the caller can fall back to the eth_call quoter.
   */
  async quoteCurve(
    state: StateBackend,
    pool: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    const key = pool.toLowerCase();
    if (this.failed.has(key)) throw new Error(`curve ${pool.slice(0, 10)} warm failed this epoch`);
    let cached = this.curve.get(key);
    if (!cached) {
      try {
        cached = await this.warmCurve(state, pool);
      } catch (err) {
        this.failed.add(key);
        throw err;
      }
      this.curve.set(key, cached);
      console.log(
        `[poolcache] warmed ${cached.kind} curve ${pool.slice(0, 10)} (${cached.coins.length} coins)`,
      );
    }
    const i = cached.coins.indexOf(tokenIn.toLowerCase());
    const j = cached.coins.indexOf(tokenOut.toLowerCase());
    if (i < 0 || j < 0) {
      throw new Error(`curve ${pool}: token not in coins (${tokenIn}->${tokenOut})`);
    }
    return cached.kind === "plain"
      ? curvePlainGetDy(cached.plain!, i, j, amountIn)
      : curveNgGetDy(cached.ng!, i, j, amountIn);
  }

  private async call(state: StateBackend, to: string, data: string): Promise<bigint> {
    return BigInt(await state.call({ to, data }));
  }

  private async warmV3(state: StateBackend, pool: string): Promise<V3Cached> {
    const slot0Res = await state.call({ to: pool, data: v3PoolIface.encodeFunctionData("slot0") });
    const slot0 = v3PoolIface.decodeFunctionResult("slot0", slot0Res);
    const sqrtPriceX96 = BigInt(slot0[0]);
    const tick = Number(slot0[1]);
    const liquidity = await this.call(state, pool, v3PoolIface.encodeFunctionData("liquidity"));
    const fee = await this.call(state, pool, v3PoolIface.encodeFunctionData("fee"));
    const tickSpacing = Number(await this.call(state, pool, v3PoolIface.encodeFunctionData("tickSpacing")));
    const token0Res = await state.call({ to: pool, data: v3PoolIface.encodeFunctionData("token0") });
    const token1Res = await state.call({ to: pool, data: v3PoolIface.encodeFunctionData("token1") });
    const token0 = ethers.getAddress("0x" + token0Res.slice(-40)).toLowerCase();
    const token1 = ethers.getAddress("0x" + token1Res.slice(-40)).toLowerCase();

    const compressed = Math.floor(tick / tickSpacing);
    const currentWord = compressed >> 8;
    const tickBitmap = new Map<number, bigint>();
    const ticks = new Map<number, bigint>();

    // Fetch tick data via the direct provider (server-side TickLens, ~3s/word,
    // correct). Words are independent reads → fire them concurrently. If no
    // direct provider is configured, fall back to the fork (slow/unreliable).
    const words: number[] = [];
    for (let w = currentWord - V3_WORD_RADIUS; w <= currentWord + V3_WORD_RADIUS; w++) words.push(w);
    const fetchWord = async (w: number): Promise<string> => {
      const data = tickLensIface.encodeFunctionData("getPopulatedTicksInWord", [pool, w]);
      return this.mainnetProvider
        ? this.mainnetProvider.call({ to: TICK_LENS, data, blockTag: this.tickBlock })
        : state.call({ to: TICK_LENS, data });
    };
    const wordResults = await Promise.all(words.map(fetchWord));

    for (let idx = 0; idx < words.length; idx++) {
      const w = words[idx];
      const populated = tickLensIface.decodeFunctionResult(
        "getPopulatedTicksInWord",
        wordResults[idx],
      )[0] as Array<{ tick: bigint; liquidityNet: bigint }>;
      if (!tickBitmap.has(w)) tickBitmap.set(w, 0n);
      for (const t of populated) {
        const tk = Number(t.tick);
        ticks.set(tk, BigInt(t.liquidityNet));
        const c = Math.floor(tk / tickSpacing);
        const word = c >> 8;
        const bit = ((c % 256) + 256) % 256;
        tickBitmap.set(word, (tickBitmap.get(word) ?? 0n) | (1n << BigInt(bit)));
      }
    }

    const v3State: V3PoolState = { sqrtPriceX96, tick, liquidity, fee, tickSpacing, tickBitmap, ticks };
    return { state: v3State, token0, token1 };
  }

  private async warmCurve(state: StateBackend, pool: string): Promise<CurveCached> {
    const coins = await this.readCoins(state, pool);
    const A = await this.call(state, pool, curveIface.encodeFunctionData("A"));
    const fee = await this.call(state, pool, curveIface.encodeFunctionData("fee"));

    // ng pools expose offpeg_fee_multiplier(); plain (old-style) revert on it.
    let offpeg: bigint | null = null;
    try {
      offpeg = await this.call(state, pool, curveIface.encodeFunctionData("offpeg_fee_multiplier"));
    } catch {
      offpeg = null;
    }

    const balances: bigint[] = [];
    for (let k = 0; k < coins.length; k++) {
      balances.push(await this.call(state, pool, curveIface.encodeFunctionData("balances", [k])));
    }

    if (offpeg !== null) {
      const ratesRes = await state.call({
        to: pool,
        data: curveIface.encodeFunctionData("stored_rates"),
      });
      const rates = (curveIface.decodeFunctionResult("stored_rates", ratesRes)[0] as bigint[]).map(
        (r) => BigInt(r),
      );
      const ng: CurveNgState = { A, fee, offpegFeeMultiplier: offpeg, balances, rates };
      return { kind: "ng", coins, ng };
    }

    // Old-style plain (e.g. 3pool): rate multiplier per coin = 10^(36 - decimals).
    const rates: bigint[] = [];
    for (const coin of coins) {
      const dec = Number(await this.call(state, coin, erc20Iface.encodeFunctionData("decimals")));
      rates.push(10n ** BigInt(36 - dec));
    }
    const plain: CurvePlainState = { A, fee, balances, rates };
    return { kind: "plain", coins, plain };
  }

  private async readCoins(state: StateBackend, pool: string): Promise<string[]> {
    const coins: string[] = [];
    for (let i = 0; i < 8; i++) {
      try {
        const res = await state.call({
          to: pool,
          data: curveIface.encodeFunctionData("coins", [i]),
        });
        if (!res || res === "0x") break;
        const addr = ethers.getAddress("0x" + res.slice(-40));
        if (addr === ethers.ZeroAddress) break;
        coins.push(addr.toLowerCase());
      } catch {
        break;
      }
    }
    if (coins.length === 0) throw new Error(`curve ${pool}: no coins`);
    return coins;
  }
}
