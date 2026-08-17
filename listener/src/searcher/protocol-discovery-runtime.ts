import { ethers } from "ethers";
import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";
import {
  createProtocolDiscoveryEvidenceCache,
  type ProtocolDiscoveryEvidenceCache,
} from "./protocol-discovery-cache.js";
import {
  createCanonicalProtocolIdentityAttester,
  createPinnedProtocolDiscoveryContext,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
  type ProtocolDiscoveryOwnership,
  type ProtocolDiscoveryProjection,
  type ProtocolDiscoveryResult,
} from "./protocol-instance-discovery.js";
import {
  scanObservedProtocolTrace,
  scanProtocolDiscoveryRange,
  type ProtocolDiscoveryRangeResult,
  type ProtocolTraceMemo,
} from "./observed-protocol-discovery.js";
import type { StrategyViews } from "./strategy-views.js";
import type { IdentityResolverRegistry } from "./venues/identity.js";
import type { CentralAdapterRuntime } from "./adapter-work-intent.js";
import type {
  ProtocolCandidate,
  ProtocolDiscoveryLog,
  ProtocolDiscoveryReadControl,
  ProtocolDiscoveryReceipt,
  RouteLegAdapter,
} from "./venues/route-leg-adapter.js";

export interface ProtocolDiscoveryRuntimeInput {
  readonly provider: ethers.JsonRpcProvider;
  /**
   * Optional archive fallback for explicitly pruned historical traces. All
   * other reads remain pinned to `provider`.
   */
  readonly observedHistoryProvider?: ethers.JsonRpcProvider;
  readonly adapters: readonly RouteLegAdapter[];
  /**
   * F8: enumerable strict-catalog event topics for the observed lane. Logs
   * matching these enter the strict observedEvents surface directly without
   * receipt/trace work.
   */
  readonly extraEventTopics?: ReadonlySet<string>;
  /** One-shot historical event-window lookback (see scanner). */
  readonly eventWindowLookbackBlocks?: number;
  readonly identityRegistry: IdentityResolverRegistry;
  /** F8: production-shaped identity runtime (revm simulation transport). */
  readonly identityRuntime?: CentralAdapterRuntime;
  readonly protocolEdgesEnabled: boolean;
  readonly chainId?: bigint | number | string;
  readonly probeExecutor?: string;
  readonly currentOwnership: ProtocolDiscoveryOwnership;
  readonly currentBackrunPools: readonly PoolEntry[];
  readonly currentBackrunGraph: readonly TokenEdge[];
  readonly currentBlockscanGraph?: readonly TokenEdge[];
  readonly currentKnownPoolKeys?: ReadonlySet<string>;
  readonly buildStrategyViews: (pools: PoolEntry[]) => StrategyViews;
  /** Parent background-pass lifetime; every discovery RPC inherits it. */
  readonly control?: ProtocolDiscoveryReadControl;
}

export interface ProtocolDiscoveryStartupFallbackOptions {
  /** Search strictly before the bounded startup window. */
  readonly searchBeforeBlock: number;
  /** One-time bounded lookback; production never chases genesis. */
  readonly maxLookbackBlocks: number;
  readonly logChunkBlocks?: number;
  readonly maxTransactionsPerFamily?: number;
}

export interface ProtocolDiscoveryStartupFallbackResult {
  readonly candidatesByAdapter: ReadonlyMap<
    string,
    readonly ProtocolCandidate[]
  >;
  readonly searchedFamilyIds: readonly string[];
  readonly recoveredFamilyIds: readonly string[];
  readonly inspectedTransactions: number;
  readonly errors: readonly {
    readonly familyId: string;
    readonly reason: string;
  }[];
}

/**
 * The active protocol address source is the DEX graph only. Protocol edges are
 * deliberately excluded so a legacy/static protocol row cannot become its own
 * discovery credential.
 */
export function protocolCandidateAddressesFromDexGraph(
  backrunGraph: readonly TokenEdge[],
  blockscanGraph?: readonly TokenEdge[],
): string[] {
  return [...new Set(
    [...backrunGraph, ...(blockscanGraph ?? [])]
      .filter((edge) => edge.slotKind === "swap")
      .flatMap((edge) => [edge.tokenIn.toLowerCase(), edge.tokenOut.toLowerCase()]),
  )];
}

/**
 * Full file-backed DEX universe domain. This deliberately reads only DEX token
 * metadata; fixed protocol tokens are not allowed to bootstrap discovery.
 */
