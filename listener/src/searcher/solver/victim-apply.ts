import type { PoolImpact } from "../detector/pool-impact.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolStateCache } from "./pool-state-cache.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import type {
  LocalVictimApplyResult,
  VictimRuntimeStageResult,
} from "../venues/victim-runtime-capability.js";
import { settleVictimRuntimeStage } from "../venues/victim-runtime-supervisor.js";
import { decodeStrictPostImpactSeed } from
  "../venues/victim-runtime-policy.js";

export type { LocalVictimApplyResult } from "../venues/victim-runtime-capability.js";

/**
 * Registry-only dispatch. Pool math and post-state construction belong to the
 * owning family callback; an unknown or detect-only family fails closed.
 */
export async function applyVictimSwapLocally(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
  state?: StateBackend,
  session?: StrictProductionRuntimeSession,
): Promise<LocalVictimApplyResult | null> {
  const settled = await applyVictimSwapLocallySettled(
    cache,
    impact,
    blockNumber,
    state,
    undefined,
    session,
  );
  return settled.ok ? settled.value : null;
}

export async function applyVictimSwapLocallySettled(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
  state?: StateBackend,
  timeoutMs?: number,
  session?: StrictProductionRuntimeSession,
): Promise<VictimRuntimeStageResult<LocalVictimApplyResult | null>> {
  void cache;
  void blockNumber;
  void state;
  const edge = session?.edges.find((candidate) =>
    candidate.adapterId === impact.matchedAdapterId &&
    candidate.target.toLowerCase() === impact.pool.toLowerCase() &&
    candidate.tokenIn.toLowerCase() === impact.tokenIn.toLowerCase() &&
    candidate.tokenOut.toLowerCase() === impact.tokenOut.toLowerCase() &&
    (impact.poolId === undefined || candidate.poolId === impact.poolId)
  );
  const familyId = edge === undefined
    ? impact.matchedAdapterId
    : session!.familyIdForEdge(edge);
  if (session === undefined || edge === undefined) {
    return Object.freeze({
      ok: false,
      familyId,
      stage: "local-apply",
      elapsedMs: 0,
      timedOut: false,
      reason: "strict current-source victim authority is unavailable",
    });
  }
  return await settleVictimRuntimeStage({
    familyId,
    stage: "local-apply",
    timeoutMs,
    work: (control) => {
      void control;
      const exactPostState = impact.v2PostState ?? impact.v3PostState ??
        impact.v4PostState;
      const replay = session.replayVictim({
        edge,
        impact: Object.freeze({
          pool: impact.pool,
          tokenIn: impact.tokenIn,
          tokenOut: impact.tokenOut,
          amountIn: impact.amountIn,
          ...(impact.amountOut === undefined
            ? {}
            : { amountOut: impact.amountOut }),
          ...(exactPostState === undefined ? {} : { exactPostState }),
        }),
        // The old cache-specific pre-state codec was intentionally removed.
        // A Family without a canonical pre-state returns null and the caller
        // proceeds through the strict overlay path.
        preState: null,
        validUntil: BigInt(Math.floor(Date.now() / 1_000) + 300),
      });
      if (replay.status !== "resolved") {
        throw new Error(replay.outcome.reasonCode);
      }
      if (replay.localApply === null) return null;
      if (
        replay.localApply === null ||
        typeof replay.localApply !== "object" ||
        Array.isArray(replay.localApply) ||
        typeof replay.localApply.amountOut !== "bigint" ||
        replay.localApply.amountOut < 0n
      ) {
        throw new Error("strict victim local apply result is invalid");
      }
      return Object.freeze({
        amountOut: replay.localApply.amountOut,
        postImpact: decodeStrictPostImpactSeed(replay.localApply.postImpact),
      });
    },
  });
}
