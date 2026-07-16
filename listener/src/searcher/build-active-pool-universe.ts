import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import { selectArbRelevantPools, type RankablePool } from "./pool-universe-arb-relevance.js";
import { DEFAULT_POOL_UNIVERSE_PATH, type PoolUniverseEntry, type PoolUniverseFile } from "./pool-universe.js";
import { ADDR } from "../shared/constants/addresses.js";
import { resolvePoolIdentity } from "./venues/identity.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "./venues/admission.js";
import { resolveCurveUnderlyingMetadata } from "./venues/curve-underlying.js";

const BLOCKS_PER_DAY = 7200;
export const DEFAULT_POOL_UNIVERSE_MIN_SWAPS = 1;

const SWAP_TOPICS: Array<{ topic: string; adapter: PoolEntry["adapter"]; label: string }> = [
  {
    topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
    adapter: "univ3",
    label: "univ3",
  },
  {
    // The distinct topic only discovers a candidate shape; factory identity remains recorded.
    topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
    adapter: "univ3",
    label: "pancake-v3",
  },
  {
    topic: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"),
    adapter: "univ2",
    label: "univ2",
  },
  {
    topic: ethers.id("TokenExchange(address,int128,uint256,int128,uint256)"),
    adapter: "curve",
    label: "curve-i128",
  },
  {
    topic: ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256)"),
    adapter: "curve",
    label: "curve-uint",
  },
  {
    topic: ethers.id("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"),
    adapter: "curve-underlying",
    label: "curve-underlying",
  },
];

const univ2Iface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);
const univ3Iface = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);
const v4InitializeIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const V4_INITIALIZE_TOPIC = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const V4_SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
export const BALANCER_V3_SWAP_TOPIC = ethers.id(
  "Swap(address,address,address,uint256,uint256,uint256,uint256)",
);
const V4_POSITION_MANAGER_POOL_KEYS_SELECTOR = "0x86b6be7d";

interface DiscoveryQueueEntry {
  addr?: unknown;
  class?: unknown;
  source?: unknown;
}

type ProbedPoolShape =
  | {
      adapter: "univ3";
      token0: string;
      token1: string;
      fee: number;
      tickSpacing: number;
      venueId: PoolUniverseEntry["venueId"];
      factory: string;
      identitySource: PoolUniverseEntry["identitySource"];
    }
  | {
      adapter: "univ2";
      token0: string;
      token1: string;
      venueId: PoolUniverseEntry["venueId"];
      factory: string;
      identitySource: PoolUniverseEntry["identitySource"];
    };

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

export function buildBalancerV3PoolEntries(
  logs: RawLog[],
  minSwaps: number,
): PoolUniverseEntry[] {
  const pools = new Map<string, PoolUniverseEntry>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== ADDR.BALANCER_V3_VAULT.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() !== BALANCER_V3_SWAP_TOPIC.toLowerCase()) continue;
    const poolTopic = log.topics[1];
    const tokenInTopic = log.topics[2];
    const tokenOutTopic = log.topics[3];
    if (!poolTopic || !tokenInTopic || !tokenOutTopic) continue;
    try {
      const address = ethers.getAddress(`0x${poolTopic.slice(-40)}`);
      const tokenIn = ethers.getAddress(`0x${tokenInTopic.slice(-40)}`);
      const tokenOut = ethers.getAddress(`0x${tokenOutTopic.slice(-40)}`);
      const key = address.toLowerCase();
      const current = pools.get(key);
      if (current) {
        current.score = (current.score ?? 0) + 1;
        current.swapCount30d = (current.swapCount30d ?? 0) + 1;
        current.lastSwapBlock = Math.max(current.lastSwapBlock ?? 0, parseInt(log.blockNumber, 16));
      } else {
        pools.set(key, {
          address,
          adapter: "balancer-v3",
          venueId: "balancer-v3",
          identitySource: "balancer-v3-vault",
          token0: tokenIn,
          token1: tokenOut,
          score: 1,
          swapCount30d: 1,
          lastSwapBlock: parseInt(log.blockNumber, 16),
          source: "balancer-v3-vault-swap",
        });
      }
    } catch { /* malformed indexed address */ }
  }
  return [...pools.values()]
    .filter((pool) => (pool.swapCount30d ?? 0) >= minSwaps)
    .sort((a, b) => (b.swapCount30d ?? 0) - (a.swapCount30d ?? 0));
}

