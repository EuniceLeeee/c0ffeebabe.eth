import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import type { PoolStateCache } from "../solver/pool-state-cache.js";
import type { ProtocolAction, SlotKind } from "../strategy-taxonomy.js";
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

/** Identity: the unit that enters the registry (one instance, one PoolEntry). */
export interface ProtocolInstance {
  readonly target: string;
  readonly adapter: PoolEntry["adapter"];
}

export interface ProtocolCandidate {
  readonly target: string;
  readonly source: "universe-token" | "parked";
}

/** Behavior: the unit routes/quotes/encodes are derived from. */
export interface ProtocolRoute {
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly action: ProtocolAction;
  readonly edgeAdapterId: string;
}

export interface RouteProbeResult {
  readonly ok: boolean;
  readonly reason: string | null;
  /** Fork receipt-level behavior verification (admission grade, Slice C); preview-only probes stay false. */
  readonly receiptVerified: boolean;
}

export interface DiscoveryContext {
  readonly backend: TokenQueryBackend;
  readonly universeTokens: readonly string[];
}

export interface ProbeContext {
  readonly backend: TokenQueryBackend;
}

/**
 * Instance discovery hooks (discovery plan §2). attestIdentity is the address
 * admission gate: null = the identity root does not recognise this address —
 * the candidate is quarantined and must never reach enumerate/probe/graph.
 */
export interface ProtocolInstanceDiscovery {
  discoverInstances(ctx: DiscoveryContext): Promise<ProtocolCandidate[]>;
  attestIdentity(candidate: ProtocolCandidate, ctx: ProbeContext): Promise<ProtocolInstance | null>;
  enumerateRoutes(instance: ProtocolInstance, ctx: ProbeContext): Promise<ProtocolRoute[]>;
  probeRoute(route: ProtocolRoute, ctx: ProbeContext): Promise<RouteProbeResult>;
}

export interface ProtocolConversionAdapter extends RouteLegAdapter {
  readonly kind: "protocol-conversion";
  readonly declaredVenues: readonly DeclaredProtocolVenue[];
  /** Required only for families whose instances must come from discovery/probe admission. */
  readonly undeclaredVenueReason: string | null;
  /** Absent = declaredVenues only (singletons stay in that tier permanently). */
  readonly discovery?: ProtocolInstanceDiscovery;
}

export interface CompatRouteLegAdapter extends RouteLegAdapter {
  readonly kind: "compat";
}
