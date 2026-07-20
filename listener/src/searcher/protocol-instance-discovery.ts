import { ethers, type JsonRpcError, type JsonRpcPayload } from "ethers";
import { mergePoolRegistries } from "./active-pool-discovery.js";
import {
  buildTokenIndex,
  type PoolEntry,
  type TokenEdge,
} from "./planner/token-graph.js";
import { poolRegistryKey } from "./pool-universe.js";
import { hashTokenGraph, type StrategyViews } from "./strategy-views.js";
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
  rpcTimeoutMs?: number;
  graphTokens: readonly string[];
  retainedInstances?: readonly AttestedProtocolInstance[];
}): ProtocolDiscoveryContext {
  const toBlock = input.toBlock ?? input.blockNumber;
  const rpcTimeoutMs = input.rpcTimeoutMs ?? Math.max(
    1_000,
    Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_RPC_TIMEOUT_MS ?? "15000"),
  );
  if (
    !Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0 ||
    !Number.isSafeInteger(input.fromBlock) || input.fromBlock < 0 ||
    !Number.isSafeInteger(toBlock) || toBlock < input.fromBlock || toBlock > input.blockNumber ||
    !Number.isFinite(rpcTimeoutMs) || rpcTimeoutMs < 1
  ) {
    throw new Error("invalid protocol discovery block range or RPC timeout");
  }
  const blockTag = ethers.toQuantity(input.blockNumber);
  return {
    blockNumber: input.blockNumber,
    fromBlock: input.fromBlock,
    toBlock,
    graphTokens: unique(input.graphTokens.map((token) => token.toLowerCase())),
    retainedInstances: input.retainedInstances ?? [],
    backend: {
      call: (req) => sendProtocolDiscoveryRpc<string>(
        input.provider,
        "eth_call",
        [input.provider.getRpcTransaction(req), blockTag],
        rpcTimeoutMs,
        "eth_call",
      ),
      getCode: (address) => sendProtocolDiscoveryRpc<string>(
        input.provider,
        "eth_getCode",
        [address, blockTag],
        rpcTimeoutMs,
        "eth_getCode",
      ),
      getStorageAt: (address, position) => sendProtocolDiscoveryRpc<string>(
        input.provider,
        "eth_getStorageAt",
        [address, ethers.toQuantity(position), blockTag],
        rpcTimeoutMs,
        "eth_getStorageAt",
      ),
      getLogs: async (req) => {
        const logs = await sendProtocolDiscoveryRpc<RawProtocolDiscoveryLog[]>(
          input.provider,
          "eth_getLogs",
          [{
            ...(req.address === undefined ? {} : { address: req.address }),
            topics: req.topics.map((topic) =>
              typeof topic === "string" || topic === null ? topic : [...topic]
            ),
            fromBlock: ethers.toQuantity(req.fromBlock),
            toBlock: ethers.toQuantity(req.toBlock),
          }],
          rpcTimeoutMs,
          "eth_getLogs",
        );
        return logs.map(normalizeProtocolDiscoveryLog);
      },
      getTransactionReceipt: async (txHash) => {
        const receipt = await sendProtocolDiscoveryRpc<RawProtocolDiscoveryReceipt | null>(
          input.provider,
          "eth_getTransactionReceipt",
          [txHash],
          rpcTimeoutMs,
          "eth_getTransactionReceipt",
        );
        if (!receipt) return null;
        return {
          status: receipt.status === null ? null : Number(BigInt(receipt.status)),
          logs: receipt.logs.map(normalizeProtocolDiscoveryLog),
        };
      },
      traceTransaction: (txHash) => sendProtocolDiscoveryRpc<unknown>(
        input.provider,
        "debug_traceTransaction",
        [txHash, { tracer: "callTracer" }],
        rpcTimeoutMs,
        "debug_traceTransaction",
      ),
    },
  };
}

interface RawProtocolDiscoveryLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash: string;
  readonly blockNumber: string;
}

interface RawProtocolDiscoveryReceipt {
  readonly status: string | null;
  readonly logs: readonly RawProtocolDiscoveryLog[];
}

function normalizeProtocolDiscoveryLog(log: RawProtocolDiscoveryLog) {
  return {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    transactionHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber)),
  };
}

let protocolDiscoveryRpcId = 0;

