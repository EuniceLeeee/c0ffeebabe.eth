import { ethers } from "ethers";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import { type TokenEdge } from "../planner/token-graph.js";
import {
  packUniv3Slot0,
  postImpactStateOverrides,
} from "../solver/post-impact-overrides.js";
import type { V3PostImpactSeed } from "../solver/pool-state-cache.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const SENDER = "0x0000000000000000000000000000000000000aaa";
const RECIPIENT = "0x0000000000000000000000000000000000000bbb";
const BLOCK = 25_449_741;

const EVENT_SQRT_PRICE_X96 = (1n << 96n) + 987_654_321n;
const EVENT_LIQUIDITY = (1n << 80n) + 123_456n;
const EVENT_TICK = -12_345;

const SYNTHETIC_SQRT_PRICE_X96 = EVENT_SQRT_PRICE_X96 + 42n;
const SYNTHETIC_TICK = EVENT_TICK + 7;

const SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);

const GRAPH: TokenEdge[] = [{
  adapterId: "univ3-swap",
  target: POOL,
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  slotKind: "swap",
  poolToken0: TOKEN0,
  poolToken1: TOKEN1,
}];

function swapLog() {
  const fragment = SWAP_IFACE.getEvent("Swap");
  assert(fragment !== null, "Swap event fragment missing");
  const encoded = SWAP_IFACE.encodeEventLog(fragment, [
    SENDER,
    RECIPIENT,
    1_000_000n,
    -997_000n,
    EVENT_SQRT_PRICE_X96,
    EVENT_LIQUIDITY,
    EVENT_TICK,
  ]);
  return {
    address: POOL,
    topics: [...encoded.topics],
    data: encoded.data,
  };
}

function seedFromEvent(
  pool: string,
  v3PostState: { sqrtPriceX96: bigint; liquidity: bigint; tick: number },
): V3PostImpactSeed {
  return {
    kind: "v3",
    pool,
    sqrtPriceX96: v3PostState.sqrtPriceX96,
    liquidity: v3PostState.liquidity,
    tick: v3PostState.tick,
    blockNumber: BLOCK,
  };
}

function syntheticFallbackSeed(pool: string): V3PostImpactSeed {
  return {
    kind: "v3",
    pool,
    sqrtPriceX96: SYNTHETIC_SQRT_PRICE_X96,
    liquidity: EVENT_LIQUIDITY,
    tick: SYNTHETIC_TICK,
    blockNumber: BLOCK,
  };
}

function decodeSlot0(word: bigint): { sqrtPriceX96: bigint; tick: number } {
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  const rawTick = (word >> 160n) & ((1n << 24n) - 1n);
  return {
    sqrtPriceX96,
    tick: Number(BigInt.asIntN(24, rawTick)),
  };
}

async function main(): Promise<void> {
  const impacts = await detectImpactFromLogs([swapLog()], GRAPH);
  assert(impacts.length === 1, `expected 1 impact, got ${impacts.length}`);
  const impact = impacts[0];
  assert(impact.matchedAdapterId === "univ3-swap", `adapter ${impact.matchedAdapterId}`);
  assert(impact.tokenIn.toLowerCase() === TOKEN0.toLowerCase(), `tokenIn ${impact.tokenIn}`);
  assert(impact.tokenOut.toLowerCase() === TOKEN1.toLowerCase(), `tokenOut ${impact.tokenOut}`);
  assert(impact.amountIn === 1_000_000n, `amountIn ${impact.amountIn}`);
  assert(impact.v3PostState !== undefined, "impact.v3PostState missing");
  assert(impact.v3PostState.sqrtPriceX96 === EVENT_SQRT_PRICE_X96, "sqrtPriceX96 not captured exactly");
  assert(impact.v3PostState.liquidity === EVENT_LIQUIDITY, "liquidity not captured exactly");
  assert(impact.v3PostState.tick === EVENT_TICK, "tick not captured exactly");
  console.log("[overlay-fidelity] UniV3 Swap post-state capture: PASS");

  const exactSeed = seedFromEvent(impact.pool, impact.v3PostState);
  const packed = packUniv3Slot0(exactSeed);
  const decoded = decodeSlot0(packed);
  assert(decoded.sqrtPriceX96 === EVENT_SQRT_PRICE_X96, "packUniv3Slot0 sqrtPriceX96 mismatch");
  assert(decoded.tick === EVENT_TICK, "packUniv3Slot0 tick mismatch");

  const overrides = await postImpactStateOverrides(exactSeed);
  assert(overrides.length === 2, `expected 2 v3 overrides, got ${overrides.length}`);
  const slot0 = overrides.find((o) => BigInt(o.slot) === 0n);
  const liquidity = overrides.find((o) => BigInt(o.slot) === 4n);
  assert(slot0 !== undefined, "slot0 override missing");
  assert(liquidity !== undefined, "liquidity override missing");
  const overrideDecoded = decodeSlot0(BigInt(slot0.value));
  assert(overrideDecoded.sqrtPriceX96 === EVENT_SQRT_PRICE_X96, "override sqrtPriceX96 mismatch");
  assert(overrideDecoded.tick === EVENT_TICK, "override tick mismatch");
  assert(BigInt(liquidity.value) === EVENT_LIQUIDITY, "liquidity override mismatch");
  console.log("[overlay-fidelity] exact-from-event slot0 override: PASS");

  const fallbackOverrides = await postImpactStateOverrides(syntheticFallbackSeed(impact.pool));
  const fallbackSlot0 = fallbackOverrides.find((o) => BigInt(o.slot) === 0n);
  assert(fallbackSlot0 !== undefined, "fallback slot0 override missing");
  const fallbackDecoded = decodeSlot0(BigInt(fallbackSlot0.value));
  assert(
    fallbackDecoded.sqrtPriceX96 !== EVENT_SQRT_PRICE_X96 || fallbackDecoded.tick !== EVENT_TICK,
    "baseline_failure: synthetic fallback unexpectedly matched event post-state",
  );
  console.log("[overlay-fidelity] baseline_failure synthetic fallback != event exact: PASS");

  console.log(
    "expected_transition: hash-only overlay slot0: simulated → exact-from-event " +
      "(sqrtPriceX96/tick match Swap event bit-for-bit)",
  );
  console.log("mevshare-overlay-fidelity PASS (3/3)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
