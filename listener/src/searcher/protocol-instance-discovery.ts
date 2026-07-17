import { ethers } from "ethers";
import { mergePoolRegistries } from "./active-pool-discovery.js";
import {
  buildTokenIndex,
  type PoolEntry,
  type TokenEdge,
} from "./planner/token-graph.js";
import { poolRegistryKey } from "./pool-universe.js";
import type { StrategyViews } from "./strategy-views.js";
import { deriveEdgeTaxonomy } from "./strategy-taxonomy.js";
import { STRICT_IDENTITY_ADMISSION } from "./venues/admission.js";
import {
  attestPoolIdentities,
  createPoolIdentityCache,
  type AttestedPoolEntry,
  type IdentityResolverRegistry,
  type PoolIdentityCache,
} from "./venues/identity.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
  ProtocolConversionAdapter,
  ProtocolDiscoveryContext,
} from "./venues/route-leg-adapter.js";

export function createPinnedProtocolDiscoveryContext(input: {
  provider: ethers.JsonRpcProvider;
  blockNumber: number;
  fromBlock: number;
  toBlock?: number;
  candidateTokens: readonly string[];
  graphTokens?: readonly string[];
  retainedInstances?: readonly AttestedProtocolInstance[];
}): ProtocolDiscoveryContext {
  const toBlock = input.toBlock ?? input.blockNumber;
  if (
    !Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 ||
    !Number.isSafeInteger(input.fromBlock) || input.fromBlock < 0 ||
    !Number.isSafeInteger(toBlock) || toBlock < input.fromBlock || toBlock > input.blockNumber
  ) {
    throw new Error("invalid protocol discovery block range");
  }
  return {
    blockNumber: input.blockNumber,
    fromBlock: input.fromBlock,
    toBlock,
    candidateTokens: unique(input.candidateTokens.map((token) => token.toLowerCase())),
    graphTokens: unique((input.graphTokens ?? input.candidateTokens).map((token) => token.toLowerCase())),
    retainedInstances: input.retainedInstances ?? [],
    backend: {
      call: (req) => input.provider.send("eth_call", [
        req,
        `0x${input.blockNumber.toString(16)}`,
      ]),
      getCode: (address) => input.provider.getCode(address, input.blockNumber),
      getStorageAt: (address, position) =>
        input.provider.getStorage(address, position, input.blockNumber),
      getCodeAt: (address, blockNumber) => input.provider.getCode(address, blockNumber),
      getStorageAtBlock: (address, position, blockNumber) =>
        input.provider.getStorage(address, position, blockNumber),
      getLogs: async (req) => {
        const logs = await input.provider.getLogs({
          ...(req.address === undefined ? {} : { address: req.address }),
          topics: [...req.topics],
          fromBlock: req.fromBlock,
          toBlock: req.toBlock,
        });
        return logs.map((log) => ({
          address: log.address,
          topics: [...log.topics],
          data: log.data,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
        }));
      },
      getTransactionReceipt: async (txHash) => {
        const receipt = await input.provider.getTransactionReceipt(txHash);
        if (!receipt) return null;
        return {
          status: receipt.status,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: [...log.topics],
            data: log.data,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
          })),
        };
      },
      traceTransaction: (txHash) => input.provider.send("debug_traceTransaction", [
        txHash,
        { tracer: "callTracer" },
      ]),
    },
  };
}

export type ProtocolDiscoveryStage = "feature_flag" | "candidate" | "identity" | "probe";

export interface ProtocolDiscoveryEvent {
  readonly event: "protocol_discovery";
  readonly adapterId: string;
  readonly target: string | null;
  readonly selectors: readonly string[];
  readonly sources: readonly string[];
  readonly verdict: "rejected" | "would_admit";
  readonly stage: ProtocolDiscoveryStage;
  readonly reason: string | null;
  readonly wouldAdmitEdges: number;
}

export interface VerifiedProtocolAdmission {
  readonly adapterId: string;
  readonly instance: AttestedProtocolInstance;
  readonly edges: readonly TokenEdge[];
}

export interface ProtocolDiscoveryResult {
  readonly events: readonly ProtocolDiscoveryEvent[];
  readonly wouldAdmit: readonly VerifiedProtocolAdmission[];
  /** Instance keys evaluated this pass. Lifecycle replacement may only touch these keys. */
  readonly evaluatedInstanceKeys: ReadonlySet<string>;
  /** False means at least one adapter source failed; scan cursors must not advance. */
  readonly sourceComplete: boolean;
}

