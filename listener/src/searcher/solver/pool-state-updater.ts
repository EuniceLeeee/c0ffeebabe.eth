import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { QuoteRequest } from "../live-state-backend.js";
import { v4PoolId } from "../planner/token-graph.js";
import {
  PoolStateCache,
  type V2Seed,
  type V3LiveSeed,
  type V3TicksSeed,
  type V4Seed,
} from "./pool-state-cache.js";
import { v2FeeBpsForFactory } from "./v2-fee.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const TICK_LENS = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573";
const V3_WORD_RADIUS = Number(process.env.SEARCHER_V3_WORD_RADIUS ?? "8");

const multicallIface = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)",
]);
const v2Iface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const v3Iface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const v4StateViewIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const tickLensIface = new ethers.Interface([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick,int128 liquidityNet,uint128 liquidityGross)[])",
]);

export interface PoolStateUpdaterOptions {
  maxPools?: number;
  maxV3TickPoolsPerBlock?: number;
  awaitTickRefreshForTest?: boolean;
}

export interface PoolStateUpdateOptions {
  awaitTicks?: boolean;
  maxTickPools?: number;
}

interface StaticV2 {
  token0: string;
  token1: string;
  feeBps: bigint;
}

interface StaticV3 {
  token0: string;
  token1: string;
  fee: bigint;
  tickSpacing: number;
}

interface BatchCall {
  target: string;
  callData: string;
  label: string;
}

