import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import { poolRegistryKey } from "./pool-universe.js";
import { VENUE_CAPABILITIES, type VenueId } from "./venues/capability.js";
import { attestPoolIdentities } from "./venues/identity.js";
import { ADDR } from "../shared/constants/addresses.js";

// Factory event topics
const UNIV2_PAIR_CREATED = ethers.id("PairCreated(address,address,address,uint256)");
const UNIV3_POOL_CREATED = ethers.id("PoolCreated(address,address,uint24,int24,address)");
const BALANCER_V3_SWAP = ethers.id("Swap(address,address,address,uint256,uint256,uint256,uint256)");

// ─── Factory-based full pool indexing ───────────────────────

const FACTORY_LOG_BATCH = 5000;

interface FactoryDef {
  address: string;
  topic: string;
  adapter: "univ2" | "univ3";
  venueId: VenueId;
  parsePool: (log: { data: string; topics: string[] }) => string;
}

const FACTORIES: FactoryDef[] = VENUE_CAPABILITIES.flatMap((capability) => {
  if (
    capability.discovery.mode !== "factory" ||
    !capability.runtimeAdapter ||
    (capability.runtimeAdapter !== "univ2" && capability.runtimeAdapter !== "univ3") ||
    !capability.discoverable ||
    !capability.quotable ||
    !capability.buildable ||
    !capability.supported_in_prod
  ) {
    return [];
  }
  const adapter = capability.runtimeAdapter;
  return capability.discovery.factories.map((address) => ({
    address,
    adapter,
    venueId: capability.venue,
    topic: adapter === "univ2" ? UNIV2_PAIR_CREATED : UNIV3_POOL_CREATED,
    parsePool: adapter === "univ2"
      // PairCreated data: pair address in first 32 bytes, then uint256.
      ? (log: { data: string }) => ethers.getAddress("0x" + log.data.slice(26, 66))
      // V3 PoolCreated data ends with the pool address.
      : (log: { data: string }) => ethers.getAddress("0x" + log.data.replace("0x", "").slice(-40)),
  }));
});

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
          pools.push({
            address: factory.parsePool(log),
            adapter: factory.adapter,
            venueId: factory.venueId,
            factory: ethers.getAddress(factory.address),
            identitySource: "factory-event",
            score: 0,
          });
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

// Swap topics discover candidate shapes. factory()/MetaRegistry records identity provenance.

type DiscoveredAdapter = "univ2" | "univ3" | "curve" | "curve-underlying" | "balancer-v3";

const SWAP_TOPICS: { topic: string; adapter: DiscoveredAdapter }[] = [
  // UniV3
  { topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"), adapter: "univ3" },
  // PancakeSwap V3 — UniV3-lineage clone; its Swap event adds protocolFeesToken0/1 so the topic differs
  // (0x19b47279…, cast-verified against coffee's pancake pools). Same swap/slot0/tick interface ⇒ univ3
  // Topics only discover candidates. Known factories select their proven adapter;
  // unproven factories retain this shape provisionally until graph build/final sim.
  { topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"), adapter: "univ3" },
  // V2-shaped candidate. An identical event does not prove a compatible invariant.
  { topic: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"), adapter: "univ2" },
  // Curve — multiple event signatures across pool versions
  { topic: ethers.id("TokenExchange(address,int128,uint256,int128,uint256)"), adapter: "curve" },
  { topic: ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256)"), adapter: "curve" },
  { topic: ethers.id("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"), adapter: "curve-underlying" },
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
  options: {
    allowProvisionalFactories?: boolean;
    allowProvisionalCurveUnderlying?: boolean;
  } = {},
): Promise<PoolEntry[]> {
  const latest = toBlock ?? await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - blocksBack);

  const poolCounts = new Map<
    string,
    { adapterCounts: Map<DiscoveredAdapter, number>; count: number }
  >();

  for (const { topic, adapter } of SWAP_TOPICS) {
    for (let start = fromBlock; start <= latest; start += LOG_BATCH) {
      const end = Math.min(start + LOG_BATCH - 1, latest);
      const logs = await getLogsWithSplitRetry(provider, topic, start, end);
      for (const log of logs) {
        const addr = log.address.toLowerCase();
        const existing = poolCounts.get(addr);
        if (existing) {
          existing.count++;
          existing.adapterCounts.set(adapter, (existing.adapterCounts.get(adapter) ?? 0) + 1);
        } else {
          poolCounts.set(addr, { adapterCounts: new Map([[adapter, 1]]), count: 1 });
        }
      }
    }
  }

  for (let start = fromBlock; start <= latest; start += LOG_BATCH) {
    const end = Math.min(start + LOG_BATCH - 1, latest);
    const logs = await getBalancerV3LogsWithSplitRetry(provider, start, end);
    for (const log of logs) {
      const topic = log.topics?.[1];
      if (!topic) continue;
      try {
        const addr = ethers.getAddress(`0x${topic.slice(-40)}`).toLowerCase();
        const existing = poolCounts.get(addr);
        if (existing) {
          existing.count++;
          existing.adapterCounts.set("balancer-v3", (existing.adapterCounts.get("balancer-v3") ?? 0) + 1);
        } else {
          poolCounts.set(addr, { adapterCounts: new Map([["balancer-v3", 1]]), count: 1 });
        }
      } catch { /* malformed indexed pool */ }
    }
  }

  const candidates: PoolEntry[] = [...poolCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([addr, item]) => ({
      address: ethers.getAddress(addr),
      adapter: bestAdapter(item.adapterCounts),
      score: item.count,
    }));
  const { accepted, rejected } = await attestPoolIdentities(provider, candidates, {
    allowProvisionalFactories: options.allowProvisionalFactories,
    allowProvisionalCurveUnderlying: options.allowProvisionalCurveUnderlying,
  });
  const ranked = accepted.slice(0, maxPools);
  const provisional = accepted.filter(
    (pool) => pool.identitySource === "factory-call-provisional",
  ).length;
  const rejectedByReason = new Map<string, number>();
  for (const item of rejected) {
    rejectedByReason.set(item.reason, (rejectedByReason.get(item.reason) ?? 0) + 1);
  }
  const rejectedSummary = [...rejectedByReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");

  console.log(
    `[discovery] scanned ${blocksBack} blocks: ${poolCounts.size} candidates, ` +
      `${accepted.length} identity-admitted (provisional=${provisional}), taking top ${ranked.length}` +
      (rejectedSummary ? `, rejected(${rejectedSummary})` : ""),
  );

  return ranked;
}

function bestAdapter(
  adapterCounts: Map<DiscoveredAdapter, number>,
): DiscoveredAdapter {
  return [...adapterCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

async function getBalancerV3LogsWithSplitRetry(
  provider: ethers.JsonRpcProvider,
  fromBlock: number,
  toBlock: number,
): Promise<Array<{ topics: string[] }>> {
  try {
    return await provider.send("eth_getLogs", [{
      address: ADDR.BALANCER_V3_VAULT,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: [BALANCER_V3_SWAP],
    }]);
  } catch {
    if (fromBlock >= toBlock) return [];
    const mid = Math.floor((fromBlock + toBlock) / 2);
    return [
      ...await getBalancerV3LogsWithSplitRetry(provider, fromBlock, mid),
      ...await getBalancerV3LogsWithSplitRetry(provider, mid + 1, toBlock),
    ];
  }
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
