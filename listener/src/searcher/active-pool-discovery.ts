import {
  ethers,
  type JsonRpcError,
  type JsonRpcPayload,
} from "ethers";
import type { PoolEntry } from "./planner/token-graph.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "./pool-universe.js";
import {
  factoryDiscoverySourcesForPoolAdapters,
  type VenueId,
} from "./venues/capability.js";
import {
  attestPoolIdentities,
  isRetryablePoolIdentityFailure,
  type IdentityCallBackend,
} from "./venues/identity.js";
import {
  STRICT_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./venues/admission.js";
import {
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_ADAPTER_FAMILIES,
} from "./venues/production-registry.js";
import {
  discoverLandedPools,
  LandedPoolDiscoverySourceMismatchError,
  type LandedPoolCacheRevalidation,
  type LandedPoolDiscoveryCoverage,
  type LandedPoolDiscoveryLog,
  type LandedPoolDiscoveryLogFilter,
  type LandedPoolDiscoveryReadBackend,
} from "./venues/landed-pool-discovery.js";

// Factory event topics
const UNIV2_PAIR_CREATED = ethers.id("PairCreated(address,address,address,uint256)");
const UNIV3_POOL_CREATED = ethers.id("PoolCreated(address,address,uint24,int24,address)");

// ─── Factory-based full pool indexing ───────────────────────

const FACTORY_LOG_BATCH = 5000;

export interface DexDiscoveryReadControl {
  /** Absolute wall-clock deadline shared by the enclosing discovery generation. */
  readonly deadlineAtMs?: number;
  /** Aborting this signal aborts the underlying HTTP request, not only its waiter. */
  readonly signal?: AbortSignal;
  /** Optional dedicated background-read semaphore (for DiscoveryBackfillLane). */
  readonly run?: <T>(
    work: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

interface FactoryDef {
  address: string;
  topic: string;
  adapter: "univ2" | "univ3";
  venueId: VenueId;
  parsePool: (log: { data: string; topics: string[] }) => string;
}

interface FactoryDiscoveryLog {
  readonly address: string;
  readonly data: string;
  readonly topics: string[];
}

const FACTORIES: FactoryDef[] = factoryDiscoverySourcesForPoolAdapters(
  PRODUCTION_ADAPTER_FAMILIES.matureDexUniversePoolAdapters(),
).flatMap((identity) => {
  const adapter = identity.poolAdapter;
  return identity.discovery.factories.map((address) => ({
    address,
    adapter,
    venueId: identity.venue,
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
  options: {
    readonly strict?: boolean;
    readonly control?: DexDiscoveryReadControl;
  } = {},
): Promise<PoolEntry[]> {
  const latest = toBlock ?? (
    hasDexDiscoveryControl(options.control)
      ? await readDexDiscoveryBlockNumber(provider, options.control)
      : await provider.getBlockNumber()
  );
  const fromBlock = Math.max(0, latest - blocksBack);
  const pools: PoolEntry[] = [];
  const logsByFactory = new Map<string, FactoryDiscoveryLog[]>();
  const factoryByAddress = new Map(
    FACTORIES.map((factory) => [factory.address.toLowerCase(), factory] as const),
  );

  /*
   * Every registered factory is scanned over the same canonical range. One
   * address/topic union preserves that exact source coverage while avoiding a
   * serial eth_getLogs round trip per factory. Bucket by emitting address and
   * replay FACTORIES order below so the returned registry remains stable.
   */
  for (let start = fromBlock; start <= latest; start += FACTORY_LOG_BATCH) {
    throwIfDexDiscoveryCancelled(options.control);
    const end = Math.min(start + FACTORY_LOG_BATCH - 1, latest);
    const logs = options.strict
      ? await sendDexDiscoveryRpc<FactoryDiscoveryLog[]>(
          provider,
          "eth_getLogs",
          [factoryUnionLogFilter(start, end)],
          options.control,
        )
      : await getFactoryLogs(provider, start, end, options.control);
    for (const log of logs) {
      const factory = factoryByAddress.get(log.address.toLowerCase());
      if (
        !factory ||
        log.topics[0]?.toLowerCase() !== factory.topic.toLowerCase()
      ) continue;
      const key = factory.address.toLowerCase();
      const bucket = logsByFactory.get(key) ?? [];
      bucket.push(log);
      logsByFactory.set(key, bucket);
    }
  }

  for (const factory of FACTORIES) {
    let count = 0;
    for (const log of logsByFactory.get(factory.address.toLowerCase()) ?? []) {
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
    console.log(`[discovery] ${factory.adapter} factory (${factory.address.slice(0, 10)}): ${count} new pools in last ${blocksBack} blocks`);
  }

  return pools;
}

async function getFactoryLogs(
  provider: ethers.JsonRpcProvider,
  from: number,
  to: number,
  control?: DexDiscoveryReadControl,
): Promise<FactoryDiscoveryLog[]> {
  try {
    return await sendDexDiscoveryRpc(
      provider,
      "eth_getLogs",
      [factoryUnionLogFilter(from, to)],
      control,
    );
  } catch (error) {
    if (isDexDiscoveryCancellationError(error)) throw error;
    throwIfDexDiscoveryCancelled(control, error);
    // Range too large — split into smaller chunks
    const results: FactoryDiscoveryLog[] = [];
    for (let s = from; s <= to; s += 1000) {
      throwIfDexDiscoveryCancelled(control);
      const e = Math.min(s + 999, to);
      try {
        results.push(...await sendDexDiscoveryRpc<FactoryDiscoveryLog[]>(
          provider,
          "eth_getLogs",
          [factoryUnionLogFilter(s, e)],
          control,
        ));
      } catch (chunkError) {
        if (isDexDiscoveryCancellationError(chunkError)) throw chunkError;
        throwIfDexDiscoveryCancelled(control, chunkError);
        /*
         * Some providers reject a large address/topic OR even over a short
         * range. Preserve the old per-factory best-effort coverage as the
         * final fallback instead of dropping every factory in this chunk.
         */
        for (const factory of FACTORIES) {
          throwIfDexDiscoveryCancelled(control);
          try {
            results.push(...await sendDexDiscoveryRpc<FactoryDiscoveryLog[]>(
              provider,
              "eth_getLogs",
              [factoryLogFilter(factory, s, e)],
              control,
            ));
          } catch (factoryError) {
            if (isDexDiscoveryCancellationError(factoryError)) {
              throw factoryError;
            }
            throwIfDexDiscoveryCancelled(control, factoryError);
            // Non-strict discovery retains the legacy best-effort behavior.
          }
        }
      }
    }
    return results;
  }
}

function factoryLogFilter(
  factory: FactoryDef,
  fromBlock: number,
  toBlock: number,
): Record<string, unknown> {
  return {
    address: factory.address,
    fromBlock: ethers.toQuantity(fromBlock),
    toBlock: ethers.toQuantity(toBlock),
    topics: [factory.topic],
  };
}

function factoryUnionLogFilter(
  fromBlock: number,
  toBlock: number,
): Record<string, unknown> {
  return {
    address: FACTORIES.map((factory) => factory.address),
    fromBlock: ethers.toQuantity(fromBlock),
    toBlock: ethers.toQuantity(toBlock),
    topics: [[...new Set(FACTORIES.map((factory) => factory.topic))]],
  };
}

const LOG_BATCH = 50;
const RETRY_LOG_BATCH = 10;

export interface ActivePoolDiscoveryOptions {
  admissionPolicy?: IdentityAdmissionPolicy;
  /**
   * Pool identities already admitted into the current graph generation.
   * Landed coverage still observes them, but address materialization and the
   * final identity pass may skip their source-pinned identity reads. Pools
   * that previously failed projection are deliberately absent and retry.
   */
  knownPoolKeys?: ReadonlySet<string>;
  /**
   * Source-pinned identity/code reads for an unbounded legacy generation.
   * A controlled generation deliberately uses the provider-backed abortable
   * transport below so every in-flight identity RPC shares its cancellation.
   */
  identityBackend?: IdentityCallBackend;
  /** Numeric source block used by family-owned singleton metadata reads. */
  identityBlockTag?: ethers.BlockTag;
  /**
   * Previously verified family inventory. Singleton materializers use this to
   * resolve opaque identities (for example a V4 poolId) before any historical
   * backfill. The inventory remains subject to the materializer's typed shape
   * checks and the normal identity/final-sim gates.
   */
  retainedPools?: readonly PoolEntry[];
  /**
   * Family-owned materialization candidates that must be retried even when the
   * original landed event is outside this incremental source range.
   */
  retryablePools?: readonly PoolEntry[];
  /**
   * Optional canonical archive used only when a family materializer asks for
   * logs older than the current discovery window. Recent logs, identity calls,
   * code and all current state remain pinned to the live provider.
   */
  historicalLogProvider?: ethers.JsonRpcProvider;
  /**
   * Locally observed canonical source used to authenticate the historical-log
   * provider on first use. Ordinary recent discovery therefore never pays an
   * archive RPC or inherits archive availability.
   */
  historicalLogAnchor?: {
    readonly blockNumber: number;
    readonly blockHash: string;
  };
  /**
   * Read all registered swap topics once per block slice when set to union.
   * The registry dispatcher preserves per-event ordering/output while
   * avoiding one identical receipt traversal per adapter family.
   */
  topicScanMode?: "per-event" | "union";
  /**
   * Bounded mode is used only by the current-head lane. Opaque identities
   * unresolved inside that budget become typed retries for detached backfill.
   */
  historicalResolution?: "bounded" | "complete";
  /**
   * Completeness mode for source-pinned graph generations. Missing reads stay
   * explicit in per-family landed coverage, so the owning family is excluded
   * without manufacturing completeness for it or blocking healthy siblings.
   */
  strict?: boolean;
  /** Current-N budget for generic V2/V3 identity reads after log discovery. */
  identityTimeoutMs?: number;
  control?: DexDiscoveryReadControl;
}

/**
 * Scan recent blocks for swap events to discover active pools.
 * Returns PoolEntry[] ranked by activity (top maxPools).
 */
export async function scanActivePools(
  provider: ethers.JsonRpcProvider,
  blocksBack = 300,
  maxPools = 100,
  toBlock?: number,
  options: ActivePoolDiscoveryOptions = {},
): Promise<PoolEntry[]> {
  return [...(await scanActivePoolsDetailed(
    provider,
    blocksBack,
    maxPools,
    toBlock,
    options,
  )).pools];
}

export interface ActivePoolDiscoveryResult {
  readonly pools: readonly PoolEntry[];
  readonly coverage: readonly LandedPoolDiscoveryCoverage[];
  /** Source-complete candidates whose current-N identity remains unresolved. */
  readonly retryablePools: readonly PoolEntry[];
  /**
   * Source-pinned corrections for conflicting persisted family projections.
   * The stale keys must be removed atomically with graph publication, while
   * the revalidated keys bypass ordinary known-pool deduplication.
   */
  readonly cacheRevalidation: LandedPoolCacheRevalidation;
  /** True when ranking omitted admitted positives; never completeness-safe. */
  readonly truncated: boolean;
}

export async function scanActivePoolsDetailed(
  provider: ethers.JsonRpcProvider,
  blocksBack = 300,
  maxPools = 100,
  toBlock?: number,
  options: ActivePoolDiscoveryOptions = {},
): Promise<ActivePoolDiscoveryResult> {
  const isKnownPool = (pool: PoolEntry): boolean =>
    isKnownDexPoolProjection(pool, options.knownPoolKeys);
  const latest = toBlock ?? (
    hasDexDiscoveryControl(options.control)
      ? await readDexDiscoveryBlockNumber(provider, options.control)
      : await provider.getBlockNumber()
  );
  const fromBlock = Math.max(0, latest - blocksBack);
  const discoveryBackend = ethersPoolDiscoveryBackend(
    provider,
    options.identityBlockTag,
    options.control,
    options.historicalLogProvider,
    fromBlock,
    options.historicalLogAnchor,
    options.historicalResolution === "bounded",
  );
  const landed = await discoverLandedPools({
    registry: PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery(),
    backend: discoveryBackend,
    fromBlock,
    toBlock: latest,
    batchSize: LOG_BATCH,
    minSwaps: 1,
    admissionPolicy:
      options.admissionPolicy ?? STRICT_IDENTITY_ADMISSION,
    retainedPools: options.retainedPools ?? [],
    retryablePools: options.retryablePools ?? [],
    isKnownPool,
    topicScanMode: options.topicScanMode ?? "per-event",
    historicalResolution: options.historicalResolution ?? "complete",
    strict: options.strict,
    signal: options.control?.signal,
  });
  const poolCounts = landed.activity;

  const genericCandidates: PoolEntry[] = [...poolCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([addr, item]) => ({
      address: ethers.getAddress(addr),
      adapter: bestAdapter(item.adapterCounts),
      score: item.count,
    }));
  const forceRevalidated = new Set(
    landed.cacheRevalidation.revalidatedPoolKeys,
  );
  const materializedCandidates = landed.materializedPools.filter(
    (pool) =>
      forceRevalidated.has(poolProjectionRowKey(pool)) ||
      !isKnownPool(pool),
  );
  throwIfDexDiscoveryCancelled(options.control);
  const identityCandidates = genericCandidates.filter(
    (pool) => !isKnownPool(pool),
  );
  const reusedKnown =
    genericCandidates.length - identityCandidates.length +
    landed.materializedPools.length - materializedCandidates.length;
  const identityTimeoutMs = normalizeIdentityTimeout(
    options.identityTimeoutMs,
  );
  const identityController = hasDexDiscoveryControl(options.control) &&
      identityCandidates.length > 0
    ? new AbortController()
    : null;
  const identityTimer = identityController === null
    ? null
    : setTimeout(
        () =>
          identityController.abort(
            new Error(
              `active-pool identity reads exceeded ${identityTimeoutMs}ms`,
            ),
          ),
        identityTimeoutMs,
      );
  const controlledIdentitySignal = mergeDexDiscoverySignals(
    options.control?.signal,
    identityController?.signal,
  );
  const identityBackend: IdentityCallBackend =
    identityController === null
      ? options.identityBackend ?? provider
      : {
          call: (req) =>
            discoveryBackend.call(
              req,
              controlledIdentitySignal === undefined
                ? undefined
                : { signal: controlledIdentitySignal },
            ),
          ...(discoveryBackend.getCode === undefined
            ? {}
            : {
                getCode: (address: string) =>
                  discoveryBackend.getCode!(
                    address,
                    controlledIdentitySignal === undefined
                      ? undefined
                      : { signal: controlledIdentitySignal },
                  ),
              }),
        };
  let identityResult: Awaited<
    ReturnType<typeof attestPoolIdentities<PoolEntry>>
  >;
  try {
    identityResult = await attestPoolIdentities(
      identityBackend,
      identityCandidates,
      {
        identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
        admissionPolicy: options.admissionPolicy,
      },
    );
  } finally {
    if (identityTimer !== null) clearTimeout(identityTimer);
  }
  const { accepted, rejected } = identityResult;
  throwIfDexDiscoveryCancelled(options.control);
  const retryableIdentityKeys = new Set(
    rejected
      .filter((item) => isRetryablePoolIdentityFailure(item.reason))
      .map((item) => identityCandidateKey(item)),
  );
  const retryableIdentityPools = identityCandidates.filter((pool) =>
    retryableIdentityKeys.has(identityCandidateKey(pool))
  );
  const retryablePools = mergePoolRegistries(
    [...landed.retryablePools],
    retryableIdentityPools,
  );
  const admitted = mergePoolRegistries(
    [...accepted],
    materializedCandidates,
  ).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const boundedMaxPools = Number.isFinite(maxPools)
    ? Math.max(0, Math.floor(maxPools))
    : admitted.length;
  const truncated = admitted.length > boundedMaxPools;
  if (options.strict && truncated) {
    throw new Error(
      "strict active-pool discovery cannot publish completeness after " +
        `truncating ${admitted.length} admitted pools to ${boundedMaxPools}`,
    );
  }
  const ranked = admitted.slice(0, boundedMaxPools);
  const provisional = admitted.filter(
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
    `[discovery] scanned ${blocksBack} blocks: ` +
      `${poolCounts.size + landed.materializedPools.length} candidates ` +
      `(materialized=${landed.materializedPools.length}), ` +
      `${admitted.length} new identity-admitted ` +
      `(provisional=${provisional}, reused-known=${reusedKnown}), ` +
      `taking top ${ranked.length} new` +
      (rejectedSummary ? `, rejected(${rejectedSummary})` : ""),
  );

  return {
    pools: Object.freeze(ranked),
    coverage: landed.coverage,
    retryablePools: Object.freeze(retryablePools),
    cacheRevalidation: landed.cacheRevalidation,
    truncated,
  };
}

export function incompleteLandedFamilyIds(
  coverage: readonly LandedPoolDiscoveryCoverage[],
): ReadonlySet<string> {
  return new Set(
    coverage
      .filter((item) => !item.complete)
      .map((item) => item.familyId),
  );
}

/**
 * Startup has no detached publication pass in front of its first graph.
 * Remove stale cache claims from the trusted inventory before that graph
 * becomes visible. Incumbent rows owned by an incomplete landed family are
 * intentionally KEPT: the file-backed universe/pinned/override inventory is
 * trusted (rebuilt by the periodic indexer), and the state coordinator prices
 * every owned family unconditionally while labeling lagging coverage as
 * degraded recall. Whole-family exclusion on a flaky startup scan silently
 * deletes ~40% of the graph (33k+ -> ~22k edges), which fails the full-graph
 * requirement. Only newly discovered swap-active pools of an incomplete
 * family stay isolated (see mergeStartupActivePoolDiscovery).
 */
export function filterStartupActivePoolIncumbents(
  pools: readonly PoolEntry[],
  discovery: Pick<
    ActivePoolDiscoveryResult,
    "coverage" | "cacheRevalidation"
  >,
  familyIdForPool: (pool: PoolEntry) => string | null,
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
  discovery: Pick<
    ActivePoolDiscoveryResult,
    "pools" | "coverage" | "cacheRevalidation"
  >,
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

function identityCandidateKey(
  pool: { readonly address: string; readonly adapter: string },
): string {
  return `${pool.adapter}\u001f${pool.address.toLowerCase()}`;
}

function normalizeIdentityTimeout(value: number | undefined): number {
  const timeout = value ?? 3_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`active-pool identity timeout must be positive`);
  }
  return Math.max(1, Math.floor(timeout));
}

/**
 * DEX-universe rows use the physical pool key, while a behavior-probed swap
 * family admitted through protocol discovery is collection-qualified by its
 * owner. Both rows represent an already verified execution instance for
 * landed-event reuse. Ignoring the projection key makes every owner-qualified
 * Fluid/DODO/Curve row look new on every block and repeats its identity RPC.
 */
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

function ethersPoolDiscoveryBackend(
  provider: ethers.JsonRpcProvider,
  blockTag?: ethers.BlockTag,
  control?: DexDiscoveryReadControl,
  historicalLogProvider?: ethers.JsonRpcProvider,
  historicalBeforeBlock = 0,
  historicalLogAnchor?: {
    readonly blockNumber: number;
    readonly blockHash: string;
  },
  preferLiveHistoricalLogs = false,
): LandedPoolDiscoveryReadBackend & IdentityCallBackend {
  let historicalAlignment: Promise<void> | undefined;
  const assertHistoricalAlignment = (
    readControl: DexDiscoveryReadControl | undefined,
  ): Promise<void> => {
    if (!historicalLogProvider) return Promise.resolve();
    if (!historicalLogAnchor) {
      return Promise.reject(
        new Error("historical log provider requires a canonical source anchor"),
      );
    }
    historicalAlignment ??= (async () => {
      const params = [
        ethers.toQuantity(historicalLogAnchor.blockNumber),
        false,
      ];
      const header = hasDexDiscoveryControl(readControl)
        ? await sendDexDiscoveryRpc<{
            readonly hash?: string;
          } | null>(
            historicalLogProvider,
            "eth_getBlockByNumber",
            params,
            readControl,
          )
        : await historicalLogProvider.send(
            "eth_getBlockByNumber",
            params,
          ) as { readonly hash?: string } | null;
      if (
        !header?.hash ||
        header.hash.toLowerCase() !==
          historicalLogAnchor.blockHash.toLowerCase()
      ) {
        throw new LandedPoolDiscoverySourceMismatchError(
          "historical log provider is not aligned at block " +
            historicalLogAnchor.blockNumber,
        );
      }
    })();
    return historicalAlignment;
  };
  return {
    async getLogs(
      filter: LandedPoolDiscoveryLogFilter,
      nestedControl?: { readonly signal?: AbortSignal },
    ) {
      const mergedControl = mergeDexDiscoveryReadControls(
        control,
        nestedControl,
      );
      const logProvider =
        historicalLogProvider !== undefined &&
          filter.fromBlock < historicalBeforeBlock
          ? historicalLogProvider
          : provider;
      const params = [{
        ...(filter.address === undefined ? {} : { address: filter.address }),
        topics: [...filter.topics],
        fromBlock: ethers.toQuantity(filter.fromBlock),
        toBlock: ethers.toQuantity(filter.toBlock),
      }];
      const readLogs = (
        selectedProvider: ethers.JsonRpcProvider,
      ): Promise<readonly LandedPoolDiscoveryLog[]> =>
        hasDexDiscoveryControl(mergedControl)
          ? sendDexDiscoveryRpc(
              selectedProvider,
              "eth_getLogs",
              params,
              mergedControl,
            )
          : selectedProvider.send("eth_getLogs", params);
      if (
        preferLiveHistoricalLogs &&
        logProvider === historicalLogProvider
      ) {
        try {
          return await readLogs(provider);
        } catch (error) {
          if (
            mergedControl?.signal?.aborted ||
            isDexDiscoveryCancellationError(error)
          ) {
            throw error;
          }
          // A pruned/range-limited local node is not completeness evidence.
          // Fall back only to the canonical-hash-aligned historical provider.
        }
      }
      if (logProvider === historicalLogProvider) {
        await assertHistoricalAlignment(mergedControl);
      }
      return readLogs(logProvider);
    },
    call(
      req: { readonly to: string; readonly data: string },
      nestedControl?: { readonly signal?: AbortSignal },
    ) {
      const mergedControl = mergeDexDiscoveryReadControls(
        control,
        nestedControl,
      );
      if (
        !hasDexDiscoveryControl(mergedControl) ||
        !supportsAbortableDexDiscoveryTransport(provider)
      ) {
        return provider.call({
          ...req,
          ...(blockTag === undefined ? {} : { blockTag }),
        });
      }
      return sendDexDiscoveryRpc<string>(
        provider,
        "eth_call",
        [
          provider.getRpcTransaction({ to: req.to, data: req.data }),
          blockTag === undefined ? "latest" : normalizeDexDiscoveryBlockTag(blockTag),
        ],
        mergedControl,
      );
    },
    getCode(
      address: string,
      nestedControl?: { readonly signal?: AbortSignal },
    ) {
      const mergedControl = mergeDexDiscoveryReadControls(
        control,
        nestedControl,
      );
      if (
        !hasDexDiscoveryControl(mergedControl) ||
        !supportsAbortableDexDiscoveryTransport(provider)
      ) {
        return provider.getCode(address, blockTag);
      }
      return sendDexDiscoveryRpc<string>(
        provider,
        "eth_getCode",
        [
          ethers.getAddress(address),
          blockTag === undefined ? "latest" : normalizeDexDiscoveryBlockTag(blockTag),
        ],
        mergedControl,
      );
    },
  };
}

let dexDiscoveryRpcId = 0;

function supportsAbortableDexDiscoveryTransport(
  provider: ethers.JsonRpcProvider,
): boolean {
  return typeof (
    provider as ethers.JsonRpcProvider & {
      readonly _getConnection?: unknown;
    }
  )._getConnection === "function";
}

async function readDexDiscoveryBlockNumber(
  provider: ethers.JsonRpcProvider,
  control?: DexDiscoveryReadControl,
): Promise<number> {
  const raw = await sendDexDiscoveryRpc<string>(
    provider,
    "eth_blockNumber",
    [],
    control,
  );
  const value = Number(BigInt(raw));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid DEX discovery block number ${raw}`);
  }
  return value;
}

/**
 * Ethers does not expose an AbortSignal for one provider request. Reuse the
 * configured connection/auth, but send through fetch so cancellation closes
 * the actual HTTP transport instead of only racing the caller's Promise.
 */
export async function sendDexDiscoveryRpc<T>(
  provider: ethers.JsonRpcProvider,
  method: string,
  params: readonly unknown[],
  control: DexDiscoveryReadControl = {},
): Promise<T> {
  validateDexDiscoveryControl(control);
  if (!hasDexDiscoveryControl(control)) {
    return provider.send(method, [...params]) as Promise<T>;
  }
  throwIfDexDiscoveryCancelled(control);
  if (control.run) {
    const { run, ...unbudgeted } = control;
    return run((budgetSignal) =>
      sendDexDiscoveryRpc<T>(provider, method, params, {
        ...unbudgeted,
        signal: mergeDexDiscoverySignals(
          unbudgeted.signal,
          budgetSignal,
        ),
      }));
  }
  const payload: JsonRpcPayload = {
    id: ++dexDiscoveryRpcId,
    jsonrpc: "2.0",
    method,
    params: [...params],
  };
  const connection = provider._getConnection();
  const controller = new AbortController();
  const detachParent = linkDexDiscoveryAbort(control.signal, controller);
  let deadlineExpired = false;
  const deadlineDelay = control.deadlineAtMs === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, control.deadlineAtMs - Date.now());
  const deadlineTimer = Number.isFinite(deadlineDelay)
    ? setTimeout(() => {
        deadlineExpired = true;
        controller.abort(dexDiscoveryDeadlineError(control.deadlineAtMs!));
      }, deadlineDelay)
    : null;
  try {
    const response = await fetch(connection.url, {
      method: "POST",
      headers: { ...connection.headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    throwIfDexDiscoveryCancelled(control);
    if (!response.ok) {
      throw new Error(
        `DEX discovery ${method} HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body = await response.json() as Partial<JsonRpcError> & {
      result?: unknown;
    };
    throwIfDexDiscoveryCancelled(control);
    if (body.error) throw provider.getRpcError(payload, body as JsonRpcError);
    if (!("result" in body)) {
      throw new Error(`DEX discovery ${method} returned no result`);
    }
    return body.result as T;
  } catch (error) {
    if (control.signal?.aborted) {
      throw control.signal.reason ?? dexDiscoveryAbortError(error);
    }
    if (
      deadlineExpired ||
      (
        control.deadlineAtMs !== undefined &&
        Date.now() >= control.deadlineAtMs
      )
    ) {
      throw dexDiscoveryDeadlineError(control.deadlineAtMs!, error);
    }
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    detachParent();
  }
}

function validateDexDiscoveryControl(control: DexDiscoveryReadControl): void {
  if (
    control.deadlineAtMs !== undefined &&
    !Number.isFinite(control.deadlineAtMs)
  ) {
    throw new Error(
      `invalid DEX discovery deadline ${String(control.deadlineAtMs)}`,
    );
  }
}

function hasDexDiscoveryControl(
  control: DexDiscoveryReadControl | undefined,
): boolean {
  return control?.deadlineAtMs !== undefined ||
    control?.signal !== undefined ||
    control?.run !== undefined;
}

export function mergeDexDiscoveryReadControls(
  parent: DexDiscoveryReadControl | undefined,
  nested: DexDiscoveryReadControl | undefined,
): DexDiscoveryReadControl {
  const signals = [parent?.signal, nested?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const deadlines = [parent?.deadlineAtMs, nested?.deadlineAtMs].filter(
    (deadline): deadline is number => deadline !== undefined,
  );
  return {
    ...(deadlines.length === 0
      ? {}
      : { deadlineAtMs: Math.min(...deadlines) }),
    ...(signals.length === 0
      ? {}
      : {
          signal: mergeDexDiscoverySignals(...signals),
        }),
    ...((parent?.run ?? nested?.run) === undefined
      ? {}
      : { run: parent?.run ?? nested?.run }),
  };
}

function mergeDexDiscoverySignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const present = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function linkDexDiscoveryAbort(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function throwIfDexDiscoveryCancelled(
  control: DexDiscoveryReadControl | undefined,
  cause?: unknown,
): void {
  if (control?.signal?.aborted) {
    throw control.signal.reason ?? dexDiscoveryAbortError(cause);
  }
  if (
    control?.deadlineAtMs !== undefined &&
    Date.now() >= control.deadlineAtMs
  ) {
    throw dexDiscoveryDeadlineError(control.deadlineAtMs, cause);
  }
}

function isDexDiscoveryCancellationError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = String((error as { readonly code?: unknown }).code);
  return code === "ABORTED" || code === "DEADLINE_EXCEEDED";
}

function dexDiscoveryAbortError(cause?: unknown): Error {
  return Object.assign(
    new Error(
      "DEX discovery aborted",
      cause === undefined ? undefined : { cause },
    ),
    { code: "ABORTED" },
  );
}

function dexDiscoveryDeadlineError(
  deadlineAtMs: number,
  cause?: unknown,
): Error {
  return Object.assign(
    new Error(
      `DEX discovery deadline expired at ${deadlineAtMs}`,
      cause === undefined ? undefined : { cause },
    ),
    { code: "DEADLINE_EXCEEDED" },
  );
}

function normalizeDexDiscoveryBlockTag(blockTag: ethers.BlockTag): string {
  try {
    return ethers.toQuantity(blockTag);
  } catch {
    if (blockTag === "latest") return blockTag;
    throw new Error(
      `DEX discovery requires a numeric block tag, received ${String(blockTag)}`,
    );
  }
}

function bestAdapter(
  adapterCounts: Map<PoolEntry["adapter"], number>,
): PoolEntry["adapter"] {
  return [...adapterCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
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

/**
 * Merge rows that may already have a behavior-probed protocol owner. Ordinary
 * DEX entries remain physical-keyed because their projection key is identical
 * to poolRegistryKey.
 */
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
