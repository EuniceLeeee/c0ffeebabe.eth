import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenEdge, V4PoolKey } from "../planner/token-graph.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import type { RuntimeEvidence } from
  "../venues/adapter-family-plugin.js";
import type {
  PendingExecutionEvidence,
  V4QuotePathStats,
} from "../venues/route-leg-adapter.js";
export type { V4QuotePathStats } from "../venues/route-leg-adapter.js";
import type { PoolStateCache } from "./pool-state-cache.js";

export class MissingRouteQuoterError extends Error {
  constructor(readonly adapterId: string) {
    super(`no quoter for adapter ${adapterId}`);
    this.name = "MissingRouteQuoterError";
  }
}

/**
 * Quoter — per-protocol amountOut estimation on the current fork state.
 * Returns "what would amountIn give you if you swapped right now".
 *
 * Used by amount-propagation to chain swap amounts through a path,
 * which then feeds solver's binary-search over flashAmount.
 *
 * Curve / UniV3 have on-chain quoters. Protocols without an exact quote or
 * dry-run path fail-fast here instead of emitting placeholder amounts.
 */

// ── Dispatch ───────────────────────────────────────────────────

export async function quote(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  state: StateBackend,
  cache?: PoolStateCache,
  v4PoolKey?: V4PoolKey,
  poolToken0?: string,
  poolToken1?: string,
  v4QuoteStats?: V4QuotePathStats,
  executor?: string,
  executionEvidence?: readonly PendingExecutionEvidence[],
  edge?: TokenEdge,
  strictSession?: StrictProductionRuntimeSession,
  runtimeEvidence: readonly RuntimeEvidence[] = Object.freeze([]),
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  void state;
  void cache;
  void v4PoolKey;
  void poolToken0;
  void poolToken1;
  void v4QuoteStats;
  void executionEvidence;
  if (strictSession !== undefined && edge !== undefined && executor !== undefined) {
    const exact = await strictSession.issueExact({
      edge,
      amountIn,
      executor,
      runtimeEvidence,
    });
    return exact.amountOut;
  }
  throw new MissingRouteQuoterError(
    `${adapterId} (strict current-source session required for ` +
      `${target}:${tokenIn}->${tokenOut})`,
  );
}
