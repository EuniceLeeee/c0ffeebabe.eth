import { PoolStateCache } from "../solver/pool-state-cache.js";
import { applyVictimSwapLocally } from "../solver/victim-apply.js";
import { v3SwapExactInput, v3SwapToState, type V3PoolState } from "../solver/v3-math.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolImpact } from "../detector/pool-impact.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const BLOCK = 123;

const noState = {
  async call(): Promise<string> {
    throw new Error("state.call should not be used");
  },
} as unknown as StateBackend;

async function testV2VictimApply(): Promise<void> {
  const cache = new PoolStateCache();
  cache.seedV2({
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    reserve0: 2_000_000n,
    reserve1: 1_000_000n,
    blockNumber: BLOCK,
  });

  const victimAmount = 10_000n;
  const expectedVictimOut = quoteV2(2_000_000n, 1_000_000n, victimAmount);
  const impact: PoolImpact = {
    pool: POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: victimAmount,
    matchedAdapterId: "univ2-swap",
  };

  const applied = applyVictimSwapLocally(cache, impact, BLOCK);
  if (!applied) throw new Error("FAIL: v2 victim apply should succeed");
  assert(applied.amountOut === expectedVictimOut, `v2 victim out ${applied.amountOut} != ${expectedVictimOut}`);

  cache.beginHint(BLOCK, { postImpact: [applied.postImpact] });
  const followAmount = 20_000n;
  const expectedFollowOut = quoteV2(
    2_000_000n + victimAmount,
    1_000_000n - expectedVictimOut,
    followAmount,
  );
  const followOut = await cache.quoteV2(noState, POOL, TOKEN0, TOKEN1, followAmount);
  assert(followOut === expectedFollowOut, `v2 post-state quote ${followOut} != ${expectedFollowOut}`);
  console.log("[victim-apply] v2 post-impact cache: PASS");
}

async function testV3VictimApply(): Promise<void> {
  const cache = new PoolStateCache();
  const preState: V3PoolState = {
    sqrtPriceX96: 1n << 96n,
    tick: 0,
    liquidity: 10n ** 18n,
    fee: 500n,
    tickSpacing: 1,
    tickBitmap: new Map([[0, 0n], [-1, 0n]]),
    ticks: new Map(),
  };
  cache.seedV3Ticks({
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: preState.fee,
    tickSpacing: preState.tickSpacing,
    tickBitmap: preState.tickBitmap,
    ticks: preState.ticks,
    blockNumber: BLOCK,
  });
  cache.seedV3Live({
    pool: POOL,
    sqrtPriceX96: preState.sqrtPriceX96,
    tick: preState.tick,
    liquidity: preState.liquidity,
    blockNumber: BLOCK,
  });

  const victimAmount = 1_000_000_000_000n;
  const expected = v3SwapToState(preState, true, victimAmount);
  const impact: PoolImpact = {
    pool: POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: victimAmount,
    matchedAdapterId: "univ3-swap",
  };

  const applied = applyVictimSwapLocally(cache, impact, BLOCK);
  if (!applied) throw new Error("FAIL: v3 victim apply should succeed");
  assert(applied.amountOut === expected.amountOut, `v3 victim out ${applied.amountOut} != ${expected.amountOut}`);

  cache.beginHint(BLOCK, { postImpact: [applied.postImpact] });
  const followAmount = 2_000_000_000_000n;
  const expectedFollowOut = v3SwapExactInput(expected.state, true, followAmount);
  const followOut = await cache.quoteV3(noState, POOL, TOKEN0, TOKEN1, followAmount);
  assert(followOut === expectedFollowOut, `v3 post-state quote ${followOut} != ${expectedFollowOut}`);
  console.log("[victim-apply] v3 post-impact cache: PASS");
}

function quoteV2(reserveIn: bigint, reserveOut: bigint, amountIn: bigint): bigint {
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

async function main(): Promise<void> {
  await testV2VictimApply();
  await testV3VictimApply();
  console.log("victim-apply PASS (2/2)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
