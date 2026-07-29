import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import type { PoolEntry } from "../../planner/token-graph.js";
import type { PoolUniverseEntry } from "../../pool-universe.js";
import type {
  LandedPoolDiscoveryLog,
  LandedPoolDiscoveryLogFilter,
  LandedPoolDiscoveryReadBackend,
  LandedPoolMaterializationContext,
  LandedPoolMaterializationCapability,
  LandedPoolMaterializationResult,
  LandedPoolSharedIdentityCapability,
  LandedPoolSharedIdentityMaterializer,
  LandedPoolSharedIdentityProjection,
} from "../landed-pool-discovery.js";
import {
  isLandedPoolDiscoverySourceMismatchError,
} from "../landed-pool-discovery.js";
import {
  materializeSharedLandedPoolIdentity,
} from "../landed-pool-shared-identity.js";
import { UNIV4_INITIALIZE_TOPIC } from "../landed-event-registry.js";
import { UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK } from "./univ4-common.js";

const initializeIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const V4_POSITION_MANAGER_POOL_KEYS_SELECTOR = "0x86b6be7d";
const V4_HOT_MATERIALIZATION_BUDGET_MS = 5_000;
const V4_HOT_INITIALIZE_LOOKBACK_BLOCKS = 100_000;
const V4_INDEXED_BACKFILL_MAX_POOL_IDS = 32;

export type V4InitializeSource =
  | "alchemy-v4-initialize"
  | "v4-initialize-backfill"
  | "v4-positionmanager-poolkeys"
  | "retained-family-inventory";

export interface ParsedV4Initialize {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  source?: V4InitializeSource;
}

export interface UniV4PoolBuildResult {
  readonly pools: readonly PoolUniverseEntry[];
  readonly unresolvedPoolIds: readonly string[];
  readonly unresolved: readonly UniV4PoolActivity[];
}

export interface UniV4PoolActivity {
  readonly poolId: string;
  readonly count: number;
  readonly lastSwapBlock: number;
}

