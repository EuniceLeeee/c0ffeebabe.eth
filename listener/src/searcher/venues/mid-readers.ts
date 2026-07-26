import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type {
  CurveSnapshot,
  PoolStateCache,
  V2Seed,
  V3Snapshot,
  V4Snapshot,
} from "../solver/pool-state-cache.js";
import { curveNgGetDy, curvePlainGetDy } from "../solver/curve-math.js";
import { BLOCKSCAN_MIN_VENUE_RESERVE_IN } from "../detector/blockscan-sizing-constants.js";
import { bigintRatio } from "./swaps/blockscan-state-shared.js";

export interface ExternalMidQuote {
  mid: number;
  feeBps: number;
  depthIn: bigint;
}

export type RouteVenueMidKind =
  | "v2"
  | "v3"
  | "v4"
  | "curve"
  | "curve-underlying"
  | "external-swap"
  | "protocol";

export interface RouteVenueMid {
  kind: RouteVenueMidKind;
  pool: string;
  edges: TokenEdge[];
  mid: number;
  feeBps: number;
  reserveA?: bigint;
  reserveB?: bigint;
  sqrtABX96?: bigint;
  liquidity?: bigint;
  depthProxy: number;
}

export interface SyncMidReadContext {
  cache: PoolStateCache;
  sourceBlock: number;
  a: string;
  b: string;
  pool: string;
  edges: TokenEdge[];
  externalMids?: ReadonlyMap<string, ExternalMidQuote>;
}

const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const WETH = ADDR.WETH.toLowerCase();

export class LegacyConcentratedLiquidityPrecisionUnsupportedError extends Error {
  readonly code = "LEGACY_CONCENTRATED_LIQUIDITY_PRECISION_UNSUPPORTED";

  constructor(
    family: "univ3" | "univ4",
    pool: string,
    reserve0Floor: bigint,
    reserve1Floor: bigint,
  ) {
    super(
      `${family} legacy sync-mid cannot represent current-source precision for ${pool}: ` +
        `virtualReserves=${reserve0Floor}/${reserve1Floor}; ` +
        "use the production pricing-state precision path",
    );
    this.name = "LegacyConcentratedLiquidityPrecisionUnsupportedError";
  }
}

export function readV2WarmMid(ctx: SyncMidReadContext): RouteVenueMid | null {
  return readV2Mid(ctx.cache.snapshotV2(ctx.pool, ctx.sourceBlock), ctx);
}

export function readV3WarmMid(ctx: SyncMidReadContext): RouteVenueMid | null {
  return readV3Mid(ctx.cache.snapshotV3(ctx.pool, ctx.sourceBlock), ctx);
}

export function readV4WarmMid(ctx: SyncMidReadContext): RouteVenueMid | null {
  return readV4Mid(ctx.cache.snapshotV4(ctx.pool, ctx.sourceBlock), ctx);
}

export function readCurveWarmMid(ctx: SyncMidReadContext): RouteVenueMid | null {
  return readCurveMid(ctx.cache.snapshotCurve(ctx.pool, ctx.sourceBlock), ctx);
}

export function readCurveUnderlyingExternalMid(ctx: SyncMidReadContext): RouteVenueMid | null {
  return readExternalMid("curve-underlying", ctx);
}

export function readProtocolExternalMid(ctx: SyncMidReadContext): RouteVenueMid | null {
  return readExternalMid("protocol", ctx);
}

export function readExternalSwapMid(ctx: SyncMidReadContext): RouteVenueMid | null {
  return readExternalMid("external-swap", ctx);
}

function readV2Mid(snapshot: V2Seed | null, ctx: SyncMidReadContext): RouteVenueMid | null {
  if (!snapshot) return null;
  const token0 = snapshot.token0.toLowerCase();
  const token1 = snapshot.token1.toLowerCase();
  const reserveA = token0 === ctx.a ? snapshot.reserve0 : token1 === ctx.a ? snapshot.reserve1 : null;
  const reserveB = token0 === ctx.b ? snapshot.reserve0 : token1 === ctx.b ? snapshot.reserve1 : null;
  if (reserveA === null || reserveB === null || reserveA <= 0n || reserveB <= 0n) return null;
  const mid = Number(reserveB) / Number(reserveA);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return {
    kind: "v2", pool: ctx.pool, edges: ctx.edges, mid,
    feeBps: Number(snapshot.feeBps), reserveA, reserveB,
    depthProxy: Number(minBigint(reserveA, reserveB)),
  };
}