export type ProtocolIdentityAttester = (
  adapter: ProtocolConversionAdapter,
  candidate: ProtocolCandidate,
  context: ProtocolDiscoveryContext,
) => Promise<AttestedPoolEntry<PoolEntry> | null>;

export function createCanonicalProtocolIdentityAttester(input: {
  identityRegistry: IdentityResolverRegistry;
  cache?: PoolIdentityCache;
}): ProtocolIdentityAttester {
  const cache = input.cache ?? createPoolIdentityCache();
  return async (_adapter, candidate, context) => {
    const result = await attestPoolIdentities(context.backend, [candidate.pool], {
      identityRegistry: input.identityRegistry,
      cache,
      admissionPolicy: STRICT_IDENTITY_ADMISSION,
      // Discovery candidates never receive legacy seed credentials.
      seedEntries: [],
    });
    return result.accepted[0] ?? null;
  };
}

/**
 * Evaluate active, retained, and observed candidates through one fail-closed
 * identity/probe outlet. The function itself never mutates a graph; callers
 * atomically project the verified result with prepareProtocolDiscoveryProjection.
 */
export async function runProtocolDiscovery(input: {
  adapters: readonly ProtocolConversionAdapter[];
  context: ProtocolDiscoveryContext;
  protocolEdgesEnabled: boolean;
  attestIdentity: ProtocolIdentityAttester;
  observedCandidates?: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  runActiveDiscovery?: boolean;
  includeRetained?: boolean;
}): Promise<ProtocolDiscoveryResult> {
  const events: ProtocolDiscoveryEvent[] = [];
  const wouldAdmit: VerifiedProtocolAdmission[] = [];
  const evaluatedInstanceKeys = new Set<string>();
  let sourceComplete = true;

  for (const adapter of input.adapters) {
    const discovery = adapter.discovery;
    if (!discovery) continue;

    if (!input.protocolEdgesEnabled) {
      events.push(eventFor(adapter.id, null, "rejected", "feature_flag", "protocol_edges_disabled", 0));
      continue;
    }

    const rawCandidates: ProtocolCandidate[] = (input.includeRetained ?? true)
      ? input.context.retainedInstances
        .filter((instance) => adapter.poolAdapters.includes(instance.pool.adapter))
        .map(candidateFromRetained)
      : [];
    if (input.runActiveDiscovery ?? true) {
      try {
        rawCandidates.push(...await discovery.discoverCandidates(input.context));
      } catch (error) {
        sourceComplete = false;
        events.push(eventFor(adapter.id, null, "rejected", "candidate", safeError(error), 0));
      }
    }
    rawCandidates.push(...(input.observedCandidates?.get(adapter.id) ?? []));

    const grouped = new Map<string, CandidateAggregate>();
    for (const rawCandidate of rawCandidates) {
      let candidate: ProtocolCandidate;
      try {
        candidate = normalizeCandidate(adapter, rawCandidate);
      } catch (error) {
        events.push(eventFor(adapter.id, rawCandidate, "rejected", "candidate", safeError(error), 0));
        continue;
      }
      const key = protocolInstanceKey(adapter.id, candidate.pool.address);
      const current = grouped.get(key);
      try {
        if (
          current &&
          poolShapeKey(current.candidate.pool) !== poolShapeKey(candidate.pool) &&
          current.sources.every((source) => source === "retained-instance") &&
          candidate.source !== "retained-instance"
        ) {
          // Current chain-derived metadata supersedes the prior snapshot. This
          // is the route-replace path for asset()/configuration changes.
          grouped.set(key, aggregateCandidate(candidate));
        } else {
          grouped.set(key, current ? mergeCandidate(current, candidate) : aggregateCandidate(candidate));
        }
      } catch (error) {
        grouped.delete(key);
        evaluatedInstanceKeys.add(key);
        events.push(eventFor(adapter.id, candidate, "rejected", "candidate", safeError(error), 0));
      }
    }

    for (const [key, aggregate] of grouped) {
      evaluatedInstanceKeys.add(key);
      const candidate = aggregate.candidate;
      let attestedPool: AttestedPoolEntry<PoolEntry> | null;
      try {
        attestedPool = await input.attestIdentity(adapter, candidate, input.context);
      } catch (error) {
        events.push(eventFor(adapter.id, aggregate, "rejected", "identity", safeError(error), 0));
        continue;
      }
      if (!attestedPool) {
        events.push(eventFor(adapter.id, aggregate, "rejected", "identity", "identity_not_attested", 0));
        continue;
      }

      let instance: AttestedProtocolInstance;
      try {
        instance = normalizeAttestedInstance(adapter, aggregate, attestedPool);
      } catch (error) {
        events.push(eventFor(adapter.id, aggregate, "rejected", "identity", safeError(error), 0));
        continue;
      }

      let edges: readonly TokenEdge[];
      try {
        edges = await discovery.probeCandidate(instance, input.context);
        assertVerifiedEdges(adapter, instance, edges);
      } catch (error) {
        events.push(eventFor(adapter.id, aggregate, "rejected", "probe", safeError(error), 0));
        continue;
      }

      wouldAdmit.push({ adapterId: adapter.id, instance, edges: [...edges] });
      events.push(eventFor(adapter.id, aggregate, "would_admit", "probe", null, edges.length));
    }
  }

  return { events, wouldAdmit, evaluatedInstanceKeys, sourceComplete };
}

