import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import type { PoolStateCache } from "../solver/pool-state-cache.js";
import type { ProtocolAction, SlotKind } from "../strategy-taxonomy.js";
import type { AttestedPoolEntry } from "./identity.js";
import type { RouteVenueMid, SyncMidReadContext } from "./mid-readers.js";
import type { SwapObservationCapability } from "./swap-observation.js";

export type SwapExecutionFamilyId =
  | "univ2-standard"
  | "univ3-standard"
  | "univ4"
  | "curve-plain"
  | "curve-underlying"
  | "balancer-v3"
  | "fluid-dex"
  | `custom-swap:${string}`;

export type ProtocolExecutionFamilyId = `protocol:${string}`;
export type CompatExecutionFamilyId = `compat:${string}`;
export type ExecutionFamilyId =
  | SwapExecutionFamilyId
  | ProtocolExecutionFamilyId
  | CompatExecutionFamilyId;

export type RouteLegKind = "swap" | "protocol-conversion" | "compat";

export interface AllowedTaxonomy {
  slotKind: SlotKind;
  protocolAction?: ProtocolAction;
}

export interface PlanBuildContext {
  edge: TokenEdge;
  amountIn: bigint;
  amountOut: bigint;
  rawOut?: bigint;
  executor: string;
  state: StateBackend;
}

export type PlanRequirement =
  | { kind: "approve"; token: string; spender: string; amount: bigint }
  | { kind: "transfer-to-pool"; token: string; pool: string; amount: bigint };

export interface PlanFragment {
  requirements: readonly PlanRequirement[];
  nodes: readonly ResolvedPlanNode[];
}

export interface ExactQuoteContext {
  state: StateBackend;
  target: string;
  edgeAdapterId: string;
  amountIn: bigint;
  tokenIn?: string;
  tokenOut?: string;
  edge?: TokenEdge;
  cache?: PoolStateCache;
  v4PoolKey?: TokenEdge["v4PoolKey"];
  v4QuoteStats?: V4QuotePathStats;
}

export interface V4QuotePathStats {
  local: number;
  fallback: number;
  localFailures: number;
  hookSkipped: number;
}

export type WarmSpec =
  | { kind: "mutable-pool"; cache: "v2" | "v3" | "v4" }
  | { kind: "curve-pool" }
  | { kind: "external-mid" }
  | {
      kind: "protocol-mid";
      priority: 0 | 1 | 2;
      quotePrewarm?: (ctx: ExactQuoteContext) => Promise<bigint>;
    };

export type SyncMidReader = (ctx: SyncMidReadContext) => RouteVenueMid | null;

export interface ProtocolDiscoveryLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly transactionHash?: string;
  readonly blockNumber?: number;
}

export interface ProtocolDiscoveryReceipt {
  readonly status: number | null;
  readonly logs: readonly ProtocolDiscoveryLog[];
}

export type ProtocolDiscoveryTopicFilter = string | readonly string[] | null;

/** All state reads are pinned to one current block on the configured node. */
export interface ProtocolDiscoveryReadBackend {
  call(req: { to: string; data: string; from?: string }): Promise<string>;
  getCode(address: string): Promise<string>;
  getStorageAt(address: string, position: bigint): Promise<string>;
  getLogs(req: {
    readonly address?: string;
    readonly topics: readonly ProtocolDiscoveryTopicFilter[];
    readonly fromBlock: number;
    readonly toBlock: number;
  }): Promise<readonly ProtocolDiscoveryLog[]>;
  getTransactionReceipt(txHash: string): Promise<ProtocolDiscoveryReceipt | null>;
  traceTransaction(txHash: string): Promise<unknown>;
}

export interface ProtocolDiscoveryContext {
  readonly backend: ProtocolDiscoveryReadBackend;
  readonly blockNumber: number;
  readonly fromBlock: number;
  readonly toBlock: number;
  /** Decimal chain id for semantic route keys; absent only in chain-agnostic fixtures. */
  readonly chainId?: string;
  /** Complete graph domain used only for post-match loop-closability checks. */
  readonly graphTokens: readonly string[];
  /** Previously admitted instances are re-probed so upgrades and route removal replace atomically. */
  readonly retainedInstances: readonly AttestedProtocolInstance[];
}

export interface ProtocolCandidate {
  readonly pool: PoolEntry;
  readonly source: string;
  /** Present for candidates derived from a concrete calltrace interaction. */
  readonly selector?: string;
  /** Adapter-owned evidence. The coordinator treats it as opaque and never turns it into identity. */
  readonly evidence?: readonly unknown[];
}

export interface AttestedProtocolInstance {
  readonly pool: AttestedPoolEntry<PoolEntry>;
  readonly sources: readonly string[];
  /** Candidate classification remains address+selector; instance admission aggregates by address. */
  readonly selectors: readonly string[];
  readonly evidence: readonly unknown[];
}

