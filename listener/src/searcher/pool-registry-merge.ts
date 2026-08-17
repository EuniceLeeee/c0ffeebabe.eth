import type { PoolEntry } from "./planner/token-graph.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-universe.js";

export function mergePoolRegistries(
  base: readonly PoolEntry[],
  extra: readonly PoolEntry[],
): PoolEntry[] {
  const seen = new Set(base.map(poolRegistryKey));
  const merged = [...base];
  for (const pool of extra) {
    const key = poolRegistryKey(pool);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(pool);
  }
  return merged;
}

export function mergePoolProjectionRows(
  base: readonly PoolEntry[],
  extra: readonly PoolEntry[],
): PoolEntry[] {
  const seen = new Set(base.map(poolProjectionRowKey));
  const merged = [...base];
  for (const pool of extra) {
    const key = poolProjectionRowKey(pool);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(pool);
  }
  return merged;
}
