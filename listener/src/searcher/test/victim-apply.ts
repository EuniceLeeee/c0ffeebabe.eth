import { PoolStateCache } from "../solver/pool-state-cache.js";
import { applyVictimSwapLocally } from "../solver/victim-apply.js";
import { curvePlainGetDy } from "../solver/curve-math.js";
import { v3SwapExactInput, v3SwapToState, type V3PoolState } from "../solver/v3-math.js";
import { quoteV2ExactInput, v2FeeBpsForFactory } from "../solver/v2-fee.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { PoolImpact } from "../detector/pool-impact.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const BLOCK = 123;
const UNIV2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const SUSHI_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const PANCAKE_V2_FACTORY = "0x1097053fd2ea711dad45caccc45eff7548fcb362";

const noState = {
  async call(): Promise<string> {
    throw new Error("state.call should not be used");
  },
} as unknown as StateBackend;

function testV2FeeMath(): void {
  const reserveIn = 2_000_000n;
  const reserveOut = 1_000_000n;
  const amountIn = 10_000n;
  const old997Over1000Expected = 4960n;

  const out30 = quoteV2ExactInput(reserveIn, reserveOut, amountIn, 30n);
  assert(
    out30 === old997Over1000Expected,
    `v2 30bps regression ${out30} != ${old997Over1000Expected}`,
  );
  console.log("[victim-apply] v2 30bps regression: PASS");

  const out25 = quoteV2ExactInput(reserveIn, reserveOut, amountIn, 25n);
  assert(out25 > out30, `v2 25bps output ${out25} should exceed 30bps ${out30}`);
  console.log("[victim-apply] v2 25bps higher output: PASS");
}

function testV2FeeTable(): void {
  assert(v2FeeBpsForFactory(UNIV2_FACTORY) === 30n, "UniV2 fee bps should be 30");
  assert(v2FeeBpsForFactory(SUSHI_FACTORY) === 30n, "SushiV2 fee bps should be 30");
  assert(v2FeeBpsForFactory(PANCAKE_V2_FACTORY) === 25n, "PancakeV2 fee bps should be 25");
  assert(v2FeeBpsForFactory("0x000000000000000000000000000000000000dEaD") === 30n, "unknown factory default");
  assert(v2FeeBpsForFactory(undefined) === 30n, "undefined factory default");
  console.log("[victim-apply] v2 fee table: PASS");
}

async function testV2VictimApply(): Promise<void> {
  const cache = new PoolStateCache();
  cache.seedV2({
    pool: POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    reserve0: 2_000_000n,
    reserve1: 1_000_000n,
    feeBps: 25n,
    blockNumber: BLOCK,
  });

  const victimAmount = 10_000n;
  const expectedVictimOut = quoteV2ExactInput(2_000_000n, 1_000_000n, victimAmount, 25n);
  const impact: PoolImpact = {
    pool: POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: victimAmount,
    matchedAdapterId: "univ2-swap",
  };

  const applied = await applyVictimSwapLocally(cache, impact, BLOCK);
  if (!applied) throw new Error("FAIL: v2 victim apply should succeed");
  assert(applied.amountOut === expectedVictimOut, `v2 victim out ${applied.amountOut} != ${expectedVictimOut}`);
  if (applied.postImpact.kind !== "v2") throw new Error("FAIL: v2 apply should return v2 post-impact seed");
  assert(applied.postImpact.feeBps === 25n, `v2 post-impact feeBps ${applied.postImpact.feeBps} != 25`);

  cache.beginHint(BLOCK, { postImpact: [applied.postImpact] });
  const followAmount = 20_000n;
  const expectedFollowOut = quoteV2ExactInput(
    2_000_000n + victimAmount,
    1_000_000n - expectedVictimOut,
    followAmount,
    25n,
  );
  const followOut = await cache.quoteV2(noState, POOL, TOKEN0, TOKEN1, followAmount);
  assert(followOut === expectedFollowOut, `v2 post-state quote ${followOut} != ${expectedFollowOut}`);
  console.log("[victim-apply] v2 fee threading + post-impact cache: PASS");
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

  const applied = await applyVictimSwapLocally(cache, impact, BLOCK);
  if (!applied) throw new Error("FAIL: v3 victim apply should succeed");
  assert(applied.amountOut === expected.amountOut, `v3 victim out ${applied.amountOut} != ${expected.amountOut}`);

  cache.beginHint(BLOCK, { postImpact: [applied.postImpact] });
  const followAmount = 2_000_000_000_000n;
  const expectedFollowOut = v3SwapExactInput(expected.state, true, followAmount);
  const followOut = await cache.quoteV3(noState, POOL, TOKEN0, TOKEN1, followAmount);
  assert(followOut === expectedFollowOut, `v3 post-state quote ${followOut} != ${expectedFollowOut}`);
  console.log("[victim-apply] v3 post-impact cache: PASS");
}

async function testCurveVictimApply(): Promise<void> {
  const cache = new PoolStateCache();
  const plain = {
    A: 4000n,
    fee: 1_000_000n,
    balances: [2_000_000n * 10n ** 18n, 2_000_000n * 10n ** 18n],
    rates: [10n ** 18n, 10n ** 18n],
  };
  cache.seedCurve({
    kind: "curve",
    pool: POOL,
    curveKind: "plain",
    coins: [TOKEN0, TOKEN1],
    plain,
    blockNumber: BLOCK,
  });

  const victimAmount = 10_000n * 10n ** 18n;
  const expectedVictimOut = curvePlainGetDy(plain, 0, 1, victimAmount);
  const impact: PoolImpact = {
    pool: POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: victimAmount,
    matchedAdapterId: "curve-exchange-plain",
  };

  const applied = await applyVictimSwapLocally(cache, impact, BLOCK);
  if (!applied) throw new Error("FAIL: curve victim apply should succeed");
  assert(
    applied.amountOut === expectedVictimOut,
    `curve victim out ${applied.amountOut} != ${expectedVictimOut}`,
  );

  cache.beginHint(BLOCK, { postImpact: [applied.postImpact] });
  const followAmount = 5_000n * 10n ** 18n;
  const postPlain = {
    ...plain,
    balances: [
      plain.balances[0] + victimAmount,
      plain.balances[1] - expectedVictimOut,
    ],
  };
  const expectedFollowOut = curvePlainGetDy(postPlain, 0, 1, followAmount);
  const followOut = await cache.quoteCurve(noState, POOL, TOKEN0, TOKEN1, followAmount);
  assert(followOut === expectedFollowOut, `curve post-state quote ${followOut} != ${expectedFollowOut}`);
  console.log("[victim-apply] curve post-impact cache: PASS");
}

async function main(): Promise<void> {
  testV2FeeMath();
  testV2FeeTable();
  await testV2VictimApply();
  await testV3VictimApply();
  await testCurveVictimApply();
  console.log("victim-apply PASS (6/6)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
