import type { PoolEntry } from "../planner/token-graph.js";
import { poolProjectionRowKey } from "../pool-registry-key.js";
import type {
  LandedPoolCacheRevalidation,
  LandedPoolMaterializationContext,
  LandedPoolMaterializationResult,
  LandedPoolSharedIdentityCapability,
  LandedPoolSharedIdentityMaterializer,
  LandedPoolSharedIdentityProjection,
} from "./landed-pool-discovery.js";

export interface SharedLandedIdentityMember {
  readonly id: string;
  readonly context: LandedPoolMaterializationContext;
  readonly sharedIdentity: LandedPoolSharedIdentityCapability;
}

export type SharedLandedIdentityOutcome =
  | {
      readonly scope: "success";
      readonly result: LandedPoolMaterializationResult;
    }
  | {
      /**
       * Family-owned translation failed after the physical source remained
       * valid. Production keeps healthy siblings and quarantines only this
       * family until its typed retries heal.
       */
      readonly scope: "projection";
      readonly error: unknown;
      readonly retryablePools: readonly PoolEntry[];
    }
  | {
      /** Physical input/source disagreement invalidates every subscriber. */
      readonly scope: "source";
      readonly error: unknown;
    }
  | {
      /** The shared source-pinned identity kernel itself failed. */
      readonly scope: "materializer";
      readonly error: unknown;
    };

interface PreparedMember extends SharedLandedIdentityMember {
  readonly retainedPools: readonly PoolEntry[];
  readonly retryablePools: readonly PoolEntry[];
  readonly knownIdentityKeys: ReadonlySet<string>;
}

interface SharedIdentityMaterializationInput {
  readonly context: LandedPoolMaterializationContext;
  readonly revalidationKeys: ReadonlySet<string>;
}

/**
 * Compatibility entry for focused family fixtures which invoke one
 * materializer directly. Production discovery uses the grouped entry below.
 */
export async function materializeSharedLandedPoolIdentity(
  sharedIdentity: LandedPoolSharedIdentityCapability,
  context: LandedPoolMaterializationContext,
): Promise<LandedPoolMaterializationResult> {
  const outcomes = await materializeSharedLandedPoolIdentityMembers([{
    id: "direct",
    context,
    sharedIdentity,
  }]);
  const outcome = outcomes.get("direct");
  if (!outcome) throw new Error("shared landed identity omitted direct result");
  if (outcome.scope !== "success") throw outcome.error;
  return outcome.result;
}

/**
 * Resolve one physical identity set, then isolate each family projection.
 * A broken projection cannot prevent healthy siblings from receiving the
 * canonical materializer result.
 */
export async function materializeSharedLandedPoolIdentityMembers(
  members: readonly SharedLandedIdentityMember[],
): Promise<ReadonlyMap<string, SharedLandedIdentityOutcome>> {
  if (members.length === 0) {
    throw new Error("shared landed identity requires at least one projection");
  }
  const outcomes = new Map<string, SharedLandedIdentityOutcome>();
  try {
    assertSamePhysicalLogs(members);
  } catch (error) {
    for (const member of members) {
      outcomes.set(member.id, { scope: "source", error });
    }
    return outcomes;
  }

  const prepared: PreparedMember[] = [];
  for (const member of members) {
    try {
      prepared.push(prepareMember(member));
    } catch (error) {
      outcomes.set(member.id, {
        scope: "projection",
        error,
        retryablePools: familyOwnedRetries(member),
      });
    }
  }
  if (prepared.length === 0) return outcomes;

  const materializer = prepared[0].sharedIdentity.materializer;
  let identityResult: LandedPoolMaterializationResult;
  let materializationInput: SharedIdentityMaterializationInput;
  try {
    materializationInput = identityContext(prepared, materializer);
    identityResult = await materializer.materialize(
      materializationInput.context,
    );
  } catch (error) {
    for (const member of prepared) {
      outcomes.set(member.id, { scope: "materializer", error });
    }
    return outcomes;
  }
  for (const member of prepared) {
    outcomes.set(
      member.id,
      projectResult(
        identityResult,
        member,
        materializer,
        materializationInput.revalidationKeys,
      ),
    );
  }
  return outcomes;
}