export class PoolStateUpdater {
  private readonly maxPools: number;
  private readonly maxV3TickPoolsPerBlock: number;
  private readonly awaitTickRefreshForTest: boolean;
  private readonly v2Static = new Map<string, StaticV2>();
  private readonly v3Static = new Map<string, StaticV3>();
  private tickRefreshing = false;

  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly cache: PoolStateCache,
    opts: PoolStateUpdaterOptions = {},
  ) {
    this.maxPools = opts.maxPools ?? Number(process.env.SEARCHER_STATE_WATCH_MAX_POOLS ?? "64");
    this.maxV3TickPoolsPerBlock = opts.maxV3TickPoolsPerBlock ??
      Number(process.env.SEARCHER_STATE_V3_TICK_POOLS_PER_BLOCK ?? "1");
    this.awaitTickRefreshForTest = opts.awaitTickRefreshForTest ?? false;
  }

  async update(blockNumber: number, hops: QuoteRequest[], opts: PoolStateUpdateOptions = {}): Promise<void> {
    const pools = this.dedupe(hops).slice(0, this.maxPools);
    if (pools.length === 0) return;

    const started = Date.now();
    const v2 = pools.filter((p) => p.adapterId === "univ2-swap");
    const v3 = pools.filter((p) => p.adapterId === "univ3-swap");
    const v4 = pools.filter((p) => p.adapterId === "univ4-unlock" && p.v4PoolKey);
    const { v2Count, v3Count, v4Count, tickFetch } = await this.updateMutableState(blockNumber, v2, v3, v4);
    if (v2Count + v3Count + v4Count > 0) {
      const tickItems = tickFetch.slice(0, opts.maxTickPools ?? this.maxV3TickPoolsPerBlock);
      console.log(
        `[pool-updater] block=${blockNumber} seeded v2=${v2Count} v3=${v3Count} v4=${v4Count} ` +
          `watched=${pools.length}/${this.maxPools} ` +
          `tickRefresh=${tickItems.length}/${tickFetch.length} ${Date.now() - started}ms`,
      );
      if (opts.awaitTicks) {
        const tickStarted = Date.now();
        await this.updateV3Ticks(blockNumber, tickItems);
        if (tickItems.length > 0) {
          console.log(
            `[pool-updater] ticks block=${blockNumber} seeded=${tickItems.length} ` +
              `${Date.now() - tickStarted}ms sync`,
          );
        }
      } else {
        const tickRefresh = this.refreshV3Ticks(blockNumber, tickItems);
        if (this.awaitTickRefreshForTest) await tickRefresh;
      }
    }
  }

  hasStaticMetadata(adapterId: string, pool: string): boolean {
    const key = pool.toLowerCase();
    if (adapterId === "univ2-swap") return this.v2Static.has(key);
    if (adapterId === "univ3-swap") return this.v3Static.has(key);
    return true;
  }

  clearStaticMetadata(): void {
    this.v2Static.clear();
    this.v3Static.clear();
  }

  private dedupe(hops: QuoteRequest[]): QuoteRequest[] {
    const seen = new Set<string>();
    const out: QuoteRequest[] = [];
    for (const hop of hops) {
      const key = poolUpdateKey(hop);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hop);
    }
    return out;
  }

  private async updateMutableState(
    blockNumber: number,
    v2Pools: QuoteRequest[],
    v3Pools: QuoteRequest[],
    v4Pools: QuoteRequest[],
  ): Promise<{
    v2Count: number;
    v3Count: number;
    v4Count: number;
    tickFetch: Array<{ pool: QuoteRequest; stat: StaticV3; tick: number }>;
  }> {
    const calls: BatchCall[] = [];
    for (const pool of v2Pools) {
      const key = pool.target.toLowerCase();
      if (!this.v2Static.has(key)) {
        calls.push({ target: pool.target, callData: v2Iface.encodeFunctionData("token0"), label: `${key}:token0` });
        calls.push({ target: pool.target, callData: v2Iface.encodeFunctionData("token1"), label: `${key}:token1` });
        calls.push({ target: pool.target, callData: v2Iface.encodeFunctionData("factory"), label: `${key}:factory` });
      }
      calls.push({ target: pool.target, callData: v2Iface.encodeFunctionData("getReserves"), label: `${key}:reserves` });
    }
    for (const pool of v3Pools) {
      const key = pool.target.toLowerCase();
      if (!this.v3Static.has(key)) {
        calls.push({ target: pool.target, callData: v3Iface.encodeFunctionData("token0"), label: `${key}:token0` });
        calls.push({ target: pool.target, callData: v3Iface.encodeFunctionData("token1"), label: `${key}:token1` });
        calls.push({ target: pool.target, callData: v3Iface.encodeFunctionData("fee"), label: `${key}:fee` });
        calls.push({ target: pool.target, callData: v3Iface.encodeFunctionData("tickSpacing"), label: `${key}:tickSpacing` });
      }
      calls.push({ target: pool.target, callData: v3Iface.encodeFunctionData("slot0"), label: `${key}:slot0` });
      calls.push({ target: pool.target, callData: v3Iface.encodeFunctionData("liquidity"), label: `${key}:liquidity` });
    }
    for (const pool of v4Pools) {
      const poolId = quoteV4PoolId(pool);
      if (!poolId) continue;
      calls.push({
        target: ADDR.UNISWAP_V4_STATE_VIEW,
        callData: v4StateViewIface.encodeFunctionData("getSlot0", [poolId]),
        label: `${poolId}:v4slot0`,
      });
      calls.push({
        target: ADDR.UNISWAP_V4_STATE_VIEW,
        callData: v4StateViewIface.encodeFunctionData("getLiquidity", [poolId]),
        label: `${poolId}:v4liquidity`,
      });
    }

    const results = await this.aggregate(blockNumber, calls);
    let v2Count = 0;
    for (const pool of v2Pools) {
      const key = pool.target.toLowerCase();
      let stat = this.v2Static.get(key);
      if (!stat) {
        const token0 = decodeAddress(results.get(`${key}:token0`), "token0");
        const token1 = decodeAddress(results.get(`${key}:token1`), "token1");
        if (!token0 || !token1) continue;
        const factory = decodeOptionalAddress(results.get(`${key}:factory`), "factory");
        stat = { token0, token1, feeBps: v2FeeBpsForFactory(factory) };
        this.v2Static.set(key, stat);
      }
      const reservesData = results.get(`${key}:reserves`);
      if (!reservesData) continue;
      const decoded = v2Iface.decodeFunctionResult("getReserves", reservesData);
      const seed: V2Seed = {
        pool: pool.target,
        token0: stat.token0,
        token1: stat.token1,
        reserve0: BigInt(decoded[0]),
        reserve1: BigInt(decoded[1]),
        feeBps: stat.feeBps,
        blockTimestampLast: Number(decoded[2]),
        blockNumber,
      };
      this.cache.seedV2(seed);
      v2Count++;
    }

    let v3Count = 0;
    const tickFetch: Array<{ pool: QuoteRequest; stat: StaticV3; tick: number }> = [];
    for (const pool of v3Pools) {
      const key = pool.target.toLowerCase();
      let stat = this.v3Static.get(key);
      if (!stat) {
        const token0 = decodeAddress(results.get(`${key}:token0`), "token0");
        const token1 = decodeAddress(results.get(`${key}:token1`), "token1");
        const feeData = results.get(`${key}:fee`);
        const spacingData = results.get(`${key}:tickSpacing`);
        if (!token0 || !token1 || !feeData || !spacingData) continue;
        stat = {
          token0,
          token1,
          fee: BigInt(v3Iface.decodeFunctionResult("fee", feeData)[0]),
          tickSpacing: Number(v3Iface.decodeFunctionResult("tickSpacing", spacingData)[0]),
        };
        this.v3Static.set(key, stat);
      }

      const slot0Data = results.get(`${key}:slot0`);
      const liquidityData = results.get(`${key}:liquidity`);
      if (!slot0Data || !liquidityData) continue;
      const slot0 = v3Iface.decodeFunctionResult("slot0", slot0Data);
      const live: V3LiveSeed = {
        pool: pool.target,
        sqrtPriceX96: BigInt(slot0[0]),
        tick: Number(slot0[1]),
        liquidity: BigInt(v3Iface.decodeFunctionResult("liquidity", liquidityData)[0]),
        observationIndex: Number(slot0[2]),
        observationCardinality: Number(slot0[3]),
        observationCardinalityNext: Number(slot0[4]),
        feeProtocol: Number(slot0[5]),
        unlocked: Boolean(slot0[6]),
        blockNumber,
      };
      this.cache.seedV3Live(live);
      if (!this.cache.v3TicksFresh(pool.target, blockNumber)) {
        tickFetch.push({ pool, stat, tick: live.tick });
      }
      v3Count++;
    }

    let v4Count = 0;
    for (const pool of v4Pools) {
      const poolId = quoteV4PoolId(pool);
      if (!poolId) continue;
      const slot0Data = results.get(`${poolId}:v4slot0`);
      const liquidityData = results.get(`${poolId}:v4liquidity`);
      if (!slot0Data || !liquidityData) continue;
      const slot0 = v4StateViewIface.decodeFunctionResult("getSlot0", slot0Data);
      const seed: V4Seed = {
        poolId,
        sqrtPriceX96: BigInt(slot0[0]),
        tick: Number(slot0[1]),
        protocolFee: BigInt(slot0[2]),
        lpFee: BigInt(slot0[3]),
        liquidity: BigInt(v4StateViewIface.decodeFunctionResult("getLiquidity", liquidityData)[0]),
        blockNumber,
      };
      this.cache.seedV4(seed);
      v4Count++;
    }
    return { v2Count, v3Count, v4Count, tickFetch };
  }

  private async updateV3Ticks(
    blockNumber: number,
    items: Array<{ pool: QuoteRequest; stat: StaticV3; tick: number }>,
  ): Promise<void> {
    if (items.length === 0) return;
    const calls: BatchCall[] = [];
    for (const item of items) {
      for (const word of v3WordRange(item.tick, item.stat.tickSpacing)) {
        calls.push({
          target: TICK_LENS,
          callData: tickLensIface.encodeFunctionData("getPopulatedTicksInWord", [item.pool.target, word]),
          label: `${item.pool.target.toLowerCase()}:tickword:${word}`,
        });
      }
    }
    const results = await this.aggregate(blockNumber, calls);
    for (const item of items) {
      const tickBitmap = new Map<number, bigint>();
      const ticks = new Map<number, bigint>();
      for (const word of v3WordRange(item.tick, item.stat.tickSpacing)) {
        const data = results.get(`${item.pool.target.toLowerCase()}:tickword:${word}`);
        if (!data) continue;
        const populated = tickLensIface.decodeFunctionResult(
          "getPopulatedTicksInWord",
          data,
        )[0] as Array<{ tick: bigint; liquidityNet: bigint }>;
        tickBitmap.set(word, tickBitmap.get(word) ?? 0n);
        for (const t of populated) {
          const tk = Number(t.tick);
          ticks.set(tk, BigInt(t.liquidityNet));
          const compressed = Math.floor(tk / item.stat.tickSpacing);
          const bitmapWord = compressed >> 8;
          const bit = ((compressed % 256) + 256) % 256;
          tickBitmap.set(bitmapWord, (tickBitmap.get(bitmapWord) ?? 0n) | (1n << BigInt(bit)));
        }
      }
      const seed: V3TicksSeed = {
        pool: item.pool.target,
        token0: item.stat.token0,
        token1: item.stat.token1,
        fee: item.stat.fee,
        tickSpacing: item.stat.tickSpacing,
        tickBitmap,
        ticks,
        blockNumber,
      };
      this.cache.seedV3Ticks(seed);
    }
  }

  private async refreshV3Ticks(
    blockNumber: number,
    items: Array<{ pool: QuoteRequest; stat: StaticV3; tick: number }>,
  ): Promise<void> {
    if (items.length === 0 || this.tickRefreshing) return;
    const started = Date.now();
    this.tickRefreshing = true;
    try {
      await this.updateV3Ticks(blockNumber, items);
      console.log(
        `[pool-updater] ticks block=${blockNumber} seeded=${items.length} ` +
          `${Date.now() - started}ms`,
      );
    } catch (err) {
      console.log(
        `[pool-updater] ticks error block=${blockNumber}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.tickRefreshing = false;
    }
  }

  private async aggregate(blockNumber: number, calls: BatchCall[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (calls.length === 0) return out;
    const data = multicallIface.encodeFunctionData("aggregate3", [
      calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: call.callData,
      })),
    ]);
    const result = await this.provider.call({ to: MULTICALL3, data, blockTag: blockNumber });
    const decoded = multicallIface.decodeFunctionResult("aggregate3", result)[0] as Array<{
      success: boolean;
      returnData: string;
    }>;
    for (let i = 0; i < calls.length; i++) {
      const res = decoded[i];
      if (res?.success && res.returnData && res.returnData !== "0x") {
        out.set(calls[i].label, res.returnData);
      }
    }
    return out;
  }
}

function quoteV4PoolId(hop: QuoteRequest): string | null {
  if (hop.adapterId !== "univ4-unlock" || !hop.v4PoolKey) return null;
  return v4PoolId(hop.v4PoolKey).toLowerCase();
}

function poolUpdateKey(hop: QuoteRequest): string {
  return `${hop.adapterId}:${quoteV4PoolId(hop) ?? hop.target.toLowerCase()}`;
}

function v3WordRange(tick: number, tickSpacing: number): number[] {
  const compressed = Math.floor(tick / tickSpacing);
  const currentWord = compressed >> 8;
  const words: number[] = [];
  for (let w = currentWord - V3_WORD_RADIUS; w <= currentWord + V3_WORD_RADIUS; w++) {
    words.push(w);
  }
  return words;
}

function decodeAddress(data: string | undefined, label: string): string | null {
  if (!data) return null;
  try {
    return ethers.getAddress("0x" + data.slice(-40));
  } catch {
    throw new Error(`bad address result for ${label}`);
  }
}

function decodeOptionalAddress(data: string | undefined, label: string): string | undefined {
  try {
    return decodeAddress(data, label) ?? undefined;
  } catch {
    return undefined;
  }
}
