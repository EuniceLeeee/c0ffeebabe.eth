/**
 * PoolStateCache — path B "warm once, compute locally" layer.
 *
 * On first access to a Curve pool it pulls the pool state (A / fee / balances /
 * rates, detecting plain vs stableswap-ng) in a few eth_calls, then every
 * subsequent quote for that pool is pure local math (curve-math.ts) — no RPC.
 * Within one solve (~hundreds of amount trials) this turns "an eth_call per
 * trial" into "one warm-up + N local computes".
 *
 * The cache holds fork-state-dependent balances, so callers normally clear it
 * whenever the underlying fork advances. Block-scan uses explicit log-based
 * invalidation plus restamping for unchanged pools. On any warm-up or lookup
 * failure the caller falls back to the on-chain quoter.
 */

import { ethers } from "ethers";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../shared/state/state-backend.js";
import {
  curvePlainGetDy,
  curveNgGetDy,
  type CurvePlainState,
  type CurveNgState,
} from "./curve-math.js";
import { V3MissingBitmapWordError, v3SwapExactInput, type V3PoolState } from "./v3-math.js";
import { quoteV2ExactInput, v2FeeBpsForFactory } from "./v2-fee.js";
import {
  curveNativeRateMultiplier,
  curveRateMultiplierFromDecimals,
} from "../venues/curve-assets.js";
import {
  decodeCurveAddressResult,
  decodeCurveUint256Result,
} from "../venues/swaps/curve-shared.js";

const curveIface = new ethers.Interface([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function balances(uint256) view returns (uint256)",
  "function coins(uint256) view returns (address)",
  "function stored_rates() view returns (uint256[])",
]);
const curveIntQuoteIface = new ethers.Interface([
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const curveUintQuoteIface = new ethers.Interface([
  "function get_dy(uint256 i,uint256 j,uint256 dx) view returns (uint256)",
]);
const erc20Iface = new ethers.Interface(["function decimals() view returns (uint8)"]);
const univ2Iface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const CURVE_MULTICALL_MAX_CALLS = 500;
const TICK_LENS = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573";
const V3_WORD_RADIUS = Number(process.env.SEARCHER_V3_WORD_RADIUS ?? "8");
const V3_ADAPTIVE_MAX_WORDS = Number(process.env.SEARCHER_V3_ADAPTIVE_MAX_WORDS ?? "64");
// How many blocks v3 tick data (bitmap + liquidityNet) may be reused before a
// re-fetch. tick liquidityNet only changes on LP mint/burn, which is rare over a
// few blocks, so caching by block turns the heavy TickLens walk from once-per-
// hint into at-most-once-per-(refresh window). slot0/liquidity are always re-read
// per hint (cheap single slots), so price/liquidity stay fresh regardless.
const TICK_REFRESH_BLOCKS = Number(process.env.SEARCHER_V3_TICK_REFRESH_BLOCKS ?? "4");

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
const multicallIface = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
]);

interface CurveCached {
  kind: "plain" | "ng";
  coins: string[]; // lowercase
  plain?: CurvePlainState;
  ng?: CurveNgState;
  blockNumber?: number;
  source: "seed" | "lazy";
}

/** Expensive, slow-changing v3 state: tick bitmap + liquidityNet + immutable
 *  pool metadata. Cached by block (see TICK_REFRESH_BLOCKS), survives clear(). */
interface V3TickCache {
  block?: number; // tickBlock these words were read at (undefined if no provider)
  fee: bigint;
  tickSpacing: number;
  token0: string; // lowercase
  token1: string; // lowercase
  tickBitmap: Map<number, bigint>;
  ticks: Map<number, bigint>;
}

/** Per-hint v3 state: shifts with the victim swap, re-read each hint. */
interface V3Live {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  observationIndex?: number;
  observationCardinality?: number;
  observationCardinalityNext?: number;
  feeProtocol?: number;
  unlocked?: boolean;
  blockNumber?: number;
  source: "seed" | "lazy";
}

/** Block-pinned v4 slot0/liquidity, keyed by poolId rather than PoolManager. */
interface V4Cached {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  protocolFee: bigint;
  lpFee: bigint;
  blockNumber?: number;
  source: "seed";
}

/** Per-hint v2 reserves: shift with the victim swap, re-read each hint. */
interface V2Cached {
  token0: string; // lowercase
  token1: string; // lowercase
  reserve0: bigint;
  reserve1: bigint;
  feeBps: bigint;
  blockTimestampLast?: number;
  blockNumber?: number;
  source: "seed" | "lazy";
}

interface CurveBatchCall {
  target: string;
  allowFailure: boolean;
  callData: string;
  label: string;
}

interface CurveBatchRound1 {
  pool: string;
  key: string;
  coins: string[];
  A: bigint;
  fee: bigint;
  offpeg: bigint | null;
}

interface CurveNgFallbackCandidate {
  pool: string;
  key: string;
  coins: string[];
  ng: CurveNgState;
}

export interface V2Seed {
  pool: string;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
  feeBps: bigint;
  blockTimestampLast?: number;
  blockNumber: number;
}

export interface V3LiveSeed {
  pool: string;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  observationIndex?: number;
  observationCardinality?: number;
  observationCardinalityNext?: number;
  feeProtocol?: number;
  unlocked?: boolean;
  blockNumber: number;
}

/**
 * Family-owned projection of already-read current-N state into the mature
 * backrun cache. V3 tick words remain on their existing slow-changing/JIT
 * lifecycle; this seed replaces only the duplicate slot0/liquidity read.
 */
export type BlockScanBackrunStateSeed =
  | {
      readonly kind: "v2";
      readonly state: V2Seed;
    }
  | {
      readonly kind: "v3-live";
      readonly state: V3LiveSeed;
    };

/**
 * Family-owned invalidation of a slow-changing backrun cache layer. These are
 * emitted only from a canonical mutation classification; an unproven direct
 * refresh remains conservatively invalidated by the publication bridge.
 */
export type BlockScanBackrunStateInvalidation = {
  readonly kind: "v3-ticks";
  readonly pool: string;
};

export interface V3TicksSeed {
  pool: string;
  token0: string;
  token1: string;
  fee: bigint;
  tickSpacing: number;
  tickBitmap: Map<number, bigint>;
  ticks: Map<number, bigint>;
  blockNumber: number;
}