function prepareMember(member: SharedLandedIdentityMember): PreparedMember {
  const retainedPools = toIdentityPools(
    member.context.retainedPools,
    member.sharedIdentity,
  );
  const retryablePools = toIdentityPools(
    member.context.retryablePools,
    member.sharedIdentity,
  );
  const knownIdentityKeys = new Set<string>();
  for (const pool of member.context.retainedPools) {
    const source = immutablePoolSnapshot(pool);
    const identityPool =
      member.sharedIdentity.projection.toIdentityPool(source);
    if (identityPool === null) continue;
    assertProjectionIntegrity(source, identityPool, "toIdentityPool");
    if (!member.context.isKnownPool(pool)) continue;
    knownIdentityKeys.add(
      identityKey(member.sharedIdentity.materializer, identityPool),
    );
  }
  return {
    ...member,
    retainedPools,
    retryablePools,
    knownIdentityKeys,
  };
}

function identityContext(
  members: readonly PreparedMember[],
  materializer: LandedPoolSharedIdentityMaterializer,
): SharedIdentityMaterializationInput {
  const cache = reconcileIdentityCache(
    members.flatMap((member) =>
      member.retainedPools.map((pool) => ({ kind: "retained" as const, pool }))
    ),
    members.flatMap((member) =>
      member.retryablePools.map((pool) => ({
        kind: "retryable" as const,
        pool,
      }))
    ),
    materializer,
  );
  const knownIdentityKeys = new Set(
    members.flatMap((member) => [...member.knownIdentityKeys]),
  );
  for (const key of cache.revalidationKeys) knownIdentityKeys.delete(key);
  return Object.freeze({
    context: Object.freeze({
      ...members[0].context,
      retainedPools: cache.retainedPools,
      retryablePools: cache.retryablePools,
      isKnownPool: (pool: PoolEntry) =>
        knownIdentityKeys.has(identityKey(materializer, pool)),
    }),
    revalidationKeys: cache.revalidationKeys,
  });
}

function toIdentityPools(
  pools: readonly PoolEntry[],
  sharedIdentity: LandedPoolSharedIdentityCapability,
): readonly PoolEntry[] {
  const projected: PoolEntry[] = [];
  for (const pool of pools) {
    const source = immutablePoolSnapshot(pool);
    const identityPool = sharedIdentity.projection.toIdentityPool(source);
    if (identityPool === null) continue;
    assertProjectionIntegrity(source, identityPool, "toIdentityPool");
    identityKey(sharedIdentity.materializer, identityPool);
    projected.push(immutablePoolSnapshot(identityPool));
  }
  return Object.freeze(projected);
}

interface IdentityCacheRow {
  readonly kind: "retained" | "retryable";
  readonly pool: PoolEntry;
}

interface ReconciledIdentityCache {
  readonly retainedPools: readonly PoolEntry[];
  readonly retryablePools: readonly PoolEntry[];
  readonly revalidationKeys: ReadonlySet<string>;
}

function reconcileIdentityCache(
  retainedRows: readonly IdentityCacheRow[],
  retryableRows: readonly IdentityCacheRow[],
  materializer: LandedPoolSharedIdentityMaterializer,
): ReconciledIdentityCache {
  const byKey = new Map<string, IdentityCacheRow[]>();
  for (const row of [...retainedRows, ...retryableRows]) {
    const key = identityKey(materializer, row.pool);
    const rows = byKey.get(key) ?? [];
    rows.push(row);
    byKey.set(key, rows);
  }
  const retainedPools: PoolEntry[] = [];
  const retryablePools: PoolEntry[] = [];
  const revalidationKeys = new Set<string>();
  for (const [key, rows] of byKey) {
    const physicalConflict = rows.some((left, index) =>
      rows.slice(index + 1).some((right) =>
        physicalIdentityConflicts(left.pool, right.pool)
      )
    );
    if (physicalConflict) {
      const activity = rows
        .map((row) => row.pool)
        .reduce(mergeActivity);
      const revalidation = immutablePoolSnapshot(
        materializer.revalidationPool(immutablePoolSnapshot(activity)),
      );
      if (identityKey(materializer, revalidation) !== key) {
        throw new Error(
          `shared landed identity ${materializer.id} changed its ` +
            `revalidation key ${key}`,
        );
      }
      retryablePools.push(revalidation);
      revalidationKeys.add(key);
      continue;
    }
    const retained = mergeCompatibleRows(
      rows.filter((row) => row.kind === "retained").map((row) => row.pool),
    );
    const retryable = mergeCompatibleRows(
      rows.filter((row) => row.kind === "retryable").map((row) => row.pool),
    );
    if (retained) retainedPools.push(retained);
    if (retryable) retryablePools.push(retryable);
  }
  return Object.freeze({
    retainedPools: Object.freeze(retainedPools),
    retryablePools: Object.freeze(retryablePools),
    revalidationKeys,
  });
}

