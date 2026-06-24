import type { PoolImpact } from "../detector/pool-impact.js";
import {
  type PoolStateCache,
  type PostImpactSeed,
  type V2PostImpactSeed,
  type V3PostImpactSeed,
} from "./pool-state-cache.js";
import { v3SwapToState } from "./v3-math.js";

export interface LocalVictimApplyResult {
  postImpact: PostImpactSeed;
  amountOut: bigint;
}

export function applyVictimSwapLocally(
  cache: PoolStateCache,
  impact: PoolImpact,
  blockNumber: number,
): LocalVictimApplyResult | null {
  switch (impact.matchedAdapterId) {
    case "univ2-swap":
      return applyV2(cache, impact, blockNumber);
    case "univ3-swap":
      return applyV3(cache, impact, blockNumber);
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
  const amountOut = quoteV2ExactInput(reserveIn, reserveOut, impact.amountIn);
  if (amountOut <= 0n || amountOut >= reserveOut) return null;

  const post: V2PostImpactSeed = {
    kind: "v2",
    pool: impact.pool,
    token0: pre.token0,
    token1: pre.token1,
    reserve0: zeroForOne ? pre.reserve0 + impact.amountIn : pre.reserve0 - amountOut,
    reserve1: zeroForOne ? pre.reserve1 - amountOut : pre.reserve1 + impact.amountIn,
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
    blockNumber,
  };
  return { postImpact: post, amountOut: result.amountOut };
}

function quoteV2ExactInput(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}
