import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import { poolRegistryKey } from "./pool-universe.js";

// ─── Factory addresses ──────────────────────────────────────

const UNIV2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const UNIV3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const SUSHI_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
// PancakeSwap V3 — a UniswapV3-lineage clone (same swap interface + PoolCreated layout, different factory).
// cast-verified 2026-07-06: factory() on coffee's pancake pools 0xacdb27b2 / 0x1445f32d = this address.
const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";

// Factory event topics
const UNIV2_PAIR_CREATED = ethers.id("PairCreated(address,address,address,uint256)");
const UNIV3_POOL_CREATED = ethers.id("PoolCreated(address,address,uint24,int24,address)");

// ─── Factory-based full pool indexing ───────────────────────

const FACTORY_LOG_BATCH = 5000;

interface FactoryDef {
  address: string;
  topic: string;
  adapter: PoolEntry["adapter"];
  parsePool: (log: { data: string; topics: string[] }) => string;
}

const FACTORIES: FactoryDef[] = [
  {
    address: UNIV2_FACTORY,
    topic: UNIV2_PAIR_CREATED,
    adapter: "univ2",
    // PairCreated data: pair address in first 32 bytes, then uint256
    parsePool: (log) => ethers.getAddress("0x" + log.data.slice(26, 66)),
  },
  {
    address: SUSHI_FACTORY,
    topic: UNIV2_PAIR_CREATED,
    adapter: "univ2",
    parsePool: (log) => ethers.getAddress("0x" + log.data.slice(26, 66)),
  },
  {
    address: UNIV3_FACTORY,
    topic: UNIV3_POOL_CREATED,
    adapter: "univ3",
    // PoolCreated data: tickSpacing(int24, 32B) + pool(address, 32B)
    parsePool: (log) => {
      const dataHex = log.data.replace("0x", "");
      return ethers.getAddress("0x" + dataHex.slice(-40));
    },
  },
  {
    // PancakeSwap V3: same PoolCreated(token0,token1,fee,tickSpacing,pool) event + data layout as UniV3
    // (only the factory address differs) → reuse the univ3 adapter + parsePool. UniV2/SushiV2/PancakeV2
    // and SushiV3 need NO entry — they share UniV2/UniV3's Swap+factory topics and are already covered.
    address: PANCAKE_V3_FACTORY,
    topic: UNIV3_POOL_CREATED,
    adapter: "univ3",
    parsePool: (log) => {
      const dataHex = log.data.replace("0x", "");
      return ethers.getAddress("0x" + dataHex.slice(-40));
    },
  },
];

/**
 * Index pools from factory PairCreated/PoolCreated events over a block range.
 *
 * Full-history scan is too slow for standard RPCs. Two modes:
 *   1. Startup: scan recent N blocks (default 50k ≈ 7 days)
 *   2. Incremental: scan last 25 blocks every refresh cycle
 *
 * For full coverage, pre-generate a pool CSV from Dune/archive and load
 * via loadPoolCsv() at startup.
 */
export async function indexFactoryPools(
  provider: ethers.JsonRpcProvider,
  blocksBack = 50000,
  toBlock?: number,
): Promise<PoolEntry[]> {
  const latest = toBlock ?? await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - blocksBack);
  const pools: PoolEntry[] = [];

  for (const factory of FACTORIES) {
    let count = 0;
    for (let start = fromBlock; start <= latest; start += FACTORY_LOG_BATCH) {
      const end = Math.min(start + FACTORY_LOG_BATCH - 1, latest);
      const logs = await getFactoryLogs(provider, factory, start, end);
      for (const log of logs) {
        try {
          // score 0: factory pools are prunable (not curated backbone), ranked
          // below swap-active pools but still above nothing.
          pools.push({ address: factory.parsePool(log), adapter: factory.adapter, score: 0 });
          count++;
        } catch { /* skip malformed */ }
      }
    }
    console.log(`[discovery] ${factory.adapter} factory (${factory.address.slice(0, 10)}): ${count} new pools in last ${blocksBack} blocks`);
  }

  return pools;
}