/**
 * The shared scanner owns block/log/receipt/trace enumeration. A family adapter
 * only declares its cheap event shortlist and parses addresses/interactions into
 * candidates. Identity and route probing remain shared admission gates.
 */
export interface ProtocolDiscoveryCapability {
  /** Topic-0 values that make a transaction worth receipt+trace inspection. */
  readonly eventTopics: readonly string[];
  /** Manually adapted on-chain calls that may establish this family's interaction. */
  readonly callSelectors: readonly string[];
  /** Bump when address matching semantics change so persisted negatives retry. */
  readonly addressMatcherVersion?: string;
  /** Optional C2 matcher; the shared scanner owns DEX-token iteration and caching. */
  candidateFromAddress?(
    candidate: {
      readonly target: string;
      readonly codeHash: string;
      readonly implementationWord: string;
    },
    ctx: ProtocolDiscoveryContext,
  ): Promise<ProtocolCandidate | null>;
  probeCandidate(
    instance: AttestedProtocolInstance,
    ctx: ProtocolDiscoveryContext,
  ): Promise<readonly TokenEdge[]>;
  /** Optional Slice-E source. Selector match is only a candidate; identity/probe still follow. */
  candidateFromObservedCall?(
    call: {
      readonly target: string;
      readonly selector: string;
      readonly txHash: string;
      readonly receipt: ProtocolDiscoveryReceipt;
      /** Full transaction trace fetched once by the shared scanner. */
      readonly trace: unknown;
    },
    ctx: ProtocolDiscoveryContext,
  ): Promise<ProtocolCandidate | null>;
}

export interface PreparedRouteRequest {
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  poolToken0?: string;
  poolToken1?: string;
  v4PoolKey?: TokenEdge["v4PoolKey"];
}

export interface PreparedRouteCall {
  from: string;
  to: string;
  calldata: string;
  gasLimit?: number;
}

export interface PreparedRouteCallResult {
  output: string;
  latencyMs: number;
  cacheStats?: { warmHits: number; coldMisses: number };
}

export interface PreparedRouteQuoteResult {
  amountOut: bigint;
  latencyMs: number;
  cacheStats?: { warmHits: number; coldMisses: number };
}

export interface PreparedRouteContext {
  request: PreparedRouteRequest;
  edge?: TokenEdge;
  callPrepared(
    to: string,
    data: string,
    options?: { from?: string; gasLimit?: number },
  ): Promise<PreparedRouteCallResult>;
  readChain(req: { to: string; data: string }): Promise<string>;
}

export interface PreparedRouteCapability {
  readonly quote: ((ctx: PreparedRouteContext) => Promise<PreparedRouteQuoteResult>) | null;
  readonly quoteUnsupportedReason: string | null;
  readonly encodeQuotePrewarm:
    ((ctx: PreparedRouteContext) => Promise<readonly PreparedRouteCall[]>) | null;
  readonly allowanceSpender: ((request: PreparedRouteRequest) => string | null) | null;
  readonly prewarmAddresses: ((request: PreparedRouteRequest) => readonly string[]) | null;
}

export interface RouteLegAdapter {
  readonly id: ExecutionFamilyId;
  readonly kind: RouteLegKind;
  readonly poolAdapters: readonly PoolEntry["adapter"][];
  readonly edgeAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
  readonly actionAdapterIds: readonly string[];
  /** Admission metadata for the global SEARCHER_ENABLE_PROTOCOL_EDGES switch. */
  readonly requiresProtocolEdgesFlag: boolean;
  /** Sync-only hot-path read over state published by the prewarm phase. */
  readonly readMid: SyncMidReader | null;
  /** Declarative prewarm class; the coordinator remains the sole scheduler/state owner. */
  readonly warm: WarmSpec | null;
  /** Optional prepared-state/Revm lane capability; null means fail closed in that lane. */
  readonly prepared: PreparedRouteCapability | null;

  buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]>;
  quoteExact(ctx: ExactQuoteContext): Promise<bigint>;
  buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment>;
}

export interface SwapAdapter extends RouteLegAdapter {
  readonly kind: "swap";
  readonly observation: SwapObservationCapability;
}

export type DeclaredProtocolVenue = Readonly<
  Omit<PoolEntry, "score"> & {
    /** Static protocol venues are code-owned and never consume the scored pool budget. */
    readonly score?: never;
    /** Preserve pre-registry graph order during migration; new venues append when omitted. */
    readonly graphOrder?: number;
  }
>;

export interface ProtocolConversionAdapter extends RouteLegAdapter {
  readonly kind: "protocol-conversion";
  readonly declaredVenues: readonly DeclaredProtocolVenue[];
  /** Required only for families whose instances must come from discovery/probe admission. */
  readonly undeclaredVenueReason: string | null;
  /** Optional active discovery path. Absence preserves declared-venue-only behavior. */
  readonly discovery?: ProtocolDiscoveryCapability;
}

export interface CompatRouteLegAdapter extends RouteLegAdapter {
  readonly kind: "compat";
}