export const univ4PoolIdentityMaterializer = Object.freeze({
  id: "univ4-poolkey",
  version: "univ4-poolkey-identity-v1",
  identityKey(pool: PoolEntry): string {
    if (
      ethers.getAddress(pool.address).toLowerCase() !==
        ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase() ||
      pool.poolId === undefined
    ) {
      throw new Error("univ4 identity kernel requires manager + poolId");
    }
    return `${pool.address.toLowerCase()}|${
      normalizeBytes32Topic(pool.poolId, "identity poolId")
    }`;
  },
  revalidationPool(pool: PoolEntry): PoolEntry {
    if (pool.poolId === undefined) {
      throw new Error("univ4 revalidation requires poolId");
    }
    const activity = pool as PoolEntry & {
      readonly swapCount30d?: number;
      readonly lastSwapBlock?: number;
    };
    return Object.freeze({
      address: ethers.getAddress(pool.address),
      adapter: "univ4",
      poolId: normalizeBytes32Topic(
        pool.poolId,
        "revalidation poolId",
      ),
      ...(pool.score === undefined ? {} : { score: pool.score }),
      ...(activity.swapCount30d === undefined
        ? {}
        : { swapCount30d: activity.swapCount30d }),
      ...(activity.lastSwapBlock === undefined
        ? {}
        : { lastSwapBlock: activity.lastSwapBlock }),
      source: "landed-event-retry:univ4-swap",
    });
  },
  async materialize(
    context: LandedPoolMaterializationContext,
  ): Promise<LandedPoolMaterializationResult> {
    const retainedByPoolId = new Map(
      context.retainedPools.flatMap((pool) => {
        const parsed = retainedV4PoolKey(pool);
        return parsed ? [[parsed.poolId, parsed] as const] : [];
      }),
    );
    const retryActivity = v4RetryActivity(context.retryablePools);
    const initScan = await context.scanLogs({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: [UNIV4_INITIALIZE_TOPIC],
      fromBlock: context.fromBlock,
      toBlock: context.toBlock,
    });
    const bounded = context.historicalResolution === "bounded";
    const controller = bounded ? new AbortController() : null;
    const timer = controller === null
      ? null
      : setTimeout(
          () =>
            controller.abort(
              new Error(
                `univ4 PoolKey materialization exceeded ` +
                  `${V4_HOT_MATERIALIZATION_BUDGET_MS}ms`,
              ),
            ),
          V4_HOT_MATERIALIZATION_BUDGET_MS,
        );
    const signal = controller === null
      ? context.signal
      : context.signal === undefined
        ? controller.signal
        : AbortSignal.any([context.signal, controller.signal]);
    let resolutionIssue: string | null = null;
    let built: UniV4PoolBuildResult;
    try {
      built = await buildUniV4PoolEntries(
        initScan.logs,
        context.logs,
        context.minSwaps,
        undefined,
        async (poolIds) => {
          try {
            const resolved = new Map<string, ParsedV4Initialize>();
            const unresolved: string[] = [];
            const positionManagerResults = await mapLimit(
              poolIds,
              24,
              async (poolId) => {
                const retained = retainedByPoolId.get(poolId);
                if (retained) return retained;
                const viaPositionManager =
                  await resolveV4PoolKeyViaPositionManager(
                    context.backend,
                    ADDR.UNISWAP_V4_POSITION_MANAGER,
                    poolId,
                    signal,
                  );
                return viaPositionManager
                  ? {
                      ...viaPositionManager,
                      source: "v4-positionmanager-poolkeys" as const,
                    }
                  : null;
              },
            );
            for (let index = 0; index < poolIds.length; index++) {
              const parsed = positionManagerResults[index];
              if (parsed) resolved.set(parsed.poolId, parsed);
              else unresolved.push(poolIds[index]);
            }
            const historical = await resolveV4InitsBackward(
              context.backend,
              ADDR.UNISWAP_V4_POOL_MANAGER,
              UNIV4_INITIALIZE_TOPIC,
              unresolved,
              context.toBlock,
              100_000,
              bounded ? V4_HOT_INITIALIZE_LOOKBACK_BLOCKS : undefined,
              signal,
            );
            for (const parsed of historical.values()) {
              resolved.set(parsed.poolId, parsed);
            }
            return [...resolved.values()];
          } catch (error) {
            if (context.signal?.aborted) {
              throw context.signal.reason ?? error;
            }
            if (isLandedPoolDiscoverySourceMismatchError(error)) {
              throw error;
            }
            if (controller?.signal.aborted) {
              resolutionIssue =
                `univ4 PoolKey materialization exceeded ` +
                `${V4_HOT_MATERIALIZATION_BUDGET_MS}ms`;
              return [];
            }
            resolutionIssue =
              `univ4 PoolKey materialization deferred: ` +
              `${error instanceof Error ? error.message : String(error)}`;
            return [];
          }
        },
        retryActivity,
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const retryablePools = built.unresolved.map(v4RetryPoolEntry);
    const issues = [
      ...initScan.issues,
      ...(resolutionIssue === null ? [] : [resolutionIssue]),
      ...built.unresolvedPoolIds.map((poolId) =>
        `unresolved PoolKey ${poolId}`
      ),
    ];
    return {
      pools: built.pools,
      complete: initScan.complete && built.unresolvedPoolIds.length === 0,
      issues,
      ...(retryablePools.length === 0
        ? {}
        : { retryablePools: Object.freeze(retryablePools) }),
    };
  },
} satisfies LandedPoolSharedIdentityMaterializer);

const univ4PoolIdentityProjection = Object.freeze({
  version: "univ4-poolkey-projection-v1",
  toIdentityPool(pool: PoolEntry): PoolEntry | null {
    return pool.adapter === "univ4" ? pool : null;
  },
  projectPool(pool: PoolEntry): PoolEntry | null {
    if (pool.adapter !== "univ4") {
      throw new Error("univ4 identity kernel emitted a non-univ4 row");
    }
    return pool;
  },
  projectRetry(pool: PoolEntry): PoolEntry {
    if (pool.adapter !== "univ4") {
      throw new Error("univ4 identity kernel emitted a foreign retry row");
    }
    return pool;
  },
} satisfies LandedPoolSharedIdentityProjection);

const univ4SharedIdentity = Object.freeze({
  materializer: univ4PoolIdentityMaterializer,
  projection: univ4PoolIdentityProjection,
} satisfies LandedPoolSharedIdentityCapability);

export const univ4PoolDiscovery = Object.freeze({
  version: "univ4-poolkey-materializer-v2",
  eventIds: ["univ4-swap"],
  consumesOpaqueRetries: true,
  sharedIdentity: univ4SharedIdentity,
  materialize(context: LandedPoolMaterializationContext) {
    return materializeSharedLandedPoolIdentity(
      univ4SharedIdentity,
      context,
    );
  },
} satisfies LandedPoolMaterializationCapability);

function retainedV4PoolKey(pool: PoolEntry): ParsedV4Initialize | null {
  if (
    pool.adapter !== "univ4" ||
    !pool.poolId ||
    !pool.currency0 ||
    !pool.currency1 ||
    pool.fee === undefined ||
    pool.tickSpacing === undefined ||
    !pool.hooks
  ) {
    return null;
  }
  const parsed: ParsedV4Initialize = {
    poolId: normalizeBytes32Topic(pool.poolId, "retained poolId"),
    currency0: ethers.getAddress(pool.currency0),
    currency1: ethers.getAddress(pool.currency1),
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: ethers.getAddress(pool.hooks),
    source: "retained-family-inventory",
  };
  const recomputed = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [
        parsed.currency0,
        parsed.currency1,
        parsed.fee,
        parsed.tickSpacing,
        parsed.hooks,
      ],
    ),
  );
  return recomputed.toLowerCase() === parsed.poolId ? parsed : null;
}

