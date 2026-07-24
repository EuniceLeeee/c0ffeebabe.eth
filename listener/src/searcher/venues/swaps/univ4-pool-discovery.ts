import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import type { PoolEntry } from "../../planner/token-graph.js";
import type { PoolUniverseEntry } from "../../pool-universe.js";
import type {
  LandedPoolDiscoveryLog,
  LandedPoolDiscoveryReadBackend,
  LandedPoolMaterializationCapability,
  LandedPoolMaterializationResult,
} from "../landed-pool-discovery.js";
import { UNIV4_INITIALIZE_TOPIC } from "../landed-event-registry.js";
import { UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK } from "./univ4-common.js";

const initializeIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const V4_POSITION_MANAGER_POOL_KEYS_SELECTOR = "0x86b6be7d";

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
}

export const univ4PoolDiscovery = Object.freeze({
  version: "univ4-poolkey-materializer-v1",
  eventIds: ["univ4-swap"],
  async materialize(context): Promise<LandedPoolMaterializationResult> {
    const retainedByPoolId = new Map(
      context.retainedPools.flatMap((pool) => {
        const parsed = retainedV4PoolKey(pool);
        return parsed ? [[parsed.poolId, parsed] as const] : [];
      }),
    );
    const initScan = await context.scanLogs({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: [UNIV4_INITIALIZE_TOPIC],
      fromBlock: context.fromBlock,
      toBlock: context.toBlock,
    });
    const built = await buildUniV4PoolEntries(
      initScan.logs,
      context.logs,
      context.minSwaps,
      undefined,
      async (poolIds) => {
        const resolved = new Map<string, ParsedV4Initialize>();
        const unresolved: string[] = [];
        const positionManagerResults = await mapLimit(
          poolIds,
          24,
          async (poolId) => {
            const retained = retainedByPoolId.get(poolId);
            if (retained) return retained;
            const viaPositionManager = await resolveV4PoolKeyViaPositionManager(
              context.backend,
              ADDR.UNISWAP_V4_POSITION_MANAGER,
              poolId,
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
          context.fromBlock,
          100_000,
          undefined,
          context.signal,
        );
        for (const parsed of historical.values()) {
          resolved.set(parsed.poolId, parsed);
        }
        return [...resolved.values()];
      },
    );
    const issues = [
      ...initScan.issues,
      ...built.unresolvedPoolIds.map((poolId) =>
        `unresolved PoolKey ${poolId}`
      ),
    ];
    return {
      pools: built.pools,
      complete: initScan.complete && built.unresolvedPoolIds.length === 0,
      issues,
    };
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
): Promise<UniV4PoolBuildResult> {
  const activity = new Map<string, { count: number; lastSwapBlock: number }>();
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
 * Resolve many opaque V4 pool ids with one historical Initialize scan per
 * block chunk. Scanning the family event once and filtering pool ids locally
 * avoids both pools × chunks fan-out and provider-specific topic-OR limits.
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
  const historicalLogs = await mapLimit(ranges, 8, async (range) => {
      const filter = {
        address: poolManagerAddr,
        topics: [topic],
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
      } as const;
      try {
        return await backend.getLogs(filter, { signal });
      } catch (error) {
        if (isPrunedHistoryError(error)) return [];
        try {
          return await backend.getLogs(filter, { signal });
        } catch (retryError) {
          if (isPrunedHistoryError(retryError)) return [];
          throw retryError;
        }
      }
  });
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
  // Some archive/indexer RPCs silently cap a broad family-topic result set.
  // Preserve the efficient broad scan, then prove every still-missing identity
  // with its indexed poolId instead of weakening strict materialization.
  if (remainingById.size > 0 && ranges.length > 0) {
    const exactFromBlock = ranges[ranges.length - 1].fromBlock;
    const exactResults = await mapLimit(
      [...remainingById],
      4,
      async (poolId) => {
        const filter = {
          address: poolManagerAddr,
          topics: [topic, poolId],
          fromBlock: exactFromBlock,
          toBlock: Math.max(0, Math.floor(searchFromBlock)),
        } as const;
        try {
          return await backend.getLogs(filter, { signal });
        } catch (error) {
          if (isPrunedHistoryError(error)) return [];
          try {
            return await backend.getLogs(filter, { signal });
          } catch (retryError) {
            if (isPrunedHistoryError(retryError)) return [];
            throw retryError;
          }
        }
      },
    );
    for (const logs of exactResults) {
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
  return resolved;
}

export async function resolveV4PoolKeyViaPositionManager(
  source:
    | Pick<LandedPoolDiscoveryReadBackend, "call">
    | ethers.JsonRpcProvider,
  positionManagerAddr: string,
  poolId: string,
): Promise<ParsedV4Initialize | null> {
  const backend = normalizeDiscoveryBackend(source);
  const normalizedPoolId = normalizeBytes32Topic(poolId, "poolId");
  const poolIdPrefix = normalizedPoolId.slice(2, 52);
  const data = V4_POSITION_MANAGER_POOL_KEYS_SELECTOR +
    poolIdPrefix.padEnd(64, "0");
  try {
    const result = await backend.call({
      to: ethers.getAddress(positionManagerAddr),
      data,
    });
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
  } catch {
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