export interface V4Seed {
  poolId: string;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  protocolFee: bigint;
  lpFee: bigint;
  blockNumber: number;
}

export interface V4Snapshot extends V4Seed {}

export interface V2PostImpactSeed extends V2Seed {
  kind: "v2";
}

export interface V3PostImpactSeed extends V3LiveSeed {
  kind: "v3";
}

export interface V4PostImpactSeed {
  kind: "v4";
  poolManager: string;
  poolId: string;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  lpFee?: number;
  protocolFee?: number;
  blockNumber: number;
}

export interface CurvePostImpactSeed {
  kind: "curve";
  pool: string;
  curveKind: "plain" | "ng";
  coins: string[];
  plain?: CurvePlainState;
  ng?: CurveNgState;
  blockNumber: number;
}

export type PostImpactSeed = V2PostImpactSeed | V3PostImpactSeed | V4PostImpactSeed | CurvePostImpactSeed;

export interface V3Snapshot {
  pool: string;
  token0: string;
  token1: string;
  blockNumber: number;
  state: V3PoolState;
}

export interface CurveSnapshot {
  pool: string;
  kind: "plain" | "ng";
  coins: string[];
  plain?: CurvePlainState;
  ng?: CurveNgState;
  blockNumber: number;
}

export interface BeginHintOptions {
  overlayPools?: string[];
  postImpact?: PostImpactSeed[];
}

export class PoolStateCache {
  private curve = new Map<string, CurveCached>();
  // Tick data persists across clear() and is refreshed lazily by block; the live
  // slot0/liquidity layer is dropped every hint.
  private v3Ticks = new Map<string, V3TickCache>();
  private v3Live = new Map<string, V3Live>();
  private v4 = new Map<string, V4Cached>();
  // v2 reserves — per-hint (shift with the victim swap), warmed once then local.
  private v2 = new Map<string, V2Cached>();
  // Pools whose state is modified by the current victim overlay. These must
  // bypass block-level seed data; quoting them from pre-victim cache would erase
  // the arb displacement.
  private overlayPools = new Set<string>();
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

  /**
   * Start a new hint/solve epoch. Keeps block-seeded non-impact state from the
   * updater, drops lazy reads from the previous overlay, and marks impact pools
   * as overlay-only for this hint.
   */
  beginHint(block?: number, overlayPoolsOrOptions: string[] | BeginHintOptions = []): void {
    this.tickBlock = block;
    const options: BeginHintOptions = Array.isArray(overlayPoolsOrOptions)
      ? { overlayPools: overlayPoolsOrOptions }
      : overlayPoolsOrOptions;
    const postImpactTargets = new Set((options.postImpact ?? []).map(postImpactTarget));
    this.overlayPools = new Set(
      (options.overlayPools ?? [])
        .map((p) => p.toLowerCase())
        .filter((p) => !postImpactTargets.has(p)),
    );
    this.failed.clear();
    this.curve.clear();
    this.v4.clear();
    for (const [key, live] of this.v3Live) {
      if (live.source !== "seed") this.v3Live.delete(key);
    }
    for (const [key, cached] of this.v2) {
      if (cached.source !== "seed") this.v2.delete(key);
    }
    for (const post of options.postImpact ?? []) {
      if (post.kind === "v2") {
        this.seedV2(post);
      } else if (post.kind === "v3") {
        this.seedV3Live(post);
      } else if (post.kind === "v4") {
        this.seedV4({
          poolId: post.poolId,
          sqrtPriceX96: post.sqrtPriceX96,
          tick: post.tick,
          liquidity: post.liquidity,
          protocolFee: BigInt(post.protocolFee ?? 0),
          lpFee: BigInt(post.lpFee ?? 0),
          blockNumber: post.blockNumber,
        });
      } else if (post.kind === "curve") {
        this.seedCurve(post);
      }
    }
  }

  /**
   * Drop per-hint cached state — call whenever the fork advances. Clears the
   * fork-dependent layers (curve balances/rates, v3 slot0+liquidity) so they
   * re-read from the new overlay, but KEEPS the v3 tick cache: tick liquidityNet
   * is stable across a few blocks, so the heavy TickLens walk is reused (refreshed
   * lazily by block in getV3Ticks) instead of re-paid every hint.
   */
  clear(): void {
    this.curve.clear();
    this.v3Live.clear();
    this.v4.clear();
    this.v2.clear();
    this.failed.clear();
    this.overlayPools.clear();
  }

  /** Discard every block-derived layer after a canonical hash change. */
  clearBlockScanWarmProgress(): void {
    this.clear();
    this.v3Ticks.clear();
    this.tickBlock = undefined;
  }

  /**
   * Block-scan pass boundary: keep seeded V2 reserves, V3 slot0/liquidity, and
   * Curve pool state across blocks. The block-scan warm planner invalidates the
   * pools that emitted state-changing logs, then restamps unchanged entries.
   */
  beginBlockScanPass(blockNumber: number): void {
    this.tickBlock = blockNumber;
    this.failed.clear();
    this.overlayPools.clear();
    for (const [key, live] of this.v3Live) {
      if (live.source !== "seed") this.v3Live.delete(key);
    }
    for (const [key, cached] of this.v2) {
      if (cached.source !== "seed") this.v2.delete(key);
    }
  }

  invalidateBlockScanV2V3(pools: Iterable<string>): void {
    for (const pool of pools) {
      const key = pool.toLowerCase();
      this.v2.delete(key);
      this.v3Live.delete(key);
      this.failed.delete(key);
    }
  }

  invalidateBlockScanV3Ticks(pools: Iterable<string>): void {
    for (const pool of pools) {
      const key = pool.toLowerCase();
      this.v3Ticks.delete(key);
      this.failed.delete(key);
    }
  }

  invalidateBlockScanCurve(pools: Iterable<string>): void {
    for (const pool of pools) {
      const key = pool.toLowerCase();
      this.curve.delete(key);
      this.failed.delete(key);
    }
  }

  invalidateBlockScanV4(poolIds: Iterable<string>): void {
    for (const poolId of poolIds) {
      const key = poolId.toLowerCase();
      this.v4.delete(key);
      this.failed.delete(key);
    }
  }

