import { ethers } from "ethers";
import { ADDR } from "../shared/constants/addresses.js";
import type { QuoteRequest } from "./live-state-backend.js";
import { v4PoolId, type TokenEdge } from "./planner/token-graph.js";
import type { PoolStateCache } from "./solver/pool-state-cache.js";
import type { PoolStateUpdater } from "./solver/pool-state-updater.js";

const V2_SYNC_TOPIC = ethers.id("Sync(uint112,uint112)");
const V3_SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V3_MINT_TOPIC = ethers.id("Mint(address,address,int24,int24,uint128,uint256,uint256)");
const V3_BURN_TOPIC = ethers.id("Burn(address,int24,int24,uint128,uint256,uint256)");
const PANCAKE_V3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
);
const V4_SWAP_TOPIC = ethers.id(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);
const BALANCER_V3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,address,uint256,uint256,uint256,uint256)",
);
const V4_MODIFY_LIQUIDITY_TOPIC = ethers.id(
  "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
);
const CURVE_N_COINS = [2, 3, 4, 5, 6, 7, 8] as const;
const CURVE_STATIC_LIQUIDITY_TOPICS = CURVE_N_COINS.flatMap((n) => [
  ethers.id(`AddLiquidity(address,uint256[${n}],uint256[${n}],uint256,uint256)`),
  ethers.id(`RemoveLiquidity(address,uint256[${n}],uint256[${n}],uint256)`),
  ethers.id(`RemoveLiquidityImbalance(address,uint256[${n}],uint256[${n}],uint256,uint256)`),
]);
const CURVE_EVENT_TOPICS = [
  ethers.id("TokenExchange(address,int128,uint256,int128,uint256)"),
  ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256)"),
  ethers.id("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"),
  ethers.id("TokenExchangeUnderlying(address,uint256,uint256,uint256,uint256)"),
  ethers.id("AddLiquidity(address,uint256[],uint256[],uint256,uint256)"),
  ethers.id("RemoveLiquidity(address,uint256[],uint256[],uint256)"),
  ethers.id("RemoveLiquidityImbalance(address,uint256[],uint256[],uint256,uint256)"),
  ethers.id("RemoveLiquidityOne(address,uint256,uint256)"),
  ethers.id("RemoveLiquidityOne(address,uint256,uint256,uint256)"),
  ethers.id("RemoveLiquidityOne(address,int128,uint256,uint256,uint256)"),
  ethers.id("RemoveLiquidityOne(address,uint256,uint256,uint256,uint256)"),
  ethers.id("RampA(uint256,uint256,uint256,uint256)"),
  ethers.id("StopRampA(uint256,uint256)"),
  ethers.id("ApplyNewFee(uint256,uint256)"),
  ethers.id("NewFee(uint256,uint256)"),
  ethers.id("SetNewMATime(uint256,uint256)"),
  ...CURVE_STATIC_LIQUIDITY_TOPICS,
];
const WARM_EVENT_TOPICS = [
  V2_SYNC_TOPIC,
  V3_SWAP_TOPIC,
  V3_MINT_TOPIC,
  V3_BURN_TOPIC,
  PANCAKE_V3_SWAP_TOPIC,
  V4_SWAP_TOPIC,
  V4_MODIFY_LIQUIDITY_TOPIC,
  BALANCER_V3_SWAP_TOPIC,
  ...CURVE_EVENT_TOPICS,
];

const MAX_INCREMENTAL_RANGE_BLOCKS = 32;

type WarmCache = Pick<
  PoolStateCache,
  "hasV2" | "hasV3Live" | "hasV4" | "hasCurve" | "curveKind"
>;
type WarmUpdater = Pick<PoolStateUpdater, "hasStaticMetadata">;

export type BlockScanFullWarmReason = "startup" | "logs_error" | "reorg" | "interval" | "range";

export interface BlockScanChangedPools {
  fromBlock: number;
  toBlock: number;
  logs: number;
  hops: QuoteRequest[];
  pools: Set<string>;
  v4PoolIds: Set<string>;
  curvePools: Set<string>;
}

