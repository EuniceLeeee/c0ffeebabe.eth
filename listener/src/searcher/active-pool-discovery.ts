import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";

// ─── Swap event topics (all variants) ────────────────────────

const SWAP_TOPICS: { topic: string; adapter: PoolEntry["adapter"] }[] = [
  // UniV3
  { topic: ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"), adapter: "univ3" },
  // UniV2
  { topic: ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"), adapter: "univ2" },
  // Curve — multiple event signatures across pool versions
  { topic: ethers.id("TokenExchange(address,int128,uint256,int128,uint256)"), adapter: "curve" },
  { topic: ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256)"), adapter: "curve" },
  { topic: ethers.id("TokenExchangeUnderlying(address,int128,uint256,int128,uint256)"), adapter: "curve" },
];

const LOG_BATCH = 50;

/**
 * Scan recent blocks for swap events to discover active pools.
 * Returns PoolEntry[] ranked by activity (top maxPools).
 */
export async function scanActivePools(
  provider: ethers.JsonRpcProvider,
  blocksBack = 300,
  maxPools = 100,
): Promise<PoolEntry[]> {
  const latest = await provider.getBlockNumber();
  const fromBlock = latest - blocksBack;

  const poolCounts = new Map<string, { adapter: PoolEntry["adapter"]; count: number }>();

  for (const { topic, adapter } of SWAP_TOPICS) {
    for (let start = fromBlock; start <= latest; start += LOG_BATCH) {
      const end = Math.min(start + LOG_BATCH - 1, latest);
      try {
        const logs: any[] = await provider.send("eth_getLogs", [{
          fromBlock: "0x" + start.toString(16),
          toBlock: "0x" + end.toString(16),
          topics: [topic],
        }]);
        for (const log of logs) {
          const addr = log.address.toLowerCase();
          const existing = poolCounts.get(addr);
          if (existing) {
            existing.count++;
          } else {
            poolCounts.set(addr, { adapter, count: 1 });
          }
        }
      } catch {
        // RPC limit exceeded — skip batch
      }
    }
  }

  const ranked = [...poolCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxPools);

  console.log(
    `[discovery] scanned ${blocksBack} blocks: ${poolCounts.size} active pools, taking top ${ranked.length}`,
  );

  return ranked.map(([addr, { adapter }]) => ({
    address: ethers.getAddress(addr),
    adapter,
  }));
}

export function mergePoolRegistries(base: PoolEntry[], extra: PoolEntry[]): PoolEntry[] {
  const seen = new Set(base.map((p) => p.address.toLowerCase()));
  const merged = [...base];
  for (const p of extra) {
    if (!seen.has(p.address.toLowerCase())) {
      merged.push(p);
      seen.add(p.address.toLowerCase());
    }
  }
  return merged;
}
