import type { PoolEntry } from "./planner/token-graph.js";
import { mergePoolRegistries } from "./pool-registry-merge.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-universe.js";
import type {
  LandedPoolCacheRevalidation,
  LandedPoolDiscoveryCoverage,
} from "./venues/landed-pool-discovery.js";

export interface StartupPoolDiscoveryProjection {
  readonly pools: readonly PoolEntry[];
  readonly coverage: readonly LandedPoolDiscoveryCoverage[];
  readonly cacheRevalidation: LandedPoolCacheRevalidation;
}

function incompleteLandedFamilyIds(
  coverage: readonly LandedPoolDiscoveryCoverage[],
): ReadonlySet<string> {
  return new Set(
    coverage
      .filter((item) => !item.complete)
      .map((item) => item.familyId),
  );
}

export function filterStartupActivePoolIncumbents(
  pools: readonly PoolEntry[],
  discovery: Pick<
    StartupPoolDiscoveryProjection,
    "coverage" | "cacheRevalidation"
  >,
  _familyIdForPool: (pool: PoolEntry) => string | null,
): PoolEntry[] {
  const stalePoolKeys = new Set(
    discovery.cacheRevalidation.stalePoolKeys,
  );
  return pools.filter((pool) =>
    !stalePoolKeys.has(poolProjectionRowKey(pool))
  );
}

export function mergeStartupActivePoolDiscovery(
  incumbentPools: readonly PoolEntry[],
  discovery: StartupPoolDiscoveryProjection,
  familyIdForPool: (pool: PoolEntry) => string | null,
): PoolEntry[] {
  const isolatedFamilyIds = incompleteLandedFamilyIds(discovery.coverage);
  return mergePoolRegistries(
    filterStartupActivePoolIncumbents(
      incumbentPools,
      discovery,
      familyIdForPool,
    ),
    discovery.pools.filter((pool) =>
      !isolatedFamilyIds.has(familyIdForPool(pool) ?? "")
    ),
  );
}

export function isKnownDexPoolProjection(
  pool: PoolEntry,
  knownPoolKeys: ReadonlySet<string> | undefined,
): boolean {
  if (!knownPoolKeys) return false;
  return (
    knownPoolKeys.has(poolRegistryKey(pool)) ||
    knownPoolKeys.has(poolProjectionRowKey(pool))
  );
}
