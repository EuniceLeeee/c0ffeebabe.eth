import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import {
  buildV4PoolEntries,
  resolveV4InitsBackward,
  resolveV4InitViaPositionManagerThenBackward,
  resolveV4PoolKeyViaPositionManager,
  type ParsedV4Initialize,
} from "../venues/swaps/univ4-pool-discovery.js";
import {
  discoverLandedPools,
  type LandedPoolDiscoveryLogFilter,
  type LandedPoolDiscoveryLog as RawLog,
} from "../venues/landed-pool-discovery.js";
import { loadPoolUniverse, type PoolUniverseEntry } from "../pool-universe.js";
import { buildTokenGraph, type TokenQueryBackend, v4PoolId } from "../planner/token-graph.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import { univ4Adapter } from "../venues/swaps/univ4.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";

const initIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const swapIface = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const initEvent = mustEvent(initIface, "Initialize");
const swapEvent = mustEvent(swapIface, "Swap");
const initializeTopic = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const poolManager = ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER);
const positionManager = ethers.getAddress(ADDR.UNISWAP_V4_POSITION_MANAGER);
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

function parsedInitialize(fixture: PoolFixture, source?: ParsedV4Initialize["source"]): ParsedV4Initialize {
  return {
    poolId: fixture.poolId,
    currency0: fixture.currency0,
    currency1: fixture.currency1,
    fee: fixture.fee,
    tickSpacing: fixture.tickSpacing,
    hooks: fixture.hooks,
    ...(source ? { source } : {}),
  };
}