interface PoolActivity {
  address: string;
  adapterCounts: Map<PoolEntry["adapter"], number>;
  count: number;
  lastSwapBlock: number;
}

interface EnrichedRankablePool extends RankablePool {
  pool: PoolUniverseEntry;
}

export type V4InitializeSource =
  | "alchemy-v4-initialize"
  | "v4-initialize-backfill"
  | "v4-positionmanager-poolkeys";

export interface ParsedV4Initialize {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  source?: V4InitializeSource;
}

function loadEnv(): void {
  const envPath = resolve("..", ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const latest = Number(process.env.POOL_UNIVERSE_TO_BLOCK ?? await provider.getBlockNumber());
  const stateProvider = pinProviderCallsToBlock(provider, latest);
  const lookbackBlocks = Number(
    process.env.POOL_UNIVERSE_LOOKBACK_BLOCKS ??
      String(Number(process.env.POOL_UNIVERSE_LOOKBACK_DAYS ?? "30") * BLOCKS_PER_DAY),
  );
  const fromBlock = Math.max(0, Number(process.env.POOL_UNIVERSE_FROM_BLOCK ?? latest - lookbackBlocks));
  // No index cap by default (0/unset = Infinity): the arb-relevance ranker only *orders* pools
  // (loop-completers first), so a hard cap silently drops real venues whose tokens look low-degree
  // in isolation but DO close loops on-chain (e.g. coffee's low-volume pools). Set the env to re-cap.
  const maxPools = Number(process.env.POOL_UNIVERSE_MAX_POOLS ?? "0") || Infinity;
  const minSwaps = Number(
    process.env.POOL_UNIVERSE_MIN_SWAPS ?? String(DEFAULT_POOL_UNIVERSE_MIN_SWAPS),
  );
  const logBatch = Number(process.env.POOL_UNIVERSE_LOG_BATCH ?? "1000");
  const metadataConcurrency = Number(process.env.POOL_UNIVERSE_METADATA_CONCURRENCY ?? "24");
  const arbRelevance = process.env.POOL_UNIVERSE_ARB_RELEVANCE !== "0";
  const relevanceOversampleRaw = Number(process.env.POOL_UNIVERSE_RELEVANCE_OVERSAMPLE ?? "2");
  const relevanceOversample = Number.isFinite(relevanceOversampleRaw)
    ? Math.max(1, Math.floor(relevanceOversampleRaw))
    : 1;
  const outPath = process.env.POOL_UNIVERSE_OUT ?? DEFAULT_POOL_UNIVERSE_PATH;

  console.log(
    `[pool-universe] scanning active pools from ${fromBlock} to ${latest} ` +
      `(blocks=${latest - fromBlock}, batch=${logBatch})`,
  );

  const activity = new Map<string, PoolActivity>();
  for (const { topic, adapter, label } of SWAP_TOPICS) {
    let topicLogs = 0;
    for (let start = fromBlock; start <= latest; start += logBatch) {
      const end = Math.min(start + logBatch - 1, latest);
      const logs = await getLogsWithSplitRetry(provider, topic, start, end);
      topicLogs += logs.length;
      for (const log of logs) {
        const address = ethers.getAddress(log.address);
        const key = address.toLowerCase();
        const block = parseInt(log.blockNumber, 16);
        let item = activity.get(key);
        if (!item) {
          item = { address, adapterCounts: new Map(), count: 0, lastSwapBlock: 0 };
          activity.set(key, item);
        }
        item.count++;
        item.lastSwapBlock = Math.max(item.lastSwapBlock, block);
        item.adapterCounts.set(adapter, (item.adapterCounts.get(adapter) ?? 0) + 1);
      }
    }
    console.log(`[pool-universe] ${label}: ${topicLogs} swap logs`);
  }

  const v4InitLogs: RawLog[] = [];
  for (let start = fromBlock; start <= latest; start += logBatch) {
    const end = Math.min(start + logBatch - 1, latest);
    v4InitLogs.push(...await getLogsWithSplitRetry(
      stateProvider,
      V4_INITIALIZE_TOPIC,
      start,
      end,
      ADDR.UNISWAP_V4_POOL_MANAGER,
    ));
  }
  const v4SwapLogs: RawLog[] = [];
  for (let start = fromBlock; start <= latest; start += logBatch) {
    const end = Math.min(start + logBatch - 1, latest);
    v4SwapLogs.push(...await getLogsWithSplitRetry(
      provider,
      V4_SWAP_TOPIC,
      start,
      end,
      ADDR.UNISWAP_V4_POOL_MANAGER,
    ));
  }
  const v4Pools = await buildV4PoolEntries(v4InitLogs, v4SwapLogs, minSwaps, async (poolId) => {
    return resolveV4InitViaPositionManagerThenBackward(
      stateProvider,
      ADDR.UNISWAP_V4_POSITION_MANAGER,
      ADDR.UNISWAP_V4_POOL_MANAGER,
      V4_INITIALIZE_TOPIC,
      poolId,
      fromBlock,
    );
  });
  console.log(`[pool-universe] univ4: ${v4InitLogs.length} Initialize events, ${v4Pools.length} above minSwaps`);

  const balancerV3Logs: RawLog[] = [];
  for (let start = fromBlock; start <= latest; start += logBatch) {
    const end = Math.min(start + logBatch - 1, latest);
    balancerV3Logs.push(...await getLogsWithSplitRetry(
      provider,
      BALANCER_V3_SWAP_TOPIC,
      start,
      end,
      ADDR.BALANCER_V3_VAULT,
    ));
  }
  const balancerV3Pools = buildBalancerV3PoolEntries(balancerV3Logs, minSwaps);
  console.log(
    `[pool-universe] balancer-v3: ${balancerV3Logs.length} Swap events, ` +
      `${balancerV3Pools.length} pools above minSwaps`,
  );

  const countRanked = [...activity.values()]
    .filter((pool) => pool.count >= minSwaps)
    .sort((a, b) => b.count - a.count || b.lastSwapBlock - a.lastSwapBlock);
  console.log(
    `[pool-universe] active pools=${activity.size}, ` +
      `after minSwaps=${countRanked.length}, maxPools=${maxPools}`,
  );

  const oversampleN = arbRelevance
    ? Math.min(countRanked.length, maxPools * relevanceOversample)
    : maxPools;
  const poolsToEnrich = countRanked.slice(0, oversampleN);
  const enriched = await mapLimit(poolsToEnrich, metadataConcurrency, async (pool, idx) => {
    if ((idx + 1) % 250 === 0) {
      console.log(`[pool-universe] metadata ${idx + 1}/${poolsToEnrich.length}`);
    }
    return enrichPool(stateProvider, pool);
  });
  const enrichedCandidates: EnrichedRankablePool[] = [];
  for (let i = 0; i < enriched.length; i++) {
    const pool = enriched[i];
    if (pool === null) continue;
    const activityPool = poolsToEnrich[i];
    enrichedCandidates.push({
      key: activityPool.address.toLowerCase(),
      token0: pool.token0,
      token1: pool.token1,
      tokens: pool.underlyingCoins,
      count: activityPool.count,
      lastSwapBlock: activityPool.lastSwapBlock,
      pool,
    });
  }
  const v4TokenPools = v4Pools.map(v4TokenPool);
  const ranked = arbRelevance
    ? selectArbRelevantPools(enrichedCandidates, v4TokenPools, { enabled: true, maxPools })
    : enrichedCandidates.slice(0, maxPools);
  const loopCompleters = countLoopCompleters(ranked, enrichedCandidates, v4TokenPools);
  console.log(
    `[pool-universe] arb-relevance: enabled=${arbRelevance} oversample=${relevanceOversample} ` +
      `loopCompleters=${loopCompleters}/${ranked.length}`,
  );
  const validPools = ranked.map((item) => item.pool);
  const tokenSet = new Set<string>();
  for (const pool of validPools) {
    if (pool.token0) tokenSet.add(pool.token0.toLowerCase());
    if (pool.token1) tokenSet.add(pool.token1.toLowerCase());
    for (const token of pool.underlyingCoins ?? []) tokenSet.add(token.toLowerCase());
  }
  for (const pool of balancerV3Pools) {
    if (pool.token0) tokenSet.add(pool.token0.toLowerCase());
    if (pool.token1) tokenSet.add(pool.token1.toLowerCase());
  }
  const discoveryQueuePath = resolve("searcher", "pools", "discovery-queue.json");
  const { included, blocked } = await consumeDiscoveryQueue(stateProvider, discoveryQueuePath, tokenSet);
  const poolByAddress = new Map<string, PoolUniverseEntry>();
  for (const pool of validPools) {
    poolByAddress.set(pool.address.toLowerCase(), pool);
  }
  for (const pool of balancerV3Pools) {
    poolByAddress.set(pool.address.toLowerCase(), pool);
  }
  for (const pool of included) {
    const key = pool.address.toLowerCase();
    if (!poolByAddress.has(key)) poolByAddress.set(key, pool);
  }
  if (existsSync(discoveryQueuePath)) {
    console.log(`[pool-universe] discovery-queue: +${included.length} included, ${blocked.length} blocked`);
    for (const item of blocked) {
      console.log(`[pool-universe] discovery-queue blocked ${item.addr}: ${item.reason}`);
    }
  }
  const file: PoolUniverseFile = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    fromBlock,
    toBlock: latest,
    pools: [...poolByAddress.values(), ...dedupeV4ByPoolId(v4Pools)],
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n");
  console.log(`[pool-universe] wrote ${file.pools.length} pools to ${outPath}`);
}

/**
 * Keep metadata attestation on the same state block as the frozen log window.
 * JsonRpcProvider.call() and the one raw eth_call path are both covered; all
 * other methods stay bound to the original provider so its private fields are
 * never invoked with the Proxy as `this`.
 */
export function pinProviderCallsToBlock(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): ethers.JsonRpcProvider {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error("pool-universe metadata block must be a non-negative safe integer");
  }
  const blockTag = ethers.toQuantity(blockNumber);
  return new Proxy(provider, {
    get(target, property) {
      if (property === "call") {
        return (request: ethers.TransactionRequest) => target.call({
          ...request,
          blockTag,
        });
      }
      if (property === "send") {
        return (method: string, params: unknown[]) => {
          if (method === "eth_call") {
            const pinned = [...params];
            pinned[1] = blockTag;
            return target.send(method, pinned);
          }
          return target.send(method, params);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function getLogsWithSplitRetry(
  provider: ethers.JsonRpcProvider,
  topic: string,
  fromBlock: number,
  toBlock: number,
  address?: string,
): Promise<RawLog[]> {
  try {
    const filter: {
      fromBlock: string;
      toBlock: string;
      topics: string[];
      address?: string;
    } = {
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: [topic],
    };
    if (address) filter.address = address;
    return await provider.send("eth_getLogs", [filter]);
  } catch {
    if (fromBlock >= toBlock) return [];
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsWithSplitRetry(provider, topic, fromBlock, mid, address);
    const right = await getLogsWithSplitRetry(provider, topic, mid + 1, toBlock, address);
    return [...left, ...right];
  }
}

export async function resolveV4InitBackward(
  provider: ethers.JsonRpcProvider,
  poolManagerAddr: string,
  topic: string,
  poolId: string,
  searchFromBlock: number,
  chunkSize = 100_000,
): Promise<RawLog | null> {
  const configuredLookback = Number(process.env.POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS ?? "2000000");
  const maxLookbackBlocks = Number.isFinite(configuredLookback)
    ? Math.max(0, Math.floor(configuredLookback))
    : 2_000_000;
  const normalizedChunkSize = Number.isFinite(chunkSize)
    ? Math.max(1, Math.floor(chunkSize))
    : 100_000;
  let remaining = maxLookbackBlocks;
  let chunkEnd = Math.max(0, Math.floor(searchFromBlock));

  while (remaining > 0 && chunkEnd >= 0) {
    const blockCount = Math.min(normalizedChunkSize, remaining, chunkEnd + 1);
    const chunkStart = chunkEnd - blockCount + 1;
    const filter = {
      address: poolManagerAddr,
      topics: [topic, poolId],
      fromBlock: "0x" + chunkStart.toString(16),
      toBlock: "0x" + chunkEnd.toString(16),
    };

    try {
      const logs = await provider.send("eth_getLogs", [filter]);
      if (Array.isArray(logs) && logs.length > 0) return logs[0] as RawLog;
    } catch (err) {
      if (isPrunedHistoryError(err)) return null;
      try {
        const logs = await provider.send("eth_getLogs", [filter]);
        if (Array.isArray(logs) && logs.length > 0) return logs[0] as RawLog;
      } catch (retryErr) {
        if (isPrunedHistoryError(retryErr)) return null;
        console.warn(
          `[pool-universe] v4 initialize backfill failed for ${poolId} ` +
            `blocks ${chunkStart}-${chunkEnd}: ${rpcErrorMessage(retryErr)}`,
        );
      }
    }

    remaining -= blockCount;
    chunkEnd = chunkStart - 1;
  }

  return null;
}

export async function resolveV4PoolKeyViaPositionManager(
  provider: ethers.JsonRpcProvider,
  positionManagerAddr: string,
  poolId: string,
): Promise<ParsedV4Initialize | null> {
  const normalizedPoolId = normalizeBytes32Topic(poolId, "poolId");
  const poolIdPrefix = normalizedPoolId.slice(2, 52);
  const data = V4_POSITION_MANAGER_POOL_KEYS_SELECTOR + poolIdPrefix.padEnd(64, "0");

  try {
    const result = await provider.send("eth_call", [
      { to: ethers.getAddress(positionManagerAddr), data },
      "latest",
    ]);
    const [decodedCurrency0, decodedCurrency1, decodedFee, decodedTickSpacing, decodedHooks] =
      ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "address", "uint24", "int24", "address"],
        String(result),
      );
    const parsed: ParsedV4Initialize = {
      poolId: normalizedPoolId,
      currency0: ethers.getAddress(String(decodedCurrency0)),
      currency1: ethers.getAddress(String(decodedCurrency1)),
      fee: Number(decodedFee),
      tickSpacing: Number(decodedTickSpacing),
      hooks: ethers.getAddress(String(decodedHooks)),
    };
    const recomputed = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "int24", "address"],
        [parsed.currency0, parsed.currency1, parsed.fee, parsed.tickSpacing, parsed.hooks],
      ),
    );
    return recomputed.toLowerCase() === normalizedPoolId ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveV4InitViaPositionManagerThenBackward(
  provider: ethers.JsonRpcProvider,
  positionManagerAddr: string,
  poolManagerAddr: string,
  topic: string,
  poolId: string,
  searchFromBlock: number,
  chunkSize = 100_000,
): Promise<ParsedV4Initialize | null> {
  const viaPositionManager = await resolveV4PoolKeyViaPositionManager(provider, positionManagerAddr, poolId);
  if (viaPositionManager) {
    return { ...viaPositionManager, source: "v4-positionmanager-poolkeys" };
  }

  const log = await resolveV4InitBackward(provider, poolManagerAddr, topic, poolId, searchFromBlock, chunkSize);
  return log ? { ...parseV4InitializeLog(log), source: "v4-initialize-backfill" } : null;
}

function isPrunedHistoryError(err: unknown): boolean {
  return /pruned|not available/i.test(rpcErrorMessage(err));
}

function rpcErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const serialized = serializeRpcError(err);
    return serialized ? `${err.message} ${serialized}` : err.message;
  }
  const serialized = serializeRpcError(err);
  return serialized || String(err);
}

function serializeRpcError(err: unknown): string {
  try {
    return JSON.stringify(err);
  } catch {
    return "";
  }
}

export async function buildV4PoolEntries(
  initLogs: RawLog[],
  swapLogs: RawLog[],
  minSwaps: number,
  resolveMissingInit?: (poolId: string) => Promise<ParsedV4Initialize | null>,
): Promise<PoolUniverseEntry[]> {
  const activity = new Map<string, { count: number; lastSwapBlock: number }>();
  for (const log of swapLogs) {
    const poolId = normalizeBytes32Topic(log.topics[1], "Swap.id");
    const block = parseLogBlockNumber(log.blockNumber);
    const item = activity.get(poolId) ?? { count: 0, lastSwapBlock: 0 };
    item.count++;
    item.lastSwapBlock = Math.max(item.lastSwapBlock, block);
    activity.set(poolId, item);
  }

  const initByPoolId = new Map<string, ParsedV4Initialize>();
  for (const log of initLogs) {
    const parsed = parseV4InitializeLog(log);
    initByPoolId.set(parsed.poolId, parsed);
  }

  const qualifying = [...activity.entries()]
    .filter(([, item]) => item.count >= minSwaps);
  const resolved = new Map<string, { parsed: ParsedV4Initialize; source: string }>();
  for (const [poolId] of qualifying) {
    const parsed = initByPoolId.get(poolId);
    if (parsed) resolved.set(poolId, { parsed, source: "alchemy-v4-initialize" });
  }

  if (resolveMissingInit) {
    const missing = qualifying
      .map(([poolId]) => poolId)
      .filter((poolId) => !resolved.has(poolId));
    const backfilled = await mapLimit(missing, 24, async (poolId) => {
      const parsed = await resolveMissingInit(poolId);
      return parsed ? { poolId, parsed } : null;
    });
    for (const item of backfilled) {
      if (item) {
        resolved.set(item.poolId, {
          parsed: item.parsed,
          source: item.parsed.source ?? "v4-initialize-backfill",
        });
      }
    }
  }

  const entries: PoolUniverseEntry[] = [];
  for (const [poolId, item] of qualifying) {
    const init = resolved.get(poolId);
    if (!init) continue;
    entries.push(v4PoolEntryFromInitialize(init.parsed, item, init.source));
  }

  return entries.sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.lastSwapBlock ?? 0) - (a.lastSwapBlock ?? 0)
  );
}

