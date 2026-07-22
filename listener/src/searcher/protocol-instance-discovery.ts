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
  chainId?: bigint | number | string;
  probeExecutor?: string;
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
    ...(input.chainId === undefined ? {} : { chainId: BigInt(input.chainId).toString() }),
    ...(input.probeExecutor === undefined
      ? {}
      : { probeExecutor: ethers.getAddress(input.probeExecutor) }),
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
      simulateCalls: async (req) => {
        const raw = await sendProtocolDiscoveryRpc<unknown>(
          input.provider,
          "eth_simulateV1",
          [{
            blockStateCalls: [{
              ...(req.stateOverrides === undefined ? {} : { stateOverrides: req.stateOverrides }),
              calls: req.calls.map((call) => ({
                from: call.from,
                to: call.to,
                data: call.data,
              })),
            }],
            validation: false,
            traceTransfers: false,
          }, blockTag],
          rpcTimeoutMs,
          "eth_simulateV1",
        );
        const firstBlock = Array.isArray(raw) ? raw[0] as { calls?: unknown } : null;
        const calls = firstBlock && Array.isArray(firstBlock.calls) ? firstBlock.calls : [];
        return calls.map((entry) => {
          const call = entry as {
            status?: unknown;
            returnData?: unknown;
            logs?: unknown;
          };
          let status = 0;
          try {
            status = Number(BigInt(String(call.status ?? "0x0")));
          } catch {
            status = 0;
          }
          const logs = Array.isArray(call.logs)
            ? call.logs.flatMap((log) => {
              const item = log as {
                address?: unknown;
                topics?: unknown;
                data?: unknown;
              };
              if (typeof item.address !== "string" || !Array.isArray(item.topics)) return [];
              return [{
                address: item.address,
                topics: item.topics.filter((topic): topic is string => typeof topic === "string"),
                data: typeof item.data === "string" ? item.data : "0x",
                blockNumber: input.blockNumber,
              }];
            })
            : [];
          return {
            status,
            returnData: typeof call.returnData === "string" ? call.returnData : "0x",
            logs,
          };
        });
      },
      createAccessList: async (req) => {
        const raw = await sendProtocolDiscoveryRpc<{ accessList?: unknown }>(
          input.provider,
          "eth_createAccessList",
          [{ from: req.from, to: req.to, data: req.data }, blockTag],
          rpcTimeoutMs,
          "eth_createAccessList",
        );
        const list = raw && Array.isArray(raw.accessList) ? raw.accessList : [];
        return list.flatMap((entry) => {
          const item = entry as { address?: unknown; storageKeys?: unknown };
          if (typeof item.address !== "string" || !Array.isArray(item.storageKeys)) return [];
          return [{
            address: item.address,
            storageKeys: item.storageKeys.filter((key): key is string => typeof key === "string"),
          }];
        });
      },
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
const PROTOCOL_DISCOVERY_RPC_MAX_ATTEMPTS = 3;
const PROTOCOL_DISCOVERY_RPC_RETRY_BASE_MS = 500;
const RETRYABLE_PROTOCOL_DISCOVERY_HTTP_STATUSES = new Set([429, 502, 503, 504]);