export type BlockScanWarmPlan =
  | { kind: "full"; reason: BlockScanFullWarmReason; error?: string }
  | { kind: "incremental"; changed: BlockScanChangedPools };

export class BlockScanWarmCoordinator {
  private lastWarmedBlock: number | null = null;
  private lastFullWarmBlock: number | null = null;

  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly cache: WarmCache,
    private readonly updater: WarmUpdater,
    private readonly fullRewarmBlocks: number,
  ) {}

  async plan(
    blockNumber: number,
    hops: QuoteRequest[],
    edges: TokenEdge[],
  ): Promise<BlockScanWarmPlan> {
    if (this.lastWarmedBlock === null) return { kind: "full", reason: "startup" };
    if (blockNumber <= this.lastWarmedBlock) return { kind: "full", reason: "reorg" };
    if (blockNumber - this.lastWarmedBlock > MAX_INCREMENTAL_RANGE_BLOCKS) {
      return { kind: "full", reason: "range" };
    }
    if (
      this.lastFullWarmBlock !== null &&
      blockNumber - this.lastFullWarmBlock >= this.fullRewarmBlocks
    ) {
      return { kind: "full", reason: "interval" };
    }

    try {
      const changed = await detectChangedPools(
        this.provider,
        this.cache,
        this.updater,
        this.lastWarmedBlock + 1,
        blockNumber,
        hops,
        uniqueCurvePools(edges),
      );
      return { kind: "incremental", changed };
    } catch (err) {
      return {
        kind: "full",
        reason: "logs_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  markV2V3WarmComplete(blockNumber: number, plan: BlockScanWarmPlan): void {
    this.lastWarmedBlock = blockNumber;
    if (plan.kind === "full") this.lastFullWarmBlock = blockNumber;
  }
}

export function formatBlockScanWarmPlan(plan: BlockScanWarmPlan): string {
  if (plan.kind === "full") {
    const suffix = plan.error ? ` error=${formatError(plan.error)}` : "";
    return `warm=full reason=${plan.reason}${suffix}`;
  }
  return `warm=incremental changed=${plan.changed.pools.size} ` +
    `changedV4=${plan.changed.v4PoolIds.size} ` +
    `changedCurve=${plan.changed.curvePools.size} ` +
    `range=${plan.changed.fromBlock}-${plan.changed.toBlock} logs=${plan.changed.logs}`;
}

export function blockScanMutableQuoteRequests(hops: QuoteRequest[]): QuoteRequest[] {
  const seen = new Set<string>();
  const out: QuoteRequest[] = [];
  for (const hop of hops) {
    if (
      hop.adapterId !== "univ2-swap" &&
      hop.adapterId !== "univ3-swap" &&
      hop.adapterId !== "univ4-unlock"
    ) continue;
    const key = warmKey(hop);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hop);
  }
  return out;
}

export function blockScanV4PoolId(hop: QuoteRequest): string | null {
  if (hop.adapterId !== "univ4-unlock" || !hop.v4PoolKey) return null;
  return v4PoolId(hop.v4PoolKey).toLowerCase();
}