  restampBlockScanV2V3(blockNumber: number, skipPools: ReadonlySet<string> = new Set()): void {
    for (const [key, cached] of this.v2) {
      if (cached.source === "seed" && !skipPools.has(key)) cached.blockNumber = blockNumber;
    }
    for (const [key, live] of this.v3Live) {
      if (live.source === "seed" && !skipPools.has(key)) live.blockNumber = blockNumber;
    }
  }

  restampBlockScanCurve(blockNumber: number, skipPools: ReadonlySet<string> = new Set()): void {
    for (const [key, cached] of this.curve) {
      if (!skipPools.has(key)) cached.blockNumber = blockNumber;
    }
  }

  restampBlockScanV4(blockNumber: number, skipPoolIds: ReadonlySet<string> = new Set()): void {
    for (const [key, cached] of this.v4) {
      if (cached.source === "seed" && !skipPoolIds.has(key)) cached.blockNumber = blockNumber;
    }
  }

  hasV2(pool: string): boolean {
    return this.v2.has(pool.toLowerCase());
  }

  hasV3Live(pool: string): boolean {
    return this.v3Live.has(pool.toLowerCase());
  }

  hasV4(poolId: string): boolean {
    return this.v4.has(poolId.toLowerCase());
  }

  hasCurve(pool: string): boolean {
    return this.curve.has(pool.toLowerCase());
  }

  curveKind(pool: string): "plain" | "ng" | null {
    return this.curve.get(pool.toLowerCase())?.kind ?? null;
  }

  seedV2(seed: V2Seed): void {
    const key = seed.pool.toLowerCase();
    this.v2.set(key, {
      token0: seed.token0.toLowerCase(),
      token1: seed.token1.toLowerCase(),
      reserve0: seed.reserve0,
      reserve1: seed.reserve1,
      feeBps: seed.feeBps,
      blockTimestampLast: seed.blockTimestampLast,
      blockNumber: seed.blockNumber,
      source: "seed",
    });
    this.failed.delete(key);
  }

  seedV3Live(seed: V3LiveSeed): void {
    const key = seed.pool.toLowerCase();
    this.v3Live.set(key, {
      sqrtPriceX96: seed.sqrtPriceX96,
      tick: seed.tick,
      liquidity: seed.liquidity,
      observationIndex: seed.observationIndex,
      observationCardinality: seed.observationCardinality,
      observationCardinalityNext: seed.observationCardinalityNext,
      feeProtocol: seed.feeProtocol,
      unlocked: seed.unlocked,
      blockNumber: seed.blockNumber,
      source: "seed",
    });
    this.failed.delete(key);
  }

  seedV3Ticks(seed: V3TicksSeed): void {
    const key = seed.pool.toLowerCase();
    this.v3Ticks.set(key, {
      block: seed.blockNumber,
      fee: seed.fee,
      tickSpacing: seed.tickSpacing,
      token0: seed.token0.toLowerCase(),
      token1: seed.token1.toLowerCase(),
      tickBitmap: seed.tickBitmap,
      ticks: seed.ticks,
    });
    this.failed.delete(key);
  }

  seedV4(seed: V4Seed): void {
    const key = seed.poolId.toLowerCase();
    this.v4.set(key, {
      sqrtPriceX96: seed.sqrtPriceX96,
      tick: seed.tick,
      liquidity: seed.liquidity,
      protocolFee: seed.protocolFee,
      lpFee: seed.lpFee,
      blockNumber: seed.blockNumber,
      source: "seed",
    });
    this.failed.delete(key);
  }

  seedCurve(seed: CurvePostImpactSeed): void {
    const key = seed.pool.toLowerCase();
    this.curve.set(key, {
      kind: seed.curveKind,
      coins: seed.coins.map((coin) => coin.toLowerCase()),
      plain: seed.plain ? clonePlain(seed.plain) : undefined,
      ng: seed.ng ? cloneNg(seed.ng) : undefined,
      blockNumber: seed.blockNumber,
      source: "seed",
    });
    this.failed.delete(key);
  }

  snapshotV2(pool: string, blockNumber?: number): V2Seed | null {
    const key = pool.toLowerCase();
    const cached = this.v2.get(key);
    if (!cached || !this.liveStateFreshFor(cached.blockNumber, blockNumber)) return null;
    return {
      pool,
      token0: cached.token0,
      token1: cached.token1,
      reserve0: cached.reserve0,
      reserve1: cached.reserve1,
      feeBps: cached.feeBps,
      blockTimestampLast: cached.blockTimestampLast,
      blockNumber: cached.blockNumber ?? blockNumber ?? 0,
    };
  }

  snapshotV3(pool: string, blockNumber?: number): V3Snapshot | null {
    const key = pool.toLowerCase();
    const live = this.v3Live.get(key);
    const ticks = this.v3Ticks.get(key);
    if (!live || !ticks || !this.liveStateFreshFor(live.blockNumber, blockNumber)) return null;
    if (blockNumber !== undefined && ticks.block !== undefined && !this.v3TicksFresh(pool, blockNumber)) return null;
    return {
      pool,
      token0: ticks.token0,
      token1: ticks.token1,
      blockNumber: live.blockNumber ?? blockNumber ?? 0,
      state: {
        sqrtPriceX96: live.sqrtPriceX96,
        tick: live.tick,
        liquidity: live.liquidity,
        observationIndex: live.observationIndex,
        observationCardinality: live.observationCardinality,
        observationCardinalityNext: live.observationCardinalityNext,
        feeProtocol: live.feeProtocol,
        unlocked: live.unlocked,
        fee: ticks.fee,
        tickSpacing: ticks.tickSpacing,
        tickBitmap: ticks.tickBitmap,
        ticks: ticks.ticks,
      },
    };
  }

  snapshotV3Live(pool: string, blockNumber?: number): V3LiveSeed | null {
    const key = pool.toLowerCase();
    const live = this.v3Live.get(key);
    if (!live || !this.liveStateFreshFor(live.blockNumber, blockNumber)) return null;
    return {
      pool,
      sqrtPriceX96: live.sqrtPriceX96,
      tick: live.tick,
      liquidity: live.liquidity,
      observationIndex: live.observationIndex,
      observationCardinality: live.observationCardinality,
      observationCardinalityNext: live.observationCardinalityNext,
      feeProtocol: live.feeProtocol,
      unlocked: live.unlocked,
      blockNumber: live.blockNumber ?? blockNumber ?? 0,
    };
  }