async function sendProtocolDiscoveryRpc<T>(
  provider: ethers.JsonRpcProvider,
  method: string,
  params: unknown[],
  timeoutMs: number,
  label: string,
): Promise<T> {
  // Ethers does not expose an AbortSignal per provider.send call. Reuse its
  // connection URL and resolved auth headers, but issue this deadline-bound
  // request through fetch so AbortController closes the actual transport.
  const connection = provider._getConnection();
  const deadlineAtMs = Date.now() + timeoutMs;
  for (let attempt = 1; attempt <= PROTOCOL_DISCOVERY_RPC_MAX_ATTEMPTS; attempt++) {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) throw protocolDiscoveryRpcTimeout(label, timeoutMs);
    const payload: JsonRpcPayload = {
      id: ++protocolDiscoveryRpcId,
      jsonrpc: "2.0",
      method,
      params,
    };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
    try {
      const response = await fetch(connection.url, {
        method: "POST",
        headers: { ...connection.headers, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = Object.assign(
          new Error(`protocol discovery ${label} HTTP ${response.status} ${response.statusText}`),
          {
            status: response.status,
            retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
          },
        );
        throw error;
      }
      const body = await response.json() as Partial<JsonRpcError> & { result?: unknown };
      if (body.error) throw provider.getRpcError(payload, body as JsonRpcError);
      if (!("result" in body)) {
        throw new Error(`protocol discovery ${label} returned no result`);
      }
      return body.result as T;
    } catch (error) {
      if (timedOut) {
        throw protocolDiscoveryRpcTimeout(label, timeoutMs, error);
      }
      if (
        attempt >= PROTOCOL_DISCOVERY_RPC_MAX_ATTEMPTS ||
        !isRetryableProtocolDiscoveryRpcTransportFailure(error)
      ) throw error;
      clearTimeout(timer);
      const retryDelayMs = protocolDiscoveryRetryDelayMs(error, attempt);
      if (retryDelayMs >= deadlineAtMs - Date.now()) {
        throw protocolDiscoveryRpcTimeout(label, timeoutMs, error);
      }
      await delay(retryDelayMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`protocol discovery ${label} exhausted RPC attempts`);
}

function isRetryableProtocolDiscoveryRpcTransportFailure(error: unknown): boolean {
  for (const item of protocolDiscoveryErrorChain(error)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const status = Number(record.status ?? record.statusCode);
    if (RETRYABLE_PROTOCOL_DISCOVERY_HTTP_STATUSES.has(status)) return true;
    const code = String(record.code ?? "").toUpperCase();
    if (
      code.startsWith("ECONN") ||
      code.startsWith("UND_ERR_") ||
      new Set([
        "ETIMEDOUT",
        "EAI_AGAIN",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "ENOTFOUND",
        "EPIPE",
      ]).has(code)
    ) return true;
    if (item instanceof TypeError && /fetch failed/i.test(item.message)) return true;
  }
  return false;
}

function protocolDiscoveryRetryDelayMs(error: unknown, attempt: number): number {
  const retryAfterMs = error && typeof error === "object" && "retryAfterMs" in error
    ? Number((error as { retryAfterMs?: unknown }).retryAfterMs)
    : NaN;
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(5_000, retryAfterMs);
  }
  return PROTOCOL_DISCOVERY_RPC_RETRY_BASE_MS * attempt;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function protocolDiscoveryRpcTimeout(
  label: string,
  timeoutMs: number,
  cause?: unknown,
): Error {
  return new Error(
    `protocol discovery ${label} timed out after ${timeoutMs}ms`,
    cause === undefined ? undefined : { cause },
  );
}

export type ProtocolDiscoveryStage =
  | "feature_flag"
  | "candidate"
  | "identity"
  | "probe"
  | "arbitration";

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

/**
 * One independently verified route. The semantic key names WHAT the route
 * converts; the execution fingerprint names HOW it executes. Observed/shortlist
 * selectors never enter either: they are candidate provenance, not identity.
 */
export interface VerifiedRouteClaim {
  readonly semanticRouteKey: string;
  readonly producerAdapterId: string;
  readonly edgeAdapterId: string;
  /** Identity root that admitted the instance (identitySource|venueId|factory). */
  readonly authorityFingerprint: string;
  /** Execution surface shape (edge adapter + execution-relevant edge fields). */
  readonly executionFingerprint: string;
  readonly edge: TokenEdge;
}

export interface VerifiedProtocolAdmission {
  readonly adapterId: string;
  readonly instance: AttestedProtocolInstance;
  readonly edges: readonly TokenEdge[];
  readonly claims: readonly VerifiedRouteClaim[];
}

export function semanticRouteKey(chainId: string | undefined, edge: TokenEdge): string {
  return [
    chainId ?? "0",
    edge.target.toLowerCase(),
    edge.poolId?.toLowerCase() ?? "",
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
    edge.protocolAction ?? "",
  ].join("|");
}

export function executionFingerprint(edge: TokenEdge): string {
  return [
    edge.adapterId,
    edge.curveI === undefined ? "" : String(edge.curveI),
    edge.curveJ === undefined ? "" : String(edge.curveJ),
    edge.poolId?.toLowerCase() ?? "",
    edge.v4PoolKey === undefined ? "" : [
      edge.v4PoolKey.currency0.toLowerCase(),
      edge.v4PoolKey.currency1.toLowerCase(),
      String(edge.v4PoolKey.fee),
      String(edge.v4PoolKey.tickSpacing),
      edge.v4PoolKey.hooks.toLowerCase(),
    ].join(":"),
  ].join("|");
}

export function authorityFingerprint(instance: AttestedProtocolInstance): string {
  return [
    instance.pool.identitySource ?? "",
    instance.pool.venueId ?? "",
    instance.pool.factory?.toLowerCase() ?? "",
  ].join("|");
}

export function deriveVerifiedRouteClaims(
  producerAdapterId: string,
  instance: AttestedProtocolInstance,
  edges: readonly TokenEdge[],
  chainId: string | undefined,
): VerifiedRouteClaim[] {
  const authority = authorityFingerprint(instance);
  return edges.map((edge) => ({
    semanticRouteKey: semanticRouteKey(chainId, edge),
    producerAdapterId,
    edgeAdapterId: edge.adapterId,
    authorityFingerprint: authority,
    executionFingerprint: executionFingerprint(edge),
    edge,
  }));
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
 * per-candidate outlet: normalize -> identity -> adapter evidence/probe ->
 * single-adapter edge assertion. No candidate is discarded before its own
 * verification; cross-adapter disagreement is adjudicated post-probe over
 * VerifiedRouteClaims. The function itself never mutates a graph; callers
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
        .filter((instance) => instance.ownerAdapterId === undefined
          ? adapter.poolAdapters.includes(instance.pool.adapter)
          : instance.ownerAdapterId === adapter.id)
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
      const key = protocolInstanceKey(adapter.id, candidate.pool);
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
      wouldAdmit.push({
        adapterId: adapter.id,
        instance,
        edges: [...edges],
        claims: deriveVerifiedRouteClaims(adapter.id, instance, edges, input.context.chainId),
      });
      events.push(eventFor(adapter.id, aggregate, "would_admit", "probe", null, edges.length));
    }
  }

  // Post-probe GLOBAL route arbitration over VerifiedRouteClaims. Every
  // claimant verified its own candidate first, so this decision is
  // evidence-backed. Same semantic route + same execution fingerprint =
  // equivalent claims that deduplicate at edge merge; same semantic route +
  // DIFFERENT execution fingerprints means at least one adapter admitted a
  // contract it should not have -> isolate the route and alert. Different
  // token pairs on one target are distinct semantic routes and coexist.
  const arbitration = arbitrateRouteClaims(wouldAdmit, events);

  return {
    events,
    wouldAdmit: arbitration,
    evaluatedInstanceKeys,
    evaluationComplete,
    sourceComplete: candidateSourceComplete && evaluationComplete,
  };
}

const AUTHORITY_RANKS: Readonly<Record<string, number>> = Object.freeze({
  "factory-call": 3,
  "curve-metaregistry": 3,
  "curve-metaregistry-underlying": 3,
  "v4-manager": 3,
  "balancer-v3-vault": 3,
  "dodo-factory-registry": 3,
  "erc4626-standard": 3,
  "eigenpie-compatible-call-surface": 3,
  "factory-event": 2,
  "factory-call-provisional": 1,
  "curve-underlying-provisional": 1,
  "seed": 0,
});

function authorityRankOf(fingerprint: string): number {
  return AUTHORITY_RANKS[fingerprint.split("|")[0] ?? ""] ?? 0;
}

function arbitrateRouteClaims(
  wouldAdmit: readonly VerifiedProtocolAdmission[],
  events: ProtocolDiscoveryEvent[],
): VerifiedProtocolAdmission[] {
  interface RouteClaimant {
    readonly admissionIndex: number;
    readonly claim: VerifiedRouteClaim;
  }
  const claimsByRoute = new Map<string, RouteClaimant[]>();
  wouldAdmit.forEach((admission, admissionIndex) => {
    for (const claim of admission.claims) {
      const claimants = claimsByRoute.get(claim.semanticRouteKey) ?? [];
      claimants.push({ admissionIndex, claim });
      claimsByRoute.set(claim.semanticRouteKey, claimants);
    }
  });

  const quarantinedRouteKeys = new Set<string>();
  for (const [routeKey, claimants] of claimsByRoute) {
    const claimantAdapterIds = unique(
      claimants.map((item) => wouldAdmit[item.admissionIndex].adapterId),
    );
    if (claimantAdapterIds.length < 2) continue;
    const target = claimants[0].claim.edge.target;
    const fingerprints = unique(claimants.map((item) => item.claim.executionFingerprint));
    if (fingerprints.length === 1) {
      // Equivalent claims: the route is admitted once (identical edge identity
      // deduplicates at merge). The primary owner is chosen by EXPLICIT
      // authority credential rank, then incumbency; a full tie is co-owned.
      // Registration order and lexical order never decide.
      const rankedClaimants = claimants.map((item) => ({
        adapterId: wouldAdmit[item.admissionIndex].adapterId,
        rank: authorityRankOf(item.claim.authorityFingerprint),
        incumbent: wouldAdmit[item.admissionIndex].instance.sources.includes("retained-instance"),
      }));
      const maxRank = Math.max(...rankedClaimants.map((item) => item.rank));
      const topRanked = rankedClaimants.filter((item) => item.rank === maxRank);
      const incumbents = topRanked.filter((item) => item.incumbent);
      const primary = topRanked.length === 1
        ? topRanked[0].adapterId
        : incumbents.length === 1
          ? incumbents[0].adapterId
          : null;
      events.push({
        event: "protocol_discovery",
        adapterId: primary ?? "co-owned",
        target,
        selectors: [],
        sources: ["route-arbitration"],
        verdict: "would_admit",
        stage: "arbitration",
        reason: `equivalent_route_claims claimants=${[...claimantAdapterIds].sort().join(",")}`,
        wouldAdmitEdges: 1,
      });
      continue;
    }
    // Non-equivalent full verifications of one semantic route are a
    // verification-looseness red flag, not a tie to break: isolate the route
    // for every claimant and alert so the loose gate gets tightened.
    quarantinedRouteKeys.add(routeKey);
    for (const adapterId of claimantAdapterIds) {
      events.push({
        event: "protocol_discovery",
        adapterId,
        target,
        selectors: [],
        sources: ["route-arbitration"],
        verdict: "rejected",
        stage: "arbitration",
        reason: `non_equivalent_execution_fingerprints claimants=${
          [...claimantAdapterIds].sort().join(",")
        }`,
        wouldAdmitEdges: 0,
      });
    }
  }
  if (quarantinedRouteKeys.size === 0) return [...wouldAdmit];

  const arbitrated: VerifiedProtocolAdmission[] = [];
  for (const admission of wouldAdmit) {
    const keptClaims = admission.claims.filter(
      (claim) => !quarantinedRouteKeys.has(claim.semanticRouteKey),
    );
    if (keptClaims.length === admission.claims.length) {
      arbitrated.push(admission);
      continue;
    }
    // A quarantined route strips its edge from every claimant; an admission
    // left with zero verified routes is dropped (and, being evaluated, any
    // prior ownership for it is revoked).
    if (keptClaims.length === 0) continue;
    const keptEdgeKeys = new Set(keptClaims.map((claim) => protocolEdgeKey(claim.edge)));
    arbitrated.push({
      ...admission,
      edges: admission.edges.filter((edge) => keptEdgeKeys.has(protocolEdgeKey(edge))),
      claims: keptClaims,
    });
  }
  return arbitrated;
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
    admissions.set(protocolInstanceKey(admission.adapterId, admission.instance.pool), admission);
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
  /**
   * Verified claims suppressed because a static/declared pool already owns the
   * address. The static venue enters the adjudication as the standing
   * authority and wins explicitly; suppression is reported, never silent.
   */
  readonly staticSuppressed: readonly VerifiedProtocolAdmission[];
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
  // separately validated migration removes the fallback explicitly.
  const staticPoolAddresses = new Set(
    input.currentBackrunPools
      .filter((pool) => !previousPoolKeys.has(poolRegistryKey(pool)))
      .map((pool) => pool.address.toLowerCase()),
  );
  const staticSuppressed = input.result.wouldAdmit.filter(
    (item) => staticPoolAddresses.has(item.instance.pool.address.toLowerCase()),
  );
  const effectiveResult: ProtocolDiscoveryResult = {
    ...input.result,
    wouldAdmit: input.result.wouldAdmit.filter(
      (item) => !staticPoolAddresses.has(item.instance.pool.address.toLowerCase()),
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
    // Stamp the exact verified routes onto the projected pool so a later
    // buildTokenGraph rebuild emits only what the probe accepted.
    admissions.map((item) => ({
      ...item.instance.pool,
      verifiedRoutes: item.edges.map(edgeToVerifiedRouteSpec),
    })),
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
    staticSuppressed,
  };
}

export function protocolInstanceKey(
  adapterId: string,
  pool: string | { readonly address: string; readonly logicalInstanceId?: string },
): string {
  const address = typeof pool === "string" ? pool : pool.address;
  const logicalInstanceId = typeof pool === "string" ? undefined : pool.logicalInstanceId;
  const base = `${adapterId}|${ethers.getAddress(address).toLowerCase()}`;
  return logicalInstanceId === undefined ? base : `${base}|${logicalInstanceId}`;
}

/** Address-level prefix of an instance key (adapterId|address). */
export function protocolInstanceAddressKey(instanceKey: string): string {
  return instanceKey.split("|").slice(0, 2).join("|");
}

function edgeToVerifiedRouteSpec(edge: TokenEdge): import("./planner/token-graph.js").VerifiedRouteSpec {
  return {
    edgeAdapterId: edge.adapterId,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    slotKind: edge.slotKind,
    ...(edge.protocolAction === undefined ? {} : { protocolAction: edge.protocolAction }),
  };
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

const MAX_PROTOCOL_EVIDENCE_PER_INSTANCE = 64;

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
    evidence: uniqueProtocolEvidence(candidate.evidence ?? []),
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
    evidence: uniqueProtocolEvidence([...current.evidence, ...(candidate.evidence ?? [])]),
  };
}

function uniqueProtocolEvidence(values: readonly unknown[]): unknown[] {
  const byWitness = new Map<string, unknown>();
  for (const value of values) {
    const key = stableEvidenceKey(value);
    // Reinsert duplicate witnesses so the retained order always prefers the
    // freshest observation when the bounded evidence window is full.
    byWitness.delete(key);
    byWitness.set(key, value);
  }
  return [...byWitness.values()].slice(-MAX_PROTOCOL_EVIDENCE_PER_INSTANCE);
}

function stableEvidenceKey(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value === null || typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (Array.isArray(value)) return `[${value.map(stableEvidenceKey).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableEvidenceKey(record[key])}`
  ).join(",")}}`;
}

function poolShapeKey(pool: PoolEntry): string {
  return JSON.stringify({
    address: pool.address.toLowerCase(),
    adapter: pool.adapter,
    logicalInstanceId: pool.logicalInstanceId,
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
    ownerAdapterId: adapter.id,
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
  const chain = protocolDiscoveryErrorChain(value);
  if (chain.some(isDeterministicProtocolRpcFailure)) return false;
  const retryableCodes = new Set([
    "NETWORK_ERROR",
    "SERVER_ERROR",
    "TIMEOUT",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "EPIPE",
  ]);
  for (const item of chain) {
    if (item instanceof RetryableProtocolDiscoveryError) return true;
    const code = item && typeof item === "object" && "code" in item
      ? String((item as { code?: unknown }).code).toUpperCase()
      : "";
    if (
      retryableCodes.has(code) ||
      code.startsWith("ECONN") ||
      code.startsWith("UND_ERR_")
    ) return true;
    const message = item instanceof Error ? item.message : String(item);
    if (
      /timed?\s*out|rate.?limit|too many requests|fetch failed|network|socket|connection (?:closed|reset|refused)|temporar(?:y|ily) unavailable|\b(?:429|502|503|504)\b/i
        .test(message)
    ) return true;
  }
  return false;
}

function isDeterministicProtocolRpcFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const code = String(record.code ?? "").toUpperCase();
  if (code === "CALL_EXCEPTION" || Number(record.code) === 3) return true;
  const message = value instanceof Error ? value.message : String(record.message ?? "");
  return /execution reverted|call exception/i.test(message) && record.data !== undefined;
}

function protocolDiscoveryErrorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: error, depth: 0 },
  ];
  const seen = new Set<object>();
  while (pending.length > 0 && values.length < 16) {
    const next = pending.shift()!;
    values.push(next.value);
    if (!next.value || typeof next.value !== "object" || next.depth >= 4) continue;
    if (seen.has(next.value)) continue;
    seen.add(next.value);
    const record = next.value as Record<string, unknown>;
    for (const key of ["cause", "error", "response"] as const) {
      if (record[key] !== undefined) {
        pending.push({ value: record[key], depth: next.depth + 1 });
      }
    }
  }
  return values;
}