async function detectChangedPools(
  provider: ethers.JsonRpcProvider,
  cache: WarmCache,
  updater: WarmUpdater,
  fromBlock: number,
  toBlock: number,
  hops: QuoteRequest[],
  curvePoolEdges: TokenEdge[],
): Promise<BlockScanChangedPools> {
  const mutableHops = blockScanMutableQuoteRequests(hops);
  const byAddress = new Map<string, QuoteRequest[]>();
  const byV4PoolId = new Map<string, QuoteRequest[]>();
  for (const hop of mutableHops) {
    const poolId = blockScanV4PoolId(hop);
    if (poolId) {
      const existing = byV4PoolId.get(poolId);
      if (existing) existing.push(hop);
      else byV4PoolId.set(poolId, [hop]);
      continue;
    }
    const key = hop.target.toLowerCase();
    const existing = byAddress.get(key);
    if (existing) existing.push(hop);
    else byAddress.set(key, [hop]);
  }
  const curvePoolKeys = new Set(curvePoolEdges.map((edge) => edge.target.toLowerCase()));
  const logs = await provider.getLogs({
    fromBlock,
    toBlock,
    topics: [WARM_EVENT_TOPICS],
  });

  const changedKeys = new Set<string>();
  const changedPools = new Set<string>();
  const changedV4PoolIds = new Set<string>();
  const changedCurvePools = new Set<string>();
  const markChanged = (hop: QuoteRequest): void => {
    const pool = hop.target.toLowerCase();
    changedPools.add(pool);
    for (const candidate of byAddress.get(pool) ?? [hop]) changedKeys.add(warmKey(candidate));
  };

  for (const log of logs) {
    const pool = log.address.toLowerCase();
    const topic0 = log.topics[0]?.toLowerCase();
    if (
      pool === ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase() &&
      (topic0 === V4_SWAP_TOPIC || topic0 === V4_MODIFY_LIQUIDITY_TOPIC)
    ) {
      const poolId = log.topics[1]?.toLowerCase();
      if (poolId) {
        changedV4PoolIds.add(poolId);
        for (const hop of byV4PoolId.get(poolId) ?? []) markChanged(hop);
      }
    }
    if (
      pool === ADDR.BALANCER_V3_VAULT.toLowerCase() &&
      topic0 === BALANCER_V3_SWAP_TOPIC
    ) {
      const indexedPool = log.topics[1];
      if (indexedPool) {
        try {
          changedPools.add(ethers.getAddress(`0x${indexedPool.slice(-40)}`).toLowerCase());
        } catch { /* malformed indexed pool */ }
      }
    }
    for (const hop of byAddress.get(pool) ?? []) markChanged(hop);
    if (curvePoolKeys.has(pool)) changedCurvePools.add(pool);
  }

  for (const hop of mutableHops) {
    if (!hasWarmState(cache, updater, hop)) markChanged(hop);
  }
  for (const edge of curvePoolEdges) {
    const pool = edge.target.toLowerCase();
    if (!cache.hasCurve(pool) || cache.curveKind(pool) === "ng") changedCurvePools.add(pool);
  }

  return {
    fromBlock,
    toBlock,
    logs: logs.length,
    hops: mutableHops.filter((hop) => changedKeys.has(warmKey(hop))),
    pools: changedPools,
    v4PoolIds: changedV4PoolIds,
    curvePools: changedCurvePools,
  };
}

function warmKey(hop: QuoteRequest): string {
  return `${hop.adapterId}:${blockScanV4PoolId(hop) ?? hop.target.toLowerCase()}`;
}

function hasWarmState(
  cache: WarmCache,
  updater: WarmUpdater,
  hop: QuoteRequest,
): boolean {
  if (hop.adapterId === "univ2-swap") {
    return cache.hasV2(hop.target) && updater.hasStaticMetadata(hop.adapterId, hop.target);
  }
  if (hop.adapterId === "univ3-swap") {
    return cache.hasV3Live(hop.target) && updater.hasStaticMetadata(hop.adapterId, hop.target);
  }
  if (hop.adapterId === "univ4-unlock") {
    const poolId = blockScanV4PoolId(hop);
    return poolId !== null && cache.hasV4(poolId);
  }
  return true;
}

function uniqueCurvePools(edges: TokenEdge[]): TokenEdge[] {
  const seen = new Set<string>();
  const out: TokenEdge[] = [];
  for (const edge of edges) {
    if (edge.slotKind !== "swap" || !isCurveAdapter(edge.adapterId)) continue;
    const key = edge.target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

function isCurveAdapter(adapterId: string): boolean {
  return adapterId === "curve-exchange" ||
    adapterId === "curve-exchange-nr" ||
    adapterId === "curve-exchange-plain" ||
    adapterId === "curve-exchange-received-uint";
}

function formatError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
}