function parseV4InitializeLog(log: RawLog): ParsedV4Initialize {
  const parsed = v4InitializeIface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) throw new Error("failed to parse univ4 Initialize log");
  return {
    poolId: normalizeBytes32Topic(String(parsed.args.id), "Initialize.id"),
    currency0: ethers.getAddress(String(parsed.args.currency0)),
    currency1: ethers.getAddress(String(parsed.args.currency1)),
    fee: Number(parsed.args.fee),
    tickSpacing: Number(parsed.args.tickSpacing),
    hooks: ethers.getAddress(String(parsed.args.hooks)),
  };
}

function v4PoolEntryFromInitialize(
  parsed: ParsedV4Initialize,
  activity: { count: number; lastSwapBlock: number },
  source: string,
): PoolUniverseEntry {
  return {
    address: ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER),
    adapter: "univ4",
    venueId: "univ4",
    identitySource: "v4-manager",
    poolId: parsed.poolId,
    currency0: parsed.currency0,
    currency1: parsed.currency1,
    fee: parsed.fee,
    tickSpacing: parsed.tickSpacing,
    hooks: parsed.hooks,
    fixedTokenIn: parsed.currency0,
    fixedTokenOut: parsed.currency1,
    score: activity.count,
    swapCount30d: activity.count,
    lastSwapBlock: activity.lastSwapBlock,
    source,
  };
}

