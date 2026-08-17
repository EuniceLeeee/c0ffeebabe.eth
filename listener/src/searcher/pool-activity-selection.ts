import type { PoolEntry } from "./planner/token-graph.js";
import type { LandedPoolActivity } from
  "./venues/landed-pool-discovery.js";

/**
 * Pure projection used by compatibility fixtures. It carries no discovery,
 * admission, coverage, cursor, Graph, or publication authority.
 */
export function selectMatureDexActivity(
  activity: ReadonlyMap<string, LandedPoolActivity>,
  maturePoolAdapters: ReadonlySet<PoolEntry["adapter"]>,
): Map<string, LandedPoolActivity> {
  const selected = new Map<string, LandedPoolActivity>();
  for (const [key, pool] of activity) {
    const adapterCounts = new Map(
      [...pool.adapterCounts].filter(([adapter]) =>
        maturePoolAdapters.has(adapter)
      ),
    );
    const count = [...adapterCounts.values()].reduce(
      (sum, adapterCount) => sum + adapterCount,
      0,
    );
    if (count === 0) continue;
    selected.set(key, {
      address: pool.address,
      adapterCounts,
      count,
      lastSwapBlock: pool.lastSwapBlock,
    });
  }
  return selected;
}