function positionManagerReturnData(fixture: PoolFixture): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [fixture.currency0, fixture.currency1, fixture.fee, fixture.tickSpacing, fixture.hooks],
  );
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
  const positionManagerPool = poolFixture(address(0x5001), address(0x5002), 5, 1, address(0));
  const fallbackPool = poolFixture(address(0x6001), address(0x6002), 5, 1, address(0));
  const garbagePoolKey = poolFixture(address(0x7001), address(0x7002), 500, 10, address(0x777));
  const batchPoolA = poolFixture(address(0x8001), address(0x8002), 500, 10, address(0));
  const batchPoolB = poolFixture(address(0x9001), address(0x9002), 3000, 60, address(0));
  const minSwaps = 2;

  const initLogs = [
    initLog(aboveA, 10),
    initLog(below, 11),
    initLog(aboveB, 12),
  ];
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
    return poolId === oldPool.poolId ? parsedInitialize(oldPool, "v4-initialize-backfill") : null;
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

  let batchLogCalls = 0;
  const batchResolved = await resolveV4InitsBackward(
    {
      async getLogs(filter: LandedPoolDiscoveryLogFilter) {
        batchLogCalls++;
        assert(
          Array.isArray(filter.topics[1]) &&
            filter.topics[1].length === 2,
          "batch backfill should OR unresolved PoolKeys in one indexed topic",
        );
        return filter.fromBlock <= 20 && filter.toBlock >= 20
          ? [initLog(batchPoolA, 20), initLog(batchPoolB, 20)]
          : [];
      },
    },
    poolManager,
    initializeTopic,
    [batchPoolA.poolId, batchPoolB.poolId],
    100,
    50,
    100,
  );
  assert(batchLogCalls === 2, `expected one call per historical chunk, got ${batchLogCalls}`);
  assert(batchResolved.size === 2, `expected two batched PoolKeys, got ${batchResolved.size}`);
  assert(
    batchResolved.get(batchPoolA.poolId)?.source === "v4-initialize-backfill" &&
      batchResolved.get(batchPoolB.poolId)?.source === "v4-initialize-backfill",
    "batched Initialize results should retain backfill provenance",
  );
  console.log("[pool-universe-v4] batched Initialize topic-OR backfill: PASS");

  let batchResolverCalls = 0;
  const batchEntries = await buildV4PoolEntries(
    [],
    [
      swapLog(batchPoolA.poolId, 90),
      swapLog(batchPoolA.poolId, 91),
      swapLog(batchPoolB.poolId, 90),
      swapLog(batchPoolB.poolId, 91),
    ],
    minSwaps,
    undefined,
    async (poolIds) => {
      batchResolverCalls++;
      assert(poolIds.length === 2, "batch resolver should receive every qualifying missing PoolKey");
      return [
        parsedInitialize(batchPoolA, "v4-initialize-backfill"),
        parsedInitialize(batchPoolB, "v4-initialize-backfill"),
      ];
    },
  );
  assert(batchResolverCalls === 1, `expected one batch resolver call, got ${batchResolverCalls}`);
  assert(batchEntries.length === 2, `expected two batch-resolved entries, got ${batchEntries.length}`);
  console.log("[pool-universe-v4] materializer consumes batch PoolKey resolver: PASS");

  let retainedResolverCalls = 0;
  const retainedDiscovery = await discoverLandedPools({
    registry: new AdapterFamilyRegistry([univ4Adapter]).landedPoolDiscovery(),
    backend: {
      async getLogs(filter) {
        const topic = filter.topics[0];
        if (topic === initializeTopic) return [];
        return [
          swapLog(oldPool.poolId, 40),
          swapLog(oldPool.poolId, 41),
        ];
      },
      async call() {
        retainedResolverCalls++;
        throw new Error("retained PoolKey must resolve before fallback RPC");
      },
    },
    fromBlock: 40,
    toBlock: 41,
    batchSize: 10,
    minSwaps,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    retainedPools: [{
      address: poolManager,
      adapter: "univ4",
      poolId: oldPool.poolId,
      currency0: oldPool.currency0,
      currency1: oldPool.currency1,
      fee: oldPool.fee,
      tickSpacing: oldPool.tickSpacing,
      hooks: oldPool.hooks,
      fixedTokenIn: oldPool.currency0,
      fixedTokenOut: oldPool.currency1,
      score: 0,
      topologyRetained: true,
    } as PoolUniverseEntry],
    strict: true,
  });
  assert(
    retainedResolverCalls === 0 &&
      retainedDiscovery.materializedPools.length === 1,
    "retained V4 PoolKey must make strict landed discovery complete without historical RPC",
  );
  assertEntry(
    retainedDiscovery.materializedPools[0],
    oldPool,
    2,
    41,
    "retained-family-inventory",
  );
  console.log("[pool-universe-v4] retained PoolKey resolves strict discovery: PASS");

  const poolKeysCalls: Array<{ to: string; data: string; blockTag: string }> = [];
  const positionManagerProvider = {
    async send(method: string, params: unknown[]) {
      assert(method === "eth_call", `expected eth_call, got ${method}`);
      const [call, blockTag] = params as [{ to: string; data: string }, string];
      poolKeysCalls.push(call ? { ...call, blockTag } : { to: "", data: "", blockTag });
      assert(ethers.getAddress(call.to) === positionManager, "poolKeys call should target PositionManager");
      assert(blockTag === "latest", "poolKeys call should use latest state");
      const expectedData = "0x86b6be7d" + positionManagerPool.poolId.slice(2, 52).padEnd(64, "0");
      assert(call.data === expectedData, "poolKeys calldata should use bytes25 poolId prefix");
      return positionManagerReturnData(positionManagerPool);
    },
  } as unknown as ethers.JsonRpcProvider;
  const resolvedPoolKey = await resolveV4PoolKeyViaPositionManager(
    positionManagerProvider,
    positionManager,
    positionManagerPool.poolId,
  );
  assert(resolvedPoolKey !== null, "PositionManager poolKeys resolver should pass integrity check");
  assert(poolKeysCalls.length === 1, `expected one poolKeys call, got ${poolKeysCalls.length}`);

  let positionManagerResolverCalls = 0;
  const positionManagerEntries = await buildV4PoolEntries(
    [],
    [swapLog(positionManagerPool.poolId, 50), swapLog(positionManagerPool.poolId, 51)],
    minSwaps,
    async (poolId) => {
      positionManagerResolverCalls++;
      assert(poolId === positionManagerPool.poolId, "PositionManager resolver should receive missing poolId");
      return { ...resolvedPoolKey, source: "v4-positionmanager-poolkeys" };
    },
  );
  const positionManagerByPoolId = new Map<string, PoolUniverseEntry>();
  for (const entry of positionManagerEntries) {
    assert(entry.poolId !== undefined, "v4 entry must include poolId");
    positionManagerByPoolId.set(entry.poolId, entry);
  }
  assert(positionManagerResolverCalls === 1, `expected one PositionManager resolver call, got ${positionManagerResolverCalls}`);
  assert(positionManagerEntries.length === 1, `expected 1 PositionManager-resolved entry, got ${positionManagerEntries.length}`);
  assertEntry(
    positionManagerByPoolId.get(positionManagerPool.poolId),
    positionManagerPool,
    2,
    51,
    "v4-positionmanager-poolkeys",
  );
  console.log("[pool-universe-v4] PositionManager poolKeys missing-init resolver: PASS");

  const fallbackPoolInitLog = initLog(fallbackPool, 45);
  const fallbackCalls: string[] = [];
  const fallbackProvider = {
    async send(method: string, params: unknown[]) {
      fallbackCalls.push(method);
      if (method === "eth_call") {
        return positionManagerReturnData(garbagePoolKey);
      }
      if (method === "eth_getLogs") {
        const [filter] = params as [{ topics: string[] }];
        assert(filter.topics[0] === initializeTopic, "fallback should query Initialize topic");
        assert(filter.topics[1] === fallbackPool.poolId, "fallback should query the missing poolId");
        return [fallbackPoolInitLog];
      }
      throw new Error(`unexpected provider method: ${method}`);
    },
  } as unknown as ethers.JsonRpcProvider;
  const fallbackEntries = await buildV4PoolEntries(
    [],
    [swapLog(fallbackPool.poolId, 60), swapLog(fallbackPool.poolId, 61)],
    minSwaps,
    async (poolId) => resolveV4InitViaPositionManagerThenBackward(
      fallbackProvider,
      positionManager,
      poolManager,
      initializeTopic,
      poolId,
      59,
      100,
    ),
  );
  const fallbackByPoolId = new Map<string, PoolUniverseEntry>();
  for (const entry of fallbackEntries) {
    assert(entry.poolId !== undefined, "v4 entry must include poolId");
    fallbackByPoolId.set(entry.poolId, entry);
  }
  assert(fallbackCalls[0] === "eth_call", "composed resolver should try PositionManager first");
  assert(fallbackCalls.includes("eth_getLogs"), "integrity mismatch should fall through to log backfill");
  assertEntry(fallbackByPoolId.get(fallbackPool.poolId), fallbackPool, 2, 61, "v4-initialize-backfill");
  console.log("[pool-universe-v4] PositionManager integrity mismatch fallback: PASS");

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

  console.log("pool-universe-v4 PASS (9/9)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