function dedupeV4ByPoolId(pools: PoolUniverseEntry[]): PoolUniverseEntry[] {
  const byPoolId = new Map<string, PoolUniverseEntry>();
  for (const pool of pools) {
    if (!pool.poolId) continue;
    const key = pool.poolId.toLowerCase();
    const existing = byPoolId.get(key);
    if (
      !existing ||
      (pool.score ?? 0) > (existing.score ?? 0) ||
      ((pool.score ?? 0) === (existing.score ?? 0) && (pool.lastSwapBlock ?? 0) > (existing.lastSwapBlock ?? 0))
    ) {
      byPoolId.set(key, pool);
    }
  }
  return [...byPoolId.values()].sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.lastSwapBlock ?? 0) - (a.lastSwapBlock ?? 0)
  );
}

function v4TokenPool(pool: PoolUniverseEntry): { token0?: string; token1?: string; tokens?: string[] } {
  return {
    token0: pool.token0 ?? pool.currency0,
    token1: pool.token1 ?? pool.currency1,
  };
}

function countLoopCompleters(
  selected: EnrichedRankablePool[],
  candidates: EnrichedRankablePool[],
  externalTokenPools: Array<{ token0?: string; token1?: string; tokens?: string[] }>,
): number {
  const tokenDegree = new Map<string, number>();
  const seenCandidates = new Set<string>();
  for (const pool of candidates) {
    const key = pool.key.toLowerCase();
    if (seenCandidates.has(key)) continue;
    seenCandidates.add(key);
    addTokenDegree(tokenDegree, pool);
  }
  for (const pool of externalTokenPools) {
    addTokenDegree(tokenDegree, pool);
  }

  return selected.filter((pool) => {
    const tokens = poolTokens(pool);
    return tokens.filter((token) => (tokenDegree.get(token) ?? 0) >= 2).length >= 2;
  }).length;
}