function v4RetryActivity(
  pools: readonly PoolEntry[],
): readonly UniV4PoolActivity[] {
  return pools
    .filter((pool) => pool.adapter === "univ4")
    .map((pool) => {
      if (
        ethers.getAddress(pool.address).toLowerCase() !==
          ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase() ||
        pool.poolId === undefined
      ) {
        throw new Error("invalid typed univ4 materialization retry");
      }
      const activity = pool as PoolEntry & {
        readonly swapCount30d?: number;
        readonly lastSwapBlock?: number;
      };
      const count = Math.max(
        1,
        Math.floor(activity.swapCount30d ?? pool.score ?? 1),
      );
      const lastSwapBlock =
        Number.isSafeInteger(activity.lastSwapBlock) &&
          (activity.lastSwapBlock ?? -1) >= 0
          ? activity.lastSwapBlock!
          : 0;
      return Object.freeze({
        poolId: normalizeBytes32Topic(pool.poolId, "retry poolId"),
        count,
        lastSwapBlock,
      });
    });
}

function v4RetryPoolEntry(
  activity: UniV4PoolActivity,
): PoolUniverseEntry {
  return Object.freeze({
    address: ADDR.UNISWAP_V4_POOL_MANAGER,
    adapter: "univ4",
    poolId: activity.poolId,
    score: activity.count,
    swapCount30d: activity.count,
    lastSwapBlock: activity.lastSwapBlock,
    source: "landed-event-retry:univ4-swap",
  });
}

