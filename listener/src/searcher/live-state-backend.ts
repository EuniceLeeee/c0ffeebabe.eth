import type { ResolvedPlanNode } from "../shared/types/plan.js";
import type { PoolImpact } from "./detector/pool-impact.js";
import type { LiveFixturePath } from "./live-fixture-recorder.js";
import type { OrderflowEvent } from "./orderflow/manual-source.js";
import type { SimulationResult } from "./simulator/botvm-simulator.js";
import type { PostImpactSeed } from "./solver/pool-state-cache.js";
import type { TokenEdge, V4PoolKey } from "./planner/token-graph.js";
import type { PendingExecutionEvidence } from "./venues/route-leg-adapter.js";
import type { StrictProductionRuntimeSession } from
  "./strict-production-runtime-session.js";

export type LiveBackendKind = "rpc" | "revm" | "hybrid";

/**
 * Everything a backend needs to reconstruct the victim's pool impact. For revm
 * (hash-only path) this drives the overlay: read chain state at `baseBlock` and
 * replay the victim swap on top, instead of mutating an Anvil fork.
 */
export interface PrepareInput {
  event: OrderflowEvent;
  impact: PoolImpact | null;
  /** Pre-victim block to read chain state at (latest mined block on hash-only). */
  baseBlock: number;
  /** Canonical hash observed before preparation; backends reject a reorged/stale cache. */
  baseBlockHash?: string;
  path: LiveFixturePath;
  /** Deduped route hops from the candidate plans. The revm backend traces a
   *  representative quote per hop during prepare so the solver's amount search
   *  starts with warm pool state instead of serial-faulting slots. */
  routeHops?: QuoteHop[];
  /** Locally computed post-victim pool state. When available, revm can inject raw
   *  storage overrides instead of replaying the victim swap with debug_traceCall. */
  postImpact?: PostImpactSeed;
  /** Absolute opportunity deadline; family-local preparation may not publish after it. */
  deadlineAtMs?: number;
  /** Sole Family/route authority for victim replay at this pinned source. */
  strictSession?: StrictProductionRuntimeSession;
}

export interface PreparedState {
  blockNumber: number;
  blockHash?: string;
  mode: "hash-only" | "rawTx" | "mined";
}

export interface QuoteRequest {
  /** Exact graph-edge identity. Prepared backends use this before structural fallback. */
  canonicalEdgeId?: TokenEdge["canonicalEdgeId"];
  /** Family-bound identity is available before a graph becomes a verified view. */
  instanceKey?: TokenEdge["instanceKey"];
  executionVariantKey?: TokenEdge["executionVariantKey"];
  adapterId: string;
  target: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  poolToken0?: string;
  poolToken1?: string;
  v4PoolKey?: V4PoolKey;
  /** Evidence for adapterId's owning family only. */
  executionEvidence?: PendingExecutionEvidence;
}

export type QuoteHop = Omit<QuoteRequest, "amountIn">;

export function quoteHopIdentityKey(hop: QuoteHop): string {
  if (hop.canonicalEdgeId !== undefined) {
    return `canonical:${hop.canonicalEdgeId}`;
  }
  if (
    hop.instanceKey !== undefined &&
    hop.executionVariantKey !== undefined
  ) {
    return JSON.stringify([
      "route-instance",
      hop.instanceKey,
      hop.executionVariantKey,
      hop.adapterId,
      hop.tokenIn.toLowerCase(),
      hop.tokenOut.toLowerCase(),
    ]);
  }
  return [
    hop.adapterId,
    hop.target.toLowerCase(),
    hop.tokenIn.toLowerCase(),
    hop.tokenOut.toLowerCase(),
    hop.poolToken0?.toLowerCase() ?? "",
    hop.poolToken1?.toLowerCase() ?? "",
    v4PoolKeyIdentity(hop.v4PoolKey),
  ].join(":");
}

export function findPreparedQuoteEdge(
  graph: readonly TokenEdge[],
  request: QuoteRequest,
): TokenEdge | undefined {
  const target = request.target.toLowerCase();
  const tokenIn = request.tokenIn.toLowerCase();
  const tokenOut = request.tokenOut.toLowerCase();
  const poolKey = v4PoolKeyIdentity(request.v4PoolKey);
  return graph.find((edge) =>
    (request.canonicalEdgeId === undefined ||
      edge.canonicalEdgeId === request.canonicalEdgeId) &&
    (request.instanceKey === undefined ||
      edge.instanceKey === request.instanceKey) &&
    (request.executionVariantKey === undefined ||
      edge.executionVariantKey === request.executionVariantKey) &&
    edge.adapterId === request.adapterId &&
    edge.target.toLowerCase() === target &&
    edge.tokenIn.toLowerCase() === tokenIn &&
    edge.tokenOut.toLowerCase() === tokenOut &&
    (poolKey === "" || v4PoolKeyIdentity(edge.v4PoolKey) === poolKey)
  );
}

export interface QuoteResult {
  amountOut: bigint;
  latencyMs: number;
  cacheStats?: {
    warmHits: number;
    coldMisses: number;
  };
}

export interface LiveStateBackend {
  readonly kind: LiveBackendKind;
  readonly executor: string;
  supportsPath?(input: PrepareInput): boolean;
  prepareVictimState(input: PrepareInput): Promise<PreparedState>;
  /** Current-candidate JIT warm. Unlike the between-block lane, this is scheduled
   *  after planning for the exact candidate set and can run while local quote
   *  search proceeds without touching the daemon. */
  warmPrepareState?(input: PrepareInput): Promise<void>;
  /** Proactive between-block warm of recurring hot pools (revm only). Traces a
   *  representative quote per pool so a later hint's solve on the same block
   *  hits warm state instead of paying a cold route-hop trace inside the TTL. */
  warmHotPools?(blockNumber: number, hops: QuoteRequest[]): Promise<void>;
  quote(req: QuoteRequest): Promise<QuoteResult>;
  /** Raw eth_call against the prepared post-victim state. Backends that hold a
   *  warm overlay (revm/hybrid) expose this so the solver's PoolStateCache can
   *  warm local-math state from the same shifted state. */
  call?(req: { to: string; data: string; from?: string }): Promise<string>;
  simulate(plan: { root: ResolvedPlanNode; profitToken: string; netProfit: bigint }): Promise<SimulationResult>;
  finalVerify?(plan: { root: ResolvedPlanNode; profitToken: string; netProfit: bigint }): Promise<SimulationResult>;
}

export function parseLiveBackendKind(value: string): LiveBackendKind {
  if (value === "rpc" || value === "revm" || value === "hybrid") return value;
  throw new Error(`unsupported live backend: ${value}`);
}

function v4PoolKeyIdentity(key: V4PoolKey | undefined): string {
  if (!key) return "";
  return [
    key.currency0.toLowerCase(),
    key.currency1.toLowerCase(),
    String(key.fee),
    String(key.tickSpacing),
    key.hooks.toLowerCase(),
  ].join(":");
}
