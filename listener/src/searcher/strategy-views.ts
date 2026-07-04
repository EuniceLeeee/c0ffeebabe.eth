import { ethers } from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";

/**
 * Strategy-scoped pool views plus attributable P1-5 view-version hashes.
 *
 * Rule-14 decision: §1.5 named selectArbRelevantPools, but PoolEntry lacks that fn's required
 * RankablePool fields (count, lastSwapBlock); ranking the universe contribution by score desc is
 * the v1 blockscan view policy. Arb-relevance ranking of this view stays the pool-scoring epic's
 * domain. This slice delivers the view split plus hashes.
 */
export interface StrategyViews {
  backrun: PoolEntry[];
  blockscan: PoolEntry[];
  versions: {
    strategy_view_version: string;
    backrun_view_hash: string;
    blockscan_view_hash: string;
    pool_universe_generated_at: string;
    overrides_hash: string;
  };
}

export function buildStrategyViews(
  basePools: PoolEntry[],
  universeFile: PoolEntry[],
  overrides: PoolEntry[],
  opts: { blockscanMaxPools: number; poolUniverseGeneratedAt: string },
): StrategyViews {
  const backrun = basePools;
  const blockscan: PoolEntry[] = [];
  const seen = new Set<string>();

  for (const pool of basePools) appendUnique(blockscan, seen, pool);
  for (const pool of overrides) appendUnique(blockscan, seen, pool);

  let universeAdded = 0;
  const universeCap = Math.max(0, opts.blockscanMaxPools);
  for (const pool of [...universeFile].sort(compareUniversePools)) {
    if (universeAdded >= universeCap) break;
    if (appendUnique(blockscan, seen, pool)) universeAdded++;
  }

  const overrides_hash = hashAddressList(overrides);
  const backrun_view_hash = hashAddressList(backrun);
  const blockscan_view_hash = keccakUtf8(`${sortedLowercaseAddresses(blockscan).join(",")}|${overrides_hash}`);
  const strategy_view_version = keccakUtf8(
    `${backrun_view_hash}|${blockscan_view_hash}|${opts.poolUniverseGeneratedAt}`,
  );

  return {
    backrun,
    blockscan,
    versions: {
      strategy_view_version,
      backrun_view_hash,
      blockscan_view_hash,
      pool_universe_generated_at: opts.poolUniverseGeneratedAt,
      overrides_hash,
    },
  };
}

function appendUnique(out: PoolEntry[], seen: Set<string>, pool: PoolEntry): boolean {
  const key = pool.address.toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  out.push(pool);
  return true;
}

function compareUniversePools(a: PoolEntry, b: PoolEntry): number {
  const scoreDiff = scoreForSort(b) - scoreForSort(a);
  if (scoreDiff !== 0) return scoreDiff;
  return a.address.toLowerCase().localeCompare(b.address.toLowerCase());
}

function scoreForSort(pool: PoolEntry): number {
  return pool.score ?? -1;
}

function hashAddressList(pools: PoolEntry[]): string {
  return keccakUtf8(sortedLowercaseAddresses(pools).join(","));
}

function sortedLowercaseAddresses(pools: PoolEntry[]): string[] {
  return pools.map((pool) => pool.address.toLowerCase()).sort();
}

function keccakUtf8(value: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}