function addTokenDegree(
  tokenDegree: Map<string, number>,
  pool: { token0?: string; token1?: string; tokens?: string[] },
): void {
  for (const token of poolTokens(pool)) {
    tokenDegree.set(token, (tokenDegree.get(token) ?? 0) + 1);
  }
}

function poolTokens(pool: { token0?: string; token1?: string; tokens?: string[] }): string[] {
  const tokens = new Set<string>();
  if (pool.token0) tokens.add(pool.token0.toLowerCase());
  if (pool.token1) tokens.add(pool.token1.toLowerCase());
  for (const token of pool.tokens ?? []) tokens.add(token.toLowerCase());
  return [...tokens];
}

function normalizeBytes32Topic(value: string | undefined, field: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`univ4 ${field} must be bytes32`);
  }
  return value.toLowerCase();
}

function parseLogBlockNumber(blockNumber: string): number {
  const block = blockNumber.startsWith("0x")
    ? parseInt(blockNumber, 16)
    : Number(blockNumber);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`invalid log blockNumber: ${blockNumber}`);
  }
  return block;
}

async function enrichPool(
  provider: ethers.JsonRpcProvider,
  pool: PoolActivity,
): Promise<PoolUniverseEntry | null> {
  const adapterHint = bestAdapter(pool.adapterCounts);
  if (adapterHint === "curve-underlying") {
    const identity = await resolvePoolIdentity(provider, pool.address, adapterHint, {
      admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    });
    if (!identity.ok) return null;
    const metadata = await resolveCurveUnderlyingMetadata(provider, pool.address, {
      allowDirectPoolFallback: true,
    });
    return {
      address: pool.address,
      adapter: "curve-underlying",
      venueId: identity.venueId,
      identitySource: identity.identitySource,
      underlyingCoins: metadata.coins,
      score: pool.count,
      swapCount30d: pool.count,
      lastSwapBlock: pool.lastSwapBlock,
      source: "alchemy-swap-logs",
    };
  }
  if (adapterHint !== "univ2" && adapterHint !== "univ3" && adapterHint !== "curve") return null;
  const identity = await resolvePoolIdentity(provider, pool.address, adapterHint, {
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  });
  if (!identity.ok) return null;
  const adapter = identity.adapter;
  const base: PoolUniverseEntry = {
    address: pool.address,
    adapter,
    venueId: identity.venueId,
    factory: identity.factory,
    identitySource: identity.identitySource,
    score: pool.count,
    swapCount30d: pool.count,
    lastSwapBlock: pool.lastSwapBlock,
    source: "alchemy-swap-logs",
  };

  try {
    if (adapter === "univ3") {
      const [token0, token1, fee, tickSpacing] = await Promise.all([
        callAddress(provider, pool.address, univ3Iface.encodeFunctionData("token0")),
        callAddress(provider, pool.address, univ3Iface.encodeFunctionData("token1")),
        callNumber(provider, pool.address, univ3Iface.encodeFunctionData("fee"), "fee"),
        callNumber(provider, pool.address, univ3Iface.encodeFunctionData("tickSpacing"), "tickSpacing"),
      ]);
      return { ...base, token0, token1, fee, tickSpacing };
    }
    if (adapter === "univ2") {
      const [token0, token1] = await Promise.all([
        callAddress(provider, pool.address, univ2Iface.encodeFunctionData("token0")),
        callAddress(provider, pool.address, univ2Iface.encodeFunctionData("token1")),
      ]);
      return { ...base, token0, token1 };
    }
    return base;
  } catch {
    return null;
  }
}