  snapshotV4(poolId: string, blockNumber?: number): V4Snapshot | null {
    const key = poolId.toLowerCase();
    const cached = this.v4.get(key);
    if (!cached || !this.liveStateFreshFor(cached.blockNumber, blockNumber)) return null;
    return {
      poolId: key,
      sqrtPriceX96: cached.sqrtPriceX96,
      tick: cached.tick,
      liquidity: cached.liquidity,
      protocolFee: cached.protocolFee,
      lpFee: cached.lpFee,
      blockNumber: cached.blockNumber ?? blockNumber ?? 0,
    };
  }

  snapshotCurve(pool: string, blockNumber?: number): CurveSnapshot | null {
    const key = pool.toLowerCase();
    const cached = this.curve.get(key);
    if (!cached || !this.liveStateFreshFor(cached.blockNumber, blockNumber)) return null;
    return {
      pool,
      kind: cached.kind,
      coins: [...cached.coins],
      plain: cached.plain ? clonePlain(cached.plain) : undefined,
      ng: cached.ng ? cloneNg(cached.ng) : undefined,
      blockNumber: cached.blockNumber ?? blockNumber ?? 0,
    };
  }

  v3TicksFresh(pool: string, blockNumber: number): boolean {
    const cached = this.v3Ticks.get(pool.toLowerCase());
    if (!cached || cached.block === undefined) return false;
    return Math.abs(blockNumber - cached.block) < TICK_REFRESH_BLOCKS;
  }