export function protocolCandidateAddressesFromDexUniverse(
  pools: readonly PoolEntry[],
  dexPoolAdapters: ReadonlySet<string>,
): string[] {
  const addresses = new Set<string>();
  for (const pool of pools) {
    if (!dexPoolAdapters.has(pool.adapter)) continue;
    const rawTokens = [
      pool.token0,
      pool.token1,
      pool.currency0,
      pool.currency1,
      ...(pool.underlyingCoins ?? []),
    ];
    for (const raw of rawTokens) {
      if (!raw) continue;
      try {
        const address = ethers.getAddress(raw);
        if (address !== ethers.ZeroAddress) addresses.add(address.toLowerCase());
      } catch {
        // Invalid universe metadata was already rejected by identity admission.
      }
    }
  }
  return [...addresses].sort();
}

/**
 * Project provenance-only address hints from the registered protocol families.
 * Hints join the address-matcher input only; they never become graph tokens,
 * PoolEntries, identity evidence, or executable routes.
 */
export function protocolDiscoveryCandidateAddressHints(
  adapters: readonly RouteLegAdapter[],
): string[] {
  const addresses = new Set<string>();
  for (const adapter of adapters) {
    for (const raw of adapter.discovery?.candidateAddressHints ?? []) {
      const address = ethers.getAddress(raw);
      if (address !== ethers.ZeroAddress) addresses.add(address.toLowerCase());
    }
  }
  return [...addresses].sort();
}