function readV3Mid(snapshot: V3Snapshot | null, ctx: SyncMidReadContext): RouteVenueMid | null {
  if (!snapshot || snapshot.state.sqrtPriceX96 <= 0n || snapshot.state.liquidity <= 0n) return null;
  const token0 = snapshot.token0.toLowerCase();
  const token1 = snapshot.token1.toLowerCase();
  const price0To1 = bigintRatio(
    snapshot.state.sqrtPriceX96 * snapshot.state.sqrtPriceX96,
    Q192,
  );
  let mid: number;
  let sqrtABX96: bigint;
  let reserveA: bigint;
  let reserveB: bigint;
  const reserve0Floor =
    snapshot.state.liquidity * Q96 / snapshot.state.sqrtPriceX96;
  const reserve1Floor =
    snapshot.state.liquidity * snapshot.state.sqrtPriceX96 / Q96;
  if (
    reserve0Floor < BLOCKSCAN_MIN_VENUE_RESERVE_IN ||
    reserve1Floor < BLOCKSCAN_MIN_VENUE_RESERVE_IN
  ) {
    throw new LegacyConcentratedLiquidityPrecisionUnsupportedError(
      "univ3",
      ctx.pool,
      reserve0Floor,
      reserve1Floor,
    );
  }
  const reserve0 = reserve0Floor;
  const reserve1 = reserve1Floor;
  if (token0 === ctx.a && token1 === ctx.b) {
    mid = price0To1;
    sqrtABX96 = snapshot.state.sqrtPriceX96;
    reserveA = reserve0;
    reserveB = reserve1;
  } else if (token0 === ctx.b && token1 === ctx.a) {
    mid = bigintRatio(
      Q192,
      snapshot.state.sqrtPriceX96 * snapshot.state.sqrtPriceX96,
    );
    sqrtABX96 = Q192 / snapshot.state.sqrtPriceX96;
    reserveA = reserve1;
    reserveB = reserve0;
  } else {
    return null;
  }
  if (!Number.isFinite(mid) || mid <= 0 || sqrtABX96 <= 0n) return null;
  return {
    kind: "v3", pool: ctx.pool, edges: ctx.edges, mid,
    feeBps: Number(snapshot.state.fee) / 100,
    sqrtABX96, liquidity: snapshot.state.liquidity, reserveA, reserveB,
    depthProxy: Number(minBigint(reserveA, reserveB)),
  };
}

function readV4Mid(snapshot: V4Snapshot | null, ctx: SyncMidReadContext): RouteVenueMid | null {
  const key = ctx.edges[0]?.v4PoolKey;
  if (!snapshot || !key || snapshot.sqrtPriceX96 <= 0n || snapshot.liquidity <= 0n) return null;
  const token0 = normalizeV4GraphCurrency(key.currency0);
  const token1 = normalizeV4GraphCurrency(key.currency1);
  const price0To1 = bigintRatio(
    snapshot.sqrtPriceX96 * snapshot.sqrtPriceX96,
    Q192,
  );
  let mid: number;
  let sqrtABX96: bigint;
  let reserveA: bigint;
  let reserveB: bigint;
  const reserve0Floor = snapshot.liquidity * Q96 / snapshot.sqrtPriceX96;
  const reserve1Floor = snapshot.liquidity * snapshot.sqrtPriceX96 / Q96;
  if (
    reserve0Floor < BLOCKSCAN_MIN_VENUE_RESERVE_IN ||
    reserve1Floor < BLOCKSCAN_MIN_VENUE_RESERVE_IN
  ) {
    throw new LegacyConcentratedLiquidityPrecisionUnsupportedError(
      "univ4",
      ctx.pool,
      reserve0Floor,
      reserve1Floor,
    );
  }
  const reserve0 = reserve0Floor;
  const reserve1 = reserve1Floor;
  if (token0 === ctx.a && token1 === ctx.b) {
    mid = price0To1;
    sqrtABX96 = snapshot.sqrtPriceX96;
    reserveA = reserve0;
    reserveB = reserve1;
  } else if (token0 === ctx.b && token1 === ctx.a) {
    mid = bigintRatio(
      Q192,
      snapshot.sqrtPriceX96 * snapshot.sqrtPriceX96,
    );
    sqrtABX96 = Q192 / snapshot.sqrtPriceX96;
    reserveA = reserve1;
    reserveB = reserve0;
  } else {
    return null;
  }
  if (!Number.isFinite(mid) || mid <= 0 || sqrtABX96 <= 0n) return null;
  return {
    kind: "v4", pool: ctx.pool, edges: ctx.edges, mid,
    feeBps: Number(snapshot.lpFee) / 100,
    sqrtABX96, liquidity: snapshot.liquidity, reserveA, reserveB,
    depthProxy: Number(minBigint(reserveA, reserveB)),
  };
}