/** Compatibility name retained for the explicit Slice-B shadow gate. */
export const runProtocolDiscoveryShadow = runProtocolDiscovery;

export interface ProtocolDiscoveryOwnership {
  readonly version: number;
  readonly admissions: ReadonlyMap<string, VerifiedProtocolAdmission>;
}

export const EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP: ProtocolDiscoveryOwnership = Object.freeze({
  version: 0,
  admissions: new Map(),
});

export function replaceProtocolDiscoveryOwnership(
  current: ProtocolDiscoveryOwnership,
  result: ProtocolDiscoveryResult,
): ProtocolDiscoveryOwnership {
  const admissions = new Map(current.admissions);
  for (const key of result.evaluatedInstanceKeys) admissions.delete(key);
  for (const admission of result.wouldAdmit) {
    admissions.set(protocolInstanceKey(admission.adapterId, admission.instance.pool.address), admission);
  }
  return {
    version: result.evaluatedInstanceKeys.size > 0 ? current.version + 1 : current.version,
    admissions,
  };
}

export interface ProtocolDiscoveryProjection {
  readonly baseOwnershipVersion: number;
  readonly ownership: ProtocolDiscoveryOwnership;
  readonly strategyViews: StrategyViews;
  readonly backrunGraph: TokenEdge[];
  readonly blockscanGraph?: TokenEdge[];
  readonly tokenIndex: Map<string, Set<string>>;
  readonly poolAddressMap: Map<string, string>;
  readonly flashTokens: string[];
  readonly knownPoolKeys: Set<string>;
  readonly knownPoolAddresses: Set<string>;
}

/**
 * Remove only previously discovery-owned pools/edges, add the new verified
 * snapshot, and rebuild every derived projection off to the side. The caller
 * commits the returned objects without an await between mutations.
 */
