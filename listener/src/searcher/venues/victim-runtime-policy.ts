import type { PostImpactSeed } from "../solver/pool-state-cache.js";
import type { PoolImpact } from "./swap-observation.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import type { VictimRuntimeStageResult } from "./victim-runtime-capability.js";
import { settleVictimRuntimeStage } from "./victim-runtime-supervisor.js";

export function victimUsesLocalCacheApply(
  _edgeAdapterId: string,
  _session?: StrictProductionRuntimeSession,
): boolean {
  // The legacy cache-specific authority was deleted. Strict replay may later
  // accept a plugin-issued canonical pre-state, but cannot inspect PoolStateCache.
  return false;
}

export function victimNeedsMutablePoolRefresh(
  _edgeAdapterId: string,
  _session?: StrictProductionRuntimeSession,
): boolean {
  return false;
}

export function hashOnlyImpactReplayAdmittedByPolicy(
  edgeAdapterId: string,
  session?: StrictProductionRuntimeSession,
): boolean {
  if (session === undefined) return false;
  return session.edges.some((edge) =>
    edge.adapterId === edgeAdapterId && session.supportsVictimReplay(edge)
  );
}

export async function eventPostImpactSeedFor(
  impact: PoolImpact,
  blockNumber: number,
  session?: StrictProductionRuntimeSession,
): Promise<PostImpactSeed | null> {
  const settled = await eventPostImpactSeedForSettled(
    impact,
    blockNumber,
    undefined,
    session,
  );
  return settled.ok ? settled.value : null;
}

export async function eventPostImpactSeedForSettled(
  impact: PoolImpact,
  blockNumber: number,
  timeoutMs?: number,
  session?: StrictProductionRuntimeSession,
): Promise<VictimRuntimeStageResult<PostImpactSeed | null>> {
  void blockNumber;
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
      stage: "exact-post-impact",
      elapsedMs: 0,
      timedOut: false,
      reason: "strict current-source victim authority is unavailable",
    });
  }
  return await settleVictimRuntimeStage({
    familyId,
    stage: "exact-post-impact",
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
        preState: null,
        validUntil: BigInt(Math.floor(Date.now() / 1_000) + 300),
      });
      if (replay.status !== "resolved") {
        throw new Error(replay.outcome.reasonCode);
      }
      return replay.exactPostState === null
        ? null
        : decodeStrictPostImpactSeed(replay.exactPostState);
    },
  });
}

export function decodeStrictPostImpactSeed(value: unknown): PostImpactSeed {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("strict victim post-impact must be an object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (!Number.isSafeInteger(record.blockNumber) || (record.blockNumber as number) < 0) {
    throw new Error("strict victim post-impact has invalid blockNumber");
  }
  if (record.kind === "v2") {
    requireString(record.pool, "v2 pool");
    requireString(record.token0, "v2 token0");
    requireString(record.token1, "v2 token1");
    requireBigint(record.reserve0, "v2 reserve0");
    requireBigint(record.reserve1, "v2 reserve1");
    requireBigint(record.feeBps, "v2 feeBps");
  } else if (record.kind === "v3") {
    requireString(record.pool, "v3 pool");
    requireBigint(record.sqrtPriceX96, "v3 sqrtPriceX96");
    requireBigint(record.liquidity, "v3 liquidity");
    requireInteger(record.tick, "v3 tick");
  } else if (record.kind === "v4") {
    requireString(record.poolManager, "v4 poolManager");
    requireString(record.poolId, "v4 poolId");
    requireBigint(record.sqrtPriceX96, "v4 sqrtPriceX96");
    requireBigint(record.liquidity, "v4 liquidity");
    requireInteger(record.tick, "v4 tick");
  } else if (record.kind === "curve") {
    requireString(record.pool, "curve pool");
    if (record.curveKind !== "plain" && record.curveKind !== "ng") {
      throw new Error("strict victim curve post-impact has invalid curveKind");
    }
    if (!Array.isArray(record.coins) || record.coins.some((coin) => typeof coin !== "string")) {
      throw new Error("strict victim curve post-impact has invalid coins");
    }
  } else {
    throw new Error("strict victim post-impact has unknown kind");
  }
  return value as PostImpactSeed;
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`strict victim ${label} is invalid`);
  }
}

function requireBigint(value: unknown, label: string): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`strict victim ${label} is invalid`);
  }
}

function requireInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`strict victim ${label} is invalid`);
  }
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
