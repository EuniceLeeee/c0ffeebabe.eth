import type { PoolImpact } from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import type {
  VictimOverlay,
  VictimOverlayBuildContext,
  VictimRuntimeStageResult,
} from "../venues/victim-runtime-capability.js";
import { settleVictimRuntimeStage } from "../venues/victim-runtime-supervisor.js";

export type {
  OverlayPreCall,
  OverlayTokenDeal,
  VictimOverlay,
} from "../venues/victim-runtime-capability.js";

export function overlaySupportsAdapter(adapterId: string): boolean {
  const callback = PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(adapterId)
    ?.runtime
    ?.buildOverlay;
  return callback !== null && callback !== undefined;
}

export interface OverlayResolveCtx {
  readonly graph: readonly TokenEdge[];
  read(req: { readonly to: string; readonly data: string }): Promise<string>;
}

/**
 * Registry-only dispatch. Router selection, ABI encoding, graph lookup and
 * any family-specific reads are owned by the registered family callback.
 */
export async function buildVictimOverlay(
  impact: PoolImpact,
  ctx: OverlayResolveCtx,
  timeoutMs?: number,
): Promise<VictimOverlay> {
  const settled = await buildVictimOverlaySettled(impact, ctx, timeoutMs);
  if (!settled.ok) throw new VictimRuntimeFamilyError(settled);
  return settled.value;
}

export async function buildVictimOverlaySettled(
  impact: PoolImpact,
  ctx: OverlayResolveCtx,
  timeoutMs?: number,
): Promise<VictimRuntimeStageResult<VictimOverlay>> {
  const family = PRODUCTION_ADAPTER_FAMILIES
    .routes()
    .findForEdge(impact.matchedAdapterId);
  const callback = PRODUCTION_ADAPTER_FAMILIES
    .victimModels()
    .forEdge(impact.matchedAdapterId)
    ?.runtime
    ?.buildOverlay;
  const familyId = family?.id ?? impact.matchedAdapterId;
  if (!callback) {
    return Object.freeze({
      ok: false,
      familyId,
      stage: "overlay",
      elapsedMs: 0,
      timedOut: false,
      reason: `overlay: unsupported adapter ${impact.matchedAdapterId}`,
    });
  }
  return await settleVictimRuntimeStage({
    familyId,
    stage: "overlay",
    timeoutMs,
    work: (control) => {
      const input: VictimOverlayBuildContext = {
        impact,
        graph: ctx.graph,
        read: ctx.read,
        control,
      };
      return callback(input);
    },
  });
}

export class VictimRuntimeFamilyError extends Error {
  readonly familyId: string;
  readonly stage: string;
  readonly timedOut: boolean;

  constructor(
    result: Extract<VictimRuntimeStageResult<unknown>, { readonly ok: false }>,
  ) {
    super(result.reason);
    this.name = "VictimRuntimeFamilyError";
    this.familyId = result.familyId;
    this.stage = result.stage;
    this.timedOut = result.timedOut;
  }
}