export function isClosablePair(token0: string, token1: string, tokenSet: Set<string>): boolean {
  return tokenSet.has(token0.toLowerCase()) && tokenSet.has(token1.toLowerCase());
}

async function probePoolShape(
  provider: ethers.JsonRpcProvider,
  addr: string,
): Promise<ProbedPoolShape | null> {
  const address = ethers.getAddress(addr);
  const identity = await resolvePoolIdentity(provider, address, "univ3", {
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
  });
  if (!identity.ok) return null;
  if (identity.adapter === "univ3") try {
    const [token0, token1, fee, tickSpacing] = await Promise.all([
      callAddress(provider, address, univ3Iface.encodeFunctionData("token0")),
      callAddress(provider, address, univ3Iface.encodeFunctionData("token1")),
      callNumber(provider, address, univ3Iface.encodeFunctionData("fee"), "fee"),
      callNumber(provider, address, univ3Iface.encodeFunctionData("tickSpacing"), "tickSpacing"),
    ]);
    return {
      adapter: "univ3",
      token0,
      token1,
      fee,
      tickSpacing,
      venueId: identity.venueId,
      factory: identity.factory!,
      identitySource: identity.identitySource,
    };
  } catch { /* an identity match still needs the expected pool ABI */ }

  if (identity.adapter === "univ2") try {
    const [token0, token1, reserves] = await Promise.all([
      callAddress(provider, address, univ2Iface.encodeFunctionData("token0")),
      callAddress(provider, address, univ2Iface.encodeFunctionData("token1")),
      provider.call({ to: address, data: univ2Iface.encodeFunctionData("getReserves") }),
    ]);
    univ2Iface.decodeFunctionResult("getReserves", reserves);
    return {
      adapter: "univ2",
      token0,
      token1,
      venueId: identity.venueId,
      factory: identity.factory!,
      identitySource: identity.identitySource,
    };
  } catch { /* fall through */ }
  return null;
}

