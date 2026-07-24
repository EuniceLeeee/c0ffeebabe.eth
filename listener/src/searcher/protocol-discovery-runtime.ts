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
import type {
  ProtocolCandidate,
  ProtocolDiscoveryReadControl,
  ProtocolDiscoveryReceipt,
  RouteLegAdapter,
} from "./venues/route-leg-adapter.js";

export interface ProtocolDiscoveryRuntimeInput {
  readonly provider: ethers.JsonRpcProvider;
  readonly adapters: readonly RouteLegAdapter[];
  readonly identityRegistry: IdentityResolverRegistry;
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
    readonly traceMemo?: ProtocolTraceMemo;
    readonly shadow: boolean;
  },
): Promise<{
  result: ProtocolDiscoveryResult;
  projection: ProtocolDiscoveryProjection | null;
  scanner: ProtocolDiscoveryRangeResult;
}> {
  const retainedInstances = [...input.currentOwnership.admissions.values()]
    .map((item) => ({ ...item.instance, ownerAdapterId: item.adapterId }));
  const context = createPinnedProtocolDiscoveryContext({
    provider: input.provider,
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
        ambiguous: 0,
      },
    };
  const result = await runProtocolDiscovery({
    adapters: input.adapters,
    context,
    protocolEdgesEnabled: input.protocolEdgesEnabled,
    attestIdentity: createCanonicalProtocolIdentityAttester({
      identityRegistry: input.identityRegistry,
    }),
    candidatesByAdapter: mergeCandidateMaps(
      scanned.candidatesByAdapter,
      input.bootstrapCandidates,
    ),
    sourceComplete: scanned.sourceComplete,
    sourceErrors: scanned.sourceErrors,
    ...(input.control === undefined ? {} : { control: input.control }),
  });
  return {
    result,
    scanner: scanned,
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
    attestIdentity: createCanonicalProtocolIdentityAttester({
      identityRegistry: input.identityRegistry,
    }),
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

function enabledDiscoveryAdapters(
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