export async function buildUniV4PoolEntries(
  initLogs: readonly LandedPoolDiscoveryLog[],
  swapLogs: readonly LandedPoolDiscoveryLog[],
  minSwaps: number,
  resolveMissingInit?: (
    poolId: string,
  ) => Promise<ParsedV4Initialize | null>,
  resolveMissingInits?: (
    poolIds: readonly string[],
  ) => Promise<readonly ParsedV4Initialize[]>,
  activitySeeds: readonly UniV4PoolActivity[] = [],
): Promise<UniV4PoolBuildResult> {
  const activity = new Map<string, { count: number; lastSwapBlock: number }>();
  for (const seed of activitySeeds) {
    const poolId = normalizeBytes32Topic(seed.poolId, "activity seed poolId");
    const existing = activity.get(poolId);
    activity.set(poolId, {
      count: Math.max(existing?.count ?? 0, seed.count),
      lastSwapBlock: Math.max(
        existing?.lastSwapBlock ?? 0,
        seed.lastSwapBlock,
      ),
    });
  }
  for (const log of swapLogs) {
    const poolId = normalizeBytes32Topic(log.topics[1], "Swap.id");
    const block = parseLogBlockNumber(log.blockNumber);
    const item = activity.get(poolId) ?? { count: 0, lastSwapBlock: 0 };
    item.count++;
    item.lastSwapBlock = Math.max(item.lastSwapBlock, block);
    activity.set(poolId, item);
  }

  const initByPoolId = new Map<string, ParsedV4Initialize>();
  for (const log of initLogs) {
    const parsed = parseV4InitializeLog(log);
    initByPoolId.set(parsed.poolId, parsed);
  }

  const qualifying = [...activity.entries()]
    .filter(([, item]) => item.count >= minSwaps);
  const resolved = new Map<string, { parsed: ParsedV4Initialize; source: string }>();
  for (const [poolId] of qualifying) {
    const parsed = initByPoolId.get(poolId);
    if (parsed) {
      resolved.set(poolId, {
        parsed,
        source: parsed.source ?? "alchemy-v4-initialize",
      });
    }
  }

  let missing = qualifying
    .map(([poolId]) => poolId)
    .filter((poolId) => !resolved.has(poolId));
  if (resolveMissingInits && missing.length > 0) {
    const requested = new Set(missing);
    const backfilled = await resolveMissingInits(missing);
    for (const parsed of backfilled) {
      const poolId = normalizeBytes32Topic(parsed.poolId, "batch resolver poolId");
      if (!requested.has(poolId)) {
        throw new Error(`univ4 batch resolver returned unrequested PoolKey ${poolId}`);
      }
      resolved.set(poolId, {
        parsed,
        source: parsed.source ?? "v4-initialize-backfill",
      });
    }
    missing = missing.filter((poolId) => !resolved.has(poolId));
  }

  if (resolveMissingInit && missing.length > 0) {
    const backfilled = await mapLimit(missing, 24, async (poolId) => {
      const parsed = await resolveMissingInit(poolId);
      return parsed ? { poolId, parsed } : null;
    });
    for (const item of backfilled) {
      if (item) {
        resolved.set(item.poolId, {
          parsed: item.parsed,
          source: item.parsed.source ?? "v4-initialize-backfill",
        });
      }
    }
  }

  const pools: PoolUniverseEntry[] = [];
  const unresolvedPoolIds: string[] = [];
  for (const [poolId, item] of qualifying) {
    const init = resolved.get(poolId);
    if (!init) {
      unresolvedPoolIds.push(poolId);
      continue;
    }
    pools.push(v4PoolEntryFromInitialize(init.parsed, item, init.source));
  }
  pools.sort((a, b) =>
    (b.score ?? 0) - (a.score ?? 0) ||
    (b.lastSwapBlock ?? 0) - (a.lastSwapBlock ?? 0)
  );
  return {
    pools: Object.freeze(pools),
    unresolvedPoolIds: Object.freeze(unresolvedPoolIds),
    unresolved: Object.freeze(
      unresolvedPoolIds.map((poolId) => {
        const item = activity.get(poolId);
        if (!item) {
          throw new Error(`missing univ4 activity for ${poolId}`);
        }
        return Object.freeze({
          poolId,
          count: item.count,
          lastSwapBlock: item.lastSwapBlock,
        });
      }),
    ),
  };
}

