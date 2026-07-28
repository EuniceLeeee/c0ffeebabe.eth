import { ethers } from "ethers";
import { CoalescingAsyncWriter } from "./coalescing-async-writer.js";
import {
  indexFactoryPools,
  mergePoolRegistries,
  scanActivePoolsDetailed,
  sendDexDiscoveryRpc,
  type ActivePoolDiscoveryResult,
  type DexDiscoveryReadControl,
} from "./active-pool-discovery.js";
import {
  CanonicalHeaderOutsideRetentionError,
  CanonicalHeaderJournal,
  type CanonicalHeader,
  type CanonicalHeaderIngestResult,
} from "./canonical-header-journal.js";
import {
  DiscoveryBackfillLane,
  type DiscoveryBackfillControl,
  type DiscoveryBackfillPlan,
} from "./discovery-backfill-lane.js";
import {
  planContiguousDiscoveryChunk,
  planLiveBackfillTargets,
  type DiscoveryRange,
} from "./discovery-source-watermark.js";
import { emitEvent } from "./events.js";
import {
  cloneLiveDiscoveryPublicationState,
  describeDexPublicationSlice,
  describeDexRoutingSlice,
  describeLiveDiscoveryPublicationState,
  describeProtocolPublicationSlice,
  projectObservedProtocolPublication,
  rebaseHotDexPublication,
  type DiscoveryCoverageAnchor,
  type LiveDiscoveryPublicationState,
} from "./live-discovery-publication.js";
import {
  createProtocolTraceMemo,
  shouldTraceForProtocolDiscovery,
} from "./observed-protocol-discovery.js";
import {
  buildTokenGraphWithResults,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
} from "./planner/token-graph.js";
import {
  advanceProtocolObservedContiguousAuthority,
  cloneProtocolDiscoveryEvidenceCache,
  pruneProtocolDiscoveryAddressCache,
  reconcileProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
  replaceProtocolDiscoveryEvidenceCache,
  saveProtocolDiscoveryEvidenceCacheAsync,
  setProtocolObservedCursor,
  type ProtocolDiscoveryEvidenceCache,
} from "./protocol-discovery-cache.js";
import {
  emitProtocolDiscoveryEvents,
  emitStaticSuppressedProtocolEvents,
  ProtocolDiscoveryCoverageCoordinator,
  ProtocolDiscoveryMutationQueue,
  protocolDiscoveryRangeForLane,
} from "./protocol-discovery-coordinator.js";
import {
  prepareActiveProtocolDiscoveryPass,
  prepareObservedProtocolDiscoveryPass,
} from "./protocol-discovery-runtime.js";
import {
  createPinnedProtocolDiscoveryContext,
  protocolEdgeKey,
  type ProtocolDiscoveryOwnership,
} from "./protocol-instance-discovery.js";
import {
  assertDexSourceHashStable,
  completeDexGraphCoverageScan,
  createDexGraphCoverageState,
  createPinnedDexReadBackend,
  type PinnedDexReadBackend,
  type DexGraphCoverageScan,
  type DexGraphCoverageState,
  planDexGraphCoverageScan,
  prepareRuntimePoolRefresh,
  selectRefreshCandidates,
} from "./runtime-pool-refresh.js";
import {
  prepareStartupDexIdentityRetryStage,
  type StartupDexIdentityRetryStage,
} from "./startup-dex-identity-retry.js";
import type { StrategyViews } from "./strategy-views.js";
import {
  PRODUCTION_IDENTITY_ADMISSION,
  type IdentityAdmissionPolicy,
} from "./venues/admission.js";
import type { IdentityResolverRegistry } from "./venues/identity.js";
import type { LandedPoolDiscoveryCoverage } from "./venues/landed-pool-discovery.js";
import {
  PRODUCTION_ADAPTER_FAMILIES,
  PRODUCTION_IDENTITY_RESOLVERS,
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
} from "./venues/production-registry.js";
import type {
  ProtocolDiscoveryReadControl,
  ProtocolDiscoveryReceipt,
} from "./venues/route-leg-adapter.js";
import { poolRegistryKey } from "./pool-universe.js";

interface LiveDiscoveryConfig {
  readonly poolUniverseTopN: number;
  readonly enableProtocolEdges: boolean;
  readonly botvmAddress: string;
}

interface LiveDiscoveryInitialState {
  readonly strategyViews: StrategyViews;
  readonly protocolOwnership: ProtocolDiscoveryOwnership;
  readonly lastProtocolDiscoveryBlock: number;
  readonly lastProtocolDiscoveryBlockHash: string | null;
  readonly protocolGraphCompleteThrough: number;
  readonly dexGraphCoverage: DexGraphCoverageState;
  readonly graph: TokenEdge[];
  readonly blockScanGraph: TokenEdge[] | undefined;
  readonly tokenIndex: Map<string, Set<string>>;
  readonly poolAddressMap: Map<string, string>;
  readonly flashTokens: string[];
  readonly knownPoolKeys: Set<string>;
  readonly knownPoolAddresses: Set<string>;
  readonly retryableDexGraphPools: Map<string, PoolEntry>;
  readonly retryableDexIdentityPools: Map<string, PoolEntry>;
}

interface RuntimeGraphConsumer {
  setGraph(graph: TokenEdge[]): void;
}

interface RuntimeDetector extends RuntimeGraphConsumer {
  setPoolAddressMap(poolAddressMap: Map<string, string>): void;
}

export function planLiveDiscoveryBackfillLanes(input: {
  readonly dexSourceCompleteThrough: number;
  readonly dexTargetThrough: number;
  readonly hasDexProjectionRetry: boolean;
}): Readonly<{
  readonly dex: "source" | "projection" | "none";
  readonly protocol: "preempt" | "schedule";
}> {
  if (input.dexSourceCompleteThrough < input.dexTargetThrough) {
    return Object.freeze({ dex: "source", protocol: "preempt" });
  }
  return Object.freeze({
    dex: input.hasDexProjectionRetry ? "projection" : "none",
    protocol: "schedule",
  });
}

export interface LiveDiscoveryCoordinatorDeps {
  readonly provider: ethers.JsonRpcProvider;
  /** Historical range evidence only; live state and probes stay on provider. */
  readonly observedHistoryProvider?: ethers.JsonRpcProvider;
  readonly mainnetBackend: TokenQueryBackend;
  readonly liveRegistry: PoolEntry[];
  /** Full current-N admitted file-backed inventory; never strategy/top-N capped. */
  readonly retainedDexUniverse: readonly PoolEntry[];
  readonly config: LiveDiscoveryConfig;
  readonly discoveryToBlock: number;
  readonly discoveryTopN: number;
  readonly refreshIntervalMs: number;
  readonly protocolDiscoveryIntervalMs: number;
  readonly protocolDiscoveryMaxCatchupBlocks: number;
  readonly protocolDiscoveryShadow: boolean;
  readonly protocolDiscoveryChainId: bigint;
  readonly protocolDiscoveryCachePath: string;
  readonly protocolDiscoveryCache: ProtocolDiscoveryEvidenceCache;
  readonly protocolDiscoveryCoverage: ProtocolDiscoveryCoverageCoordinator;
  readonly startupActivePoolDiscovery: Pick<
    ActivePoolDiscoveryResult,
    "coverage"
  >;
  readonly startupDexSourceBlockHash: string;
  readonly initial: LiveDiscoveryInitialState;
  readonly rebuildStrategyViews: (pools: PoolEntry[]) => StrategyViews;
  readonly protocolDexDomainFor: (
    backrunGraph: readonly TokenEdge[],
    blockScanGraph: readonly TokenEdge[] | undefined,
  ) => string[];
  readonly protocolAddressCandidatesFor: (
    backrunGraph: readonly TokenEdge[],
    blockScanGraph: readonly TokenEdge[] | undefined,
  ) => string[];
  readonly blockScanPlanner: RuntimeGraphConsumer | undefined;
  readonly detector: RuntimeDetector;
  readonly planner: RuntimeGraphConsumer;
  readonly blockScanRuntimeAbort: AbortController;
  readonly blindProductionAudit: boolean;
  readonly mempoolIntakeRefresh: { notify(): void };
  readonly getProtocolTraceMemo: () => ReturnType<typeof createProtocolTraceMemo>;
  readonly onPublicationApplied: (state: {
    readonly strategyViews: StrategyViews;
    readonly dexGraphCoverage: DexGraphCoverageState;
  }) => void;
  readonly persistRuntimeGraphs: (
    strategyViews: StrategyViews,
  ) => Promise<void>;
  readonly logRuntimeRefreshFailures: (
    failures: readonly { readonly pool: PoolEntry; readonly reason: string }[],
    label?: string,
  ) => void;
  readonly onFatalReorg: (reason: string) => void;
}

/**
 * Owns live DEX/protocol discovery preparation, canonical validation,
 * publication, backfill scheduling and observed-receipt discovery. The caller
 * supplies only typed runtime bindings; family/discovery semantics stay here.
 */