function mergeCompatibleRows(
  pools: readonly PoolEntry[],
): PoolEntry | null {
  if (pools.length === 0) return null;
  return pools.reduce((left, right) => {
    if (physicalIdentityConflicts(left, right)) {
      throw new Error("compatible identity merge received a conflict");
    }
    const richer = physicalFieldCount(right) > physicalFieldCount(left)
      ? right
      : left;
    const other = richer === left ? right : left;
    return mergeActivity(richer, other);
  });
}

function projectResult(
  result: LandedPoolMaterializationResult,
  member: PreparedMember,
  materializer: LandedPoolSharedIdentityMaterializer,
  revalidationKeys: ReadonlySet<string>,
): SharedLandedIdentityOutcome {
  const projection = member.sharedIdentity.projection;
  const expectedAdapter = member.context.event.discovery.poolAdapter;
  const pools: PoolEntry[] = [];
  const errors: unknown[] = [];
  const revalidatedPoolKeys = new Set<string>();
  let stalePoolKeys: readonly string[] = [];
  if (result.complete && revalidationKeys.size > 0) {
    try {
      stalePoolKeys = familyRevalidationPoolKeys(
        member,
        materializer,
        revalidationKeys,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  for (const pool of result.pools) {
    try {
      const source = immutablePoolSnapshot(pool);
      const projected = projection.projectPool(source);
      if (projected === null) continue;
      assertProjectionIntegrity(source, projected, "projectPool");
      assertProjectionOwner(projected, expectedAdapter, "projectPool");
      const immutable = immutablePoolSnapshot(projected);
      pools.push(immutable);
      if (
        result.complete &&
        revalidationKeys.has(identityKey(materializer, source))
      ) {
        revalidatedPoolKeys.add(poolProjectionRowKey(immutable));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  const retryablePools: PoolEntry[] = [];
  for (const pool of result.retryablePools ?? []) {
    try {
      retryablePools.push(projectRetry(pool, projection, expectedAdapter));
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    // No partial family publication: retry every canonical positive so a
    // repaired projection can rebuild the complete family on the next pass.
    const retries = new Map<string, PoolEntry>();
    for (const pool of [...result.pools, ...(result.retryablePools ?? [])]) {
      try {
        const retry = projectRetry(pool, projection, expectedAdapter);
        retries.set(familyRetryKey(retry), retry);
      } catch (error) {
        errors.push(error);
      }
    }
    return Object.freeze({
      scope: "projection",
      error: projectionAggregateError(errors),
      retryablePools: Object.freeze([...retries.values()]),
    });
  }
  return Object.freeze({
    scope: "success",
    result: Object.freeze({
      pools: Object.freeze(pools),
      complete: result.complete,
      ...(stalePoolKeys.length === 0
        ? {}
        : {
            cacheRevalidation: Object.freeze({
              stalePoolKeys: Object.freeze([...stalePoolKeys]),
              revalidatedPoolKeys: Object.freeze([
                ...revalidatedPoolKeys,
              ]),
            }) satisfies LandedPoolCacheRevalidation,
          }),
      ...(result.issues === undefined
        ? {}
        : { issues: Object.freeze([...result.issues]) }),
      ...(result.retryablePools === undefined
        ? {}
        : { retryablePools: Object.freeze(retryablePools) }),
    }),
  });
}

function projectRetry(
  pool: PoolEntry,
  projection: LandedPoolSharedIdentityProjection,
  expectedAdapter: PoolEntry["adapter"],
): PoolEntry {
  const source = immutablePoolSnapshot(pool);
  const projected = projection.projectRetry(source);
  assertProjectionIntegrity(source, projected, "projectRetry");
  assertProjectionOwner(projected, expectedAdapter, "projectRetry");
  return immutablePoolSnapshot(projected);
}

function familyRevalidationPoolKeys(
  member: PreparedMember,
  materializer: LandedPoolSharedIdentityMaterializer,
  revalidationKeys: ReadonlySet<string>,
): readonly string[] {
  const stale = new Set<string>();
  for (
    const pool of [
      ...member.context.retainedPools,
      ...member.context.retryablePools,
    ]
  ) {
    const source = immutablePoolSnapshot(pool);
    const identityPool =
      member.sharedIdentity.projection.toIdentityPool(source);
    if (identityPool === null) continue;
    assertProjectionIntegrity(source, identityPool, "toIdentityPool");
    if (
      revalidationKeys.has(identityKey(materializer, identityPool))
    ) {
      stale.add(poolProjectionRowKey(source));
    }
  }
  return Object.freeze([...stale]);
}

function identityKey(
  materializer: LandedPoolSharedIdentityMaterializer,
  pool: PoolEntry,
): string {
  const key = materializer.identityKey(pool);
  if (typeof key !== "string" || !key.trim()) {
    throw new Error(
      `shared landed identity ${materializer.id} returned an empty key`,
    );
  }
  return key;
}

function familyOwnedRetries(
  member: SharedLandedIdentityMember,
): readonly PoolEntry[] {
  const familyAdapter = member.context.event.discovery.poolAdapter;
  const retries = new Map<string, PoolEntry>();
  for (
    const pool of [
      ...member.context.retainedPools,
      ...member.context.retryablePools,
    ]
  ) {
    if (pool.adapter !== familyAdapter) continue;
    const retry = immutablePoolSnapshot({
      ...pool,
      source: `landed-event-retry:${member.context.event.id}`,
    } as PoolEntry);
    retries.set(familyRetryKey(retry), retry);
  }
  return Object.freeze([...retries.values()]);
}

function familyRetryKey(pool: PoolEntry): string {
  return [
    pool.adapter,
    pool.address.toLowerCase(),
    pool.poolId?.toLowerCase() ?? "",
    pool.logicalInstanceId?.toLowerCase() ?? "",
  ].join("|");
}

function projectionAggregateError(errors: readonly unknown[]): Error {
  const messages = [...new Set(errors.map((error) =>
    error instanceof Error ? error.message : String(error)
  ))];
  return new Error(
    "shared landed identity family projection failed: " +
      messages.join("; "),
  );
}

function mergeActivity(left: PoolEntry, right: PoolEntry): PoolEntry {
  const max = (
    field: "score" | "swapCount30d" | "lastSwapBlock",
  ): number | undefined => {
    const values = [activity(left, field), activity(right, field)]
      .filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : Math.max(...values);
  };
  const score = max("score");
  const swapCount30d = max("swapCount30d");
  const lastSwapBlock = max("lastSwapBlock");
  return Object.freeze({
    ...left,
    ...(score === undefined ? {} : { score }),
    ...(swapCount30d === undefined ? {} : { swapCount30d }),
    ...(lastSwapBlock === undefined ? {} : { lastSwapBlock }),
  });
}

function physicalFieldCount(pool: PoolEntry): number {
  return [
    pool.address,
    pool.poolId,
    pool.currency0,
    pool.currency1,
    pool.fee,
    pool.tickSpacing,
    pool.hooks,
  ].filter((value) => value !== undefined).length;
}

function activity(
  pool: PoolEntry,
  field: "score" | "swapCount30d" | "lastSwapBlock",
): number | undefined {
  return (pool as PoolEntry & {
    readonly swapCount30d?: number;
    readonly lastSwapBlock?: number;
  })[field];
}

function assertProjectionIntegrity(
  source: PoolEntry,
  projected: PoolEntry,
  phase: string,
): void {
  assertSamePhysicalIdentity(source, projected, `shared ${phase}`);
  for (const field of ["score", "swapCount30d", "lastSwapBlock"] as const) {
    if (activity(source, field) !== activity(projected, field)) {
      throw new Error(
        `shared landed identity projection mutated ${field}`,
      );
    }
  }
}

function assertProjectionOwner(
  pool: PoolEntry,
  expectedAdapter: PoolEntry["adapter"],
  phase: string,
): void {
  if (pool.adapter !== expectedAdapter) {
    throw new Error(
      `shared ${phase} returned foreign pool adapter ${pool.adapter}; ` +
        `expected ${expectedAdapter}`,
    );
  }
}

function assertSamePhysicalIdentity(
  left: PoolEntry,
  right: PoolEntry,
  context: string,
): void {
  for (
    const field of ["address", "currency0", "currency1", "hooks"] as const
  ) {
    const leftValue = left[field];
    const rightValue = right[field];
    if (
      (leftValue === undefined) !== (rightValue === undefined) ||
      (
        leftValue !== undefined &&
        rightValue !== undefined &&
        leftValue.toLowerCase() !== rightValue.toLowerCase()
      )
    ) {
      throw new Error(`${context} has conflicting ${field}`);
    }
  }
  if (left.poolId?.toLowerCase() !== right.poolId?.toLowerCase()) {
    throw new Error(`${context} has conflicting poolId`);
  }
  for (const field of ["fee", "tickSpacing"] as const) {
    if (left[field] !== right[field]) {
      throw new Error(`${context} has conflicting ${field}`);
    }
  }
}

function physicalIdentityConflicts(
  left: PoolEntry,
  right: PoolEntry,
): boolean {
  for (
    const field of ["address", "poolId", "currency0", "currency1", "hooks"] as const
  ) {
    const leftValue = left[field];
    const rightValue = right[field];
    if (
      leftValue !== undefined &&
      rightValue !== undefined &&
      leftValue.toLowerCase() !== rightValue.toLowerCase()
    ) {
      return true;
    }
  }
  for (const field of ["fee", "tickSpacing"] as const) {
    if (
      left[field] !== undefined &&
      right[field] !== undefined &&
      left[field] !== right[field]
    ) {
      return true;
    }
  }
  return false;
}

function immutablePoolSnapshot(pool: PoolEntry): PoolEntry {
  const receiptEmitters = pool.receiptEmitters === undefined
    ? undefined
    : [...pool.receiptEmitters];
  const underlyingCoins = pool.underlyingCoins === undefined
    ? undefined
    : [...pool.underlyingCoins];
  if (receiptEmitters) Object.freeze(receiptEmitters);
  if (underlyingCoins) Object.freeze(underlyingCoins);
  const verifiedRoutes = pool.verifiedRoutes?.map((route) =>
    Object.freeze({ ...route })
  );
  return Object.freeze({
    ...pool,
    ...(receiptEmitters === undefined
      ? {}
      : { receiptEmitters }),
    ...(underlyingCoins === undefined
      ? {}
      : { underlyingCoins }),
    ...(verifiedRoutes === undefined
      ? {}
      : { verifiedRoutes: Object.freeze(verifiedRoutes) }),
  });
}

function assertSamePhysicalLogs(
  members: readonly SharedLandedIdentityMember[],
): void {
  if (members.length < 2) return;
  const expected = members[0].context.logs;
  for (const member of members.slice(1)) {
    if (!samePhysicalLogSequence(member.context.logs, expected)) {
      throw new Error(
        `shared landed identity source diverged for ` +
          `${members[0].id}/${member.id}`,
      );
    }
  }
}

function samePhysicalLogSequence(
  left: LandedPoolMaterializationContext["logs"],
  right: LandedPoolMaterializationContext["logs"],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (
      a.address.toLowerCase() !== b.address.toLowerCase() ||
      a.data.toLowerCase() !== b.data.toLowerCase() ||
      parseBlockNumber(a.blockNumber) !== parseBlockNumber(b.blockNumber) ||
      a.topics.length !== b.topics.length
    ) {
      return false;
    }
    for (let topic = 0; topic < a.topics.length; topic++) {
      if (a.topics[topic].toLowerCase() !== b.topics[topic].toLowerCase()) {
        return false;
      }
    }
  }
  return true;
}

function parseBlockNumber(value: string | number): number {
  const parsed = typeof value === "number"
    ? value
    : value.startsWith("0x")
    ? parseInt(value, 16)
    : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
