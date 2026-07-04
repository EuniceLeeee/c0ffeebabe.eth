import { ethers } from "ethers";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import { type TokenEdge, type TokenQueryBackend, type V4PoolKey, v4PoolId } from "../planner/token-graph.js";
import {
  packUniv2ReservesSlot,
  packUniv3Slot0,
  packUniv4Slot0,
  postImpactStateOverrides,
  univ4PoolStateBaseSlot,
} from "../solver/post-impact-overrides.js";
import type { V2PostImpactSeed, V3PostImpactSeed, V4PostImpactSeed } from "../solver/pool-state-cache.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const V2_POOL = "0x0000000000000000000000000000000000000c02";
const V3_POOL = "0x0000000000000000000000000000000000000c03";
const V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const SENDER = "0x0000000000000000000000000000000000000aaa";
const RECIPIENT = "0x0000000000000000000000000000000000000bbb";
const BLOCK = 25_449_741;

const V2_EVENT_RESERVE0 = 10_000_111n;
const V2_EVENT_RESERVE1 = 20_000_222n;
const V2_SYNTHETIC_RESERVE0 = V2_EVENT_RESERVE0 + 7n;
const V2_SYNTHETIC_RESERVE1 = V2_EVENT_RESERVE1 - 11n;

const V3_EVENT_SQRT_PRICE_X96 = (1n << 96n) + 987_654_321n;
const V3_EVENT_LIQUIDITY = (1n << 80n) + 123_456n;
const V3_EVENT_TICK = -12_345;
const V3_SYNTHETIC_SQRT_PRICE_X96 = V3_EVENT_SQRT_PRICE_X96 + 42n;
const V3_SYNTHETIC_TICK = V3_EVENT_TICK + 7;

const V4_EVENT_SQRT_PRICE_X96 = (1n << 96n) + 333_222_111n;
const V4_EVENT_LIQUIDITY = (1n << 72n) + 99_001n;
const V4_EVENT_TICK = 22_222;
const V4_EVENT_LP_FEE = 3_000;
const V4_SYNTHETIC_SQRT_PRICE_X96 = V4_EVENT_SQRT_PRICE_X96 + 5n;
const V4_SYNTHETIC_TICK = V4_EVENT_TICK - 13;

const V2_IFACE = new ethers.Interface([
  "event Sync(uint112 reserve0,uint112 reserve1)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const V3_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const V4_SWAP_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
]);

const V4_KEY: V4PoolKey = {
  currency0: TOKEN0,
  currency1: TOKEN1,
  fee: V4_EVENT_LP_FEE,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress,
};
const V4_POOL_ID = v4PoolId(V4_KEY);

const V2_GRAPH: TokenEdge[] = [
  {
    adapterId: "univ2-swap",
    target: V2_POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    slotKind: "swap",
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  },
  {
    adapterId: "univ2-swap",
    target: V2_POOL,
    tokenIn: TOKEN1,
    tokenOut: TOKEN0,
    slotKind: "swap",
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  },
];

const V3_GRAPH: TokenEdge[] = [{
  adapterId: "univ3-swap",
  target: V3_POOL,
  tokenIn: TOKEN0,
  tokenOut: TOKEN1,
  slotKind: "swap",
  poolToken0: TOKEN0,
  poolToken1: TOKEN1,
}];

const V4_GRAPH: TokenEdge[] = [
  {
    adapterId: "univ4-unlock",
    target: V4_POOL_MANAGER,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    slotKind: "swap",
    v4PoolKey: V4_KEY,
    poolId: V4_POOL_ID,
  },
  {
    adapterId: "univ4-unlock",
    target: V4_POOL_MANAGER,
    tokenIn: TOKEN1,
    tokenOut: TOKEN0,
    slotKind: "swap",
    v4PoolKey: V4_KEY,
    poolId: V4_POOL_ID,
  },
];

function encodedLog(iface: ethers.Interface, eventName: string, address: string, args: unknown[]) {
  const fragment = iface.getEvent(eventName);
  assert(fragment !== null, `${eventName} event fragment missing`);
  const encoded = iface.encodeEventLog(fragment, args);
  return {
    address,
    topics: [...encoded.topics],
    data: encoded.data,
  };
}

function v2SyncLog() {
  return encodedLog(V2_IFACE, "Sync", V2_POOL, [V2_EVENT_RESERVE0, V2_EVENT_RESERVE1]);
}

function v2SwapLog() {
  return encodedLog(V2_IFACE, "Swap", V2_POOL, [SENDER, 1_000n, 0n, 0n, 900n, RECIPIENT]);
}