/** Compatibility helper for the existing focused fixture tests. */
export async function buildV4PoolEntries(
  initLogs: readonly LandedPoolDiscoveryLog[],
  swapLogs: readonly LandedPoolDiscoveryLog[],
  minSwaps: number,
  resolveMissingInit?: (
    poolId: string,
  ) => Promise<ParsedV4Initialize | null>,
  resolveMissingInits?: (
    poolIds: readonly string[],
  ) => Promise<readonly ParsedV4Initialize[]>,
): Promise<PoolUniverseEntry[]> {
  return [
    ...(await buildUniV4PoolEntries(
      initLogs,
      swapLogs,
      minSwaps,
      resolveMissingInit,
      resolveMissingInits,
    )).pools,
  ];
}

/**
 * Resolve opaque V4 pool ids newest-first. Small live sets use indexed PoolId
 * reads so one recent pool never triggers a full-family historical crawl;
 * large offline sets amortize broad Initialize scans and stop after the first
 * wave that resolves every requested identity.
 */
export async function resolveV4InitsBackward(
  source:
    | Pick<LandedPoolDiscoveryReadBackend, "getLogs">
    | ethers.JsonRpcProvider,
  poolManagerAddr: string,
  topic: string,
  poolIds: readonly string[],
  searchFromBlock: number,
  chunkSize = 100_000,
  maxLookbackBlocks?: number,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ParsedV4Initialize>> {
  const backend = normalizeDiscoveryBackend(source);
  const requested = [...new Set(
    poolIds.map((poolId) => normalizeBytes32Topic(poolId, "poolId")),
  )];
  const configuredLookback = resolveV4BackfillLookback(
    searchFromBlock,
    maxLookbackBlocks,
  );
  const remainingById = new Set(requested);
  const resolved = new Map<string, ParsedV4Initialize>();
  let remainingBlocks = Number.isFinite(configuredLookback)
    ? Math.max(0, Math.floor(configuredLookback))
    : defaultV4BackfillLookback(searchFromBlock);
  const normalizedChunkSize = Number.isFinite(chunkSize)
    ? Math.max(1, Math.floor(chunkSize))
    : 100_000;
  let chunkEnd = Math.max(0, Math.floor(searchFromBlock));
  const ranges: Array<{ fromBlock: number; toBlock: number }> = [];
  while (remainingBlocks > 0 && chunkEnd >= 0) {
    const blockCount = Math.min(
      normalizedChunkSize,
      remainingBlocks,
      chunkEnd + 1,
    );
    const chunkStart = chunkEnd - blockCount + 1;
    ranges.push({ fromBlock: chunkStart, toBlock: chunkEnd });
    remainingBlocks -= blockCount;
    chunkEnd = chunkStart - 1;
  }

  if (requested.length <= V4_INDEXED_BACKFILL_MAX_POOL_IDS) {
    const exact = await mapLimit(
      requested,
      8,
      (poolId) =>
        resolveIndexedV4Initialize(
          backend,
          poolManagerAddr,
          topic,
          poolId,
          ranges,
          signal,
        ),
    );
    for (const parsed of exact) {
      if (!parsed) continue;
      resolved.set(parsed.poolId, parsed);
      remainingById.delete(parsed.poolId);
    }
    return resolved;
  }

  // Large offline/startup sets amortize one broad family scan across many
  // identities. Process newest-first in bounded waves and stop as soon as all
  // requested PoolIds resolve; the previous implementation launched every
  // historical range up front even when the first range already proved them.
  for (
    let groupStart = 0;
    groupStart < ranges.length && remainingById.size > 0;
    groupStart += 8
  ) {
    const historicalLogs = await mapLimit(
      ranges.slice(groupStart, groupStart + 8),
      8,
      (range) =>
        getLogsWithAdaptiveRange(backend, {
          address: poolManagerAddr,
          topics: [topic],
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        }, signal),
    );
    for (const logs of historicalLogs) {
      for (const log of logs) {
        const parsed = {
          ...parseV4InitializeLog(log),
          source: "v4-initialize-backfill" as const,
        };
        if (!remainingById.has(parsed.poolId)) continue;
        resolved.set(parsed.poolId, parsed);
        remainingById.delete(parsed.poolId);
      }
    }
  }

  // Some archive/indexer RPCs silently cap a broad family-topic result set.
  // Prove every still-missing identity with its indexed PoolId instead of
  // weakening strict materialization.
  if (remainingById.size > 0) {
    const exactResults = await mapLimit(
      [...remainingById],
      4,
      (poolId) =>
        resolveIndexedV4Initialize(
          backend,
          poolManagerAddr,
          topic,
          poolId,
          ranges,
          signal,
        ),
    );
    for (const parsed of exactResults) {
      if (!parsed) continue;
      resolved.set(parsed.poolId, parsed);
      remainingById.delete(parsed.poolId);
    }
  }
  return resolved;
}

async function resolveIndexedV4Initialize(
  backend: Pick<LandedPoolDiscoveryReadBackend, "getLogs">,
  poolManagerAddr: string,
  topic: string,
  poolId: string,
  ranges: readonly { readonly fromBlock: number; readonly toBlock: number }[],
  signal?: AbortSignal,
): Promise<ParsedV4Initialize | null> {
  for (const range of ranges) {
    const logs = await getLogsWithAdaptiveRange(backend, {
      address: poolManagerAddr,
      topics: [topic, poolId],
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    }, signal);
    for (const log of logs) {
      const parsed = {
        ...parseV4InitializeLog(log),
        source: "v4-initialize-backfill" as const,
      };
      if (parsed.poolId === poolId) return parsed;
    }
  }
  return null;
}

/**
 * Archive providers impose different eth_getLogs span/result limits. Split a
 * failed non-pruned range into stable, disjoint halves until it succeeds.
 * A one-block failure remains an error so callers cannot publish an omitted
 * identity as a completed historical scan.
 */
async function getLogsWithAdaptiveRange(
  backend: Pick<LandedPoolDiscoveryReadBackend, "getLogs">,
  filter: LandedPoolDiscoveryLogFilter,
  signal?: AbortSignal,
): Promise<readonly LandedPoolDiscoveryLog[]> {
  throwIfAborted(signal);
  try {
    return await backend.getLogs(filter, { signal });
  } catch (error) {
    throwIfAborted(signal, error);
    if (isAbortError(error)) throw error;
    if (isLandedPoolDiscoverySourceMismatchError(error)) throw error;
    if (isPrunedHistoryError(error)) return [];
    if (filter.fromBlock >= filter.toBlock) throw error;

    const midpoint = Math.floor((filter.fromBlock + filter.toBlock) / 2);
    const lower = await getLogsWithAdaptiveRange(
      backend,
      {
        ...filter,
        toBlock: midpoint,
      },
      signal,
    );
    const upper = await getLogsWithAdaptiveRange(
      backend,
      {
        ...filter,
        fromBlock: midpoint + 1,
      },
      signal,
    );
    return [...lower, ...upper];
  }
}

export async function resolveV4PoolKeyViaPositionManager(
  source:
    | Pick<LandedPoolDiscoveryReadBackend, "call">
    | ethers.JsonRpcProvider,
  positionManagerAddr: string,
  poolId: string,
  signal?: AbortSignal,
): Promise<ParsedV4Initialize | null> {
  const backend = normalizeDiscoveryBackend(source);
  const normalizedPoolId = normalizeBytes32Topic(poolId, "poolId");
  const poolIdPrefix = normalizedPoolId.slice(2, 52);
  const data = V4_POSITION_MANAGER_POOL_KEYS_SELECTOR +
    poolIdPrefix.padEnd(64, "0");
  try {
    const result = await backend.call(
      {
        to: ethers.getAddress(positionManagerAddr),
        data,
      },
      signal === undefined ? undefined : { signal },
    );
    const [currency0, currency1, fee, tickSpacing, hooks] =
      ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "address", "uint24", "int24", "address"],
        result,
      );
    const parsed: ParsedV4Initialize = {
      poolId: normalizedPoolId,
      currency0: ethers.getAddress(String(currency0)),
      currency1: ethers.getAddress(String(currency1)),
      fee: Number(fee),
      tickSpacing: Number(tickSpacing),
      hooks: ethers.getAddress(String(hooks)),
    };
    const recomputed = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "int24", "address"],
        [
          parsed.currency0,
          parsed.currency1,
          parsed.fee,
          parsed.tickSpacing,
          parsed.hooks,
        ],
      ),
    );
    return recomputed.toLowerCase() === normalizedPoolId ? parsed : null;
  } catch (error) {
    throwIfAborted(signal, error);
    return null;
  }
}