function readCurveMid(snapshot: CurveSnapshot | null, ctx: SyncMidReadContext): RouteVenueMid | null {
  if (!snapshot) return null;
  const state = snapshot.kind === "plain" ? snapshot.plain : snapshot.ng;
  if (!state || !state.balances || state.balances.length === 0) return null;
  const i = snapshot.coins.findIndex((coin) => coin.toLowerCase() === ctx.a);
  const j = snapshot.coins.findIndex((coin) => coin.toLowerCase() === ctx.b);
  if (i < 0 || j < 0) return null;
  const reserveA = state.balances[i];
  const reserveB = state.balances[j];
  if (reserveA <= 0n || reserveB <= 0n) return null;
  const exact = ctx.externalMids?.get(`${ctx.pool}|${ctx.a}|${ctx.b}`);
  let mid: number;
  let feeBps: number;
  if (exact) {
    mid = exact.mid;
    feeBps = exact.feeBps;
  } else {
    const probeIn = reserveA / 1_000_000n > 0n ? reserveA / 1_000_000n : 1n;
    let probeOut: bigint;
    try {
      probeOut = snapshot.kind === "plain"
        ? curvePlainGetDy(snapshot.plain!, i, j, probeIn)
        : curveNgGetDy(snapshot.ng!, i, j, probeIn);
    } catch {
      return null;
    }
    if (probeOut <= 0n) return null;
    mid = Number(probeOut) / Number(probeIn);
    feeBps = 0;
  }
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return {
    kind: "curve", pool: ctx.pool, edges: ctx.edges, mid, feeBps,
    reserveA, reserveB, depthProxy: Number(minBigint(reserveA, reserveB)),
  };
}

function readExternalMid(
  kind: "protocol" | "curve-underlying" | "external-swap",
  ctx: SyncMidReadContext,
): RouteVenueMid | null {
  if (!ctx.externalMids || !findEdge(ctx.edges, ctx.a, ctx.b)) return null;
  const direct = ctx.externalMids.get(`${ctx.pool}|${ctx.a}|${ctx.b}`);
  const reverse = direct ? null : ctx.externalMids.get(`${ctx.pool}|${ctx.b}|${ctx.a}`);
  const quoted = direct ?? reverse;
  if (!quoted || !Number.isFinite(quoted.mid) || quoted.mid <= 0 || quoted.depthIn <= 0n) return null;
  const mid = direct ? quoted.mid : 1 / quoted.mid;
  const reserveANumber = direct ? Number(quoted.depthIn) : Number(quoted.depthIn) / quoted.mid;
  const reserveBNumber = direct ? Number(quoted.depthIn) * quoted.mid : Number(quoted.depthIn);
  if (
    !Number.isFinite(mid) || mid <= 0 ||
    !Number.isFinite(reserveANumber) || reserveANumber <= 0 ||
    !Number.isFinite(reserveBNumber) || reserveBNumber <= 0
  ) return null;
  const reserveA = BigInt(Math.floor(reserveANumber));
  const reserveB = BigInt(Math.floor(reserveBNumber));
  if (reserveA <= 0n || reserveB <= 0n) return null;
  return {
    kind, pool: ctx.pool, edges: ctx.edges, mid,
    feeBps: quoted.feeBps, reserveA, reserveB,
    depthProxy: Number(minBigint(reserveA, reserveB)),
  };
}

function findEdge(edges: TokenEdge[], tokenIn: string, tokenOut: string): TokenEdge | null {
  return edges.find((edge) =>
    edge.tokenIn.toLowerCase() === tokenIn && edge.tokenOut.toLowerCase() === tokenOut
  ) ?? null;
}

function normalizeV4GraphCurrency(currency: string): string {
  const normalized = currency.toLowerCase();
  return normalized === ethers.ZeroAddress.toLowerCase() ? WETH : normalized;
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
