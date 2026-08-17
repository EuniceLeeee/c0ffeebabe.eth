import type { PoolImpact } from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
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

export function overlaySupportsAdapter(
  impact: PoolImpact,
  session: StrictProductionRuntimeSession,
): boolean {
  const edge = strictVictimEdge(session, impact);
  return edge !== null && session.supportsVictimReplay(edge);
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
  session: StrictProductionRuntimeSession,
  ctx: OverlayResolveCtx,
  timeoutMs?: number,
): Promise<VictimOverlay> {
  const settled = await buildVictimOverlaySettled(
    impact,
    session,
    ctx,
    timeoutMs,
  );
  if (!settled.ok) throw new VictimRuntimeFamilyError(settled);
  return settled.value;
}

export async function buildVictimOverlaySettled(
  impact: PoolImpact,
  session: StrictProductionRuntimeSession,
  ctx: OverlayResolveCtx,
  timeoutMs?: number,
): Promise<VictimRuntimeStageResult<VictimOverlay>> {
  void ctx;
  const edge = strictVictimEdge(session, impact);
  const familyId = edge === null
    ? impact.matchedAdapterId
    : session.familyIdForEdge(edge);
  if (edge === null || !session.supportsVictimReplay(edge)) {
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
      void control;
      const replay = session.replayVictim({
        edge,
        impact: normalizedImpact(impact),
        preState: null,
        validUntil: BigInt(Math.floor(Date.now() / 1_000) + 300),
      });
      if (replay.status !== "resolved" || replay.overlay === null) {
        const reason = replay.status === "resolved"
          ? "strict victim replay produced no overlay"
          : replay.outcome.reasonCode;
        throw new Error(reason);
      }
      return Object.freeze({
        whale: replay.overlay.whale,
        tokenDeals: replay.overlay.tokenDeals.map((deal) => ({ ...deal })),
        preCalls: replay.overlay.preCalls.map((call) => ({ ...call })),
      });
    },
  });
}

function strictVictimEdge(
  session: StrictProductionRuntimeSession,
  impact: PoolImpact,
): TokenEdge | null {
  const target = impact.pool.toLowerCase();
  const tokenIn = impact.tokenIn.toLowerCase();
  const tokenOut = impact.tokenOut.toLowerCase();
  return session.edges.find((edge) =>
    edge.adapterId === impact.matchedAdapterId &&
    edge.target.toLowerCase() === target &&
    edge.tokenIn.toLowerCase() === tokenIn &&
    edge.tokenOut.toLowerCase() === tokenOut &&
    (impact.poolId === undefined || edge.poolId === impact.poolId)
  ) ?? null;
}

function normalizedImpact(impact: PoolImpact) {
  const exactPostState = impact.v2PostState ?? impact.v3PostState ??
    impact.v4PostState;
  return Object.freeze({
    pool: impact.pool,
    tokenIn: impact.tokenIn,
    tokenOut: impact.tokenOut,
    amountIn: impact.amountIn,
    ...(impact.amountOut === undefined ? {} : { amountOut: impact.amountOut }),
    ...(exactPostState === undefined ? {} : { exactPostState }),
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