export async function consumeDiscoveryQueue(
  provider: ethers.JsonRpcProvider,
  queuePath: string,
  tokenSet: Set<string>,
): Promise<{
  included: PoolUniverseEntry[];
  blocked: Array<{ addr: string; reason: string }>;
}> {
  if (!existsSync(queuePath)) return { included: [], blocked: [] };

  const parsed = JSON.parse(readFileSync(queuePath, "utf8")) as unknown;
  const included: PoolUniverseEntry[] = [];
  const blocked: Array<{ addr: string; reason: string }> = [];
  const queue = isRecord(parsed) && Array.isArray(parsed.queue) ? parsed.queue : [];

  for (const rawEntry of queue) {
    if (!isRecord(rawEntry)) {
      blocked.push({ addr: String(rawEntry), reason: "invalid_entry" });
      continue;
    }
    const entry = rawEntry as DiscoveryQueueEntry;
    if (entry.class !== "closable") continue;
    const addr = typeof entry.addr === "string" ? entry.addr : "";
    if (!addr) {
      blocked.push({ addr: String(entry.addr), reason: "invalid_entry" });
      continue;
    }

    try {
      const shape = await probePoolShape(provider, addr);
      if (shape === null) {
        blocked.push({ addr, reason: "blocked_on_adapter" });
        continue;
      }
      if (!isClosablePair(shape.token0, shape.token1, tokenSet)) {
        blocked.push({ addr, reason: "not_closable_in_current_graph" });
        continue;
      }
      included.push({
        address: ethers.getAddress(addr),
        adapter: shape.adapter,
        venueId: shape.venueId,
        factory: shape.factory,
        identitySource: shape.identitySource,
        token0: shape.token0,
        token1: shape.token1,
        fee: shape.adapter === "univ3" ? shape.fee : undefined,
        tickSpacing: shape.adapter === "univ3" ? shape.tickSpacing : undefined,
        source: typeof entry.source === "string" ? entry.source : undefined,
        score: undefined,
      });
    } catch {
      blocked.push({ addr, reason: "blocked_on_adapter" });
    }
  }

  return { included, blocked };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bestAdapter(adapterCounts: Map<PoolEntry["adapter"], number>): PoolEntry["adapter"] {
  return [...adapterCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

async function callAddress(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
): Promise<string> {
  const result = await provider.call({ to, data });
  return ethers.getAddress("0x" + result.slice(-40));
}

async function callNumber(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
  method: "fee" | "tickSpacing",
): Promise<number> {
  const result = await provider.call({ to, data });
  const decoded = univ3Iface.decodeFunctionResult(method, result);
  return Number(decoded[0]);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, () => worker()));
  return results;
}

// Only run the full scan when executed directly as a script (npm run searcher:pool-universe),
// not when this module is imported (e.g. to reuse consumeDiscoveryQueue / isClosablePair in a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[pool-universe] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
