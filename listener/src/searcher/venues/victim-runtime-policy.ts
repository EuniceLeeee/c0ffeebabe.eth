import type { PostImpactSeed } from "../solver/pool-state-cache.js";
import type { PoolImpact } from "./swap-observation.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "./production-registry.js";
import type { VictimRuntimeStageResult } from "./victim-runtime-capability.js";
import { settleVictimRuntimeStage } from "./victim-runtime-supervisor.js";

export function victimUsesLocalCacheApply(edgeAdapterId: string): boolean {
  return PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(edgeAdapterId)
    ?.runtime
    ?.localApply
    ?.cacheBacked === true;
}

export function victimNeedsMutablePoolRefresh(edgeAdapterId: string): boolean {
  return PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(edgeAdapterId)
    ?.runtime
    ?.localApply
    ?.needsMutablePoolRefresh === true;
}

export function hashOnlyImpactReplayAdmittedByPolicy(
  edgeAdapterId: string,
): boolean {
  const runtime = PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(edgeAdapterId)
    ?.runtime;
  return Boolean(
    runtime &&
      (
        runtime.localApply !== null ||
        runtime.exactPostImpact !== null ||
        runtime.buildOverlay !== null
      ),
  );
}

export async function eventPostImpactSeedFor(
  impact: PoolImpact,
  blockNumber: number,
): Promise<PostImpactSeed | null> {
  const settled = await eventPostImpactSeedForSettled(impact, blockNumber);
  return settled.ok ? settled.value : null;
}

export async function eventPostImpactSeedForSettled(
  impact: PoolImpact,
  blockNumber: number,
  timeoutMs?: number,
): Promise<VictimRuntimeStageResult<PostImpactSeed | null>> {
  const family = PRODUCTION_ADAPTER_FAMILIES
    .routes()
    .findForEdge(impact.matchedAdapterId);
  const callback = PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(impact.matchedAdapterId)
    ?.runtime
    ?.exactPostImpact;
  const familyId = family?.id ?? impact.matchedAdapterId;
  if (!callback) {
    return Object.freeze({
      ok: true,
      familyId,
      stage: "exact-post-impact",
      elapsedMs: 0,
      value: null,
    });
  }
  return await settleVictimRuntimeStage({
    familyId,
    stage: "exact-post-impact",
    timeoutMs,
    work: (control) => callback(impact, blockNumber, control),
  });
}

export function postImpactSeedSummary(postImpact: PostImpactSeed): string {
  const values = postImpact as unknown as Record<string, unknown>;
  return [
    "pool",
    "poolManager",
    "poolId",
    "reserve0",
    "reserve1",
    "sqrtPriceX96",
    "tick",
  ]
    .filter((key) => values[key] !== undefined)
    .map((key) => {
      const value = String(values[key]);
      return `${key}=${value.startsWith("0x") ? value.slice(0, 10) : value}`;
    })
    .join(" ");
}