  /**
   * Local cross-tick exact-input quote for a Uniswap V3 pool. Tick data (the
   * heavy TickLens walk) is warmed once per refresh window and reused across
   * hints; slot0 + liquidity are re-read per hint from the (overlay) state.
   * If the swap crosses beyond initially warmed words, fetches the missing word
   * and retries locally up to V3_ADAPTIVE_MAX_WORDS. Throws on true failures or
   * cap exhaustion so the caller falls back to the eth_call quoter.
   */
  async quoteV3(
    state: StateBackend,
    pool: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    const key = pool.toLowerCase();
    if (this.overlayPools.has(key)) {
      throw new Error(`v3 ${pool.slice(0, 10)} is overlay-only for this hint`);
    }
    if (this.failed.has(key)) throw new Error(`v3 ${pool.slice(0, 10)} warm failed this epoch`);
    let ticks: V3TickCache;
    let live: V3Live;
    try {
      ticks = await this.getV3Ticks(state, pool, key);
      live = await this.getV3Live(state, pool, key);
    } catch (err) {
      this.failed.add(key);
      console.log(
        `[poolcache] v3 warm failed ${pool.slice(0, 10)} → eth_call fallback: ` +
          `${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
      );
      throw err;
    }
    const zeroForOne = tokenIn.toLowerCase() === ticks.token0;
    const adaptiveWords = new Set<number>();
    for (;;) {
      const v3State: V3PoolState = {
        sqrtPriceX96: live.sqrtPriceX96,
        tick: live.tick,
        liquidity: live.liquidity,
        fee: ticks.fee,
        tickSpacing: ticks.tickSpacing,
        tickBitmap: ticks.tickBitmap,
        ticks: ticks.ticks,
      };
      try {
        return v3SwapExactInput(v3State, zeroForOne, amountIn);
      } catch (err) {
        if (!(err instanceof V3MissingBitmapWordError)) throw err;
        const word = err.word;
        if (adaptiveWords.has(word)) {
          throw new Error(`v3 ${pool.slice(0, 10)} still missing bitmap word ${word} after adaptive warm`);
        }
        if (adaptiveWords.size >= V3_ADAPTIVE_MAX_WORDS) {
          throw new Error(
            `v3 ${pool.slice(0, 10)} adaptive bitmap warm cap ${V3_ADAPTIVE_MAX_WORDS} reached; ` +
              `next missing word ${word}`,
          );
        }
        try {
          await this.warmV3TickWord(state, pool, ticks, word);
        } catch (warmErr) {
          this.failed.add(key);
          throw new Error(
            `v3 ${pool.slice(0, 10)} failed warming missing bitmap word ${word}: ` +
              `${warmErr instanceof Error ? warmErr.message : String(warmErr)}`,
          );
        }
        adaptiveWords.add(word);
      }
    }
  }

  /** Tick bitmap + liquidityNet + immutable metadata, reused until the block
   *  drifts past TICK_REFRESH_BLOCKS (or forever when no block context). */
  private async getV3Ticks(state: StateBackend, pool: string, key: string): Promise<V3TickCache> {
    const cached = this.v3Ticks.get(key);
    if (cached && this.tickCacheFresh(cached)) return cached;
    const warmed = await this.warmV3Ticks(state, pool);
    this.v3Ticks.set(key, warmed);
    console.log(
      `[poolcache] warmed univ3 ticks ${pool.slice(0, 10)} (${warmed.ticks.size} ticks, ` +
        `±${V3_WORD_RADIUS} words, block ${warmed.block ?? "n/a"})`,
    );
    return warmed;
  }

  private tickCacheFresh(cached: V3TickCache): boolean {
    if (this.tickBlock === undefined || cached.block === undefined) return true;
    return Math.abs(this.tickBlock - cached.block) < TICK_REFRESH_BLOCKS;
  }

  /** Per-hint slot0 + liquidity, read from the (overlay) state and reused for
   *  every trial within the hint; cleared by clear(). */
  private async getV3Live(state: StateBackend, pool: string, key: string): Promise<V3Live> {
    const cached = this.v3Live.get(key);
    if (cached && this.liveStateFresh(cached.blockNumber)) return cached;
    if (cached) this.v3Live.delete(key);
    const slot0Res = await state.call({ to: pool, data: v3PoolIface.encodeFunctionData("slot0") });
    const slot0 = v3PoolIface.decodeFunctionResult("slot0", slot0Res);
    const live: V3Live = {
      sqrtPriceX96: BigInt(slot0[0]),
      tick: Number(slot0[1]),
      liquidity: await this.call(state, pool, v3PoolIface.encodeFunctionData("liquidity")),
      observationIndex: Number(slot0[2]),
      observationCardinality: Number(slot0[3]),
      observationCardinalityNext: Number(slot0[4]),
      feeProtocol: Number(slot0[5]),
      unlocked: Boolean(slot0[6]),
      blockNumber: this.tickBlock,
      source: "lazy",
    };
    this.v3Live.set(key, live);
    return live;
  }

  /**
   * Local constant-product (UniV2-lineage) quote, warming token0 + reserves +
   * per-pool fee once per hint then computing output locally for every trial.
   * Reserves shift with the victim swap, so the cache is cleared each hint.
   * Throws on any failure so the caller can fall back to the eth_call quoter.
   */
  async quoteV2(
    state: StateBackend,
    pool: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    const key = pool.toLowerCase();
    if (this.overlayPools.has(key)) {
      throw new Error(`v2 ${pool.slice(0, 10)} is overlay-only for this hint`);
    }
    if (this.failed.has(key)) throw new Error(`v2 ${pool.slice(0, 10)} warm failed this epoch`);
    let cached = this.v2.get(key);
    if (cached && !this.liveStateFresh(cached.blockNumber)) {
      this.v2.delete(key);
      cached = undefined;
    }
    if (!cached) {
      try {
        cached = await this.warmV2(state, pool);
      } catch (err) {
        this.failed.add(key);
        throw err;
      }
      this.v2.set(key, cached);
      console.log(`[poolcache] warmed univ2 ${pool.slice(0, 10)}`);
    }
    const ti = tokenIn.toLowerCase();
    const to = tokenOut.toLowerCase();
    const zeroForOne = ti === cached.token0 && to === cached.token1;
    const oneForZero = ti === cached.token1 && to === cached.token0;
    if (!zeroForOne && !oneForZero) {
      throw new Error(`v2 ${pool.slice(0, 10)} does not trade requested pair`);
    }
    const [reserveIn, reserveOut] = zeroForOne
      ? [cached.reserve0, cached.reserve1]
      : [cached.reserve1, cached.reserve0];
    return quoteV2ExactInput(reserveIn, reserveOut, amountIn, cached.feeBps);
  }

  private async warmV2(state: StateBackend, pool: string): Promise<V2Cached> {
    const [t0Res, t1Res, resvRes, factoryRes] = await Promise.all([
      state.call({ to: pool, data: univ2Iface.encodeFunctionData("token0") }),
      state.call({ to: pool, data: univ2Iface.encodeFunctionData("token1") }),
      state.call({ to: pool, data: univ2Iface.encodeFunctionData("getReserves") }),
      state.call({ to: pool, data: univ2Iface.encodeFunctionData("factory") }).catch(() => undefined),
    ]);
    const token0 = ethers.getAddress("0x" + t0Res.slice(-40)).toLowerCase();
    const token1 = ethers.getAddress("0x" + t1Res.slice(-40)).toLowerCase();
    const decoded = univ2Iface.decodeFunctionResult("getReserves", resvRes);
    if (!factoryRes) {
      throw new Error(`v2 ${pool.slice(0, 10)} factory read failed`);
    }
    const factory = univ2Iface.decodeFunctionResult("factory", factoryRes)[0] as string;
    const feeBps = v2FeeBpsForFactory(factory);
    if (feeBps === null) {
      throw new Error(`v2 ${pool.slice(0, 10)} factory identity is missing`);
    }
    return {
      token0,
      token1,
      reserve0: BigInt(decoded[0]),
      reserve1: BigInt(decoded[1]),
      feeBps,
      blockTimestampLast: Number(decoded[2]),
      blockNumber: this.tickBlock,
      source: "lazy",
    };
  }

  private liveStateFresh(blockNumber: number | undefined): boolean {
    return this.tickBlock === undefined || blockNumber === this.tickBlock;
  }

  private liveStateFreshFor(blockNumber: number | undefined, expectedBlock: number | undefined): boolean {
    return expectedBlock === undefined || blockNumber === expectedBlock;
  }

  /**
   * Local-math get_dy for a Curve pool, warming state on first touch.
   * Throws on any failure so the caller can fall back to the eth_call quoter.
   */
  async warmCurvesBatch(state: StateBackend, pools: string[]): Promise<void> {
    const candidates: Array<{ pool: string; key: string }> = [];
    const seen = new Set<string>();
    for (const pool of pools) {
      const key = pool.toLowerCase();
      if (seen.has(key) || this.overlayPools.has(key) || this.curve.has(key) || this.failed.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({ pool, key });
    }
    if (candidates.length === 0) return;

    const round1Calls: CurveBatchCall[] = [];
    for (const { pool, key } of candidates) {
      for (let i = 0; i < 8; i++) {
        round1Calls.push({
          target: pool,
          allowFailure: true,
          callData: curveIface.encodeFunctionData("coins", [i]),
          label: `${key}:coins:${i}`,
        });
      }
      round1Calls.push({
        target: pool,
        allowFailure: true,
        callData: curveIface.encodeFunctionData("A"),
        label: `${key}:A`,
      });
      round1Calls.push({
        target: pool,
        allowFailure: true,
        callData: curveIface.encodeFunctionData("fee"),
        label: `${key}:fee`,
      });
      round1Calls.push({
        target: pool,
        allowFailure: true,
        callData: curveIface.encodeFunctionData("offpeg_fee_multiplier"),
        label: `${key}:offpeg_fee_multiplier`,
      });
    }

    const round1 = await this.aggregateCurveCalls(state, round1Calls);
    const parsed: CurveBatchRound1[] = [];
    for (const candidate of candidates) {
      try {
        parsed.push(this.parseCurveBatchRound1(candidate.pool, candidate.key, round1));
      } catch {
        this.failed.add(candidate.key);
      }
    }
    if (parsed.length === 0) return;

    const round2Calls: CurveBatchCall[] = [];
    for (const item of parsed) {
      for (let k = 0; k < item.coins.length; k++) {
        round2Calls.push({
          target: item.pool,
          allowFailure: true,
          callData: curveIface.encodeFunctionData("balances", [k]),
          label: `${item.key}:balances:${k}`,
        });
      }
      if (item.offpeg !== null) {
        round2Calls.push({
          target: item.pool,
          allowFailure: true,
          callData: curveIface.encodeFunctionData("stored_rates"),
          label: `${item.key}:stored_rates`,
        });
      } else {
        for (let k = 0; k < item.coins.length; k++) {
          if (curveNativeRateMultiplier(item.coins[k]) !== null) continue;
          round2Calls.push({
            target: item.coins[k],
            allowFailure: true,
            callData: erc20Iface.encodeFunctionData("decimals"),
            label: `${item.key}:decimals:${k}`,
          });
        }
      }
    }

    const round2 = await this.aggregateCurveCalls(state, round2Calls);
    const staticRateFallbackCalls: CurveBatchCall[] = [];
    for (const item of parsed) {
      if (
        item.offpeg === null ||
        round2.has(`${item.key}:stored_rates`)
      ) {
        continue;
      }
      for (let k = 0; k < item.coins.length; k++) {
        if (curveNativeRateMultiplier(item.coins[k]) !== null) continue;
        staticRateFallbackCalls.push({
          target: item.coins[k],
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData("decimals"),
          label: `${item.key}:decimals:${k}`,
        });
      }
    }
    const staticRateFallback = staticRateFallbackCalls.length > 0
      ? await this.aggregateCurveCalls(state, staticRateFallbackCalls)
      : new Map<string, string>();
    const pendingNgFallbacks: CurveNgFallbackCandidate[] = [];
    for (const item of parsed) {
      try {
        const balances: bigint[] = [];
        for (let k = 0; k < item.coins.length; k++) {
          balances.push(
            decodeCurveUint256Result(
              requireCurveBatchData(round2, `${item.key}:balances:${k}`),
              `curve ${item.pool} balance ${k}`,
            ),
          );
        }

        if (item.offpeg !== null) {
          const storedRates = round2.get(`${item.key}:stored_rates`);
          const rates = storedRates
            ? decodeCurveStoredRates(storedRates)
            : curveStaticRates(item.coins, staticRateFallback, item.key);
          assertCurveRates(item.pool, item.coins, rates);
          const ng: CurveNgState = {
            A: item.A,
            fee: item.fee,
            offpegFeeMultiplier: item.offpeg,
            balances,
            rates,
          };
          if (!storedRates) {
            pendingNgFallbacks.push({
              pool: item.pool,
              key: item.key,
              coins: item.coins,
              ng,
            });
            continue;
          }
          this.curve.set(item.key, {
            kind: "ng",
            coins: item.coins,
            ng,
            blockNumber: this.tickBlock,
            source: "lazy",
          });
        } else {
          const rates: bigint[] = [];
          for (let k = 0; k < item.coins.length; k++) {
            const nativeRate = curveNativeRateMultiplier(item.coins[k]);
            if (nativeRate !== null) {
              rates.push(nativeRate);
              continue;
            }
            const dec = Number(
              decodeCurveUint256Result(
                requireCurveBatchData(
                  round2,
                  `${item.key}:decimals:${k}`,
                ),
                `curve ${item.pool} coin ${k} decimals`,
              ),
            );
            rates.push(curveRateMultiplierFromDecimals(dec));
          }
          const plain: CurvePlainState = { A: item.A, fee: item.fee, balances, rates };
          this.curve.set(item.key, {
            kind: "plain",
            coins: item.coins,
            plain,
            blockNumber: this.tickBlock,
            source: "lazy",
          });
        }
      } catch {
        this.curve.delete(item.key);
        this.failed.add(item.key);
      }
    }
    if (pendingNgFallbacks.length === 0) return;

    let witnessResults: Map<string, string>;
    try {
      witnessResults = await this.aggregateCurveCalls(
        state,
        pendingNgFallbacks.flatMap((candidate) =>
          this.curveNgStateWitnessCalls(candidate)
        ),
      );
    } catch {
      for (const candidate of pendingNgFallbacks) {
        this.curve.delete(candidate.key);
        this.failed.add(candidate.key);
      }
      return;
    }
    for (const candidate of pendingNgFallbacks) {
      try {
        this.verifyCurveNgStateWitness(candidate, witnessResults);
        this.curve.set(candidate.key, {
          kind: "ng",
          coins: candidate.coins,
          ng: candidate.ng,
          blockNumber: this.tickBlock,
          source: "lazy",
        });
      } catch {
        this.curve.delete(candidate.key);
        this.failed.add(candidate.key);
      }
    }
  }

  async quoteCurve(
    state: StateBackend,
    pool: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<bigint> {
    const key = pool.toLowerCase();
    if (this.overlayPools.has(key)) {
      throw new Error(`curve ${pool.slice(0, 10)} is overlay-only for this hint`);
    }
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
    return decodeCurveUint256Result(
      await state.call({ to, data }),
      `scalar view ${to}`,
    );
  }

  private async aggregateCurveCalls(state: StateBackend, calls: CurveBatchCall[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (calls.length === 0) return out;
    for (let i = 0; i < calls.length; i += CURVE_MULTICALL_MAX_CALLS) {
      const chunk = calls.slice(i, i + CURVE_MULTICALL_MAX_CALLS);
      const data = multicallIface.encodeFunctionData("aggregate3", [
        chunk.map((call) => ({
          target: call.target,
          allowFailure: call.allowFailure,
          callData: call.callData,
        })),
      ]);
      const result = await state.call({ to: MULTICALL3, data });
      const decoded = multicallIface.decodeFunctionResult("aggregate3", result)[0] as Array<{
        success: boolean;
        returnData: string;
      }>;
      for (let j = 0; j < chunk.length; j++) {
        const res = decoded[j];
        if (res?.success && res.returnData && res.returnData !== "0x") {
          out.set(chunk[j].label, res.returnData);
        }
      }
    }
    return out;
  }

  private parseCurveBatchRound1(
    pool: string,
    key: string,
    results: Map<string, string>,
  ): CurveBatchRound1 {
    const coins: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = results.get(`${key}:coins:${i}`);
      if (!res || res === "0x") break;
      let addr: string;
      try {
        addr = decodeCurveAddressResult(res, `curve ${pool} coin ${i}`);
      } catch {
        break;
      }
      if (addr === ethers.ZeroAddress) break;
      coins.push(addr.toLowerCase());
    }
    if (coins.length === 0) throw new Error(`curve ${pool}: no coins`);
    const A = decodeCurveUint256Result(
      requireCurveBatchData(results, `${key}:A`),
      `curve ${pool} A`,
    );
    const fee = decodeCurveUint256Result(
      requireCurveBatchData(results, `${key}:fee`),
      `curve ${pool} fee`,
    );
    let offpeg: bigint | null = null;
    const offpegRes = results.get(`${key}:offpeg_fee_multiplier`);
    if (offpegRes) {
      try {
        offpeg = decodeCurveUint256Result(
          offpegRes,
          `curve ${pool} offpeg_fee_multiplier`,
        );
      } catch {
        offpeg = null;
      }
    }
    return { pool, key, coins, A, fee, offpeg };
  }

  private async warmV3Ticks(state: StateBackend, pool: string): Promise<V3TickCache> {
    const fee = await this.call(state, pool, v3PoolIface.encodeFunctionData("fee"));
    const tickSpacing = Number(await this.call(state, pool, v3PoolIface.encodeFunctionData("tickSpacing")));
    const token0Res = await state.call({ to: pool, data: v3PoolIface.encodeFunctionData("token0") });
    const token1Res = await state.call({ to: pool, data: v3PoolIface.encodeFunctionData("token1") });
    const token0 = ethers.getAddress("0x" + token0Res.slice(-40)).toLowerCase();
    const token1 = ethers.getAddress("0x" + token1Res.slice(-40)).toLowerCase();
    // Center the word fetch on the current tick. Read slot0.tick once here; the
    // live sqrtPrice/liquidity are read separately per hint in getV3Live.
    const slot0Res = await state.call({ to: pool, data: v3PoolIface.encodeFunctionData("slot0") });
    const tick = Number(v3PoolIface.decodeFunctionResult("slot0", slot0Res)[1]);

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

    return { block: this.tickBlock, fee, tickSpacing, token0, token1, tickBitmap, ticks };
  }

  private async warmV3TickWord(
    state: StateBackend,
    pool: string,
    cached: V3TickCache,
    word: number,
  ): Promise<void> {
    if (cached.tickBitmap.has(word)) return;
    const data = tickLensIface.encodeFunctionData("getPopulatedTicksInWord", [pool, word]);
    const result = this.mainnetProvider
      ? await this.mainnetProvider.call({ to: TICK_LENS, data, blockTag: this.tickBlock })
      : await state.call({ to: TICK_LENS, data });
    const populated = tickLensIface.decodeFunctionResult(
      "getPopulatedTicksInWord",
      result,
    )[0] as Array<{ tick: bigint; liquidityNet: bigint }>;
    cached.tickBitmap.set(word, 0n);
    for (const t of populated) {
      const tk = Number(t.tick);
      cached.ticks.set(tk, BigInt(t.liquidityNet));
      const compressed = Math.floor(tk / cached.tickSpacing);
      const bitmapWord = compressed >> 8;
      const bit = ((compressed % 256) + 256) % 256;
      cached.tickBitmap.set(bitmapWord, (cached.tickBitmap.get(bitmapWord) ?? 0n) | (1n << BigInt(bit)));
    }
    console.log(
      `[poolcache] adaptive warmed univ3 tick word ${word} ${pool.slice(0, 10)} ` +
        `(${populated.length} ticks, block ${cached.block ?? "n/a"})`,
    );
  }

  private async warmCurve(state: StateBackend, pool: string): Promise<CurveCached> {
    const coins = await this.readCoins(state, pool);
    const A = await this.call(state, pool, curveIface.encodeFunctionData("A"));
    const fee = await this.call(state, pool, curveIface.encodeFunctionData("fee"));

    // A direct transport failure must not masquerade as ABI absence. Confirm
    // optional-view absence through an allowFailure Multicall at the same
    // source before choosing a different math lineage.
    const offpegRaw = await this.readOptionalCurveView(
      state,
      pool,
      curveIface.encodeFunctionData("offpeg_fee_multiplier"),
      `${pool.toLowerCase()}:offpeg_fee_multiplier`,
    );
    const offpeg = offpegRaw === null
      ? null
      : decodeCurveUint256Result(
          offpegRaw,
          `curve ${pool} offpeg_fee_multiplier`,
        );

    const balances: bigint[] = [];
    for (let k = 0; k < coins.length; k++) {
      balances.push(await this.call(state, pool, curveIface.encodeFunctionData("balances", [k])));
    }

    if (offpeg !== null) {
      const storedRatesRaw = await this.readOptionalCurveView(
        state,
        pool,
        curveIface.encodeFunctionData("stored_rates"),
        `${pool.toLowerCase()}:stored_rates`,
      );
      const rates = storedRatesRaw === null
        ? await this.readCurveStaticRates(state, coins)
        : decodeCurveStoredRates(storedRatesRaw);
      assertCurveRates(pool, coins, rates);
      const ng: CurveNgState = { A, fee, offpegFeeMultiplier: offpeg, balances, rates };
      if (storedRatesRaw === null) {
        await this.assertCurveNgStateWitness(state, pool, coins, ng);
      }
      return { kind: "ng", coins, ng, blockNumber: this.tickBlock, source: "lazy" };
    }

    // Old-style plain (e.g. 3pool): rate multiplier per coin = 10^(36 - decimals).
    const rates: bigint[] = [];
    for (const coin of coins) {
      const nativeRate = curveNativeRateMultiplier(coin);
      if (nativeRate !== null) {
        rates.push(nativeRate);
        continue;
      }
      const dec = Number(await this.call(state, coin, erc20Iface.encodeFunctionData("decimals")));
      rates.push(curveRateMultiplierFromDecimals(dec));
    }
    const plain: CurvePlainState = { A, fee, balances, rates };
    return { kind: "plain", coins, plain, blockNumber: this.tickBlock, source: "lazy" };
  }

  private async readCurveStaticRates(
    state: StateBackend,
    coins: readonly string[],
  ): Promise<bigint[]> {
    const rates: bigint[] = [];
    for (const coin of coins) {
      const nativeRate = curveNativeRateMultiplier(coin);
      if (nativeRate !== null) {
        rates.push(nativeRate);
        continue;
      }
      const decimals = Number(
        await this.call(
          state,
          coin,
          erc20Iface.encodeFunctionData("decimals"),
        ),
      );
      rates.push(curveRateMultiplierFromDecimals(decimals));
    }
    return rates;
  }

  private async readOptionalCurveView(
    state: StateBackend,
    target: string,
    data: string,
    label: string,
  ): Promise<string | null> {
    try {
      return await state.call({ to: target, data });
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      const confirmed = await this.aggregateCurveCalls(state, [{
        target,
        allowFailure: true,
        callData: data,
        label,
      }]);
      return confirmed.get(label) ?? null;
    }
  }

  private async assertCurveNgStateWitness(
    state: StateBackend,
    pool: string,
    coins: readonly string[],
    ng: CurveNgState,
  ): Promise<void> {
    const candidate: CurveNgFallbackCandidate = {
      pool,
      key: pool.toLowerCase(),
      coins: [...coins],
      ng,
    };
    const observed = await this.aggregateCurveCalls(
      state,
      this.curveNgStateWitnessCalls(candidate),
    );
    this.verifyCurveNgStateWitness(candidate, observed);
  }

  private curveNgStateWitnessCalls(
    candidate: CurveNgFallbackCandidate,
  ): CurveBatchCall[] {
    const calls: CurveBatchCall[] = [];
    for (let i = 0; i < candidate.coins.length; i++) {
      const amountIn = curveOneTokenProbe(candidate.ng.rates[i]);
      for (let j = 0; j < candidate.coins.length; j++) {
        if (i === j) continue;
        const args = [BigInt(i), BigInt(j), amountIn] as const;
        calls.push({
          target: candidate.pool,
          allowFailure: true,
          callData: curveIntQuoteIface.encodeFunctionData("get_dy", args),
          label: curveWitnessLabel(candidate.key, "int128", i, j),
        });
        calls.push({
          target: candidate.pool,
          allowFailure: true,
          callData: curveUintQuoteIface.encodeFunctionData("get_dy", args),
          label: curveWitnessLabel(candidate.key, "uint256", i, j),
        });
      }
    }
    return calls;
  }

  private verifyCurveNgStateWitness(
    candidate: CurveNgFallbackCandidate,
    observed: ReadonlyMap<string, string>,
  ): void {
    for (let i = 0; i < candidate.coins.length; i++) {
      const amountIn = curveOneTokenProbe(candidate.ng.rates[i]);
      for (let j = 0; j < candidate.coins.length; j++) {
        if (i === j) continue;
        const intData = observed.get(
          curveWitnessLabel(candidate.key, "int128", i, j),
        );
        const uintData = observed.get(
          curveWitnessLabel(candidate.key, "uint256", i, j),
        );
        if (!intData && !uintData) {
          throw new Error(
            `curve ${candidate.pool}: static-rate fallback lacks get_dy ` +
              `${i}->${j} witness`,
          );
        }
        const intOut = intData
          ? BigInt(curveIntQuoteIface.decodeFunctionResult("get_dy", intData)[0])
          : null;
        const uintOut = uintData
          ? BigInt(curveUintQuoteIface.decodeFunctionResult("get_dy", uintData)[0])
          : null;
        if (intOut !== null && uintOut !== null && intOut !== uintOut) {
          throw new Error(
            `curve ${candidate.pool}: ambiguous get_dy ${i}->${j} witness`,
          );
        }
        const onchain = intOut ?? uintOut!;
        const local = curveNgGetDy(candidate.ng, i, j, amountIn);
        const difference = local > onchain ? local - onchain : onchain - local;
        if (onchain <= 0n || local <= 0n || difference > 2n) {
          throw new Error(
            `curve ${candidate.pool}: static-rate get_dy witness mismatch ` +
              `${i}->${j}: local=${local} onchain=${onchain} ` +
              `diff=${difference}`,
          );
        }
      }
    }
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
        const addr = decodeCurveAddressResult(res, `curve ${pool} coin ${i}`);
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

function postImpactTarget(seed: PostImpactSeed): string {
  return (seed.kind === "v4" ? seed.poolManager : seed.pool).toLowerCase();
}

function clonePlain(state: CurvePlainState): CurvePlainState {
  return {
    A: state.A,
    fee: state.fee,
    balances: [...state.balances],
    rates: [...state.rates],
  };
}

function cloneNg(state: CurveNgState): CurveNgState {
  return {
    A: state.A,
    fee: state.fee,
    offpegFeeMultiplier: state.offpegFeeMultiplier,
    balances: [...state.balances],
    rates: [...state.rates],
  };
}

function decodeCurveStoredRates(data: string): bigint[] {
  return (
    curveIface.decodeFunctionResult("stored_rates", data)[0] as bigint[]
  ).map(BigInt);
}

function curveStaticRates(
  coins: readonly string[],
  results: Map<string, string>,
  key: string,
): bigint[] {
  return coins.map((coin, index) => {
    const nativeRate = curveNativeRateMultiplier(coin);
    if (nativeRate !== null) return nativeRate;
    const decimals = Number(
      decodeCurveUint256Result(
        requireCurveBatchData(results, `${key}:decimals:${index}`),
        `curve coin ${coin} decimals`,
      ),
    );
    return curveRateMultiplierFromDecimals(decimals);
  });
}

function assertCurveRates(
  pool: string,
  coins: readonly string[],
  rates: readonly bigint[],
): void {
  if (
    rates.length !== coins.length ||
    rates.some((rate) => rate <= 0n)
  ) {
    throw new Error(`curve ${pool}: invalid rate vector`);
  }
}

function curveOneTokenProbe(rate: bigint): bigint {
  const scale = 10n ** 36n;
  if (rate <= 0n || scale % rate !== 0n) {
    throw new Error(`curve fallback rate ${rate} has no exact one-token probe`);
  }
  const amount = scale / rate;
  if (amount <= 0n) throw new Error("curve fallback one-token probe is zero");
  return amount;
}

function curveWitnessLabel(
  poolKey: string,
  abi: "int128" | "uint256",
  i: number,
  j: number,
): string {
  return `${poolKey}:get_dy:${abi}:${i}:${j}`;
}

function requireCurveBatchData(results: Map<string, string>, label: string): string {
  const data = results.get(label);
  if (!data) throw new Error(`missing ${label}`);
  return data;
}