export function prepareProtocolDiscoveryProjection(input: {
  currentOwnership: ProtocolDiscoveryOwnership;
  result: ProtocolDiscoveryResult;
  currentBackrunPools: readonly PoolEntry[];
  currentBackrunGraph: readonly TokenEdge[];
  currentBlockscanGraph?: readonly TokenEdge[];
  currentKnownPoolKeys?: ReadonlySet<string>;
  buildStrategyViews: (pools: PoolEntry[]) => StrategyViews;
}): ProtocolDiscoveryProjection {
  const previousPoolKeys = new Set(
    [...input.currentOwnership.admissions.values()].map((item) => poolRegistryKey(item.instance.pool)),
  );
  // A compatibility/declared pool with the same address predates discovery and
  // must never become discovery-owned merely because the scanner independently
  // attested it. Such entries keep their existing graph edges until a separate
  // no-seed migration removes the fallback explicitly.
  const staticPoolKeys = new Set(
    input.currentBackrunPools
      .map(poolRegistryKey)
      .filter((key) => !previousPoolKeys.has(key)),
  );
  const effectiveResult: ProtocolDiscoveryResult = {
    ...input.result,
    wouldAdmit: input.result.wouldAdmit.filter(
      (item) => !staticPoolKeys.has(poolRegistryKey(item.instance.pool)),
    ),
  };
  const ownership = replaceProtocolDiscoveryOwnership(input.currentOwnership, effectiveResult);
  const previousEdgeKeys = new Set(
    [...input.currentOwnership.admissions.values()].flatMap((item) => item.edges.map(protocolEdgeKey)),
  );
  const basePools = input.currentBackrunPools.filter((pool) => !previousPoolKeys.has(poolRegistryKey(pool)));
  const baseGraph = input.currentBackrunGraph.filter((edge) => !previousEdgeKeys.has(protocolEdgeKey(edge)));
  const baseBlockscanGraph = input.currentBlockscanGraph?.filter(
    (edge) => !previousEdgeKeys.has(protocolEdgeKey(edge)),
  );
  const admissions = [...ownership.admissions.values()];
  const backrunPools = mergePoolRegistries(
    [...basePools],
    admissions.map((item) => ({ ...item.instance.pool })),
  );
  const strategyViews = input.buildStrategyViews(backrunPools);
  const backrunGraph = mergeEdges(baseGraph, admissions.flatMap((item) => [...item.edges]));
  const blockscanKeys = new Set(strategyViews.blockscan.map(poolRegistryKey));
  const blockscanAdditions = admissions.flatMap((item) =>
    blockscanKeys.has(poolRegistryKey(item.instance.pool)) ? [...item.edges] : []
  );
  const blockscanGraph = baseBlockscanGraph === undefined
    ? undefined
    : mergeEdges(baseBlockscanGraph, blockscanAdditions);
  const tokenIndex = buildTokenIndex(backrunGraph);
  const poolAddressMap = new Map<string, string>();
  for (const pool of strategyViews.backrun) {
    poolAddressMap.set(pool.address.toLowerCase(), pool.adapter);
  }
  const knownPoolKeys = new Set(
    input.currentKnownPoolKeys ?? basePools.map(poolRegistryKey),
  );
  for (const key of previousPoolKeys) knownPoolKeys.delete(key);
  for (const admission of admissions) knownPoolKeys.add(poolRegistryKey(admission.instance.pool));
  return {
    baseOwnershipVersion: input.currentOwnership.version,
    ownership,
    strategyViews,
    backrunGraph,
    blockscanGraph,
    tokenIndex,
    poolAddressMap,
    flashTokens: [...tokenIndex.keys()],
    knownPoolKeys,
    knownPoolAddresses: new Set(strategyViews.backrun.map((pool) => pool.address.toLowerCase())),
  };
}

export function protocolInstanceKey(adapterId: string, target: string): string {
  return `${adapterId}|${ethers.getAddress(target).toLowerCase()}`;
}

export function protocolEdgeKey(edge: TokenEdge): string {
  return [
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.protocolAction ?? "",
    edge.poolId?.toLowerCase() ?? "",
  ].join("|");
}

interface CandidateAggregate {
  readonly candidate: ProtocolCandidate;
  readonly sources: readonly string[];
  readonly selectors: readonly string[];
  readonly evidence: readonly unknown[];
}

function candidateFromRetained(instance: AttestedProtocolInstance): ProtocolCandidate {
  return {
    pool: { ...instance.pool },
    source: "retained-instance",
    ...(instance.selectors[0] === undefined ? {} : { selector: instance.selectors[0] }),
    evidence: instance.evidence,
  };
}

function aggregateCandidate(candidate: ProtocolCandidate): CandidateAggregate {
  return {
    candidate,
    sources: [candidate.source],
    selectors: candidate.selector === undefined ? [] : [candidate.selector],
    evidence: [...(candidate.evidence ?? [])],
  };
}

function mergeCandidate(current: CandidateAggregate, candidate: ProtocolCandidate): CandidateAggregate {
  if (poolShapeKey(current.candidate.pool) !== poolShapeKey(candidate.pool)) {
    throw new Error("candidate sources disagree on instance metadata");
  }
  return {
    candidate: current.candidate,
    sources: unique([...current.sources, candidate.source]),
    selectors: unique([
      ...current.selectors,
      ...(candidate.selector === undefined ? [] : [candidate.selector]),
    ]),
    evidence: [...current.evidence, ...(candidate.evidence ?? [])],
  };
}

function poolShapeKey(pool: PoolEntry): string {
  return JSON.stringify({
    address: pool.address.toLowerCase(),
    adapter: pool.adapter,
    fixedTokenIn: pool.fixedTokenIn?.toLowerCase(),
    fixedTokenOut: pool.fixedTokenOut?.toLowerCase(),
    fixedSlotKind: pool.fixedSlotKind,
    fixedProtocolAction: pool.fixedProtocolAction,
    nonStandardRedeem: pool.nonStandardRedeem,
    redeemTokenOut: pool.redeemTokenOut?.toLowerCase(),
  });
}