function v3SwapLog() {
  return encodedLog(V3_SWAP_IFACE, "Swap", V3_POOL, [
    SENDER,
    RECIPIENT,
    1_000_000n,
    -997_000n,
    V3_EVENT_SQRT_PRICE_X96,
    V3_EVENT_LIQUIDITY,
    V3_EVENT_TICK,
  ]);
}

function v4SwapLog() {
  return encodedLog(V4_SWAP_IFACE, "Swap", V4_POOL_MANAGER, [
    V4_POOL_ID,
    SENDER,
    1_000_000n,
    -998_000n,
    V4_EVENT_SQRT_PRICE_X96,
    V4_EVENT_LIQUIDITY,
    V4_EVENT_TICK,
    V4_EVENT_LP_FEE,
  ]);
}

function v2SeedFromEvent(reserve0: bigint, reserve1: bigint): V2PostImpactSeed {
  return {
    kind: "v2",
    pool: V2_POOL,
    token0: TOKEN0,
    token1: TOKEN1,
    reserve0,
    reserve1,
    blockNumber: BLOCK,
  };
}

function v3SeedFromEvent(
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

function v4SeedFromEvent(
  poolManager: string,
  v4PostState: { sqrtPriceX96: bigint; liquidity: bigint; tick: number; poolId: string; lpFee?: number },
): V4PostImpactSeed {
  return {
    kind: "v4",
    poolManager,
    poolId: v4PostState.poolId,
    sqrtPriceX96: v4PostState.sqrtPriceX96,
    liquidity: v4PostState.liquidity,
    tick: v4PostState.tick,
    lpFee: v4PostState.lpFee,
    blockNumber: BLOCK,
  };
}

function syntheticV2Seed(): V2PostImpactSeed {
  return v2SeedFromEvent(V2_SYNTHETIC_RESERVE0, V2_SYNTHETIC_RESERVE1);
}

function syntheticV3Seed(pool: string): V3PostImpactSeed {
  return {
    kind: "v3",
    pool,
    sqrtPriceX96: V3_SYNTHETIC_SQRT_PRICE_X96,
    liquidity: V3_EVENT_LIQUIDITY,
    tick: V3_SYNTHETIC_TICK,
    blockNumber: BLOCK,
  };
}

function syntheticV4Seed(poolManager: string): V4PostImpactSeed {
  return {
    kind: "v4",
    poolManager,
    poolId: V4_POOL_ID,
    sqrtPriceX96: V4_SYNTHETIC_SQRT_PRICE_X96,
    liquidity: V4_EVENT_LIQUIDITY,
    tick: V4_SYNTHETIC_TICK,
    lpFee: V4_EVENT_LP_FEE,
    blockNumber: BLOCK,
  };
}

function decodeV3Slot0(word: bigint): { sqrtPriceX96: bigint; tick: number } {
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  const rawTick = (word >> 160n) & ((1n << 24n) - 1n);
  return {
    sqrtPriceX96,
    tick: Number(BigInt.asIntN(24, rawTick)),
  };
}

function decodeV4Slot0(word: bigint): { sqrtPriceX96: bigint; tick: number; protocolFee: bigint; lpFee: bigint } {
  const sqrtPriceX96 = word & ((1n << 160n) - 1n);
  const rawTick = (word >> 160n) & ((1n << 24n) - 1n);
  return {
    sqrtPriceX96,
    tick: Number(BigInt.asIntN(24, rawTick)),
    protocolFee: (word >> 184n) & ((1n << 24n) - 1n),
    lpFee: (word >> 208n) & ((1n << 24n) - 1n),
  };
}

async function assertV2(): Promise<void> {
  const impacts = await detectImpactFromLogs([v2SyncLog(), v2SwapLog()], V2_GRAPH);
  assert(impacts.length === 1, `v2 expected 1 impact, got ${impacts.length}`);
  const impact = impacts[0];
  assert(impact.matchedAdapterId === "univ2-swap", `v2 adapter ${impact.matchedAdapterId}`);
  assert(impact.v2PostState !== undefined, "impact.v2PostState missing");
  assert(impact.v2PostState.reserve0 === V2_EVENT_RESERVE0, "v2 reserve0 not captured exactly");
  assert(impact.v2PostState.reserve1 === V2_EVENT_RESERVE1, "v2 reserve1 not captured exactly");
  console.log("[overlay-fidelity] UniV2 Sync post-reserve capture: PASS");

  const preReserve0 = 9_000_000n;
  const preReserve1 = 8_000_000n;
  const tokenQuery: TokenQueryBackend = {
    call: async ({ data }) => {
      if (data === V2_IFACE.encodeFunctionData("getReserves")) {
        return V2_IFACE.encodeFunctionResult("getReserves", [preReserve0, preReserve1, 123]);
      }
      if (data === V2_IFACE.encodeFunctionData("token0")) {
        return V2_IFACE.encodeFunctionResult("token0", [TOKEN0]);
      }
      if (data === V2_IFACE.encodeFunctionData("token1")) {
        return V2_IFACE.encodeFunctionResult("token1", [TOKEN1]);
      }
      throw new Error(`unexpected tokenQuery data ${data}`);
    },
  };
  const fallbackImpacts = await detectImpactFromLogs([v2SwapLog()], V2_GRAPH, undefined, tokenQuery);
  assert(fallbackImpacts[0].v2PostState?.reserve0 === preReserve0 + 1_000n, "v2 reserve0 fallback mismatch");
  assert(fallbackImpacts[0].v2PostState?.reserve1 === preReserve1 - 900n, "v2 reserve1 fallback mismatch");
  console.log("[overlay-fidelity] UniV2 no-Sync fallback from pre-reserves: PASS");

  const exactSeed = v2SeedFromEvent(impact.v2PostState.reserve0, impact.v2PostState.reserve1);
  const packed = packUniv2ReservesSlot(exactSeed);
  assert((packed & ((1n << 112n) - 1n)) === V2_EVENT_RESERVE0, "packUniv2 reserve0 mismatch");
  assert(((packed >> 112n) & ((1n << 112n) - 1n)) === V2_EVENT_RESERVE1, "packUniv2 reserve1 mismatch");

  const overrides = await postImpactStateOverrides(exactSeed, async (token) =>
    token.toLowerCase() === TOKEN0.toLowerCase() ? 0 : token.toLowerCase() === TOKEN1.toLowerCase() ? 9 : null);
  assert(overrides.length === 3, `expected 3 v2 overrides, got ${overrides.length}`);
  const reserveOverride = overrides.find((o) => BigInt(o.slot) === 8n);
  assert(reserveOverride !== undefined, "v2 reserves slot override missing");
  assert(BigInt(reserveOverride.value) === packed, "v2 reserves override mismatch");
  console.log("[overlay-fidelity] UniV2 exact-from-event reserve override: PASS");

  assert(
    packUniv2ReservesSlot(syntheticV2Seed()) !== packed,
    "baseline_failure: synthetic v2 fallback unexpectedly matched event post-reserves",
  );
  console.log("[overlay-fidelity] UniV2 baseline_failure synthetic fallback != event exact: PASS");
  console.log("expected_transition: hash-only v2 overlay: simulated → exact-from-event");
}

async function assertV3(): Promise<void> {
  const impacts = await detectImpactFromLogs([v3SwapLog()], V3_GRAPH);
  assert(impacts.length === 1, `v3 expected 1 impact, got ${impacts.length}`);
  const impact = impacts[0];
  assert(impact.matchedAdapterId === "univ3-swap", `v3 adapter ${impact.matchedAdapterId}`);
  assert(impact.v3PostState !== undefined, "impact.v3PostState missing");
  assert(impact.v3PostState.sqrtPriceX96 === V3_EVENT_SQRT_PRICE_X96, "v3 sqrtPriceX96 not captured exactly");
  assert(impact.v3PostState.liquidity === V3_EVENT_LIQUIDITY, "v3 liquidity not captured exactly");
  assert(impact.v3PostState.tick === V3_EVENT_TICK, "v3 tick not captured exactly");
  console.log("[overlay-fidelity] UniV3 Swap post-state capture: PASS");

  const exactSeed = v3SeedFromEvent(impact.pool, impact.v3PostState);
  const packed = packUniv3Slot0(exactSeed);
  const decoded = decodeV3Slot0(packed);
  assert(decoded.sqrtPriceX96 === V3_EVENT_SQRT_PRICE_X96, "packUniv3Slot0 sqrtPriceX96 mismatch");
  assert(decoded.tick === V3_EVENT_TICK, "packUniv3Slot0 tick mismatch");

  const overrides = await postImpactStateOverrides(exactSeed);
  assert(overrides.length === 2, `expected 2 v3 overrides, got ${overrides.length}`);
  const slot0 = overrides.find((o) => BigInt(o.slot) === 0n);
  const liquidity = overrides.find((o) => BigInt(o.slot) === 4n);
  assert(slot0 !== undefined, "v3 slot0 override missing");
  assert(liquidity !== undefined, "v3 liquidity override missing");
  const overrideDecoded = decodeV3Slot0(BigInt(slot0.value));
  assert(overrideDecoded.sqrtPriceX96 === V3_EVENT_SQRT_PRICE_X96, "v3 override sqrtPriceX96 mismatch");
  assert(overrideDecoded.tick === V3_EVENT_TICK, "v3 override tick mismatch");
  assert(BigInt(liquidity.value) === V3_EVENT_LIQUIDITY, "v3 liquidity override mismatch");
  console.log("[overlay-fidelity] UniV3 exact-from-event slot0 override: PASS");

  const fallbackSlot0 = (await postImpactStateOverrides(syntheticV3Seed(impact.pool))).find((o) => BigInt(o.slot) === 0n);
  assert(fallbackSlot0 !== undefined, "v3 fallback slot0 override missing");
  const fallbackDecoded = decodeV3Slot0(BigInt(fallbackSlot0.value));
  assert(
    fallbackDecoded.sqrtPriceX96 !== V3_EVENT_SQRT_PRICE_X96 || fallbackDecoded.tick !== V3_EVENT_TICK,
    "baseline_failure: synthetic v3 fallback unexpectedly matched event post-state",
  );
  console.log("[overlay-fidelity] UniV3 baseline_failure synthetic fallback != event exact: PASS");
  console.log("expected_transition: hash-only v3 overlay: simulated → exact-from-event");
}

async function assertV4(): Promise<void> {
  const impacts = await detectImpactFromLogs([v4SwapLog()], V4_GRAPH);
  assert(impacts.length === 1, `v4 expected 1 impact, got ${impacts.length}`);
  const impact = impacts[0];
  assert(impact.matchedAdapterId === "univ4-unlock", `v4 adapter ${impact.matchedAdapterId}`);
  assert(impact.poolId === V4_POOL_ID, "impact poolId mismatch");
  assert(impact.v4PostState !== undefined, "impact.v4PostState missing");
  assert(impact.v4PostState.poolId === V4_POOL_ID, "v4 post-state poolId mismatch");
  assert(impact.v4PostState.sqrtPriceX96 === V4_EVENT_SQRT_PRICE_X96, "v4 sqrtPriceX96 not captured exactly");
  assert(impact.v4PostState.liquidity === V4_EVENT_LIQUIDITY, "v4 liquidity not captured exactly");
  assert(impact.v4PostState.tick === V4_EVENT_TICK, "v4 tick not captured exactly");
  console.log("[overlay-fidelity] UniV4 Swap post-state capture: PASS");

  const exactSeed = v4SeedFromEvent(impact.pool, impact.v4PostState);
  const preserved = packUniv4Slot0(exactSeed, (77n << 184n) | (88n << 208n));
  const preservedDecoded = decodeV4Slot0(preserved);
  assert(preservedDecoded.protocolFee === 77n, "v4 packer failed to preserve protocolFee");
  assert(preservedDecoded.lpFee === 88n, "v4 packer failed to preserve lpFee");

  const overrides = await postImpactStateOverrides(exactSeed);
  assert(overrides.length === 2, `expected 2 v4 overrides, got ${overrides.length}`);
  const base = univ4PoolStateBaseSlot(V4_POOL_ID);
  const slot0 = overrides.find((o) => BigInt(o.slot) === base);
  const liquidity = overrides.find((o) => BigInt(o.slot) === base + 3n);
  assert(slot0 !== undefined, "v4 slot0 override missing");
  assert(liquidity !== undefined, "v4 liquidity override missing");
  const overrideDecoded = decodeV4Slot0(BigInt(slot0.value));
  assert(overrideDecoded.sqrtPriceX96 === V4_EVENT_SQRT_PRICE_X96, "v4 override sqrtPriceX96 mismatch");
  assert(overrideDecoded.tick === V4_EVENT_TICK, "v4 override tick mismatch");
  assert(overrideDecoded.lpFee === BigInt(V4_EVENT_LP_FEE), "v4 override lpFee mismatch");
  assert(BigInt(liquidity.value) === V4_EVENT_LIQUIDITY, "v4 liquidity override mismatch");
  console.log("[overlay-fidelity] UniV4 exact-from-event PoolManager override: PASS");

  const fallbackDecoded = decodeV4Slot0(packUniv4Slot0(syntheticV4Seed(impact.pool)));
  assert(
    fallbackDecoded.sqrtPriceX96 !== V4_EVENT_SQRT_PRICE_X96 || fallbackDecoded.tick !== V4_EVENT_TICK,
    "baseline_failure: synthetic v4 fallback unexpectedly matched event post-state",
  );
  console.log("[overlay-fidelity] UniV4 baseline_failure synthetic fallback != event exact: PASS");
  console.log("expected_transition: hash-only v4 overlay: simulated → exact-from-event");
}

async function main(): Promise<void> {
  await assertV2();
  await assertV3();
  await assertV4();
  console.log(
    "[overlay-fidelity] Curve overlay: DEFERRED (plain/ng balances storage layout varies; no unverified write shipped)",
  );
  console.log("mevshare-overlay-fidelity PASS (v2/v3/v4 exact, curve deferred)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