export async function resolveV4InitBackward(
  source:
    | Pick<LandedPoolDiscoveryReadBackend, "getLogs">
    | ethers.JsonRpcProvider,
  poolManagerAddr: string,
  topic: string,
  poolId: string,
  searchFromBlock: number,
  chunkSize = 100_000,
  maxLookbackBlocks?: number,
): Promise<LandedPoolDiscoveryLog | null> {
  const backend = normalizeDiscoveryBackend(source);
  const configuredLookback = resolveV4BackfillLookback(
    searchFromBlock,
    maxLookbackBlocks,
  );
  const lookbackBlocks = Number.isFinite(configuredLookback)
    ? Math.max(0, Math.floor(configuredLookback))
    : defaultV4BackfillLookback(searchFromBlock);
  const normalizedChunkSize = Number.isFinite(chunkSize)
    ? Math.max(1, Math.floor(chunkSize))
    : 100_000;
  let remaining = lookbackBlocks;
  let chunkEnd = Math.max(0, Math.floor(searchFromBlock));
  while (remaining > 0 && chunkEnd >= 0) {
    const blockCount = Math.min(
      normalizedChunkSize,
      remaining,
      chunkEnd + 1,
    );
    const chunkStart = chunkEnd - blockCount + 1;
    try {
      const logs = await backend.getLogs({
        address: poolManagerAddr,
        topics: [topic, poolId],
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });
      if (logs.length > 0) return logs[0];
    } catch (error) {
      if (isPrunedHistoryError(error)) return null;
      try {
        const logs = await backend.getLogs({
          address: poolManagerAddr,
          topics: [topic, poolId],
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        });
        if (logs.length > 0) return logs[0];
      } catch (retryError) {
        if (isPrunedHistoryError(retryError)) return null;
      }
    }
    remaining -= blockCount;
    chunkEnd = chunkStart - 1;
  }
  return null;
}

