import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../planner/token-graph.js";
import type { PoolStateCache } from "../solver/pool-state-cache.js";
import type { ProtocolAction, SlotKind } from "../strategy-taxonomy.js";
import type { RouteVenueMid, SyncMidReadContext } from "./mid-readers.js";

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

export interface RouteLegAdapter {
  readonly id: ExecutionFamilyId;
  readonly kind: RouteLegKind;
  readonly poolAdapters: readonly PoolEntry["adapter"][];
  readonly edgeAdapterIds: readonly string[];
  readonly allowedTaxonomy: readonly AllowedTaxonomy[];
  readonly actionAdapterIds: readonly string[];
  /** Sync-only hot-path read over state published by the prewarm phase. */
  readonly readMid: SyncMidReader | null;
  /** Declarative prewarm class; the coordinator remains the sole scheduler/state owner. */
  readonly warm: WarmSpec | null;

  buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]>;
  quoteExact(ctx: ExactQuoteContext): Promise<bigint>;
  buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment>;
}

export interface SwapAdapter extends RouteLegAdapter {
  readonly kind: "swap";
}

export interface ProtocolConversionAdapter extends RouteLegAdapter {
  readonly kind: "protocol-conversion";
}

export interface CompatRouteLegAdapter extends RouteLegAdapter {
  readonly kind: "compat";
}
