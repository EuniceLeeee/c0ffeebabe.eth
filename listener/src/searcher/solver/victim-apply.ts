import type { PoolImpact } from "../detector/pool-impact.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolStateCache } from "./pool-state-cache.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import type {
  LocalVictimApplyResult,
  VictimRuntimeStageResult,
} from "../venues/victim-runtime-capability.js";
import { settleVictimRuntimeStage } from "../venues/victim-runtime-supervisor.js";

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
): Promise<LocalVictimApplyResult | null> {
  const settled = await applyVictimSwapLocallySettled(
    cache,
    impact,
    blockNumber,
    state,
  );
  return settled.ok ? settled.value : null;
}

export async function applyVictimSwapLocallySettled(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
  state?: StateBackend,
  timeoutMs?: number,
): Promise<VictimRuntimeStageResult<LocalVictimApplyResult | null>> {
  const family = PRODUCTION_ADAPTER_FAMILIES
    .routes()
    .findForEdge(impact.matchedAdapterId);
  const callback = PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(impact.matchedAdapterId)
    ?.runtime
    ?.localApply
    ?.apply;
  const familyId = family?.id ?? impact.matchedAdapterId;
  if (!callback) {
    return Object.freeze({
      ok: true,
      familyId,
      stage: "local-apply",
      elapsedMs: 0,
      value: null,
    });
  }
  return await settleVictimRuntimeStage({
    familyId,
    stage: "local-apply",
    timeoutMs,
    work: (control) =>
      callback({ cache, impact, blockNumber, state, control }),
  });
}