async function sendProtocolDiscoveryRpc<T>(
  provider: ethers.JsonRpcProvider,
  method: string,
  params: unknown[],
  timeoutMs: number,
  label: string,
): Promise<T> {
  const payload: JsonRpcPayload = {
    id: ++protocolDiscoveryRpcId,
    jsonrpc: "2.0",
    method,
    params,
  };
  // Ethers does not expose an AbortSignal per provider.send call. Reuse its
  // connection URL and resolved auth headers, but issue this deadline-bound
  // request through fetch so AbortController closes the actual transport.
  const connection = provider._getConnection();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(connection.url, {
      method: "POST",
      headers: { ...connection.headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `protocol discovery ${label} HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body = await response.json() as Partial<JsonRpcError> & { result?: unknown };
    if (body.error) throw provider.getRpcError(payload, body as JsonRpcError);
    if (!("result" in body)) {
      throw new Error(`protocol discovery ${label} returned no result`);
    }
    return body.result as T;
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `protocol discovery ${label} timed out after ${timeoutMs}ms`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
  /** False means identity/probe hit a retryable read failure. */
  readonly evaluationComplete: boolean;
  /** False means a candidate source or identity/probe read failed. */
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
    const accepted = result.accepted[0];
    if (accepted) return accepted;
    const rejected = result.rejected[0];
    if (rejected?.reason === "identity_call_failed") {
      throw new RetryableProtocolDiscoveryError(
        `identity_call_failed for ${rejected.address}`,
      );
    }
    return null;
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
  candidatesByAdapter?: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  sourceComplete?: boolean;
  sourceErrors?: readonly {
    readonly adapterId: string | null;
    readonly target: string | null;
    readonly reason: string;
    readonly retryable?: boolean;
  }[];
  includeRetained?: boolean;
}): Promise<ProtocolDiscoveryResult> {
  const events: ProtocolDiscoveryEvent[] = [];
  const wouldAdmit: VerifiedProtocolAdmission[] = [];
  const evaluatedInstanceKeys = new Set<string>();
  const candidateSourceComplete = input.sourceComplete ?? true;
  let evaluationComplete = true;
  const ambiguousTargets = crossAdapterAmbiguousTargets(input);
  const reportedAmbiguities = new Set<string>();

  for (const error of input.sourceErrors ?? []) {
    events.push({
      event: "protocol_discovery",
      adapterId: error.adapterId ?? "protocol-scanner",
      target: error.target,
      selectors: [],
      sources: ["shared-scanner"],
      verdict: "rejected",
      stage: "candidate",
      reason: error.reason,
      wouldAdmitEdges: 0,
    });
  }

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
    rawCandidates.push(...(input.candidatesByAdapter?.get(adapter.id) ?? []));

    const grouped = new Map<string, CandidateAggregate>();
    const quarantinedKeys = new Set<string>();
    for (const rawCandidate of rawCandidates) {
      let candidate: ProtocolCandidate;
      try {
        candidate = normalizeCandidate(adapter, rawCandidate);
      } catch (error) {
        events.push(eventFor(adapter.id, rawCandidate, "rejected", "candidate", safeError(error), 0));
        continue;
      }
      const key = protocolInstanceKey(adapter.id, candidate.pool.address);
      const target = candidate.pool.address.toLowerCase();
      const ambiguousAdapterIds = ambiguousTargets.get(target);
      if (ambiguousAdapterIds) {
        grouped.delete(key);
        quarantinedKeys.add(key);
        evaluatedInstanceKeys.add(key);
        const reportKey = `${adapter.id}|${target}`;
        if (!reportedAmbiguities.has(reportKey)) {
          reportedAmbiguities.add(reportKey);
          events.push(eventFor(
            adapter.id,
            candidate,
            "rejected",
            "candidate",
            `ambiguous target adapters: ${ambiguousAdapterIds.join(",")}`,
            0,
          ));
        }
        continue;
      }
      if (quarantinedKeys.has(key)) continue;
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
        quarantinedKeys.add(key);
        evaluatedInstanceKeys.add(key);
        events.push(eventFor(adapter.id, candidate, "rejected", "candidate", safeError(error), 0));
      }
    }

    for (const [key, aggregate] of grouped) {
      const candidate = aggregate.candidate;
      let attestedPool: AttestedPoolEntry<PoolEntry> | null;
      try {
        attestedPool = await input.attestIdentity(adapter, candidate, input.context);
      } catch (error) {
        if (isRetryableProtocolDiscoveryFailure(error)) {
          evaluationComplete = false;
        } else {
          evaluatedInstanceKeys.add(key);
        }
        events.push(eventFor(adapter.id, aggregate, "rejected", "identity", safeError(error), 0));
        continue;
      }
      if (!attestedPool) {
        evaluatedInstanceKeys.add(key);
        events.push(eventFor(adapter.id, aggregate, "rejected", "identity", "identity_not_attested", 0));
        continue;
      }

      let instance: AttestedProtocolInstance;
      try {
        instance = normalizeAttestedInstance(adapter, aggregate, attestedPool);
      } catch (error) {
        evaluatedInstanceKeys.add(key);
        events.push(eventFor(adapter.id, aggregate, "rejected", "identity", safeError(error), 0));
        continue;
      }

      let edges: readonly TokenEdge[];
      try {
        edges = await discovery.probeCandidate(instance, input.context);
        assertVerifiedEdges(adapter, instance, edges);
      } catch (error) {
        if (isRetryableProtocolDiscoveryFailure(error)) {
          evaluationComplete = false;
        } else {
          evaluatedInstanceKeys.add(key);
        }
        events.push(eventFor(adapter.id, aggregate, "rejected", "probe", safeError(error), 0));
        continue;
      }

      evaluatedInstanceKeys.add(key);
      wouldAdmit.push({ adapterId: adapter.id, instance, edges: [...edges] });
      events.push(eventFor(adapter.id, aggregate, "would_admit", "probe", null, edges.length));
    }
  }

  return {
    events,
    wouldAdmit,
    evaluatedInstanceKeys,
    evaluationComplete,
    sourceComplete: candidateSourceComplete && evaluationComplete,
  };
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
 * Re-attestation can refresh ownership evidence without changing any routing
 * consumer. Keep that evidence update, but do not rebuild graphs or reconnect
 * the public-mempool subscription for a routing no-op.
 */
export function protocolDiscoveryProjectionChangesRouting(
  current: {
    readonly strategyViews: StrategyViews;
    readonly backrunGraph: TokenEdge[];
    readonly blockscanGraph?: TokenEdge[];
  },
  projection: ProtocolDiscoveryProjection,
): boolean {
  if (
    current.strategyViews.versions.strategy_view_version !==
      projection.strategyViews.versions.strategy_view_version
  ) return true;
  if (hashTokenGraph(current.backrunGraph) !== hashTokenGraph(projection.backrunGraph)) return true;
  if (current.blockscanGraph === undefined || projection.blockscanGraph === undefined) {
    return current.blockscanGraph !== projection.blockscanGraph;
  }
  return hashTokenGraph(current.blockscanGraph) !== hashTokenGraph(projection.blockscanGraph);
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

class RetryableProtocolDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableProtocolDiscoveryError";
  }
}

function isRetryableProtocolDiscoveryFailure(value: unknown): boolean {
  if (value instanceof RetryableProtocolDiscoveryError) return true;
  const code = value && typeof value === "object" && "code" in value
    ? String((value as { code?: unknown }).code).toUpperCase()
    : "";
  if (new Set([
    "NETWORK_ERROR",
    "SERVER_ERROR",
    "TIMEOUT",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
  ]).has(code)) return true;
  const message = value instanceof Error ? value.message : String(value);
  return /timed?\s*out|network|socket|connection (?:closed|reset|refused)|temporarily unavailable|\b(?:429|502|503|504)\b/i
    .test(message);
}

function crossAdapterAmbiguousTargets(input: {
  adapters: readonly ProtocolConversionAdapter[];
  context: ProtocolDiscoveryContext;
  candidatesByAdapter?: ReadonlyMap<string, readonly ProtocolCandidate[]>;
  includeRetained?: boolean;
}): ReadonlyMap<string, readonly string[]> {
  const byTarget = new Map<string, Set<string>>();
  for (const adapter of input.adapters) {
    if (!adapter.discovery) continue;
    const candidates: ProtocolCandidate[] = [
      ...(input.candidatesByAdapter?.get(adapter.id) ?? []),
    ];
    if (input.includeRetained ?? true) {
      candidates.push(...input.context.retainedInstances
        .filter((instance) => adapter.poolAdapters.includes(instance.pool.adapter))
        .map(candidateFromRetained));
    }
    for (const candidate of candidates) {
      if (!adapter.poolAdapters.includes(candidate.pool.adapter)) continue;
      try {
        const target = ethers.getAddress(candidate.pool.address).toLowerCase();
        const ids = byTarget.get(target) ?? new Set<string>();
        ids.add(adapter.id);
        byTarget.set(target, ids);
      } catch {
        // Malformed addresses are rejected by normalizeCandidate, not arbitration.
      }
    }
  }
  return new Map(
    [...byTarget.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([target, ids]) => [target, [...ids].sort()] as const),
  );
}
