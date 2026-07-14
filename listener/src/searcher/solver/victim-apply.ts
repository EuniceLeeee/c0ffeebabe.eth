import type { PoolImpact } from "../detector/pool-impact.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  type PoolStateCache,
  type CurvePostImpactSeed,
  type PostImpactSeed,
  type V2PostImpactSeed,
  type V3PostImpactSeed,
} from "./pool-state-cache.js";
import { curveNgGetDy, curvePlainGetDy } from "./curve-math.js";
import { v3SwapToState } from "./v3-math.js";
import { quoteV2ExactInput } from "./v2-fee.js";

export interface LocalVictimApplyResult {
  postImpact: PostImpactSeed;
  amountOut: bigint;
}

export async function applyVictimSwapLocally(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
  state?: StateBackend,
): Promise<LocalVictimApplyResult | null> {
  switch (impact.matchedAdapterId) {
    case "univ2-swap":
      return applyV2(cache, impact, blockNumber);
    case "univ3-swap":
      return applyV3(cache, impact, blockNumber);
    case "curve-exchange":
    case "curve-exchange-nr":
    case "curve-exchange-plain":
    case "curve-exchange-received-uint":
      return applyCurve(cache, impact, blockNumber, state);
    default:
      return null;
  }
}

function applyV2(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
): LocalVictimApplyResult | null {
  const pre = cache.snapshotV2(impact.pool, blockNumber);
  if (!pre) return null;

  const tokenIn = impact.tokenIn.toLowerCase();
  const tokenOut = impact.tokenOut.toLowerCase();
  const zeroForOne = tokenIn === pre.token0 && tokenOut === pre.token1;
  const oneForZero = tokenIn === pre.token1 && tokenOut === pre.token0;
  if (!zeroForOne && !oneForZero) return null;

  const [reserveIn, reserveOut] = zeroForOne
    ? [pre.reserve0, pre.reserve1]
    : [pre.reserve1, pre.reserve0];
  const amountOut = quoteV2ExactInput(reserveIn, reserveOut, impact.amountIn, pre.feeBps);
  if (amountOut <= 0n || amountOut >= reserveOut) return null;

  const post: V2PostImpactSeed = {
    kind: "v2",
    pool: impact.pool,
    token0: pre.token0,
    token1: pre.token1,
    reserve0: zeroForOne ? pre.reserve0 + impact.amountIn : pre.reserve0 - amountOut,
    reserve1: zeroForOne ? pre.reserve1 - amountOut : pre.reserve1 + impact.amountIn,
    feeBps: pre.feeBps,
    blockTimestampLast: pre.blockTimestampLast,
    blockNumber,
  };
  return { postImpact: post, amountOut };
}

function applyV3(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
): LocalVictimApplyResult | null {
  const pre = cache.snapshotV3(impact.pool, blockNumber);
  if (!pre) return null;

  const tokenIn = impact.tokenIn.toLowerCase();
  const tokenOut = impact.tokenOut.toLowerCase();
  const zeroForOne = tokenIn === pre.token0 && tokenOut === pre.token1;
  const oneForZero = tokenIn === pre.token1 && tokenOut === pre.token0;
  if (!zeroForOne && !oneForZero) return null;

  const result = v3SwapToState(pre.state, zeroForOne, impact.amountIn);
  if (result.amountOut <= 0n) return null;

  const post: V3PostImpactSeed = {
    kind: "v3",
    pool: impact.pool,
    sqrtPriceX96: result.state.sqrtPriceX96,
    tick: result.state.tick,
    liquidity: result.state.liquidity,
    observationIndex: result.state.observationIndex,
    observationCardinality: result.state.observationCardinality,
    observationCardinalityNext: result.state.observationCardinalityNext,
    feeProtocol: result.state.feeProtocol,
    unlocked: result.state.unlocked,
    blockNumber,
  };
  return { postImpact: post, amountOut: result.amountOut };
}

async function applyCurve(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
  state?: StateBackend,
): Promise<LocalVictimApplyResult | null> {
  let pre = cache.snapshotCurve(impact.pool, blockNumber);
  if (!pre && state) {
    try {
      await cache.quoteCurve(state, impact.pool, impact.tokenIn, impact.tokenOut, impact.amountIn);
      pre = cache.snapshotCurve(impact.pool, blockNumber);
    } catch {
      return null;
    }
  }
  if (!pre) return null;

  const i = pre.coins.indexOf(impact.tokenIn.toLowerCase());
  const j = pre.coins.indexOf(impact.tokenOut.toLowerCase());
  if (i < 0 || j < 0) return null;

  const amountOut = pre.kind === "plain"
    ? curvePlainGetDy(pre.plain!, i, j, impact.amountIn)
    : curveNgGetDy(pre.ng!, i, j, impact.amountIn);
  if (amountOut <= 0n) return null;

  const post: CurvePostImpactSeed = {
    kind: "curve",
    pool: impact.pool,
    curveKind: pre.kind,
    coins: [...pre.coins],
    blockNumber,
  };
  if (pre.kind === "plain") {
    const plain = {
      A: pre.plain!.A,
      fee: pre.plain!.fee,
      balances: [...pre.plain!.balances],
      rates: [...pre.plain!.rates],
    };
    if (amountOut >= plain.balances[j]) return null;
    plain.balances[i] += impact.amountIn;
    plain.balances[j] -= amountOut;
    post.plain = plain;
  } else {
    const ng = {
      A: pre.ng!.A,
      fee: pre.ng!.fee,
      offpegFeeMultiplier: pre.ng!.offpegFeeMultiplier,
      balances: [...pre.ng!.balances],
      rates: [...pre.ng!.rates],
    };
    if (amountOut >= ng.balances[j]) return null;
    ng.balances[i] += impact.amountIn;
    ng.balances[j] -= amountOut;
    post.ng = ng;
  }
  return { postImpact: post, amountOut };
}