export async function resolveV4InitViaPositionManagerThenBackward(
  source: LandedPoolDiscoveryReadBackend | ethers.JsonRpcProvider,
  positionManagerAddr: string,
  poolManagerAddr: string,
  topic: string,
  poolId: string,
  searchFromBlock: number,
  chunkSize = 100_000,
  maxLookbackBlocks?: number,
): Promise<ParsedV4Initialize | null> {
  const backend = normalizeDiscoveryBackend(source);
  const viaPositionManager = await resolveV4PoolKeyViaPositionManager(
    backend,
    positionManagerAddr,
    poolId,
  );
  if (viaPositionManager) {
    return {
      ...viaPositionManager,
      source: "v4-positionmanager-poolkeys",
    };
  }
  const log = await resolveV4InitBackward(
    backend,
    poolManagerAddr,
    topic,
    poolId,
    searchFromBlock,
    chunkSize,
    maxLookbackBlocks,
  );
  return log
    ? {
        ...parseV4InitializeLog(log),
        source: "v4-initialize-backfill",
      }
    : null;
}

function defaultV4BackfillLookback(searchFromBlock: number): number {
  return Math.max(
    0,
    Math.floor(searchFromBlock) - UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 1,
  );
}

function resolveV4BackfillLookback(
  searchFromBlock: number,
  explicit?: number,
): number {
  if (explicit !== undefined) return explicit;
  const configured = process.env.POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS;
  return configured === undefined
    ? defaultV4BackfillLookback(searchFromBlock)
    : Number(configured);
}