export async function prepareActiveProtocolDiscoveryPass(
  input: ProtocolDiscoveryRuntimeInput & {
    readonly blockNumber: number;
    readonly fromBlock: number;
    /** Historical observed-source range end; state/probes remain pinned to blockNumber. */
    readonly toBlock?: number;
    readonly graphTokens: readonly string[];
    readonly candidateAddresses: readonly string[];
    readonly evidenceCache?: ProtocolDiscoveryEvidenceCache;
    readonly bootstrapCandidates?: ReadonlyMap<string, readonly ProtocolCandidate[]>;
    readonly startupFallback?: ProtocolDiscoveryStartupFallbackOptions;
    readonly traceMemo?: ProtocolTraceMemo;
    readonly shadow: boolean;
  },
): Promise<{
  result: ProtocolDiscoveryResult;
  projection: ProtocolDiscoveryProjection | null;
  scanner: ProtocolDiscoveryRangeResult;
  startupFallback: ProtocolDiscoveryStartupFallbackResult;
}> {
  const retainedInstances = [...input.currentOwnership.admissions.values()]
    .map((item) => ({ ...item.instance, ownerAdapterId: item.adapterId }));
  const context = createPinnedProtocolDiscoveryContext({
    provider: input.provider,
    ...(input.observedHistoryProvider === undefined
      ? {}
      : { observedHistoryProvider: input.observedHistoryProvider }),
    blockNumber: input.blockNumber,
    fromBlock: input.fromBlock,
    ...(input.toBlock === undefined ? {} : { toBlock: input.toBlock }),
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
    ...(input.probeExecutor === undefined ? {} : { probeExecutor: input.probeExecutor }),
    graphTokens: input.graphTokens,
    retainedInstances,
    ...(input.control === undefined ? {} : { control: input.control }),
  });
  const enabledAdapters = enabledDiscoveryAdapters(
    input.adapters,
    input.protocolEdgesEnabled,
  );
  const scanned = enabledAdapters.length > 0
    ? await scanProtocolDiscoveryRange({
      adapters: enabledAdapters,
      context,
      candidateAddresses: input.candidateAddresses,
      evidenceCache: input.evidenceCache ?? createProtocolDiscoveryEvidenceCache(),
      ...(input.traceMemo === undefined ? {} : { traceMemo: input.traceMemo }),
      ...(input.control === undefined ? {} : { control: input.control }),
      ...(input.extraEventTopics === undefined
        ? {}
        : { extraEventTopics: input.extraEventTopics }),
      ...(input.eventWindowLookbackBlocks === undefined
        ? {}
        : { eventWindowLookbackBlocks: input.eventWindowLookbackBlocks }),
    })
    : {
      candidatesByAdapter: new Map(),
      unknownSelectors: [],
      sourceComplete: true,
      eventSourceComplete: true,
      addressSourceComplete: true,
      sourceErrors: [],
      addressStats: {
        addresses: 0,
        codeReads: 0,
        cacheHits: 0,
        probes: 0,
        matches: 0,
        negatives: 0,
        overlapAddresses: 0,
      },
    };
  if (
    scanned.eventSourceComplete === false ||
    scanned.sourceErrors.length > 0
  ) {
    console.log(
      `[searcher/live] protocol observed range scan: ` +
        `eventSourceComplete=${scanned.eventSourceComplete} ` +
        `errors=${JSON.stringify(
          scanned.sourceErrors.slice(0, 3).map((issue) => ({
            sourceKind: issue.sourceKind,
            reason: issue.reason,
            retryable: issue.retryable,
          })),
        )}`,
    );
  }
  const initialCandidates = mergeCandidateMaps(
    scanned.candidatesByAdapter,
    input.bootstrapCandidates,
  );
  const attestIdentity = createCanonicalProtocolIdentityAttester(
    input.identityRuntime === undefined
      ? undefined
      : { identityRuntime: input.identityRuntime },
  );
  const initialResult = await runProtocolDiscovery({
    adapters: input.adapters,
    context,
    protocolEdgesEnabled: input.protocolEdgesEnabled,
    attestIdentity,
    candidatesByAdapter: initialCandidates,
    sourceComplete: scanned.sourceComplete,
    sourceErrors: scanned.sourceErrors,
    ...(input.control === undefined ? {} : { control: input.control }),
  });
  const startupFallback = input.startupFallback === undefined
    ? emptyStartupFallbackResult()
    : await discoverStartupObservedFallbackCandidates({
        adapters: enabledAdapters,
        context,
        admittedFamilyIds: new Set(
          initialResult.wouldAdmit.map((admission) => admission.adapterId),
        ),
        options: input.startupFallback,
        ...(input.traceMemo === undefined
          ? {}
          : { traceMemo: input.traceMemo }),
        ...(input.control === undefined ? {} : { control: input.control }),
      });
  const result = startupFallback.candidatesByAdapter.size === 0
    ? initialResult
    : await runProtocolDiscovery({
        adapters: input.adapters,
        context,
        protocolEdgesEnabled: input.protocolEdgesEnabled,
        attestIdentity,
        candidatesByAdapter: mergeCandidateMaps(
          initialCandidates,
          startupFallback.candidatesByAdapter,
        ),
        sourceComplete: scanned.sourceComplete,
        sourceErrors: scanned.sourceErrors,
        ...(input.control === undefined ? {} : { control: input.control }),
      });
  return {
    result,
    scanner: scanned,
    startupFallback,
    projection: input.shadow
      ? null
      : prepareProtocolDiscoveryProjection({
        currentOwnership: input.currentOwnership,
        result,
        currentBackrunPools: input.currentBackrunPools,
        currentBackrunGraph: input.currentBackrunGraph,
        currentBlockscanGraph: input.currentBlockscanGraph,
        currentKnownPoolKeys: input.currentKnownPoolKeys,
        buildStrategyViews: input.buildStrategyViews,
      }),
  };
}

export function protocolFamiliesNeedingStartupObservedFallback(
  adapters: readonly RouteLegAdapter[],
  admittedFamilyIds: ReadonlySet<string>,
): RouteLegAdapter[] {
  return adapters.filter((adapter) =>
    adapter.discovery?.candidateSources.includes("observed-interaction") ===
      true &&
    adapter.discovery.eventTopics.length > 0 &&
    !admittedFamilyIds.has(adapter.id)
  );
}

