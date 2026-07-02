import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { buildV4PoolEntries, type RawLog } from "../build-active-pool-universe.js";
import { loadPoolUniverse, type PoolUniverseEntry } from "../pool-universe.js";
import { buildTokenGraph, type TokenQueryBackend, v4PoolId } from "../planner/token-graph.js";
import { ADDR } from "../../shared/constants/addresses.js";

const initIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const swapIface = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const initEvent = mustEvent(initIface, "Initialize");
const swapEvent = mustEvent(swapIface, "Swap");
const poolManager = ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER);
const sqrtPriceX96 = 79228162514264337593543950336n;

interface PoolFixture {
  poolId: string;
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function mustEvent(iface: ethers.Interface, name: string): ethers.EventFragment {
  const event = iface.getEvent(name);
  if (!event) throw new Error(`missing event: ${name}`);
  return event;
}

function address(n: number): string {
  return ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
}

function hexBlock(block: number): string {
  return "0x" + block.toString(16);
}

function poolFixture(
  currency0: string,
  currency1: string,
  fee: number,
  tickSpacing: number,
  hooks: string,
): PoolFixture {
  return {
    poolId: v4PoolId({ currency0, currency1, fee, tickSpacing, hooks }),
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
  };
}

function initLog(fixture: PoolFixture, blockNumber: number): RawLog {
  const encoded = initIface.encodeEventLog(initEvent, [
    fixture.poolId,
    fixture.currency0,
    fixture.currency1,
    fixture.fee,
    fixture.tickSpacing,
    fixture.hooks,
    sqrtPriceX96,
    0,
  ]);
  return {
    address: poolManager,
    topics: [...encoded.topics],
    data: encoded.data,
    blockNumber: hexBlock(blockNumber),
  };
}

function swapLog(poolId: string, blockNumber: number): RawLog {
  const encoded = swapIface.encodeEventLog(swapEvent, [
    poolId,
    address(0xdead),
    1n,
    2n,
    sqrtPriceX96,
    1000n,
    12,
    500,
  ]);
  return {
    address: poolManager,
    topics: [...encoded.topics],
    data: encoded.data,
    blockNumber: hexBlock(blockNumber),
  };
}

function assertEntry(
  entry: PoolUniverseEntry | undefined,
  fixture: PoolFixture,
  score: number,
  lastSwapBlock: number,
  source = "alchemy-v4-initialize",
): PoolUniverseEntry {
  assert(entry !== undefined, `missing entry for ${fixture.poolId}`);
  assert(entry.address === poolManager, "PoolManager address should be preserved");
  assert(entry.adapter === "univ4", "adapter should be univ4");
  assert(entry.poolId === fixture.poolId, "poolId should match Initialize log");
  assert(entry.currency0 === fixture.currency0, "currency0 should match Initialize log");
  assert(entry.currency1 === fixture.currency1, "currency1 should match Initialize log");
  assert(entry.fee === fixture.fee, "fee should match Initialize log");
  assert(entry.tickSpacing === fixture.tickSpacing, "tickSpacing should match Initialize log");
  assert(entry.hooks === fixture.hooks, "hooks should match Initialize log");
  assert(entry.fixedTokenIn === fixture.currency0, "fixedTokenIn should default to currency0");
  assert(entry.fixedTokenOut === fixture.currency1, "fixedTokenOut should default to currency1");
  assert(entry.score === score, `score should be ${score}`);
  assert(entry.swapCount30d === score, `swapCount30d should be ${score}`);
  assert(entry.lastSwapBlock === lastSwapBlock, `lastSwapBlock should be ${lastSwapBlock}`);
  assert(entry.source === source, `source should be ${source}`);
  return entry;
}

function assertInlineV4Fields(entry: PoolUniverseEntry): void {
  assert(entry.currency0 !== undefined, "currency0 must be present for inline v4 PoolKey");
  assert(entry.currency1 !== undefined, "currency1 must be present for inline v4 PoolKey");
  assert(entry.fee !== undefined, "fee must be present for inline v4 PoolKey");
  assert(entry.tickSpacing !== undefined, "tickSpacing must be present for inline v4 PoolKey");
  assert(entry.hooks !== undefined, "hooks must be present for inline v4 PoolKey");
}

async function main(): Promise<void> {
  const aboveA = poolFixture(address(0x1001), address(0x1002), 500, 10, address(0));
  const below = poolFixture(address(0x2001), address(0x2002), 3000, 60, address(0x9999));
  const aboveB = poolFixture(address(0x3001), address(0x3002), 100, 1, address(0x7777));
  const oldPool = poolFixture(address(0x4001), address(0x4002), 10000, 200, address(0x8888));
  const minSwaps = 2;

  const initLogs = [
    initLog(aboveA, 10),
    initLog(below, 11),
    initLog(aboveB, 12),
  ];
  const oldPoolInitLog = initLog(oldPool, 5);
  const swapLogs = [
    swapLog(aboveA.poolId, 20),
    swapLog(aboveA.poolId, 22),
    swapLog(aboveA.poolId, 21),
    swapLog(below.poolId, 23),
    swapLog(aboveB.poolId, 30),
    swapLog(aboveB.poolId, 31),
    swapLog(oldPool.poolId, 40),
    swapLog(oldPool.poolId, 41),
  ];

  const entries = await buildV4PoolEntries(initLogs, swapLogs, minSwaps);
  assert(entries.length === 2, `expected 2 v4 entries above minSwaps, got ${entries.length}`);

  const byPoolId = new Map<string, PoolUniverseEntry>();
  for (const entry of entries) {
    assert(entry.poolId !== undefined, "v4 entry must include poolId");
    byPoolId.set(entry.poolId, entry);
  }
  const entryA = assertEntry(byPoolId.get(aboveA.poolId), aboveA, 3, 22);
  assertEntry(byPoolId.get(aboveB.poolId), aboveB, 2, 31);
  assert(!byPoolId.has(below.poolId), "pool below minSwaps should be excluded");
  assert(!byPoolId.has(oldPool.poolId), "baseline_failure: old v4 pool without resolver should be excluded");
  console.log("[pool-universe-v4] buildV4PoolEntries fixtures: PASS");

  const resolverCalls: string[] = [];
  const backfilledEntries = await buildV4PoolEntries(initLogs, swapLogs, minSwaps, async (poolId) => {
    resolverCalls.push(poolId);
    return poolId === oldPool.poolId ? oldPoolInitLog : null;
  });
  const backfilledByPoolId = new Map<string, PoolUniverseEntry>();
  for (const entry of backfilledEntries) {
    assert(entry.poolId !== undefined, "v4 entry must include poolId");
    backfilledByPoolId.set(entry.poolId, entry);
  }
  assert(resolverCalls.length === 1, `expected one missing-init resolver call, got ${resolverCalls.length}`);
  assert(resolverCalls[0] === oldPool.poolId, "resolver should only be called for above-threshold missing init");
  assert(backfilledEntries.length === 3, `expected 3 v4 entries with backfill, got ${backfilledEntries.length}`);
  assertEntry(backfilledByPoolId.get(aboveA.poolId), aboveA, 3, 22);
  assertEntry(backfilledByPoolId.get(aboveB.poolId), aboveB, 2, 31);
  assert(!backfilledByPoolId.has(below.poolId), "pool below minSwaps should remain excluded");
  assertEntry(backfilledByPoolId.get(oldPool.poolId), oldPool, 2, 41, "v4-initialize-backfill");
  console.log("[pool-universe-v4] expected_transition old v4 Initialize backfill: PASS");

  const dir = mkdtempSync(join(tmpdir(), "pool-universe-v4-"));
  try {
    const file = join(dir, "active-pools.json");
    writeFileSync(file, JSON.stringify({ pools: [entryA] }, null, 2) + "\n");
    const loaded = loadPoolUniverse(file, { maxPools: 0 });
    assert(loaded.length === 1, `expected 1 round-tripped v4 pool, got ${loaded.length}`);
    const roundTripped = assertEntry(loaded[0], aboveA, 3, 22);
    assertInlineV4Fields(roundTripped);
    console.log("[pool-universe-v4] loadPoolUniverse round-trip: PASS");

    let backendCalls = 0;
    const backend: TokenQueryBackend = {
      async call() {
        backendCalls++;
        throw new Error("unexpected backend.call");
      },
      async getLogs() {
        backendCalls++;
        throw new Error("unexpected backend.getLogs");
      },
    };
    const edges = await buildTokenGraph(backend, [roundTripped]);
    assert(backendCalls === 0, `inline v4 PoolKey should avoid backend calls, got ${backendCalls}`);
    assert(edges.length === 2, `expected 2 directed v4 edges, got ${edges.length}`);
    assert(edges.every((edge) => edge.adapterId === "univ4-unlock"), "edges should use univ4 adapter");
    assert(edges.every((edge) => edge.target === poolManager), "edges should target PoolManager");
    assert(edges.every((edge) => edge.poolId === aboveA.poolId), "edges should carry canonical poolId");
    assert(edges.every((edge) => edge.v4PoolKey !== undefined), "edges should carry v4 PoolKey");
    assert(
      edges.some((edge) => edge.tokenIn === aboveA.currency0 && edge.tokenOut === aboveA.currency1),
      "forward v4 edge should use currency0 -> currency1",
    );
    assert(
      edges.some((edge) => edge.tokenIn === aboveA.currency1 && edge.tokenOut === aboveA.currency0),
      "reverse v4 edge should use currency1 -> currency0",
    );
    console.log("[pool-universe-v4] buildTokenGraph inline PoolKey path: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("pool-universe-v4 PASS (4/4)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
