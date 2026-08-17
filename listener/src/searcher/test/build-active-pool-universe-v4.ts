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
import { v4PoolId } from "../planner/token-graph.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { AdapterFamilyRegistry } from "../venues/adapter-family-registry.js";
import { univ4Adapter } from "../venues/swaps/univ4.js";
import { UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK } from "../venues/swaps/univ4-common.js";
import { PRODUCTION_IDENTITY_ADMISSION } from "../venues/admission.js";
import {
  createSplitHorizonPoolDiscoveryBackend,
} from "../pool-discovery-read-backend.js";

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
  const activityLogCalls: LandedPoolDiscoveryLogFilter[] = [];
  const historicalLogCalls: LandedPoolDiscoveryLogFilter[] = [];
  const splitBackend = createSplitHorizonPoolDiscoveryBackend(
    {
      async call() {
        return "0x";
      },
      async getCode() {
        return "0x";
      },
      async send() {
        throw new Error("state provider must not serve pool discovery logs");
      },
    } as unknown as ethers.JsonRpcProvider,
    {
      async send(_method: string, params: unknown[]) {
        activityLogCalls.push(params[0] as LandedPoolDiscoveryLogFilter);
        return [];
      },
    } as unknown as ethers.JsonRpcProvider,
    {
      async send(_method: string, params: unknown[]) {
        historicalLogCalls.push(params[0] as LandedPoolDiscoveryLogFilter);
        return [];
      },
    } as unknown as ethers.JsonRpcProvider,
    100,
  );
  await splitBackend.getLogs({
    topics: [initializeTopic],
    fromBlock: 100,
    toBlock: 110,
  });
  await splitBackend.getLogs({
    topics: [initializeTopic],
    fromBlock: 50,
    toBlock: 99,
  });
  assert(
    activityLogCalls.length === 1 && historicalLogCalls.length === 1,
    "split-horizon backend should keep the activity window local and route only old logs to history",
  );
  console.log("[pool-universe-v4] split-horizon activity/history log routing: PASS");

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
  const priorV4Lookback = process.env.POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS;
  delete process.env.POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS;
  let batchResolved: ReadonlyMap<string, ParsedV4Initialize>;
  try {
    const initializeBlock = UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 20;
    batchResolved = await resolveV4InitsBackward(
      {
        async getLogs(filter: LandedPoolDiscoveryLogFilter) {
          batchLogCalls++;
          assert(
            filter.topics.length === 2 &&
              filter.topics[0] === initializeTopic &&
              (
                filter.topics[1] === batchPoolA.poolId ||
                filter.topics[1] === batchPoolB.poolId
              ),
            "small backfill should use the indexed PoolId topic",
          );
          if (
            filter.fromBlock > initializeBlock ||
            filter.toBlock < initializeBlock
          ) return [];
          return filter.topics[1] === batchPoolA.poolId
            ? [initLog(batchPoolA, initializeBlock)]
            : [initLog(batchPoolB, initializeBlock)];
        },
      },
      poolManager,
      initializeTopic,
      [batchPoolA.poolId, batchPoolB.poolId],
      UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 99,
      50,
    );
  } finally {
    if (priorV4Lookback === undefined) {
      delete process.env.POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS;
    } else {
      process.env.POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS = priorV4Lookback;
    }
  }
  assert(
    batchLogCalls === 4,
    `expected newest-first indexed calls per PoolId, got ${batchLogCalls}`,
  );
  assert(batchResolved.size === 2, `expected two batched PoolKeys, got ${batchResolved.size}`);
  assert(
    batchResolved.get(batchPoolA.poolId)?.source === "v4-initialize-backfill" &&
      batchResolved.get(batchPoolB.poolId)?.source === "v4-initialize-backfill",
    "batched Initialize results should retain backfill provenance",
  );
  console.log("[pool-universe-v4] indexed small-set Initialize backfill: PASS");

  const adaptiveFromBlock = UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK;
  const adaptiveToBlock = adaptiveFromBlock + 99;
  const adaptivePoolABlock = adaptiveFromBlock + 10;
  const adaptivePoolBBlock = adaptiveFromBlock + 90;
  const adaptiveRanges: Array<{ fromBlock: number; toBlock: number }> = [];
  const adaptiveResolved = await resolveV4InitsBackward(
    {
      async getLogs(filter: LandedPoolDiscoveryLogFilter) {
        adaptiveRanges.push({
          fromBlock: filter.fromBlock,
          toBlock: filter.toBlock,
        });
        const blockCount = filter.toBlock - filter.fromBlock + 1;
        if (blockCount > 25) {
          throw new Error("provider getLogs range exceeds response limit");
        }
        const poolId = filter.topics[1];
        return poolId === batchPoolA.poolId &&
            filter.fromBlock <= adaptivePoolABlock &&
            filter.toBlock >= adaptivePoolABlock
          ? [initLog(batchPoolA, adaptivePoolABlock)]
          : poolId === batchPoolB.poolId &&
              filter.fromBlock <= adaptivePoolBBlock &&
              filter.toBlock >= adaptivePoolBBlock
            ? [initLog(batchPoolB, adaptivePoolBBlock)]
            : [];
      },
    },
    poolManager,
    initializeTopic,
    [batchPoolA.poolId, batchPoolA.poolId, batchPoolB.poolId],
    adaptiveToBlock,
    100,
    100,
  );
  const successfulAdaptiveRanges = adaptiveRanges.filter(
    (range) => range.toBlock - range.fromBlock + 1 <= 25,
  );
  assert(
    adaptiveRanges.length === 14 && successfulAdaptiveRanges.length === 8,
    "each indexed PoolId should recursively split into four successful leaves",
  );
  const adaptiveLeafCounts = new Map<string, number>();
  for (const range of successfulAdaptiveRanges) {
    const key = `${range.fromBlock}-${range.toBlock}`;
    adaptiveLeafCounts.set(key, (adaptiveLeafCounts.get(key) ?? 0) + 1);
  }
  assert(
    Array.from({ length: 4 }, (_, leaf) =>
      adaptiveLeafCounts.get(
        `${adaptiveFromBlock + leaf * 25}-` +
          `${adaptiveFromBlock + (leaf + 1) * 25 - 1}`,
      ) === 2
    ).every(Boolean),
    "adaptive indexed leaves should cover each disjoint range per PoolId",
  );
  assert(
    adaptiveResolved.size === 2 &&
      [...adaptiveResolved.keys()].join(",") ===
        [batchPoolA.poolId, batchPoolB.poolId].join(","),
    "adaptive split should preserve PoolKey ordering and de-duplicate requested identities",
  );
  console.log("[pool-universe-v4] adaptive historical range split: PASS");

  let terminalFailureCalls = 0;
  let terminalFailure: unknown;
  try {
    await resolveV4InitsBackward(
      {
        async getLogs() {
          terminalFailureCalls++;
          throw new Error("provider rejects even one block");
        },
      },
      poolManager,
      initializeTopic,
      [batchPoolA.poolId],
      adaptiveFromBlock,
      1,
      1,
    );
  } catch (error) {
    terminalFailure = error;
  }
  assert(
    terminalFailureCalls === 1 &&
      terminalFailure instanceof Error &&
      terminalFailure.message === "provider rejects even one block",
    "an unsplittable non-pruned range must fail closed instead of omitting Initialize logs",
  );
  console.log("[pool-universe-v4] unsplittable historical range fails closed: PASS");

  const abortController = new AbortController();
  const abortReason = new Error("historical scan cancelled");
  abortReason.name = "AbortError";
  let abortedCalls = 0;
  let observedAbort: unknown;
  try {
    await resolveV4InitsBackward(
      {
        async getLogs(_filter, control) {
          abortedCalls++;
          assert(
            control?.signal === abortController.signal,
            "adaptive historical reads must forward the caller AbortSignal",
          );
          abortController.abort(abortReason);
          throw new Error("provider request interrupted");
        },
      },
      poolManager,
      initializeTopic,
      [batchPoolA.poolId],
      adaptiveToBlock,
      100,
      100,
      abortController.signal,
    );
  } catch (error) {
    observedAbort = error;
  }
  assert(
    abortedCalls === 1 && observedAbort === abortReason,
    "aborted historical reads must propagate the abort reason without recursive retries",
  );
  console.log("[pool-universe-v4] adaptive historical range cancellation: PASS");

  let broadBackfillCalls = 0;
  let exactBackfillCalls = 0;
  const truncatedBroadResolved = await resolveV4InitsBackward(
    {
      async getLogs(filter: LandedPoolDiscoveryLogFilter) {
        if (filter.topics.length === 1) {
          broadBackfillCalls++;
          return [];
        }
        exactBackfillCalls++;
        return filter.topics[1] === batchPoolA.poolId
          ? [initLog(
              batchPoolA,
              UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 20,
            )]
          : [initLog(
              batchPoolB,
              UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 30,
            )];
      },
    },
    poolManager,
    initializeTopic,
    [batchPoolA.poolId, batchPoolB.poolId],
    UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 99,
    100,
  );
  assert(
    broadBackfillCalls === 0 && exactBackfillCalls === 2,
    "small PoolId sets must skip broad history and query exact identities",
  );
  assert(
    truncatedBroadResolved.size === 2,
    "indexed PoolKey fallback should restore complete strict identity materialization",
  );
  console.log("[pool-universe-v4] small-set exact-first history: PASS");

  const largeBackfillPools = Array.from({ length: 33 }, (_, index) =>
    poolFixture(
      address(0x1000 + index * 2),
      address(0x1001 + index * 2),
      500,
      10,
      ethers.ZeroAddress,
    )
  );
  const largeInitializeBlock =
    UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 950;
  let largeBroadCalls = 0;
  const largeResolved = await resolveV4InitsBackward(
    {
      async getLogs(filter: LandedPoolDiscoveryLogFilter) {
        largeBroadCalls++;
        assert(
          filter.topics.length === 1 &&
            filter.topics[0] === initializeTopic,
          "large PoolId sets should amortize a broad family scan",
        );
        return filter.fromBlock <= largeInitializeBlock &&
            filter.toBlock >= largeInitializeBlock
          ? largeBackfillPools.map((pool) =>
              initLog(pool, largeInitializeBlock)
            )
          : [];
      },
    },
    poolManager,
    initializeTopic,
    largeBackfillPools.map((pool) => pool.poolId),
    UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 999,
    100,
    1_000,
  );
  assert(
    largeResolved.size === largeBackfillPools.length &&
      largeBroadCalls === 8,
    "large broad history should stop after the newest resolving wave",
  );
  console.log("[pool-universe-v4] large-set newest-first early stop: PASS");

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

  const v4Registry =
    new AdapterFamilyRegistry([univ4Adapter]).landedPoolDiscovery();
  assert(
    !v4Registry.consumesAddressRetries("univ4") &&
      v4Registry.consumesMaterializationRetries("univ4"),
    "V4 must own opaque PoolId retries without claiming address identity",
  );
  let retryPhase: "defer" | "resolve" = "defer";
  const boundedRetryBackend = {
    async getLogs(filter: LandedPoolDiscoveryLogFilter) {
      if (filter.topics[0] === initializeTopic) return [];
      return retryPhase === "defer"
        ? [
            swapLog(positionManagerPool.poolId, 70),
            swapLog(positionManagerPool.poolId, 71),
          ]
        : [];
    },
    async call() {
      return retryPhase === "defer"
        ? positionManagerReturnData(garbagePoolKey)
        : positionManagerReturnData(positionManagerPool);
    },
  };
  const deferredV4 = await discoverLandedPools({
    registry: v4Registry,
    backend: boundedRetryBackend,
    fromBlock: 70,
    toBlock: 71,
    batchSize: 10,
    minSwaps,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    historicalResolution: "bounded",
    strict: true,
  });
  assert(
    deferredV4.materializedPools.length === 0 &&
      deferredV4.retryablePools.length === 1 &&
      deferredV4.retryablePools[0].poolId === positionManagerPool.poolId &&
      deferredV4.coverage.every((item) => !item.complete),
    "bounded V4 miss must advance only as a typed incomplete retry",
  );
  retryPhase = "resolve";
  const healedV4 = await discoverLandedPools({
    registry: v4Registry,
    backend: boundedRetryBackend,
    fromBlock: 72,
    toBlock: 72,
    batchSize: 10,
    minSwaps,
    admissionPolicy: PRODUCTION_IDENTITY_ADMISSION,
    retryablePools: deferredV4.retryablePools,
    historicalResolution: "bounded",
    strict: true,
  });
  assert(
    healedV4.retryablePools.length === 0 &&
      healedV4.materializedPools.length === 1 &&
      healedV4.materializedPools[0].poolId === positionManagerPool.poolId &&
      healedV4.coverage.every((item) => item.complete),
    "opaque V4 retry must heal without replaying the original Swap log",
  );
  console.log("[pool-universe-v4] bounded opaque retry heals next generation: PASS");

  let retainedResolverCalls = 0;
  const retainedDiscovery = await discoverLandedPools({
    registry: v4Registry,
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

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("pool-universe-v4 PASS (15/15)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