export async function discoverStartupObservedFallbackCandidates(input: {
  readonly adapters: readonly RouteLegAdapter[];
  readonly context: ReturnType<typeof createPinnedProtocolDiscoveryContext>;
  readonly admittedFamilyIds: ReadonlySet<string>;
  readonly options: ProtocolDiscoveryStartupFallbackOptions;
  readonly traceMemo?: ProtocolTraceMemo;
  readonly control?: ProtocolDiscoveryReadControl;
}): Promise<ProtocolDiscoveryStartupFallbackResult> {
  const {
    searchBeforeBlock,
    maxLookbackBlocks,
  } = input.options;
  if (
    !Number.isSafeInteger(searchBeforeBlock) ||
    searchBeforeBlock < 0 ||
    !Number.isSafeInteger(maxLookbackBlocks) ||
    maxLookbackBlocks < 0
  ) {
    throw new Error("invalid protocol startup fallback range");
  }
  const logChunkBlocks = Math.max(
    1,
    Math.floor(input.options.logChunkBlocks ?? 1_000),
  );
  const maxTransactionsPerFamily = Math.max(
    1,
    Math.floor(input.options.maxTransactionsPerFamily ?? 3),
  );
  const missing = protocolFamiliesNeedingStartupObservedFallback(
    input.adapters,
    input.admittedFamilyIds,
  );
  const candidatesByAdapter = new Map<string, ProtocolCandidate[]>();
  const recoveredFamilyIds: string[] = [];
  const errors: Array<{ familyId: string; reason: string }> = [];
  const txMemo = new Map<string, Promise<{
    readonly receipt: ProtocolDiscoveryReceipt;
    readonly trace: unknown;
  }>>();
  let inspectedTransactions = 0;
  const earliestBlock = Math.max(
    0,
    searchBeforeBlock - maxLookbackBlocks + 1,
  );

  for (const adapter of missing) {
    let toBlock = Math.min(searchBeforeBlock, input.context.blockNumber);
    let inspectedForFamily = 0;
    let recovered = false;
    while (
      !recovered &&
      inspectedForFamily < maxTransactionsPerFamily &&
      toBlock >= earliestBlock
    ) {
      const fromBlock = Math.max(
        earliestBlock,
        toBlock - logChunkBlocks + 1,
      );
      let logs: readonly ProtocolDiscoveryLog[];
      try {
        const topics = adapter.discovery!.eventTopics;
        logs = await input.context.backend.getLogs({
          topics: [
            topics.length === 1 ? topics[0] : [...topics],
          ],
          fromBlock,
          toBlock,
        }, input.control);
      } catch (error) {
        errors.push({
          familyId: adapter.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      const txs = [...new Map(
        [...logs]
          .filter((log) =>
            log.transactionHash !== undefined &&
            log.blockNumber !== undefined
          )
          .sort((a, b) =>
            (b.blockNumber ?? -1) - (a.blockNumber ?? -1)
          )
          .map((log) => [
            log.transactionHash!.toLowerCase(),
            log.blockNumber!,
          ]),
      )];
      for (const [txHash, txBlock] of txs) {
        if (inspectedForFamily >= maxTransactionsPerFamily) break;
        inspectedForFamily++;
        inspectedTransactions++;
        try {
          const evidence = txMemo.get(txHash) ?? (async () => {
            const receipt = await input.context.backend
              .getTransactionReceipt(txHash, input.control);
            if (!receipt) {
              throw new Error("receipt unavailable");
            }
            const trace = input.traceMemo
              ? await input.traceMemo.trace(
                  txHash,
                  txBlock,
                  () => input.context.backend.traceTransaction(
                    txHash,
                    input.control,
                  ),
                )
              : await input.context.backend.traceTransaction(
                  txHash,
                  input.control,
                );
            return { receipt, trace };
          })();
          txMemo.set(txHash, evidence);
          const { receipt, trace } = await evidence;
          const observed = await scanObservedProtocolTrace({
            adapters: [adapter],
            context: input.context,
            txHash,
            receipt,
            trace,
            ...(input.control === undefined
              ? {}
              : { control: input.control }),
          });
          const candidates = observed.candidatesByAdapter.get(adapter.id) ??
            [];
          if (candidates.length === 0) continue;
          candidatesByAdapter.set(adapter.id, [...candidates]);
          recoveredFamilyIds.push(adapter.id);
          recovered = true;
          break;
        } catch (error) {
          errors.push({
            familyId: adapter.id,
            reason:
              `${txHash}: ` +
              (error instanceof Error ? error.message : String(error)),
          });
        }
      }
      toBlock = fromBlock - 1;
    }
  }
  return Object.freeze({
    candidatesByAdapter,
    searchedFamilyIds: Object.freeze(missing.map((adapter) => adapter.id)),
    recoveredFamilyIds: Object.freeze(recoveredFamilyIds.sort()),
    inspectedTransactions,
    errors: Object.freeze(errors),
  });
}

function emptyStartupFallbackResult(): ProtocolDiscoveryStartupFallbackResult {
  return Object.freeze({
    candidatesByAdapter: new Map(),
    searchedFamilyIds: Object.freeze([]),
    recoveredFamilyIds: Object.freeze([]),
    inspectedTransactions: 0,
    errors: Object.freeze([]),
  });
}

export async function prepareObservedProtocolDiscoveryPass(
  input: ProtocolDiscoveryRuntimeInput & {
    readonly blockNumber: number;
    readonly txHash: string;
    readonly receipt: ProtocolDiscoveryReceipt;
    readonly trace: unknown;
    readonly graphTokens: readonly string[];
  },
): Promise<{
  result: ProtocolDiscoveryResult;
  projection: ProtocolDiscoveryProjection;
  unknownSelectors: Awaited<ReturnType<typeof scanObservedProtocolTrace>>["unknownSelectors"];
}> {
  const scanContext = createPinnedProtocolDiscoveryContext({
    provider: input.provider,
    ...(input.observedHistoryProvider === undefined
      ? {}
      : { observedHistoryProvider: input.observedHistoryProvider }),
    blockNumber: input.blockNumber,
    fromBlock: input.blockNumber,
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
    ...(input.probeExecutor === undefined ? {} : { probeExecutor: input.probeExecutor }),
    graphTokens: input.graphTokens,
    retainedInstances: [],
    ...(input.control === undefined ? {} : { control: input.control }),
  });
  const enabledAdapters = enabledDiscoveryAdapters(
    input.adapters,
    input.protocolEdgesEnabled,
  );
  const observed = enabledAdapters.length > 0
    ? await scanObservedProtocolTrace({
      adapters: enabledAdapters,
      context: scanContext,
      txHash: input.txHash,
      receipt: input.receipt,
      trace: input.trace,
      ...(input.control === undefined ? {} : { control: input.control }),
    })
    : { candidatesByAdapter: new Map(), unknownSelectors: [], sourceErrors: [] };
  // Cross-pass ownership: prior claims for the SAME targets re-enter this
  // pass as retained candidates, so an earlier family's admission and a new
  // observed claim are adjudicated together instead of being invisible to
  // each other. Unrelated retained instances are not re-probed per tx.
  const observedTargets = new Set(
    [...observed.candidatesByAdapter.values()]
      .flat()
      .map((candidate) => candidate.pool.address.toLowerCase()),
  );
  const retainedForTargets = [...input.currentOwnership.admissions.values()]
    .filter((item) => observedTargets.has(item.instance.pool.address.toLowerCase()))
    .map((item) => ({ ...item.instance, ownerAdapterId: item.adapterId }));
  const context: typeof scanContext = {
    ...scanContext,
    retainedInstances: retainedForTargets,
  };
  const result = await runProtocolDiscovery({
    adapters: input.adapters,
    context,
    protocolEdgesEnabled: input.protocolEdgesEnabled,
    attestIdentity: createCanonicalProtocolIdentityAttester(
      input.identityRuntime === undefined
        ? undefined
        : { identityRuntime: input.identityRuntime },
    ),
    candidatesByAdapter: observed.candidatesByAdapter,
    sourceComplete: observed.sourceErrors.length === 0,
    sourceErrors: observed.sourceErrors,
    ...(input.control === undefined ? {} : { control: input.control }),
  });
  const projection = prepareProtocolDiscoveryProjection({
    currentOwnership: input.currentOwnership,
    result,
    currentBackrunPools: input.currentBackrunPools,
    currentBackrunGraph: input.currentBackrunGraph,
    currentBlockscanGraph: input.currentBlockscanGraph,
    currentKnownPoolKeys: input.currentKnownPoolKeys,
    buildStrategyViews: input.buildStrategyViews,
  });
  return { result, projection, unknownSelectors: observed.unknownSelectors };
}

export function enabledDiscoveryAdapters(
  adapters: readonly RouteLegAdapter[],
  protocolEdgesEnabled: boolean,
): RouteLegAdapter[] {
  return adapters.filter((adapter) =>
    adapter.discovery !== undefined &&
    (!adapter.requiresProtocolEdgesFlag || protocolEdgesEnabled)
  );
}

function mergeCandidateMaps(
  first: ReadonlyMap<string, readonly ProtocolCandidate[]>,
  second?: ReadonlyMap<string, readonly ProtocolCandidate[]>,
): ReadonlyMap<string, readonly ProtocolCandidate[]> {
  const merged = new Map<string, ProtocolCandidate[]>();
  for (const source of [first, second ?? new Map()]) {
    for (const [adapterId, candidates] of source) {
      const current = merged.get(adapterId) ?? [];
      current.push(...candidates);
      merged.set(adapterId, current);
    }
  }
  return merged;
}