export async function createLiveDiscoveryCoordinator(
  deps: LiveDiscoveryCoordinatorDeps,
) {
  const {
    provider,
    observedHistoryProvider,
    mainnetBackend,
    liveRegistry,
    retainedDexUniverse,
    config,
    discoveryToBlock,
    discoveryTopN,
    refreshIntervalMs,
    protocolDiscoveryIntervalMs,
    protocolDiscoveryMaxCatchupBlocks,
    protocolDiscoveryShadow,
    protocolDiscoveryChainId,
    protocolDiscoveryCachePath,
    protocolDiscoveryCache,
    protocolDiscoveryCoverage,
    startupActivePoolDiscovery,
    startupDexSourceBlockHash,
    rebuildStrategyViews,
    protocolDexDomainFor,
    protocolAddressCandidatesFor,
    blockScanPlanner,
    detector,
    planner,
    blockScanRuntimeAbort,
    blindProductionAudit,
    mempoolIntakeRefresh,
    logRuntimeRefreshFailures,
  } = deps;
  const {
    graph,
    blockScanGraph,
    tokenIndex,
    poolAddressMap: allPoolMap,
    flashTokens,
    knownPoolKeys,
    knownPoolAddresses: knownPoolAddrs,
    retryableDexGraphPools,
    retryableDexIdentityPools,
  } = deps.initial;
  let strategyViews = deps.initial.strategyViews;
  let protocolDiscoveryOwnership = deps.initial.protocolOwnership;
  let lastProtocolDiscoveryBlock =
    deps.initial.lastProtocolDiscoveryBlock;
  let lastProtocolDiscoveryBlockHash =
    deps.initial.lastProtocolDiscoveryBlockHash;
  let protocolGraphCompleteThrough =
    deps.initial.protocolGraphCompleteThrough;
  let dexGraphCoverage = { ...deps.initial.dexGraphCoverage };
  const protocolDiscoveryQueue = new ProtocolDiscoveryMutationQueue();
  const canonicalHeaderJournal = new CanonicalHeaderJournal({
    retentionDepth: Math.max(
      512,
      Number(process.env.SEARCHER_DISCOVERY_HEADER_RETENTION ?? "2048"),
    ),
  });
  canonicalHeaderJournal.ingest(
    await readCanonicalHeader(provider, discoveryToBlock),
  );
  let discoveryCanonicalEpoch = 0;
  let discoveryUnsafeReason: string | null = null;
  let discoveryPublicationRevision = 0;
  let lastLandedCoverage: readonly LandedPoolDiscoveryCoverage[] =
    Object.freeze([...startupActivePoolDiscovery.coverage]);
  const landedPoolDiscoveryRegistry =
    PRODUCTION_ADAPTER_FAMILIES.landedPoolDiscovery();
  const initialDexSourceAnchor = await discoveryCoverageAnchor(
    provider,
    dexGraphCoverage.sourceCompleteThrough,
    discoveryToBlock,
    startupDexSourceBlockHash,
  );
  let dexSourceAnchor: DiscoveryCoverageAnchor =
    initialDexSourceAnchor;
  let dexGraphAnchor: DiscoveryCoverageAnchor =
    dexGraphCoverage.graphCompleteThrough ===
        dexGraphCoverage.sourceCompleteThrough
      ? initialDexSourceAnchor
      : await discoveryCoverageAnchor(
          provider,
          dexGraphCoverage.graphCompleteThrough,
          discoveryToBlock,
          startupDexSourceBlockHash,
        );
  let protocolFamilySourceAnchors = new Map<
    string,
    DiscoveryCoverageAnchor
  >();
  for (
    const [key, completeThrough] of
      protocolDiscoveryCoverage.snapshot()
  ) {
    const knownHash =
      completeThrough === lastProtocolDiscoveryBlock
        ? lastProtocolDiscoveryBlockHash
        : completeThrough === discoveryToBlock
          ? startupDexSourceBlockHash
          : null;
    protocolFamilySourceAnchors.set(
      key,
      knownHash === null
        ? await discoveryCoverageAnchor(
            provider,
            completeThrough,
            discoveryToBlock,
            startupDexSourceBlockHash,
          )
        : Object.freeze({
            completeThroughBlock: completeThrough,
            completeThroughHash: knownHash.toLowerCase(),
          }),
    );
  }
  const captureLiveDiscoveryPublication = (
    revision = discoveryPublicationRevision,
  ): LiveDiscoveryPublicationState =>
    cloneLiveDiscoveryPublicationState({
      revision,
      strategyViews,
      backrunGraph: graph,
      ...(blockScanGraph === undefined
        ? {}
        : { blockscanGraph: blockScanGraph }),
      tokenIndex,
      poolAddressMap: allPoolMap,
      flashTokens,
      knownPoolKeys,
      knownPoolAddresses: knownPoolAddrs,
      protocolOwnership: protocolDiscoveryOwnership,
      protocolEvidenceCache: protocolDiscoveryCache,
      retryableDexGraphPools,
      retryableDexIdentityPools,
      dexGraphCoverage,
      dexSourceAnchor,
      dexGraphAnchor,
      landedCoverage: lastLandedCoverage,
      protocolFamilySourceCoverage: protocolFamilySourceAnchors,
      protocolObservedCursor: Object.freeze({
        completeThroughBlock: lastProtocolDiscoveryBlock,
        completeThroughHash: lastProtocolDiscoveryBlockHash,
      }),
    });
  type DexDiscoveryBase = {
    readonly coverage: DexGraphCoverageState;
    readonly retryablePools: ReadonlyMap<string, PoolEntry>;
    readonly retryableIdentityPools: ReadonlyMap<string, PoolEntry>;
    readonly knownPoolKeys: ReadonlySet<string>;
    readonly strategyViews: StrategyViews;
    readonly backrunGraph: readonly TokenEdge[];
    readonly blockscanGraph: readonly TokenEdge[] | undefined;
  };
  const dexDiscoveryBaseFromPublication = (
    current: LiveDiscoveryPublicationState,
  ): DexDiscoveryBase => ({
    coverage: { ...current.dexGraphCoverage },
    retryablePools: new Map(current.retryableDexGraphPools),
    retryableIdentityPools: new Map(
      current.retryableDexIdentityPools,
    ),
    knownPoolKeys: new Set(current.knownPoolKeys),
    strategyViews: {
      backrun: [...current.strategyViews.backrun],
      blockscan: [...current.strategyViews.blockscan],
      versions: { ...current.strategyViews.versions },
    },
    backrunGraph: Object.freeze([...current.backrunGraph]),
    blockscanGraph: current.blockscanGraph === undefined
      ? undefined
      : Object.freeze([...current.blockscanGraph]),
  });
  const captureDexDiscoveryBase = (): DexDiscoveryBase =>
    dexDiscoveryBaseFromPublication(captureLiveDiscoveryPublication());
  const runDexDiscoveryPass = async (
    targetBlock: number,
    options: {
      readonly strict: boolean;
      readonly blocksBack: number;
      /** Frozen publication base for detached/background preparation. */
      readonly current?: DexDiscoveryBase;
      /**
       * Historical source range. Identity, graph projection and static
       * re-attestation remain pinned to targetBlock.
       */
      readonly scan?: DexGraphCoverageScan;
      readonly control?: DexDiscoveryReadControl;
      /** Retry projection at current-N without moving an already-ahead cursor. */
      readonly advanceCoverage?: boolean;
      /** Current-head work is bounded; detached work may finish history. */
      readonly historicalResolution: "bounded" | "complete";
    },
  ) => {
    const passStartedAtMs = performance.now();
    const stageMs = {
      swapScan: 0,
      factoryIndex: 0,
      incumbentAttestation: 0,
      identityRetry: 0,
      projection: 0,
      canonicalFence: 0,
    };
    const measured = async <T>(
      stage: keyof typeof stageMs,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const startedAtMs = performance.now();
      try {
        return await operation();
      } finally {
        stageMs[stage] = Math.max(0, performance.now() - startedAtMs);
      }
    };
    const current = options.current ?? captureDexDiscoveryBase();
    const scan = options.scan ?? (options.strict
      ? planDexGraphCoverageScan(current.coverage, targetBlock)
      : {
          fromBlock: Math.max(0, targetBlock - options.blocksBack),
          toBlock: targetBlock,
          blocksBack: Math.min(targetBlock, options.blocksBack),
        });
    if (
      scan.toBlock > targetBlock ||
      scan.fromBlock > scan.toBlock ||
      scan.blocksBack !== scan.toBlock - scan.fromBlock
    ) {
      throw new Error(
        `invalid DEX discovery range ${scan.fromBlock}-${scan.toBlock} ` +
          `for source ${targetBlock}`,
      );
    }
    const strictSourceBlockHash = options.strict
      ? await readDexDiscoveryBlockHash(
          provider,
          targetBlock,
          options.control,
        )
      : null;
    const historicalLogAnchor = observedHistoryProvider === undefined
      ? undefined
      : {
          blockNumber: targetBlock,
          blockHash:
            strictSourceBlockHash ??
            await readDexDiscoveryBlockHash(
              provider,
              targetBlock,
              options.control,
            ),
        };
    const strictScanBlockHash = options.strict
      ? scan.toBlock === targetBlock
        ? strictSourceBlockHash
        : await readDexDiscoveryBlockHash(
            provider,
            scan.toBlock,
            options.control,
          )
      : null;
    const pinnedReadBackend = options.strict
      ? createPinnedDexReadBackend(provider, targetBlock, options.control)
      : null;
    const readBackend = pinnedReadBackend ?? mainnetBackend;
    const familyMaterializationRetries = [
      ...current.retryableIdentityPools.values(),
    ].filter((pool) =>
      landedPoolDiscoveryRegistry.consumesMaterializationRetries(pool.adapter)
    );
    const genericIdentityRetries = [
      ...current.retryableIdentityPools.values(),
    ].filter((pool) =>
      !landedPoolDiscoveryRegistry.consumesMaterializationRetries(pool.adapter)
    );
    const [
      swapDiscovery,
      factoryFresh,
      staticAttestation,
      identityRetry,
    ] = await Promise.all([
      measured("swapScan", () => scanActivePoolsDetailed(
          provider,
          scan.blocksBack,
          options.strict
            ? Number.POSITIVE_INFINITY
            : Math.max(config.poolUniverseTopN, discoveryTopN * 2),
          scan.toBlock,
          {
            admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
            identityBackend: readBackend,
            identityBlockTag: options.strict ? targetBlock : undefined,
            retainedPools: mergePoolRegistries(
              mergePoolRegistries(
                [...retainedDexUniverse],
                current.strategyViews.blockscan,
              ),
              [...current.retryablePools.values()],
            ),
            retryablePools: familyMaterializationRetries,
            knownPoolKeys: current.knownPoolKeys,
            ...(historicalLogAnchor === undefined
              ? {}
              : {
                  historicalLogProvider: observedHistoryProvider!,
                  historicalLogAnchor,
                }),
            topicScanMode: "union",
            historicalResolution: options.historicalResolution,
            strict: options.strict,
            control: options.control,
          },
        )),
        measured("factoryIndex", () => indexFactoryPools(
          provider,
          scan.blocksBack,
          scan.toBlock,
          {
            strict: options.strict,
            control: options.control,
          },
        )),
        options.strict
          ? measured(
              "incumbentAttestation",
              () => buildTokenGraphWithResults(
                readBackend,
                liveRegistry,
                { quiet: true },
              ),
            )
          : Promise.resolve(null),
        pinnedReadBackend
          ? measured("identityRetry", () => prepareBoundedDexIdentityRetry({
              currentN: targetBlock,
              backend: pinnedReadBackend,
              remaining: genericIdentityRetries,
              identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
              seedEntries: liveRegistry,
              admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
            }))
          : Promise.resolve(null),
    ]);
    const swapFresh = [...swapDiscovery.pools];
    const fresh = mergePoolRegistries(
      mergePoolRegistries(factoryFresh, swapFresh),
      [...(identityRetry?.accepted ?? [])],
    );
    const retryableAndStatic = mergePoolRegistries(
      liveRegistry,
      [...current.retryablePools.values()],
    );
    const candidates = selectRefreshCandidates(
      retryableAndStatic,
      fresh,
      current.knownPoolKeys,
    );
    let projection: Awaited<ReturnType<typeof prepareRuntimePoolRefresh>> | null = null;
    const nextRetryableDexGraphPools = new Map(current.retryablePools);
    const nextRetryableDexIdentityPools = identityRetry === null
      ? new Map(
          genericIdentityRetries.map((pool) => [
            poolRegistryKey(pool),
            pool,
          ] as const),
        )
      : new Map(
          identityRetry.remaining.map((pool) => [
            poolRegistryKey(pool),
            pool,
          ] as const),
        );
    for (const pool of swapDiscovery.retryablePools) {
      nextRetryableDexIdentityPools.set(poolRegistryKey(pool), pool);
    }
    const staticFailures: Array<{
      pool: PoolEntry;
      reason: string;
    }> = [];
    if (candidates.length > 0) {
      projection = await measured("projection", () => prepareRuntimePoolRefresh({
          backend: readBackend,
          freshPools: candidates,
          knownPoolKeys: current.knownPoolKeys,
          currentBackrunPools: [...current.strategyViews.backrun],
          currentBackrunGraph: [...current.backrunGraph],
          currentBlockscanGraph: current.blockscanGraph === undefined
            ? undefined
            : [...current.blockscanGraph],
          buildStrategyViews: rebuildStrategyViews,
      }));
      for (const admitted of projection.admittedPools) {
        nextRetryableDexGraphPools.delete(poolRegistryKey(admitted));
      }
      for (const failure of projection.failedPools) {
        nextRetryableDexGraphPools.set(poolRegistryKey(failure.pool), failure.pool);
      }
    }
    if (staticAttestation) {
      const stagedGraph = projection?.backrunGraph ?? current.backrunGraph;
      const stagedEdgeKeys = new Set(stagedGraph.map(protocolEdgeKey));
      for (const success of staticAttestation.successful) {
        const key = poolRegistryKey(success.pool);
        if (success.edges.every((edge) => stagedEdgeKeys.has(protocolEdgeKey(edge)))) {
          nextRetryableDexGraphPools.delete(key);
        } else {
          nextRetryableDexGraphPools.set(key, success.pool);
          staticFailures.push({
            pool: success.pool,
            reason: "current-N incumbent edge set is missing from the staged graph",
          });
        }
      }
      for (const failure of staticAttestation.failed) {
        staticFailures.push(failure);
        nextRetryableDexGraphPools.set(
          poolRegistryKey(failure.pool),
          failure.pool,
        );
      }
    }
    const projectionComplete =
      nextRetryableDexGraphPools.size === 0 &&
      nextRetryableDexIdentityPools.size === 0;
    if (strictSourceBlockHash !== null) {
      await measured("canonicalFence", async () => {
        const canonicalAfter = await readDexDiscoveryBlockHash(
            provider,
            targetBlock,
            options.control,
          );
        assertDexSourceHashStable(
          targetBlock,
          strictSourceBlockHash,
          canonicalAfter,
        );
        if (strictScanBlockHash === null) {
          throw new Error("strict DEX discovery did not anchor its scan range");
        }
        const scanCanonicalAfter = scan.toBlock === targetBlock
          ? canonicalAfter
          : await readDexDiscoveryBlockHash(
              provider,
              scan.toBlock,
              options.control,
            );
        assertDexSourceHashStable(
          scan.toBlock,
          strictScanBlockHash,
          scanCanonicalAfter,
        );
      });
    }
    const coverage = options.strict
      ? options.advanceCoverage === false
        ? createDexGraphCoverageState({
            sourceCompleteThrough:
              current.coverage.sourceCompleteThrough,
            graphCompleteThrough: projectionComplete
              ? current.coverage.sourceCompleteThrough
              : current.coverage.graphCompleteThrough,
          })
        : completeDexGraphCoverageScan(
            current.coverage,
            scan,
            projectionComplete,
          )
      : current.coverage;
    const timing = Object.freeze({
      ...stageMs,
      wallMs: Math.max(0, performance.now() - passStartedAtMs),
    });
    console.log(
      `[searcher/discovery-stage-telemetry] ${JSON.stringify({
        targetBlock,
        strict: options.strict,
        scan,
        timing,
        swapPools: swapFresh.length,
        factoryPools: factoryFresh.length,
        candidates: candidates.length,
        incumbentSuccesses: staticAttestation?.successful.length ?? 0,
        incumbentFailures: staticAttestation?.failed.length ?? 0,
        identityAccepted: identityRetry?.accepted.length ?? 0,
        identityRemaining: identityRetry?.remaining.length ?? 0,
      })}`,
    );
    return {
      complete: coverage.graphCompleteThrough >= targetBlock,
      sourceBlockHash: strictSourceBlockHash,
      scanBlockHash: strictScanBlockHash,
      scan,
      projection,
      staticFailures,
      retryablePools: nextRetryableDexGraphPools,
      retryableIdentityPools: nextRetryableDexIdentityPools,
      coverage,
      landedCoverage: swapDiscovery.coverage,
      timing,
    };
  };
  type DexDiscoveryStage = Awaited<ReturnType<typeof runDexDiscoveryPass>>;
  type ProtocolDiscoveryBase = {
    readonly strategyViews: StrategyViews;
    readonly backrunGraph: readonly TokenEdge[];
    readonly blockscanGraph: readonly TokenEdge[] | undefined;
    readonly knownPoolKeys: ReadonlySet<string>;
    readonly ownership: ProtocolDiscoveryOwnership;
    readonly evidenceCache: ProtocolDiscoveryEvidenceCache;
    readonly familyGraphCompleteThrough: ReadonlyMap<string, number>;
    readonly lastObservedBlock: number;
    readonly lastObservedBlockHash: string | null;
  };
  const protocolDiscoveryBaseFromPublication = (
    current: LiveDiscoveryPublicationState,
    graphBase: {
      readonly strategyViews: StrategyViews;
      readonly backrunGraph: readonly TokenEdge[];
      readonly blockscanGraph: readonly TokenEdge[] | undefined;
      readonly knownPoolKeys: ReadonlySet<string>;
    } = {
      strategyViews: current.strategyViews,
      backrunGraph: current.backrunGraph,
      blockscanGraph: current.blockscanGraph,
      knownPoolKeys: current.knownPoolKeys,
    },
    evidenceCache = current.protocolEvidenceCache,
  ): ProtocolDiscoveryBase => ({
    strategyViews: {
      backrun: [...graphBase.strategyViews.backrun],
      blockscan: [...graphBase.strategyViews.blockscan],
      versions: { ...graphBase.strategyViews.versions },
    },
    backrunGraph: Object.freeze([...graphBase.backrunGraph]),
    blockscanGraph: graphBase.blockscanGraph === undefined
      ? undefined
      : Object.freeze([...graphBase.blockscanGraph]),
    knownPoolKeys: new Set(graphBase.knownPoolKeys),
    ownership: {
      version: current.protocolOwnership.version,
      admissions: new Map(current.protocolOwnership.admissions),
    },
    evidenceCache: cloneProtocolDiscoveryEvidenceCache(evidenceCache),
    familyGraphCompleteThrough: new Map(
      [...current.protocolFamilySourceCoverage].map(([key, anchor]) => [
        key,
        anchor.completeThroughBlock,
      ]),
    ),
    lastObservedBlock:
      current.protocolObservedCursor.completeThroughBlock,
    lastObservedBlockHash:
      current.protocolObservedCursor.completeThroughHash,
  });
  const captureProtocolDiscoveryBase = (
    graphBase: {
      readonly strategyViews: StrategyViews;
      readonly backrunGraph: readonly TokenEdge[];
      readonly blockscanGraph: readonly TokenEdge[] | undefined;
      readonly knownPoolKeys: ReadonlySet<string>;
    } = {
      strategyViews,
      backrunGraph: graph,
      blockscanGraph: blockScanGraph,
      knownPoolKeys,
    },
  ): ProtocolDiscoveryBase => protocolDiscoveryBaseFromPublication(
    captureLiveDiscoveryPublication(),
    graphBase,
  );
  const prepareActiveProtocolDiscoveryStage = async (
    latestProtocolBlock: number,
    current: ProtocolDiscoveryBase,
    options: {
      readonly scanRange?: DiscoveryRange | null;
      readonly control?: ProtocolDiscoveryReadControl;
      readonly traceMemo?: ReturnType<typeof createProtocolTraceMemo>;
    },
  ) => {
    const hasObservedSource = protocolDiscoveryCoverage.hasObservedSource();
    const scanRange = options.scanRange !== undefined
      ? options.scanRange
      : hasObservedSource
        ? planContiguousDiscoveryChunk(
          current.lastObservedBlock,
          latestProtocolBlock,
          protocolDiscoveryMaxCatchupBlocks,
        )
        : { fromBlock: latestProtocolBlock, toBlock: latestProtocolBlock };
    if (!scanRange) {
      const graphCompleteThrough = protocolDiscoveryCoverage
        .graphCompleteThrough(current.familyGraphCompleteThrough);
      return {
        pass: null,
        scanRange: null,
        scanRangeHash: null,
        latestProtocolBlock,
        nextLastProtocolDiscoveryBlock: current.lastObservedBlock,
        nextLastProtocolDiscoveryBlockHash: current.lastObservedBlockHash,
        nextProtocolGraphCompleteThrough: graphCompleteThrough,
        nextProtocolFamilyGraphCompleteThrough:
          new Map(current.familyGraphCompleteThrough),
        completedProtocolFamilySourceKeys: new Set<string>(),
        complete: graphCompleteThrough >= latestProtocolBlock,
      };
    }
    const scanRangeHashBefore = await readDexDiscoveryBlockHash(
      provider,
      scanRange.toBlock,
      options.control,
    );
    const protocolDexDomain = protocolDexDomainFor(
      current.backrunGraph,
      current.blockscanGraph,
    );
    const protocolAddressCandidates = protocolAddressCandidatesFor(
      current.backrunGraph,
      current.blockscanGraph,
    );
    const pass = await prepareActiveProtocolDiscoveryPass({
      provider,
      ...(observedHistoryProvider === undefined
        ? {}
        : { observedHistoryProvider }),
      adapters: PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes(),
      identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
      protocolEdgesEnabled: config.enableProtocolEdges,
      chainId: protocolDiscoveryChainId,
      probeExecutor: config.botvmAddress,
      currentOwnership: current.ownership,
      currentBackrunPools: current.strategyViews.backrun,
      currentBackrunGraph: current.backrunGraph,
      currentBlockscanGraph: current.blockscanGraph,
      currentKnownPoolKeys: current.knownPoolKeys,
      buildStrategyViews: rebuildStrategyViews,
      blockNumber: latestProtocolBlock,
      fromBlock: scanRange.fromBlock,
      toBlock: scanRange.toBlock,
      graphTokens: protocolDexDomain,
      candidateAddresses: protocolAddressCandidates,
      evidenceCache: current.evidenceCache,
      traceMemo: options.traceMemo ?? createProtocolTraceMemo(),
      shadow: protocolDiscoveryShadow,
      control: options.control,
    });
    const scanRangeHashAfter = await readDexDiscoveryBlockHash(
      provider,
      scanRange.toBlock,
      options.control,
    );
    assertDexSourceHashStable(
      scanRange.toBlock,
      scanRangeHashBefore,
      scanRangeHashAfter,
    );
    let nextProtocolFamilyGraphCompleteThrough: ReadonlyMap<string, number> =
      new Map(current.familyGraphCompleteThrough);
    let nextLastProtocolDiscoveryBlock = current.lastObservedBlock;
    let nextLastProtocolDiscoveryBlockHash =
      current.lastObservedBlockHash;
    let nextProtocolGraphCompleteThrough =
      protocolDiscoveryCoverage.graphCompleteThrough(
        current.familyGraphCompleteThrough,
      );
    let completedProtocolFamilySourceKeys: ReadonlySet<string> =
      new Set<string>();
    if (!protocolDiscoveryShadow) {
      const advanced = protocolDiscoveryCoverage.advance({
        current: current.familyGraphCompleteThrough,
        range: scanRange,
        scanner: pass.scanner,
        result: pass.result,
        positiveOnlyObserved: false,
        evaluationBlock: latestProtocolBlock,
      });
      nextProtocolFamilyGraphCompleteThrough = advanced.watermarks;
      completedProtocolFamilySourceKeys = advanced.completedKeys;
      nextLastProtocolDiscoveryBlock =
        protocolDiscoveryCoverage.nextObservedCursor({
          currentCursor: current.lastObservedBlock,
          range: scanRange,
          watermarks: advanced.watermarks,
          positiveOnlyObserved: false,
          eventSourceComplete: pass.scanner.eventSourceComplete,
      });
      if (nextLastProtocolDiscoveryBlock !== current.lastObservedBlock) {
        if (nextLastProtocolDiscoveryBlock !== scanRange.toBlock) {
          throw new Error(
            "protocol discovery advanced to an unanchored partial range",
          );
        }
        nextLastProtocolDiscoveryBlockHash = scanRangeHashAfter;
      }
      nextProtocolGraphCompleteThrough =
        protocolDiscoveryCoverage.graphCompleteThrough(advanced.watermarks);
    }
    const complete =
      !protocolDiscoveryShadow &&
      nextProtocolGraphCompleteThrough >= latestProtocolBlock;
    return {
      pass,
      scanRange,
      scanRangeHash: scanRangeHashAfter,
      latestProtocolBlock,
      nextLastProtocolDiscoveryBlock,
      nextLastProtocolDiscoveryBlockHash,
      nextProtocolGraphCompleteThrough,
      nextProtocolFamilyGraphCompleteThrough,
      completedProtocolFamilySourceKeys,
      complete,
    };
  };
  type ActiveProtocolDiscoveryStage = Awaited<
    ReturnType<typeof prepareActiveProtocolDiscoveryStage>
  >;
  type DiscoveryTransitionMode =
    | "hot"
    | "dex-backfill"
    | "protocol-backfill";
  type CombinedDiscoveryPrepared = {
    readonly source: { readonly number: number; readonly hash: string };
    readonly through: number;
    readonly mode: DiscoveryTransitionMode;
    readonly canonicalEpoch: number;
    readonly baseDexFingerprint: string | null;
    readonly baseDexRoutingFingerprint: string | null;
    readonly baseProtocolFingerprint: string | null;
    readonly dex: DexDiscoveryStage | null;
    readonly protocol: ActiveProtocolDiscoveryStage;
    readonly stagedProtocolCache: ProtocolDiscoveryEvidenceCache;
  };
  const prepareCombinedDiscoveryTransition = async (
    base: LiveDiscoveryPublicationState,
    input: {
      readonly source: { readonly number: number; readonly hash: string };
      readonly through: number;
      readonly mode: DiscoveryTransitionMode;
      readonly control?: DiscoveryBackfillControl;
    },
  ): Promise<CombinedDiscoveryPrepared> => {
    const canonicalEpoch = discoveryCanonicalEpoch;
    if (discoveryUnsafeReason !== null) {
      throw new Error(
        `discovery publication is unsafe: ${discoveryUnsafeReason}`,
      );
    }
    if (
      !Number.isSafeInteger(input.through) ||
      input.through < 0 ||
      input.through > input.source.number
    ) {
      throw new Error(
        `invalid discovery transition through=${input.through} ` +
          `source=${input.source.number}`,
      );
    }
    const rpcControl = input.control === undefined
      ? undefined
      : {
          signal: input.control.signal,
          deadlineAtMs: input.control.deadlineAtMs,
          run: input.control.run,
        };
    const canonicalBefore = await readDexDiscoveryBlockHash(
      provider,
      input.source.number,
      rpcControl,
    );
    assertDexSourceHashStable(
      input.source.number,
      input.source.hash,
      canonicalBefore,
    );

    const dexEnabled = input.mode !== "protocol-backfill";
    const dexNeedsSourceScan =
      dexEnabled &&
      base.dexGraphCoverage.sourceCompleteThrough <= input.through;
    const dexNeedsProjectionRetry =
      dexEnabled &&
      (
        base.retryableDexGraphPools.size > 0 ||
        base.retryableDexIdentityPools.size > 0 ||
        base.dexGraphCoverage.graphCompleteThrough <
          base.dexGraphCoverage.sourceCompleteThrough
      );
    const dexScan = !dexEnabled
      ? null
      : dexNeedsSourceScan
        ? planDexGraphCoverageScan(
            base.dexGraphCoverage,
            input.through,
          )
        : dexNeedsProjectionRetry
          ? {
              fromBlock: input.through,
              toBlock: input.through,
              blocksBack: 0,
            }
          : null;
    const dex = dexScan === null
      ? null
      : await runDexDiscoveryPass(input.source.number, {
          strict: true,
          blocksBack: 0,
          current: dexDiscoveryBaseFromPublication(base),
          scan: dexScan,
          control: rpcControl,
          advanceCoverage: dexNeedsSourceScan,
          historicalResolution:
            input.mode === "hot" ? "bounded" : "complete",
        });

    const stagedStrategyViews =
      dex?.projection?.strategyViews ?? base.strategyViews;
    const stagedBackrunGraph =
      dex?.projection?.backrunGraph ?? base.backrunGraph;
    const stagedBlockscanGraph =
      dex?.projection?.blockscanGraph ?? base.blockscanGraph;
    const stagedKnownPoolKeys =
      dex?.projection?.knownPoolKeys ?? base.knownPoolKeys;
    const stagedProtocolCache = cloneProtocolDiscoveryEvidenceCache(
      base.protocolEvidenceCache,
    );
    const publicationProtocolBase = protocolDiscoveryBaseFromPublication(
      base,
      {
        strategyViews: stagedStrategyViews,
        backrunGraph: stagedBackrunGraph,
        blockscanGraph: stagedBlockscanGraph,
        knownPoolKeys: stagedKnownPoolKeys,
      },
      stagedProtocolCache,
    );
    const protocolBase = publicationProtocolBase;
    const observedRange =
      protocolDiscoveryCoverage.hasObservedSource()
        ? planContiguousDiscoveryChunk(
            protocolBase.lastObservedBlock,
            input.through,
            protocolDiscoveryMaxCatchupBlocks,
          )
        : null;
    const protocolSourceBehind = [
      ...base.protocolFamilySourceCoverage.values(),
    ].some((anchor) =>
      anchor.completeThroughBlock < input.source.number
    );
    const addressOnlyRetryRange =
      observedRange === null && protocolSourceBehind
        ? {
            fromBlock: Math.max(0, protocolBase.lastObservedBlock),
            toBlock: Math.max(0, protocolBase.lastObservedBlock),
          }
        : null;
    // Current-head DEX discovery is the block-scan hot gate. Protocol
    // receipt/trace/address probing belongs to the independent background and
    // observed-receipt lanes; awaiting it here lets one slow protocol family
    // consume the entire DEX pass deadline.
    const protocol = await prepareActiveProtocolDiscoveryStage(
      input.source.number,
      protocolBase,
      input.mode === "dex-backfill"
        ? { scanRange: null }
        : {
            scanRange: protocolDiscoveryRangeForLane({
              mode: input.mode === "hot" ? "hot" : "backfill",
              observedRange,
              addressOnlyRetryRange,
            }),
            ...(input.mode === "hot"
              ? {}
              : {
                  control: rpcControl,
                  traceMemo: createProtocolTraceMemo(),
                }),
          },
    );
    const canonicalAfter = await readDexDiscoveryBlockHash(
      provider,
      input.source.number,
      rpcControl,
    );
    assertDexSourceHashStable(
      input.source.number,
      input.source.hash,
      canonicalAfter,
    );
    return Object.freeze({
      source: Object.freeze({ ...input.source }),
      through: input.through,
      mode: input.mode,
      canonicalEpoch,
      baseDexFingerprint: input.mode === "protocol-backfill"
        ? null
        : describeDexPublicationSlice(base),
      baseDexRoutingFingerprint: input.mode === "protocol-backfill"
        ? describeDexRoutingSlice(base)
        : null,
      baseProtocolFingerprint: input.mode === "protocol-backfill"
        ? describeProtocolPublicationSlice(base)
        : null,
      dex,
      protocol,
      stagedProtocolCache,
    });
  };

  const validateCombinedDiscoveryTransition = (
    base: LiveDiscoveryPublicationState,
    prepared: CombinedDiscoveryPrepared,
  ): LiveDiscoveryPublicationState => {
    if (
      discoveryUnsafeReason !== null ||
      prepared.canonicalEpoch !== discoveryCanonicalEpoch
    ) {
      throw new Error(
        `discovery transition crossed canonical epoch ` +
          `${prepared.canonicalEpoch}->${discoveryCanonicalEpoch}`,
      );
    }
    if (prepared.mode !== "protocol-backfill") {
      throw new Error(
        "combined discovery validator requires a protocol-backfill transition",
      );
    }
    const dex = prepared.dex;
    const protocol = prepared.protocol;
    if (
      dex?.sourceBlockHash !== null &&
      dex?.sourceBlockHash !== undefined &&
      dex.sourceBlockHash.toLowerCase() !== prepared.source.hash.toLowerCase()
    ) {
      throw new Error("DEX transition source hash mismatch");
    }
    const finalProjection =
      protocol.pass?.projection ?? dex?.projection ?? null;
    const nextOwnership =
      protocol.pass?.projection?.ownership ?? base.protocolOwnership;
    const nextCache = cloneProtocolDiscoveryEvidenceCache(
      prepared.stagedProtocolCache,
    );
    if (protocol.pass) {
      reconcileProtocolDiscoveryEvidenceCache(
        nextCache,
        protocol.pass.result,
      );
    }
    recordProtocolRouteOwnership(nextCache, nextOwnership);
    pruneProtocolDiscoveryAddressCache(nextCache, {
      currentBlock: prepared.source.number,
    });
    const baseObservedBlock =
      base.protocolObservedCursor.completeThroughBlock;
    const nextObservedBlock = Math.max(
      baseObservedBlock,
      protocol.nextLastProtocolDiscoveryBlock,
    );
    const nextObservedHash = nextObservedBlock === baseObservedBlock
      ? base.protocolObservedCursor.completeThroughHash
      : protocol.nextLastProtocolDiscoveryBlockHash;
    setProtocolObservedCursor(
      nextCache,
      nextObservedBlock >= 0 ? nextObservedBlock : null,
      nextObservedBlock >= 0 ? nextObservedHash : null,
    );

    const nextDexCoverage = dex?.coverage ?? base.dexGraphCoverage;
    const nextDexSourceAnchor =
      nextDexCoverage.sourceCompleteThrough ===
          base.dexGraphCoverage.sourceCompleteThrough
        ? base.dexSourceAnchor
        : coverageAnchorFromStage(
            nextDexCoverage.sourceCompleteThrough,
            dex?.scan.toBlock,
            dex?.scanBlockHash,
            "DEX source",
          );
    const nextDexGraphAnchor =
      nextDexCoverage.graphCompleteThrough ===
          base.dexGraphCoverage.graphCompleteThrough
        ? base.dexGraphAnchor
        : coverageAnchorFromStage(
            nextDexCoverage.graphCompleteThrough,
            dex?.scan.toBlock,
            dex?.scanBlockHash,
            "DEX graph",
          );

    const nextProtocolAnchors = new Map(
      base.protocolFamilySourceCoverage,
    );
    for (
      const [key, completeThrough] of
      protocol.nextProtocolFamilyGraphCompleteThrough
    ) {
      const prior = nextProtocolAnchors.get(key);
      if (prior?.completeThroughBlock === completeThrough) continue;
      if (!protocol.completedProtocolFamilySourceKeys.has(key)) {
        throw new Error(
          `protocol source ${key} advanced without central completion proof`,
        );
      }
      const isObserved = key.endsWith(
        "\u001fobserved-interaction",
      );
      const expectedBlock = isObserved
        ? protocol.scanRange?.toBlock
        : prepared.source.number;
      const expectedHash = isObserved
        ? protocol.scanRangeHash
        : prepared.source.hash;
      nextProtocolAnchors.set(
        key,
        coverageAnchorFromStage(
          completeThrough,
          expectedBlock,
          expectedHash,
          `protocol source ${key}`,
        ),
      );
    }
    if (
      protocol.pass &&
      protocol.scanRange &&
      protocol.scanRangeHash
    ) {
      const observedFamilies = protocolDiscoveryCoverage.families
        .filter((family) =>
          family.sourceIds.includes("observed-interaction")
        )
        .map((family) => ({
          familyId: family.familyId,
          sourceIds: ["observed-interaction"],
        }));
      const observedCoverage = new Map<string, boolean>(
        protocol.pass.result.familySourceCoverage
          .filter((coverage) =>
            coverage.sourceId === "observed-interaction"
          )
          .map((coverage) => [coverage.familyId, coverage.complete]),
      );
      if (observedFamilies.length > 0) {
        advanceProtocolObservedContiguousAuthority({
          cache: nextCache,
          families: observedFamilies,
          familySourceCoverage: observedFamilies.map((family) => ({
            familyId: family.familyId,
            sourceId: "observed-interaction",
            complete: observedCoverage.get(family.familyId) === true,
          })),
          fromBlock: protocol.scanRange.fromBlock,
          toBlock: protocol.scanRange.toBlock,
          toBlockHash: protocol.scanRangeHash,
          contiguousSourceIds: new Set(["observed-interaction"]),
        });
      }
    }

    return cloneLiveDiscoveryPublicationState({
      revision: base.revision + 1,
      strategyViews:
        finalProjection?.strategyViews ?? base.strategyViews,
      backrunGraph:
        finalProjection?.backrunGraph ?? base.backrunGraph,
      ...((
        finalProjection?.blockscanGraph ?? base.blockscanGraph
      ) === undefined
        ? {}
        : {
            blockscanGraph:
              finalProjection?.blockscanGraph ??
              base.blockscanGraph!,
          }),
      tokenIndex: finalProjection?.tokenIndex ?? base.tokenIndex,
      poolAddressMap:
        finalProjection?.poolAddressMap ?? base.poolAddressMap,
      flashTokens:
        finalProjection?.flashTokens ?? base.flashTokens,
      knownPoolKeys:
        finalProjection?.knownPoolKeys ?? base.knownPoolKeys,
      knownPoolAddresses:
        finalProjection?.knownPoolAddresses ??
        base.knownPoolAddresses,
      protocolOwnership: nextOwnership,
      protocolEvidenceCache: nextCache,
      retryableDexGraphPools:
        dex?.retryablePools ?? base.retryableDexGraphPools,
      retryableDexIdentityPools:
        dex?.retryableIdentityPools ??
        base.retryableDexIdentityPools,
      dexGraphCoverage: nextDexCoverage,
      dexSourceAnchor: nextDexSourceAnchor,
      dexGraphAnchor: nextDexGraphAnchor,
      landedCoverage: dex?.landedCoverage ?? base.landedCoverage,
      protocolFamilySourceCoverage: nextProtocolAnchors,
      protocolObservedCursor: Object.freeze({
        completeThroughBlock: nextObservedBlock,
        completeThroughHash: nextObservedHash,
      }),
    });
  };
  const rebasePreparedDexTransition = (
    current: LiveDiscoveryPublicationState,
    prepared: CombinedDiscoveryPrepared,
  ): LiveDiscoveryPublicationState | null => {
    if (
      discoveryUnsafeReason !== null ||
      prepared.canonicalEpoch !== discoveryCanonicalEpoch
    ) {
      return null;
    }
    if (
      (prepared.mode !== "hot" &&
        prepared.mode !== "dex-backfill") ||
      prepared.protocol.pass !== null ||
      prepared.baseDexFingerprint === null
    ) {
      throw new Error(
        "DEX rebase requires a protocol-free hot or backfill delta",
      );
    }
    const dex = prepared.dex;
    const nextDexCoverage = dex?.coverage ?? current.dexGraphCoverage;
    const nextDexSourceAnchor =
      nextDexCoverage.sourceCompleteThrough ===
          current.dexGraphCoverage.sourceCompleteThrough
        ? current.dexSourceAnchor
        : coverageAnchorFromStage(
            nextDexCoverage.sourceCompleteThrough,
            dex?.scan.toBlock,
            dex?.scanBlockHash,
            "DEX source",
          );
    const nextDexGraphAnchor =
      nextDexCoverage.graphCompleteThrough ===
          current.dexGraphCoverage.graphCompleteThrough
        ? current.dexGraphAnchor
        : coverageAnchorFromStage(
            nextDexCoverage.graphCompleteThrough,
            dex?.scan.toBlock,
            dex?.scanBlockHash,
            "DEX graph",
          );
    return rebaseHotDexPublication({
      current,
      patch: {
        baseDexFingerprint: prepared.baseDexFingerprint,
        chainId: protocolDiscoveryChainId.toString(),
        delta: dex?.projection?.delta ?? null,
        retryableDexGraphPools:
          dex?.retryablePools ?? current.retryableDexGraphPools,
        retryableDexIdentityPools:
          dex?.retryableIdentityPools ??
          current.retryableDexIdentityPools,
        dexGraphCoverage: nextDexCoverage,
        dexSourceAnchor: nextDexSourceAnchor,
        dexGraphAnchor: nextDexGraphAnchor,
        landedCoverage: dex?.landedCoverage ?? current.landedCoverage,
      },
      buildStrategyViews: rebuildStrategyViews,
    });
  };
  const rebasePreparedProtocolTransition = (
    current: LiveDiscoveryPublicationState,
    prepared: CombinedDiscoveryPrepared,
  ): LiveDiscoveryPublicationState | null => {
    if (
      discoveryUnsafeReason !== null ||
      prepared.canonicalEpoch !== discoveryCanonicalEpoch
    ) {
      return null;
    }
    if (
      prepared.mode !== "protocol-backfill" ||
      prepared.dex !== null ||
      prepared.baseDexRoutingFingerprint === null ||
      prepared.baseProtocolFingerprint === null
    ) {
      throw new Error(
        "protocol rebase requires a protocol-only backfill delta",
      );
    }
    if (
      describeProtocolPublicationSlice(current) !==
        prepared.baseProtocolFingerprint ||
      describeDexRoutingSlice(current) !==
        prepared.baseDexRoutingFingerprint
    ) {
      return null;
    }
    return validateCombinedDiscoveryTransition(current, {
      ...prepared,
      stagedProtocolCache: cloneProtocolDiscoveryEvidenceCache(
        current.protocolEvidenceCache,
      ),
    });
  };
  const publishLiveDiscoveryState = (
    state: LiveDiscoveryPublicationState,
  ): void => {
    if (discoveryUnsafeReason !== null) {
      throw new Error(
        `refusing unsafe discovery publication: ` +
          discoveryUnsafeReason,
      );
    }
    const next = cloneLiveDiscoveryPublicationState(state);
    strategyViews = next.strategyViews;
    replaceArray(graph, next.backrunGraph);
    if (blockScanGraph && next.blockscanGraph) {
      replaceArray(blockScanGraph, next.blockscanGraph);
      blockScanPlanner?.setGraph(blockScanGraph);
    }
    replaceMap(
      tokenIndex,
      new Map(
        [...next.tokenIndex].map(([token, peers]) => [
          token,
          new Set(peers),
        ]),
      ),
    );
    replaceMap(allPoolMap, next.poolAddressMap);
    replaceArray(flashTokens, next.flashTokens);
    replaceSet(knownPoolKeys, next.knownPoolKeys);
    replaceSet(knownPoolAddrs, next.knownPoolAddresses);
    protocolDiscoveryOwnership = {
      version: next.protocolOwnership.version,
      admissions: new Map(next.protocolOwnership.admissions),
    };
    replaceProtocolDiscoveryEvidenceCache(
      protocolDiscoveryCache,
      next.protocolEvidenceCache,
    );
    replaceMap(
      retryableDexGraphPools,
      next.retryableDexGraphPools,
    );
    replaceMap(
      retryableDexIdentityPools,
      next.retryableDexIdentityPools,
    );
    dexGraphCoverage = { ...next.dexGraphCoverage };
    dexSourceAnchor = { ...next.dexSourceAnchor };
    dexGraphAnchor = { ...next.dexGraphAnchor };
    lastLandedCoverage = Object.freeze([...next.landedCoverage]);
    protocolFamilySourceAnchors = new Map(
      next.protocolFamilySourceCoverage,
    );
    lastProtocolDiscoveryBlock =
      next.protocolObservedCursor.completeThroughBlock;
    lastProtocolDiscoveryBlockHash =
      next.protocolObservedCursor.completeThroughHash;
    protocolDiscoveryCoverage.replace(
      new Map(
        [...next.protocolFamilySourceCoverage].map(
          ([key, anchor]) => [
            key,
            anchor.completeThroughBlock,
          ],
        ),
      ),
    );
    protocolGraphCompleteThrough =
      protocolDiscoveryCoverage.graphCompleteThrough();
    discoveryPublicationRevision = next.revision;
    detector.setGraph(graph);
    detector.setPoolAddressMap(allPoolMap);
    planner.setGraph(graph);
    deps.onPublicationApplied({
      strategyViews,
      dexGraphCoverage: { ...dexGraphCoverage },
    });
  };

  const persistenceDelayRaw = Number(
    process.env.SEARCHER_DISCOVERY_PERSIST_DEBOUNCE_MS ??
      "30000",
  );
  const persistenceDelayMs = Number.isSafeInteger(persistenceDelayRaw) &&
      persistenceDelayRaw >= 1_000
    ? persistenceDelayRaw
    : 30_000;
  let lastPersistedGraphFingerprint =
    `${strategyViews.versions.backrun_view_hash}:` +
    strategyViews.versions.blockscan_view_hash;
  const persistenceWriter = new CoalescingAsyncWriter<number>(
    persistenceDelayMs,
    async () => {
      const graphFingerprint =
        `${strategyViews.versions.backrun_view_hash}:` +
        strategyViews.versions.blockscan_view_hash;
      const graphChanged =
        graphFingerprint !== lastPersistedGraphFingerprint;
      const views = strategyViews;
      const cacheSnapshot = cloneProtocolDiscoveryEvidenceCache(
        protocolDiscoveryCache,
      );
      await Promise.all([
        graphChanged
          ? deps.persistRuntimeGraphs(views)
          : Promise.resolve(),
        saveProtocolDiscoveryEvidenceCacheAsync(
          protocolDiscoveryCachePath,
          cacheSnapshot,
        ),
      ]);
      if (graphChanged) {
        lastPersistedGraphFingerprint = graphFingerprint;
      }
    },
    (error) => {
      console.warn(
        `[searcher/live] discovery persistence failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    },
  );
  const finishPublishedDiscoveryState = (): void => {
    if (discoveryUnsafeReason !== null) return;
    if (blindProductionAudit) return;
    mempoolIntakeRefresh.notify();
    persistenceWriter.schedule(discoveryPublicationRevision);
  };
  const finishCombinedDiscoveryTransition = (
    prepared: CombinedDiscoveryPrepared,
  ): void => {
    const dex = prepared.dex;
    if (dex) {
      logRuntimeRefreshFailures(
        dex.staticFailures,
        "static identity re-attestation failed",
      );
      if (dex.projection) {
        logRuntimeRefreshFailures(dex.projection.failedPools);
      }
    }
    const protocol = prepared.protocol;
    if (protocol.pass && protocol.scanRange) {
      emitProtocolDiscoveryEvents(
        protocol.pass.result.events,
        protocolDiscoveryShadow ? "shadow" : "active",
        protocol.scanRange.toBlock,
      );
      emitStaticSuppressedProtocolEvents(
        protocol.pass.projection,
        protocolDiscoveryShadow ? "shadow" : "active",
        protocol.scanRange.toBlock,
      );
      console.log(
        `[searcher/live] protocol address scan: ` +
          `addresses=${protocol.pass.scanner.addressStats.addresses} ` +
          `code_reads=${protocol.pass.scanner.addressStats.codeReads} ` +
          `cache_hits=${protocol.pass.scanner.addressStats.cacheHits} ` +
          `probes=${protocol.pass.scanner.addressStats.probes} ` +
          `matches=${protocol.pass.scanner.addressStats.matches} ` +
          `overlaps=${protocol.pass.scanner.addressStats.overlapAddresses} ` +
          `range=${protocol.scanRange.fromBlock}-` +
          `${protocol.scanRange.toBlock} ` +
          `target=${protocol.latestProtocolBlock}`,
      );
    }
    finishPublishedDiscoveryState();
  };
  const discoveryBackfillMaxBlocks = Math.max(
    1,
    Number(
      process.env.SEARCHER_DISCOVERY_BACKFILL_MAX_BLOCKS ??
        String(protocolDiscoveryMaxCatchupBlocks),
    ),
  );
  const discoveryBackfillBudgetMs = Math.max(
    1_000,
    Number(
      process.env.SEARCHER_DISCOVERY_BACKFILL_BUDGET_MS ??
        "120000",
    ),
  );
  const discoveryBackfillConcurrency = Math.max(
    1,
    Number(
      process.env.SEARCHER_DISCOVERY_BACKFILL_RPC_CONCURRENCY ??
        "2",
    ),
  );
  const dexBackfillLane = new DiscoveryBackfillLane<
    LiveDiscoveryPublicationState,
    CombinedDiscoveryPrepared
  >({
    maxBlocksPerJob: discoveryBackfillMaxBlocks,
    maxPreparationMs: discoveryBackfillBudgetMs,
    maxConcurrency: discoveryBackfillConcurrency,
    describeState: describeLiveDiscoveryPublicationState,
    prepare: (
      plan: DiscoveryBackfillPlan<LiveDiscoveryPublicationState>,
      control,
    ) => prepareCombinedDiscoveryTransition(plan.baseState, {
      source: plan.source,
      through: plan.range.toBlock,
      mode: "dex-backfill",
      control,
    }),
    validateTransition: (plan, prepared) => {
      const state = rebasePreparedDexTransition(
        plan.baseState,
        prepared,
      );
      if (state === null) {
        throw new Error(
          `DEX backfill ${plan.id} conflicted with its frozen base`,
        );
      }
      return { state, source: prepared.source };
    },
    rebaseTransition: (_plan, prepared, current) => {
      const state = rebasePreparedDexTransition(current, prepared);
      return state === null
        ? null
        : { state, source: prepared.source };
    },
    onError: (plan, error) => {
      console.warn(
        `[searcher/live] DEX backfill failed plan=${plan.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  const protocolBackfillLane = new DiscoveryBackfillLane<
    LiveDiscoveryPublicationState,
    CombinedDiscoveryPrepared
  >({
    maxBlocksPerJob: discoveryBackfillMaxBlocks,
    maxPreparationMs: discoveryBackfillBudgetMs,
    maxConcurrency: discoveryBackfillConcurrency,
    describeState: describeLiveDiscoveryPublicationState,
    prepare: (
      plan: DiscoveryBackfillPlan<LiveDiscoveryPublicationState>,
      control,
    ) => prepareCombinedDiscoveryTransition(plan.baseState, {
      source: plan.source,
      through: plan.range.toBlock,
      mode: "protocol-backfill",
      control,
    }),
    validateTransition: (plan, prepared) => ({
      state: validateCombinedDiscoveryTransition(
        plan.baseState,
        prepared,
      ),
      source: prepared.source,
    }),
    rebaseTransition: (_plan, prepared, current) => {
      const state = rebasePreparedProtocolTransition(
        current,
        prepared,
      );
      return state === null
        ? null
        : { state, source: prepared.source };
    },
    onError: (plan, error) => {
      console.warn(
        `[searcher/live] protocol backfill failed plan=${plan.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  const observeLiveCanonicalHeader = async (
    blockNumber: number,
  ): Promise<CanonicalHeader> => observeCanonicalHeader(
    provider,
    canonicalHeaderJournal,
    blockNumber,
    (result) => {
      if (result.invalidatedFrom === null) return;
      discoveryCanonicalEpoch++;
      const reason =
        `canonical_reorg_from_${result.invalidatedFrom}_` +
        `revision_${result.revision}`;
      dexBackfillLane.invalidate(reason);
      protocolBackfillLane.invalidate(reason);
      if (discoveryUnsafeReason !== null) return;
      // The aggregate publication has no per-edge branch provenance yet.
      // Keeping it after any observed reorg could retain an orphan-only pool
      // and later re-label the monotonic merge complete. Stop all generations
      // and let the supervisor rebuild from the canonical chain.
      discoveryUnsafeReason = reason;
      deps.onFatalReorg(reason);
      if (!blockScanRuntimeAbort.signal.aborted) {
        blockScanRuntimeAbort.abort(new Error(reason));
      }
      console.error(
        `[searcher/live] fatal discovery reorg: ${reason}; ` +
          `refusing publication and requesting clean restart`,
      );
      setImmediate(() => process.exit(1));
    },
  );
  const operationalDiscoveryCompleteThrough = (
    state: LiveDiscoveryPublicationState,
  ): number => {
    const observedThrough = protocolDiscoveryCoverage.hasObservedSource()
      ? state.protocolObservedCursor.completeThroughBlock
      : state.dexGraphCoverage.sourceCompleteThrough;
    return Math.min(
      state.dexGraphCoverage.sourceCompleteThrough,
      observedThrough,
    );
  };
  const consumeProtocolBackfillReady = async (): Promise<void> => {
    const ready = protocolBackfillLane.readyDescriptor();
    if (ready === null || discoveryUnsafeReason !== null) return;
    const latest = await provider.getBlockNumber();
    const target = await observeLiveCanonicalHeader(latest);
    let preparedHeader: CanonicalHeader;
    try {
      preparedHeader = await observeLiveCanonicalHeader(
        ready.source.number,
      );
    } catch (error) {
      if (!(error instanceof CanonicalHeaderOutsideRetentionError)) {
        throw error;
      }
      protocolBackfillLane.invalidate(
        `prepared source ${ready.source.number} fell outside ` +
          `retained canonical journal at ${error.retainedHeadNumber}`,
      );
      await scheduleDiscoveryBackfill(latest);
      return;
    }
    const proof = canonicalHeaderJournal.proof(preparedHeader.number);
    const taken = await protocolDiscoveryQueue.enqueue(
      "active",
      async () => {
        const result = protocolBackfillLane.takeForHotHead({
          targetSource: {
            number: target.number,
            hash: target.hash,
          },
          currentState: captureLiveDiscoveryPublication(),
          canonicalPreparedSource: proof === null
            ? null
            : {
                revision: proof.revision,
                source: proof.source,
              },
          currentCanonicalRevision: canonicalHeaderJournal.revision,
        });
        if (result.status !== "degraded") {
          publishLiveDiscoveryState(result.state);
        }
        return result;
      },
    );
    if (taken.status !== "degraded") {
      finishPublishedDiscoveryState();
    }
  };
  const scheduleProtocolBackfill = (
    source: CanonicalHeader,
    base: LiveDiscoveryPublicationState,
    targetThrough: number,
  ): void => {
    const completeThrough = operationalDiscoveryCompleteThrough(base);
    if (completeThrough >= targetThrough) return;
    const fromBlock = completeThrough + 1;
    const toBlock = Math.min(
      targetThrough,
      completeThrough + discoveryBackfillMaxBlocks,
    );
    const scheduled = protocolBackfillLane.schedule({
      id:
        `protocol:${fromBlock}-${toBlock}@` +
        `${source.number}:${source.hash}`,
      range: { fromBlock, toBlock },
      source: { number: source.number, hash: source.hash },
    }, base);
    if (!scheduled.scheduled) return;
    void protocolBackfillLane.settled()
      .then(consumeProtocolBackfillReady)
      .catch((error) => {
        console.warn(
          `[searcher/live] protocol backfill publication failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const scheduleDiscoveryBackfill = async (
    targetBlock?: number,
  ): Promise<void> => {
    const latest = targetBlock ?? await provider.getBlockNumber();
    const source = await observeLiveCanonicalHeader(latest);
    const base = captureLiveDiscoveryPublication();
    const {
      dexThrough: dexTargetThrough,
      protocolThrough: protocolTargetThrough,
    } = planLiveBackfillTargets(source.number);
    const hasProjectionRetry =
      base.retryableDexGraphPools.size > 0 ||
      base.retryableDexIdentityPools.size > 0 ||
      base.dexGraphCoverage.graphCompleteThrough <
        base.dexGraphCoverage.sourceCompleteThrough;
    const dexSourceThrough =
      base.dexGraphCoverage.sourceCompleteThrough;
    const lanePlan = planLiveDiscoveryBackfillLanes({
      dexSourceCompleteThrough: dexSourceThrough,
      dexTargetThrough,
      hasDexProjectionRetry: hasProjectionRetry,
    });
    if (lanePlan.protocol === "preempt") {
      protocolBackfillLane.invalidate("DEX backfill priority");
      const fromBlock = dexSourceThrough + 1;
      const toBlock = Math.min(
        dexTargetThrough,
        dexSourceThrough + discoveryBackfillMaxBlocks,
      );
      dexBackfillLane.schedule({
        id:
          `dex:${fromBlock}-${toBlock}@` +
          `${source.number}:${source.hash}`,
        range: { fromBlock, toBlock },
        source: { number: source.number, hash: source.hash },
      }, base);
      return;
    }

    if (lanePlan.dex === "projection") {
      dexBackfillLane.schedule({
        id:
          `dex:${dexTargetThrough}-${dexTargetThrough}@` +
          `${source.number}:${source.hash}`,
        range: {
          fromBlock: dexTargetThrough,
          toBlock: dexTargetThrough,
        },
        source: { number: source.number, hash: source.hash },
      }, base);
    }

    // Protocol history is a lower-priority worker. Its trace/probe deadline
    // cannot occupy or erase the independent DEX recovery lane. A family-local
    // projection retry likewise cannot starve protocol history indefinitely.
    scheduleProtocolBackfill(source, base, protocolTargetThrough);
  };
  let refreshTimer: NodeJS.Timeout | null = null;
  let protocolDiscoveryTimer: NodeJS.Timeout | null = null;
  let started = false;
  let stopped = false;
  const start = (): void => {
    if (started || stopped) return;
    started = true;
    if (blindProductionAudit) return;
    refreshTimer = setInterval(() => {
      void scheduleDiscoveryBackfill().catch((error) => {
        console.warn(
          `[searcher/live] discovery backfill schedule failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, refreshIntervalMs);
    protocolDiscoveryTimer = setInterval(() => {
        void scheduleDiscoveryBackfill().catch((error) => {
          console.warn(
            `[searcher/live] protocol backfill schedule failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, protocolDiscoveryIntervalMs);
    void scheduleDiscoveryBackfill(discoveryToBlock).catch((error) => {
      console.warn(
        `[searcher/live] initial discovery backfill schedule failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (refreshTimer) clearInterval(refreshTimer);
    if (protocolDiscoveryTimer) clearInterval(protocolDiscoveryTimer);
    refreshTimer = null;
    protocolDiscoveryTimer = null;
    dexBackfillLane.invalidate("searcher shutdown");
    protocolBackfillLane.invalidate("searcher shutdown");
    await Promise.all([
      dexBackfillLane.settled(),
      protocolBackfillLane.settled(),
    ]);
    // An observed preparation may enqueue a final atomic publication. Drain
    // it before the mutation queue, then schedule the latest published
    // revision so shutdown never flushes an older cache snapshot.
    await observedProtocolPreparationTail;
    await protocolDiscoveryQueue.settled();
    if (!blindProductionAudit && discoveryUnsafeReason === null) {
      persistenceWriter.schedule(discoveryPublicationRevision);
    }
    await persistenceWriter.flush();
  };
  const unknownProtocolSelectorLastBlock = new Map<string, number>();
  // Receipt/trace/probe preparation is serialized independently of the live
  // publication queue. Slow trace RPC can delay another observed receipt, but
  // it can never delay current-block discovery publication or block-scan.
  let observedProtocolPreparationTail: Promise<void> = Promise.resolve();
  const enqueueObservedProtocolPreparation = (
    work: () => Promise<void>,
  ): Promise<void> => {
    const run = observedProtocolPreparationTail.then(work);
    observedProtocolPreparationTail = run.catch((error) => {
      console.log(
        `[searcher/live] observed protocol preparation error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return observedProtocolPreparationTail;
  };
  const processObservedProtocolReceipt = async (input: {
    txHash: string;
    blockNumber: number;
    receipt: ProtocolDiscoveryReceipt;
  }): Promise<void> => {
    const enabledDiscoveryAdapters = PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes()
      .filter((adapter) =>
        !adapter.requiresProtocolEdgesFlag || config.enableProtocolEdges
      );
    if (
      protocolDiscoveryShadow ||
      !shouldTraceForProtocolDiscovery(
        input.receipt.logs,
        enabledDiscoveryAdapters,
      )
    ) return;
    const txKey = input.txHash.toLowerCase();
    const maxPreparationMs = Math.max(
      1_000,
      Number(
        process.env.SEARCHER_OBSERVED_PROTOCOL_BUDGET_MS ??
          "30000",
      ),
    );
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + maxPreparationMs;
    const timer = setTimeout(() => {
      controller.abort(
        new Error(
          `observed protocol preparation exceeded ` +
            `${maxPreparationMs}ms`,
        ),
      );
    }, maxPreparationMs);
    const control: ProtocolDiscoveryReadControl = {
      signal: controller.signal,
      deadlineAtMs,
      run: (work) => work(controller.signal),
    };
    try {
      // A current-block publication may legitimately win while trace/probe is
      // running. Retry once from the new aggregate base; the trace memo makes
      // the expensive call a cache hit.
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (controller.signal.aborted) return;
        const canonicalEpoch = discoveryCanonicalEpoch;
        const base = captureLiveDiscoveryPublication();
        if (
          base.protocolEvidenceCache.runtime.recentProcessedTxs.has(
            txKey,
          )
        ) return;
        const sourceBefore = await observeLiveCanonicalHeader(
          input.blockNumber,
        );
        const graphTokens = protocolDexDomainFor(
          base.backrunGraph,
          base.blockscanGraph,
        );
        const traceContext = createPinnedProtocolDiscoveryContext({
          provider,
          blockNumber: input.blockNumber,
          fromBlock: input.blockNumber,
          chainId: protocolDiscoveryChainId,
          probeExecutor: config.botvmAddress,
          graphTokens,
          control,
        });
        let trace: unknown;
        try {
          trace = await deps.getProtocolTraceMemo().trace(
            txKey,
            input.blockNumber,
            () => traceContext.backend.traceTransaction(
              input.txHash,
              control,
            ),
          );
        } catch (error) {
          console.log(
            `[searcher/live] protocol discovery trace unavailable tx=` +
              `${input.txHash.slice(0, 10)} ` +
              `${error instanceof Error
                ? error.message
                : String(error)}`,
          );
          return;
        }
        const pass = await prepareObservedProtocolDiscoveryPass({
          provider,
          adapters:
            PRODUCTION_ADAPTER_FAMILIES.discoverableRoutes(),
          identityRegistry:
            PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
          protocolEdgesEnabled: config.enableProtocolEdges,
          chainId: protocolDiscoveryChainId,
          probeExecutor: config.botvmAddress,
          currentOwnership: base.protocolOwnership,
          currentBackrunPools: base.strategyViews.backrun,
          currentBackrunGraph: base.backrunGraph,
          currentBlockscanGraph: base.blockscanGraph,
          currentKnownPoolKeys: base.knownPoolKeys,
          buildStrategyViews: rebuildStrategyViews,
          blockNumber: input.blockNumber,
          txHash: input.txHash,
          receipt: input.receipt,
          trace,
          graphTokens,
          control,
        });
        const sourceAfter = await observeLiveCanonicalHeader(
          input.blockNumber,
        );
        if (sourceAfter.hash !== sourceBefore.hash) return;
        const next = projectObservedProtocolPublication({
          base,
          projection: pass.projection,
          result: pass.result,
          txHash: input.txHash,
          blockNumber: input.blockNumber,
        });
        const expected =
          describeLiveDiscoveryPublicationState(base);
        const canonicalRevision =
          canonicalHeaderJournal.revision;
        const committed = await protocolDiscoveryQueue.enqueue(
          "observed",
          async () => {
            const actual = describeLiveDiscoveryPublicationState(
              captureLiveDiscoveryPublication(),
            );
            if (
              actual.revision !== expected.revision ||
              actual.baseFingerprint !==
                expected.baseFingerprint ||
              actual.coverageFingerprint !==
                expected.coverageFingerprint ||
              discoveryUnsafeReason !== null ||
              discoveryCanonicalEpoch !== canonicalEpoch ||
              canonicalHeaderJournal.revision !==
                canonicalRevision ||
              canonicalHeaderJournal.lookup(input.blockNumber)
                ?.hash !== sourceAfter.hash
            ) {
              return false;
            }
            publishLiveDiscoveryState(next);
            return true;
          },
        );
        if (!committed) {
          if (attempt < 2) continue;
          console.log(
            `[searcher/live] observed protocol publication stale tx=` +
              `${input.txHash.slice(0, 10)} attempts=${attempt}`,
          );
          return;
        }

        emitProtocolDiscoveryEvents(
          pass.result.events,
          "observed",
          input.blockNumber,
        );
        emitStaticSuppressedProtocolEvents(
          pass.projection,
          "observed",
          input.blockNumber,
        );
        for (const diagnostic of pass.unknownSelectors) {
          const key =
            `${diagnostic.target.toLowerCase()}|` +
            diagnostic.selector;
          const last =
            unknownProtocolSelectorLastBlock.get(key) ?? -Infinity;
          if (input.blockNumber - last < 100) continue;
          unknownProtocolSelectorLastBlock.set(
            key,
            input.blockNumber,
          );
          emitEvent({
            type: "protocol_discovery_unknown_selector",
            target: diagnostic.target,
            selector: diagnostic.selector,
            reason: diagnostic.reason,
            recommendation: diagnostic.recommendation,
            ...(diagnostic.matchingAdapterIds === undefined
              ? {}
              : {
                  matching_adapter_ids: [
                    ...diagnostic.matchingAdapterIds,
                  ],
                }),
            tx_hash: input.txHash,
            block_number: input.blockNumber,
          });
        }
        finishPublishedDiscoveryState();
        return;
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const observeProtocolReceipt = (input: {
    txHash: string;
    blockNumber: number;
    receipt: ProtocolDiscoveryReceipt;
  }): Promise<void> => enqueueObservedProtocolPreparation(
    () => processObservedProtocolReceipt(input),
  );
  const observeProtocolTxHash = (txHash: string): Promise<void> =>
    enqueueObservedProtocolPreparation(
      async () => {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1 || receipt.blockNumber === null) return;
        await processObservedProtocolReceipt({
          txHash,
          blockNumber: receipt.blockNumber,
          receipt: {
            status: receipt.status,
            logs: receipt.logs.map((log) => ({
              address: log.address,
              topics: [...log.topics],
              data: log.data,
              transactionHash: log.transactionHash,
              blockNumber: log.blockNumber,
            })),
          },
        });
      },
    );

  const blockScanHooks = {
    lane: dexBackfillLane,
    journal: canonicalHeaderJournal,
    queue: protocolDiscoveryQueue,
    observeHeader: observeLiveCanonicalHeader,
    capture: captureLiveDiscoveryPublication,
    publish: publishLiveDiscoveryState,
    finishPublished: finishPublishedDiscoveryState,
    scheduleBackfill: scheduleDiscoveryBackfill,
    prepare: (
      base: LiveDiscoveryPublicationState,
      input: {
        readonly source: {
          readonly number: number;
          readonly hash: string;
        };
        readonly through: number;
        readonly control?: DiscoveryBackfillControl;
      },
    ) =>
      prepareCombinedDiscoveryTransition(base, {
        ...input,
        mode: "hot",
      }),
    validateHot: rebasePreparedDexTransition,
    finish: finishCombinedDiscoveryTransition,
  };

  return Object.freeze({
    start,
    shutdown,
    scheduleBackfill: scheduleDiscoveryBackfill,
    observeProtocolReceipt,
    observeProtocolTxHash,
    capture: captureLiveDiscoveryPublication,
    publish: publishLiveDiscoveryState,
    settled: () => protocolDiscoveryQueue.settled(),
    blockScanHooks,
  });
}

const DEX_IDENTITY_RETRY_TIMEOUT_MS = 3_000;

/**
 * A retry generation must not inherit the enclosing pass's entire deadline.
 * Keep unresolved identities explicit for the next block while cancelling the
 * actual HTTP requests, so healthy adapter families can still reach pricing.
 */
async function prepareBoundedDexIdentityRetry(input: {
  readonly currentN: number;
  readonly backend: PinnedDexReadBackend;
  readonly remaining: readonly PoolEntry[];
  readonly identityRegistry: IdentityResolverRegistry;
  readonly seedEntries: readonly PoolEntry[];
  readonly admissionPolicy: IdentityAdmissionPolicy;
}): Promise<StartupDexIdentityRetryStage<PoolEntry>> {
  if (input.remaining.length === 0) {
    return prepareStartupDexIdentityRetryStage({
      currentN: input.currentN,
      backend: input.backend,
      state: { accepted: [], remaining: [] },
      identityRegistry: input.identityRegistry,
      seedEntries: input.seedEntries,
      admissionPolicy: input.admissionPolicy,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `DEX identity retry exceeded ${DEX_IDENTITY_RETRY_TIMEOUT_MS}ms`,
        ),
      ),
    DEX_IDENTITY_RETRY_TIMEOUT_MS,
  );
  const backend: PinnedDexReadBackend = Object.freeze({
    sourceBlock: input.backend.sourceBlock,
    call: (request: {
      readonly to: string;
      readonly data: string;
      readonly blockTag?: ethers.BlockTag;
    }) =>
      input.backend.call(request, { signal: controller.signal }),
    getCode: (address: string) =>
      input.backend.getCode(address, { signal: controller.signal }),
  });
  try {
    return await prepareStartupDexIdentityRetryStage({
      currentN: input.currentN,
      backend,
      state: { accepted: [], remaining: input.remaining },
      identityRegistry: input.identityRegistry,
      seedEntries: input.seedEntries,
      admissionPolicy: input.admissionPolicy,
    });
  } finally {
    clearTimeout(timer);
  }
}

export type LiveDiscoveryCoordinator = Awaited<
  ReturnType<typeof createLiveDiscoveryCoordinator>
>;

export async function readBlockHash(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): Promise<string> {
  const block = await provider.getBlock(blockNumber);
  if (!block?.hash) {
    throw new Error(`missing canonical hash for block ${blockNumber}`);
  }
  return block.hash.toLowerCase();
}

async function readDexDiscoveryBlockHash(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  control?: DexDiscoveryReadControl | ProtocolDiscoveryReadControl,
): Promise<string> {
  if (!control) return readBlockHash(provider, blockNumber);
  const block = await sendDexDiscoveryRpc<{
    readonly hash?: unknown;
  } | null>(
    provider,
    "eth_getBlockByNumber",
    [ethers.toQuantity(blockNumber), false],
    control,
  );
  if (
    typeof block?.hash !== "string" ||
    !ethers.isHexString(block.hash, 32)
  ) {
    throw new Error(`missing canonical hash for block ${blockNumber}`);
  }
  return block.hash.toLowerCase();
}

async function readCanonicalHeader(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): Promise<CanonicalHeader> {
  const block = await provider.send(
    "eth_getBlockByNumber",
    [ethers.toQuantity(blockNumber), false],
  ) as {
    readonly number?: unknown;
    readonly hash?: unknown;
    readonly parentHash?: unknown;
  } | null;
  if (
    typeof block?.number !== "string" ||
    ethers.toNumber(block.number) !== blockNumber ||
    typeof block.hash !== "string" ||
    typeof block.parentHash !== "string" ||
    !ethers.isHexString(block.hash, 32) ||
    !ethers.isHexString(block.parentHash, 32)
  ) {
    throw new Error(
      `canonical header ${blockNumber} is missing number/hash/parentHash`,
    );
  }
  return Object.freeze({
    number: blockNumber,
    hash: block.hash.toLowerCase(),
    parentHash: block.parentHash.toLowerCase(),
  });
}

async function observeCanonicalHeader(
  provider: ethers.JsonRpcProvider,
  journal: CanonicalHeaderJournal,
  blockNumber: number,
  onIngest?: (result: CanonicalHeaderIngestResult) => void,
): Promise<CanonicalHeader> {
  const currentHead = journal.head;
  if (
    currentHead &&
    blockNumber < currentHead.number &&
    journal.lookup(blockNumber) === null
  ) {
    const distance = currentHead.number - blockNumber;
    if (distance >= 2_048) {
      throw new CanonicalHeaderOutsideRetentionError(
        blockNumber,
        currentHead.number,
      );
    }
    let child = currentHead;
    for (
      let number = currentHead.number - 1;
      number >= blockNumber;
      number--
    ) {
      const known = journal.lookup(number);
      if (known) {
        if (child.parentHash !== known.hash) {
          throw new Error(
            `canonical ancestor mismatch ${child.number}: ` +
              `${child.parentHash} != ${known.hash}`,
          );
        }
        child = known;
        continue;
      }
      const ancestor = await readCanonicalHeader(provider, number);
      if (child.parentHash !== ancestor.hash) {
        throw new Error(
          `canonical ancestor mismatch ${child.number}: ` +
            `${child.parentHash} != ${ancestor.hash}`,
        );
      }
      const result = journal.ingest(ancestor);
      onIngest?.(result);
      child = ancestor;
    }
    const anchored = journal.lookup(blockNumber);
    if (!anchored) {
      throw new Error(
        `canonical ancestor ${blockNumber} was not retained`,
      );
    }
    return anchored;
  }
  const incoming = await readCanonicalHeader(provider, blockNumber);
  const existing = journal.lookup(blockNumber);
  if (
    existing?.hash === incoming.hash &&
    existing.parentHash === incoming.parentHash
  ) {
    onIngest?.(journal.ingest(incoming));
    return incoming;
  }

  const reverse: CanonicalHeader[] = [incoming];
  let cursor = incoming;
  while (cursor.number > 0) {
    const knownParent = journal.lookup(cursor.number - 1);
    if (knownParent?.hash === cursor.parentHash) break;
    const parent = await readCanonicalHeader(
      provider,
      cursor.number - 1,
    );
    if (parent.hash !== cursor.parentHash) {
      throw new Error(
        `canonical header parent mismatch ${cursor.number}: ` +
          `${cursor.parentHash} != ${parent.hash}`,
      );
    }
    reverse.push(parent);
    cursor = parent;
    if (
      journal.head &&
      journal.head.number - cursor.number >= 2_048
    ) {
      break;
    }
  }
  for (const header of reverse.reverse()) {
    onIngest?.(journal.ingest(header));
  }
  return incoming;
}

async function discoveryCoverageAnchor(
  provider: ethers.JsonRpcProvider,
  completeThroughBlock: number,
  knownBlock: number,
  knownHash: string,
): Promise<DiscoveryCoverageAnchor> {
  if (completeThroughBlock < 0) {
    return Object.freeze({
      completeThroughBlock: -1,
      completeThroughHash: null,
    });
  }
  const completeThroughHash = completeThroughBlock === knownBlock
    ? knownHash.toLowerCase()
    : await readBlockHash(provider, completeThroughBlock);
  return Object.freeze({
    completeThroughBlock,
    completeThroughHash,
  });
}

function coverageAnchorFromStage(
  completeThroughBlock: number,
  expectedBlock: number | undefined,
  expectedHash: string | null | undefined,
  label: string,
): DiscoveryCoverageAnchor {
  if (completeThroughBlock < 0) {
    return Object.freeze({
      completeThroughBlock: -1,
      completeThroughHash: null,
    });
  }
  if (
    expectedBlock !== completeThroughBlock ||
    typeof expectedHash !== "string" ||
    !ethers.isHexString(expectedHash, 32)
  ) {
    throw new Error(
      `${label} coverage ${completeThroughBlock} has no exact canonical anchor`,
    );
  }
  return Object.freeze({
    completeThroughBlock,
    completeThroughHash: expectedHash.toLowerCase(),
  });
}

function replaceArray<T>(target: T[], next: readonly T[]): void {
  target.splice(0, target.length, ...next);
}

function replaceMap<K, V>(
  target: Map<K, V>,
  next: ReadonlyMap<K, V>,
): void {
  target.clear();
  for (const [key, value] of next) target.set(key, value);
}

function replaceSet<T>(target: Set<T>, next: ReadonlySet<T>): void {
  target.clear();
  for (const value of next) target.add(value);
}