function parseV4InitializeLog(
  log: LandedPoolDiscoveryLog,
): ParsedV4Initialize {
  const parsed = initializeIface.parseLog({
    topics: [...log.topics],
    data: log.data,
  });
  if (!parsed) throw new Error("failed to parse univ4 Initialize log");
  return {
    poolId: normalizeBytes32Topic(String(parsed.args.id), "Initialize.id"),
    currency0: ethers.getAddress(String(parsed.args.currency0)),
    currency1: ethers.getAddress(String(parsed.args.currency1)),
    fee: Number(parsed.args.fee),
    tickSpacing: Number(parsed.args.tickSpacing),
    hooks: ethers.getAddress(String(parsed.args.hooks)),
  };
}

function v4PoolEntryFromInitialize(
  parsed: ParsedV4Initialize,
  activity: { count: number; lastSwapBlock: number },
  source: string,
): PoolUniverseEntry {
  return {
    address: ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER),
    adapter: "univ4",
    venueId: "univ4",
    identitySource: "v4-manager",
    poolId: parsed.poolId,
    currency0: parsed.currency0,
    currency1: parsed.currency1,
    fee: parsed.fee,
    tickSpacing: parsed.tickSpacing,
    hooks: parsed.hooks,
    fixedTokenIn: parsed.currency0,
    fixedTokenOut: parsed.currency1,
    score: activity.count,
    swapCount30d: activity.count,
    lastSwapBlock: activity.lastSwapBlock,
    source,
  };
}

function normalizeDiscoveryBackend(
  source:
    | Pick<LandedPoolDiscoveryReadBackend, "call">
    | Pick<LandedPoolDiscoveryReadBackend, "getLogs">
    | LandedPoolDiscoveryReadBackend
    | ethers.JsonRpcProvider,
): LandedPoolDiscoveryReadBackend {
  if ("send" in source && typeof source.send === "function") {
    const provider = source as ethers.JsonRpcProvider;
    return {
      getLogs(filter) {
        return provider.send("eth_getLogs", [{
          ...(filter.address === undefined ? {} : { address: filter.address }),
          topics: [...filter.topics],
          fromBlock: ethers.toQuantity(filter.fromBlock),
          toBlock: ethers.toQuantity(filter.toBlock),
        }]);
      },
      call(req) {
        return provider.send("eth_call", [req, "latest"]);
      },
    };
  }
  const partial = source as Partial<LandedPoolDiscoveryReadBackend>;
  return {
    getLogs: partial.getLogs
      ? partial.getLogs.bind(source)
      : async () => {
          throw new Error("univ4 discovery backend lacks getLogs");
        },
    call: partial.call
      ? partial.call.bind(source)
      : async () => {
          throw new Error("univ4 discovery backend lacks call");
        },
  };
}

function normalizeBytes32Topic(
  value: string | undefined,
  field: string,
): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`univ4 ${field} must be bytes32`);
  }
  return value.toLowerCase();
}

function parseLogBlockNumber(value: string | number): number {
  const block = typeof value === "number"
    ? value
    : value.startsWith("0x")
    ? parseInt(value, 16)
    : Number(value);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error(`invalid log blockNumber: ${value}`);
  }
  return block;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function isPrunedHistoryError(error: unknown): boolean {
  return /pruned|not available/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal, cause?: unknown): void {
  if (!signal?.aborted) return;
  throw signal.reason ??
    cause ??
    new DOMException("Aborted", "AbortError");
}
