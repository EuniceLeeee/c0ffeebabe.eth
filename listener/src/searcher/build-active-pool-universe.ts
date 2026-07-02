import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import { DEFAULT_POOL_UNIVERSE_PATH, type PoolUniverseEntry, type PoolUniverseFile } from "./pool-universe.js";

const BLOCKS_PER_DAY = 7200;

const SWAP_TOPICS: Array<{ topic: string; adapter: PoolEntry["adapter"]; label: string }> = [
  {
    topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"),
    adapter: "univ3",
    label: "univ3",
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
    adapter: "curve",
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

interface DiscoveryQueueEntry {
  addr?: unknown;
  class?: unknown;
  source?: unknown;
}

type ProbedPoolShape =
  | { adapter: "univ3"; token0: string; token1: string; fee: number; tickSpacing: number }
  | { adapter: "univ2"; token0: string; token1: string };

interface RawLog {
  address: string;
  blockNumber: string;
}

interface PoolActivity {
  address: string;
  adapterCounts: Map<PoolEntry["adapter"], number>;
  count: number;
  lastSwapBlock: number;
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
  const lookbackBlocks = Number(
    process.env.POOL_UNIVERSE_LOOKBACK_BLOCKS ??
      String(Number(process.env.POOL_UNIVERSE_LOOKBACK_DAYS ?? "30") * BLOCKS_PER_DAY),
  );
  const fromBlock = Math.max(0, Number(process.env.POOL_UNIVERSE_FROM_BLOCK ?? latest - lookbackBlocks));
  const maxPools = Number(process.env.POOL_UNIVERSE_MAX_POOLS ?? "3000");
  const minSwaps = Number(process.env.POOL_UNIVERSE_MIN_SWAPS ?? "2");
  const logBatch = Number(process.env.POOL_UNIVERSE_LOG_BATCH ?? "1000");
  const metadataConcurrency = Number(process.env.POOL_UNIVERSE_METADATA_CONCURRENCY ?? "24");
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

  const ranked = [...activity.values()]
    .filter((pool) => pool.count >= minSwaps)
    .sort((a, b) => b.count - a.count || b.lastSwapBlock - a.lastSwapBlock)
    .slice(0, maxPools);
  console.log(
    `[pool-universe] active pools=${activity.size}, ` +
      `after minSwaps=${ranked.length}, maxPools=${maxPools}`,
  );

  const pools = await mapLimit(ranked, metadataConcurrency, async (pool, idx) => {
    if ((idx + 1) % 250 === 0) {
      console.log(`[pool-universe] metadata ${idx + 1}/${ranked.length}`);
    }
    return enrichPool(provider, pool);
  });
  const validPools = pools.filter((pool): pool is PoolUniverseEntry => pool !== null);
  const tokenSet = new Set<string>();
  for (const pool of validPools) {
    if (pool.token0) tokenSet.add(pool.token0.toLowerCase());
    if (pool.token1) tokenSet.add(pool.token1.toLowerCase());
  }
  const discoveryQueuePath = resolve("searcher", "pools", "discovery-queue.json");
  const { included, blocked } = await consumeDiscoveryQueue(provider, discoveryQueuePath, tokenSet);
  const poolByAddress = new Map<string, PoolUniverseEntry>();
  for (const pool of validPools) {
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
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fromBlock,
    toBlock: latest,
    pools: [...poolByAddress.values()],
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(file, null, 2) + "\n");
  console.log(`[pool-universe] wrote ${file.pools.length} pools to ${outPath}`);
}

async function getLogsWithSplitRetry(
  provider: ethers.JsonRpcProvider,
  topic: string,
  fromBlock: number,
  toBlock: number,
): Promise<RawLog[]> {
  try {
    return await provider.send("eth_getLogs", [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: [topic],
    }]);
  } catch {
    if (fromBlock >= toBlock) return [];
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsWithSplitRetry(provider, topic, fromBlock, mid);
    const right = await getLogsWithSplitRetry(provider, topic, mid + 1, toBlock);
    return [...left, ...right];
  }
}

async function enrichPool(
  provider: ethers.JsonRpcProvider,
  pool: PoolActivity,
): Promise<PoolUniverseEntry | null> {
  const adapter = bestAdapter(pool.adapterCounts);
  const base: PoolUniverseEntry = {
    address: pool.address,
    adapter,
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
  try {
    const [token0, token1, fee, tickSpacing] = await Promise.all([
      callAddress(provider, address, univ3Iface.encodeFunctionData("token0")),
      callAddress(provider, address, univ3Iface.encodeFunctionData("token1")),
      callNumber(provider, address, univ3Iface.encodeFunctionData("fee"), "fee"),
      callNumber(provider, address, univ3Iface.encodeFunctionData("tickSpacing"), "tickSpacing"),
    ]);
    return { adapter: "univ3", token0, token1, fee, tickSpacing };
  } catch {
    // Try the v2 shape below.
  }

  try {
    const [token0, token1, reserves] = await Promise.all([
      callAddress(provider, address, univ2Iface.encodeFunctionData("token0")),
      callAddress(provider, address, univ2Iface.encodeFunctionData("token1")),
      provider.call({ to: address, data: univ2Iface.encodeFunctionData("getReserves") }),
    ]);
    univ2Iface.decodeFunctionResult("getReserves", reserves);
    return { adapter: "univ2", token0, token1 };
  } catch {
    return null;
  }
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

main().catch((err) => {
  console.error(`[pool-universe] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