async function getFactoryLogs(
  provider: ethers.JsonRpcProvider,
  factory: FactoryDef,
  from: number,
  to: number,
): Promise<Array<{ data: string; topics: string[] }>> {
  try {
    return await provider.send("eth_getLogs", [{
      address: factory.address,
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
      topics: [factory.topic],
    }]);
  } catch {
    // Range too large — split into smaller chunks
    const results: Array<{ data: string; topics: string[] }> = [];
    for (let s = from; s <= to; s += 1000) {
      const e = Math.min(s + 999, to);
      try {
        results.push(...await provider.send("eth_getLogs", [{
          address: factory.address,
          fromBlock: "0x" + s.toString(16),
          toBlock: "0x" + e.toString(16),
          topics: [factory.topic],
        }]));
      } catch { /* skip chunk */ }
    }
    return results;
  }
}

// ─── Swap event topics (all variants) ────────────────────────

const SWAP_TOPICS: { topic: string; adapter: PoolEntry["adapter"] }[] = [
  // UniV3
  { topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"), adapter: "univ3" },
  // PancakeSwap V3 — UniV3-lineage clone; its Swap event adds protocolFeesToken0/1 so the topic differs
  // (0x19b47279…, cast-verified against coffee's pancake pools). Same swap/slot0/tick interface ⇒ univ3
  // adapter routes it (local v3 math is layout-identical). SushiV3 reuses UniV3's topic — already covered.
  { topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"), adapter: "univ3" },
  // UniV2 (also PancakeV2 / SushiV2 — identical event ⇒ same topic, already covered)
  { topic: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"), adapter: "univ2" },
  // Curve — multiple event signatures across pool versions
  { topic: ethers.id("TokenExchange(address,int128,uint256,int128,uint256)"), adapter: "curve" },
  { topic: ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256)"), adapter: "curve" },
  { topic: ethers.id("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"), adapter: "curve" },
];

const LOG_BATCH = 50;
const RETRY_LOG_BATCH = 10;

/**
 * Scan recent blocks for swap events to discover active pools.
 * Returns PoolEntry[] ranked by activity (top maxPools).
 */
export async function scanActivePools(
  provider: ethers.JsonRpcProvider,
  blocksBack = 300,
  maxPools = 100,
  toBlock?: number,
): Promise<PoolEntry[]> {
  const latest = toBlock ?? await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - blocksBack);

  const poolCounts = new Map<string, { adapter: PoolEntry["adapter"]; count: number }>();

  for (const { topic, adapter } of SWAP_TOPICS) {
    for (let start = fromBlock; start <= latest; start += LOG_BATCH) {
      const end = Math.min(start + LOG_BATCH - 1, latest);
      const logs = await getLogsWithSplitRetry(provider, topic, start, end);
      for (const log of logs) {
        const addr = log.address.toLowerCase();
        const existing = poolCounts.get(addr);
        if (existing) {
          existing.count++;
        } else {
          poolCounts.set(addr, { adapter, count: 1 });
        }
      }
    }
  }

  const ranked = [...poolCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxPools);

  console.log(
    `[discovery] scanned ${blocksBack} blocks: ${poolCounts.size} active pools, taking top ${ranked.length}`,
  );

  return ranked.map(([addr, { adapter, count }]) => ({
    address: ethers.getAddress(addr),
    adapter,
    score: count,
  }));
}

async function getLogsWithSplitRetry(
  provider: ethers.JsonRpcProvider,
  topic: string,
  fromBlock: number,
  toBlock: number,
): Promise<Array<{ address: string }>> {
  try {
    return await getLogs(provider, topic, fromBlock, toBlock);
  } catch {
    const logs: Array<{ address: string }> = [];
    for (let start = fromBlock; start <= toBlock; start += RETRY_LOG_BATCH) {
      const end = Math.min(start + RETRY_LOG_BATCH - 1, toBlock);
      try {
        logs.push(...await getLogs(provider, topic, start, end));
      } catch {
        // Keep scanning other chunks. A missed 10-block slice is less harmful
        // than dropping the original 50-block batch.
      }
    }
    return logs;
  }
}

async function getLogs(
  provider: ethers.JsonRpcProvider,
  topic: string,
  fromBlock: number,
  toBlock: number,
): Promise<Array<{ address: string }>> {
  return provider.send("eth_getLogs", [{
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
    topics: [topic],
  }]);
}

export function mergePoolRegistries(base: PoolEntry[], extra: PoolEntry[]): PoolEntry[] {
  const seen = new Set(base.map(poolRegistryKey));
  const merged = [...base];
  for (const p of extra) {
    const key = poolRegistryKey(p);
    if (!seen.has(key)) {
      merged.push(p);
      seen.add(key);
    }
  }
  return merged;
}