function normalizeCandidate(
  adapter: ProtocolConversionAdapter,
  candidate: ProtocolCandidate,
): ProtocolCandidate {
  const address = ethers.getAddress(candidate.pool.address);
  if (!adapter.poolAdapters.includes(candidate.pool.adapter)) {
    throw new Error(`foreign pool adapter ${candidate.pool.adapter}`);
  }
  const source = candidate.source.trim();
  if (!source) throw new Error("candidate source is required");
  const selector = candidate.selector?.toLowerCase();
  if (selector !== undefined && !/^0x[0-9a-f]{8}$/.test(selector)) {
    throw new Error("candidate selector must be four bytes");
  }
  return {
    pool: { ...candidate.pool, address },
    source,
    ...(selector === undefined ? {} : { selector }),
    evidence: [...(candidate.evidence ?? [])],
  };
}

function normalizeAttestedInstance(
  adapter: ProtocolConversionAdapter,
  aggregate: CandidateAggregate,
  pool: AttestedPoolEntry<PoolEntry>,
): AttestedProtocolInstance {
  const address = ethers.getAddress(pool.address);
  if (address.toLowerCase() !== aggregate.candidate.pool.address.toLowerCase()) {
    throw new Error("identity attester changed candidate target");
  }
  if (!pool.identitySource) throw new Error("identity attester omitted identity credential");
  if (!adapter.poolAdapters.includes(pool.adapter)) {
    throw new Error(`identity attester returned foreign pool adapter ${pool.adapter}`);
  }
  return {
    pool: { ...pool, address },
    sources: aggregate.sources,
    selectors: aggregate.selectors,
    evidence: aggregate.evidence,
  };
}

function assertVerifiedEdges(
  adapter: ProtocolConversionAdapter,
  instance: AttestedProtocolInstance,
  edges: readonly TokenEdge[],
): void {
  if (edges.length === 0) throw new Error("probe produced zero verified edges");
  const target = instance.pool.address.toLowerCase();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (ethers.getAddress(edge.target).toLowerCase() !== target) {
      throw new Error("probe edge target differs from attested instance");
    }
    ethers.getAddress(edge.tokenIn);
    ethers.getAddress(edge.tokenOut);
    if (!adapter.edgeAdapterIds.includes(edge.adapterId)) {
      throw new Error(`probe emitted undeclared edge adapter ${edge.adapterId}`);
    }
    const taxonomyAllowed = adapter.allowedTaxonomy.some((allowed) =>
      allowed.slotKind === edge.slotKind && allowed.protocolAction === edge.protocolAction
    );
    if (!taxonomyAllowed) throw new Error("probe emitted disallowed edge taxonomy");
    const taxonomy = deriveEdgeTaxonomy(edge.slotKind, edge.protocolAction);
    if (
      taxonomy.edgeKind !== edge.edgeKind ||
      taxonomy.leavesStandingPosition !== edge.leavesStandingPosition
    ) {
      throw new Error("probe emitted inconsistent edge taxonomy");
    }
    const key = protocolEdgeKey(edge);
    if (seen.has(key)) throw new Error("probe emitted duplicate verified edge");
    seen.add(key);
  }
}

function eventFor(
  adapterId: string,
  candidate: ProtocolCandidate | CandidateAggregate | null,
  verdict: ProtocolDiscoveryEvent["verdict"],
  stage: ProtocolDiscoveryStage,
  reason: string | null,
  wouldAdmitEdges: number,
): ProtocolDiscoveryEvent {
  const aggregate: CandidateAggregate | null = candidate && "candidate" in candidate
    ? candidate as CandidateAggregate
    : null;
  const raw: ProtocolCandidate | null = aggregate?.candidate ?? candidate as ProtocolCandidate | null;
  return {
    event: "protocol_discovery",
    adapterId,
    target: raw?.pool.address ?? null,
    selectors: aggregate?.selectors ?? (raw?.selector === undefined ? [] : [raw.selector]),
    sources: aggregate?.sources ?? (raw?.source === undefined ? [] : [raw.source]),
    verdict,
    stage,
    reason,
    wouldAdmitEdges,
  };
}

function mergeEdges(current: readonly TokenEdge[], additions: readonly TokenEdge[]): TokenEdge[] {
  const merged = [...current];
  const seen = new Set(current.map(protocolEdgeKey));
  for (const edge of additions) {
    const key = protocolEdgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(edge);
  }
  return merged;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function safeError(value: unknown): string {
  const message = (value instanceof Error ? value.message : String(value))
    .replace(/https?:\/\/\S+/g, "<redacted-url>");
  return message.slice(0, 240) || "unknown_error";
}
