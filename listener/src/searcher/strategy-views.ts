import { ethers } from "ethers";
import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";
import { poolRegistryKey } from "./pool-universe.js";
import {
  edgeExecutionVariantKey,
  edgeInstanceKey,
} from "./venues/route-instance-identity.js";

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

  const overrides_hash = hashPoolList(overrides);
  const backrun_view_hash = hashPoolList(backrun);
  const blockscan_view_hash = keccakUtf8(`${sortedPoolKeys(blockscan).join(",")}|${overrides_hash}`);
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
  const key = poolRegistryKey(pool);
  if (seen.has(key)) return false;
  seen.add(key);
  out.push(pool);
  return true;
}

function compareUniversePools(a: PoolEntry, b: PoolEntry): number {
  const scoreDiff = scoreForSort(b) - scoreForSort(a);
  if (scoreDiff !== 0) return scoreDiff;
  return poolRegistryKey(a).localeCompare(poolRegistryKey(b));
}

function scoreForSort(pool: PoolEntry): number {
  return pool.score ?? -1;
}

function hashPoolList(pools: PoolEntry[]): string {
  return keccakUtf8(sortedPoolKeys(pools).join(","));
}

function sortedPoolKeys(pools: PoolEntry[]): string[] {
  return pools.map(poolRegistryKey).sort();
}

export function hashTokenGraph(edges: TokenEdge[]): string {
  const keys = edges.map((edge) => [
    edgeInstanceKey(edge),
    edgeExecutionVariantKey(edge),
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.protocolAction ?? "",
    edge.edgeKind,
    edge.leavesStandingPosition ? "1" : "0",
    edge.curveI ?? "",
    edge.curveJ ?? "",
    edge.poolToken0?.toLowerCase() ?? "",
    edge.poolToken1?.toLowerCase() ?? "",
    edge.score ?? "",
    edge.poolId?.toLowerCase() ?? "",
    edge.nativeCurrency0 ? "1" : "0",
    edge.nativeCurrency1 ? "1" : "0",
    edge.v4PoolKey
      ? [
        edge.v4PoolKey.currency0.toLowerCase(),
        edge.v4PoolKey.currency1.toLowerCase(),
        edge.v4PoolKey.fee,
        edge.v4PoolKey.tickSpacing,
        edge.v4PoolKey.hooks.toLowerCase(),
      ].join(":")
      : "",
  ].join("|")).sort();
  return keccakUtf8(keys.join(","));
}

function keccakUtf8(value: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}
