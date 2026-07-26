import { ethers } from "ethers";
import { v4PoolId, type PoolEntry, type TokenEdge } from "../planner/token-graph.js";
import { indexFactoryPools, scanActivePools } from "../active-pool-discovery.js";
import { buildStrategyViews, hashTokenGraph } from "../strategy-views.js";
import { poolRegistryKey } from "../pool-universe.js";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
} from "../venues/swaps/univ4-common.js";
import {
  deriveEdgeTaxonomy,
  edgeKindFromPoolEntry,
  type EdgeKind,
} from "../strategy-taxonomy.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertArrayEq(actual: string[], expected: string[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((item, i) => item === expected[i]),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertEdgeKind(actual: EdgeKind, expected: EdgeKind, msg: string): void {
  assert(actual === expected, `${msg}: expected ${expected}, got ${actual}`);
}

function address(n: number): string {
  return "0x" + n.toString(16).padStart(40, "0");
}

function pool(
  n: number,
  adapter: PoolEntry["adapter"] = "univ3",
  score?: number,
  fixedSlotKind?: PoolEntry["fixedSlotKind"],
): PoolEntry {
  return {
    address: address(n),
    adapter,
    token0: address(0x1000 + n),
    token1: address(0x2000 + n),
    score,
    fixedSlotKind,
  };
}

const BASE_A = pool(0x101, "univ3", 100);
const BASE_B = pool(0x102, "curve", 80);
const OVERRIDE_A = pool(0x201, "univ2", 5);
const OVERRIDE_B = pool(0x202, "fluid-vault", 1, "lend");
const U_HIGH = pool(0x301, "univ4", 500);
const U_MID = pool(0x302, "univ3", 100);
const U_LOW = pool(0x303, "curve", 1);
const U_UNSCORED = pool(0x304, "univ2");
const U_DUP_BASE = { ...pool(0x101, "univ3", 1_000), address: BASE_A.address.toUpperCase() };
const GENERATED_AT = "2026-07-04T00:00:00.000Z";

function buildFixture(blockscanMaxPools = 2) {
  const basePools = [BASE_A, BASE_B];
  const overrides = [OVERRIDE_A, OVERRIDE_B];
  const universeFile = [U_LOW, U_DUP_BASE, U_UNSCORED, U_MID, U_HIGH];
  return {
    basePools,
    overrides,
    universeFile,
    views: buildStrategyViews(basePools, universeFile, overrides, {
      blockscanMaxPools,
      poolUniverseGeneratedAt: GENERATED_AT,
    }),
  };
}

function lowerAddresses(pools: PoolEntry[]): string[] {
  return pools.map((entry) => entry.address.toLowerCase());
}

function testBackrunIsBasePoolsAsIs(): void {
  const { basePools, views } = buildFixture();
  assert(views.backrun === basePools, "backrun should be the same array instance as basePools");
  assertArrayEq(lowerAddresses(views.backrun), lowerAddresses(basePools), "backrun address order");
  console.log("[universe-split] backrun identity/order: PASS");
}

function testBlockscanSupersetAndOverrides(): void {
  const { basePools, overrides, views } = buildFixture();
  const blockscanSet = new Set(lowerAddresses(views.blockscan));
  for (const entry of basePools) {
    assert(blockscanSet.has(entry.address.toLowerCase()), `blockscan missing backrun ${entry.address}`);
  }
  for (const entry of overrides) {
    assert(blockscanSet.has(entry.address.toLowerCase()), `blockscan missing override ${entry.address}`);
  }
  console.log("[universe-split] blockscan contains backrun and overrides: PASS");
}

function testUniverseCapAndScoreSort(): void {
  const { basePools, overrides, views } = buildFixture(2);
  const baseOrOverride = new Set([...lowerAddresses(basePools), ...lowerAddresses(overrides)]);
  const universeOnly = views.blockscan
    .filter((entry) => !baseOrOverride.has(entry.address.toLowerCase()))
    .map((entry) => entry.address.toLowerCase());

  assert(universeOnly.length <= 2, `universe cap: expected <=2 additions, got ${universeOnly.length}`);
  assertArrayEq(universeOnly, [U_HIGH.address, U_MID.address], "universe cap should select highest scores");
  assert(!universeOnly.includes(U_LOW.address), "low-score universe pool should be excluded beyond cap");
  assert(!universeOnly.includes(U_UNSCORED.address), "undefined-score universe pool should sort last");
  console.log("[universe-split] universe cap and score sort: PASS");
}

function testNoDuplicateAddresses(): void {
  const { views } = buildFixture();
  const addresses = lowerAddresses(views.blockscan);
  assert(new Set(addresses).size === addresses.length, "blockscan should not contain duplicate addresses");
  assert(
    addresses.filter((entry) => entry === BASE_A.address).length === 1,
    "duplicate universe/base address should dedupe",
  );
  console.log("[universe-split] blockscan dedupe: PASS");
}

function testV4SingletonUsesPoolIdentity(): void {
  const manager = address(0x444);
  const v4a: PoolEntry = {
    address: manager,
    adapter: "univ4",
    poolId: "0x" + "11".repeat(32),
    currency0: address(0x501),
    currency1: address(0x502),
    fee: 100,
    tickSpacing: 1,
    hooks: address(0),
    score: 2,
  };
  const v4b: PoolEntry = {
    ...v4a,
    poolId: "0x" + "22".repeat(32),
    currency1: address(0x503),
    score: 1,
  };
  const both = buildStrategyViews([], [v4a, v4b], [], {
    blockscanMaxPools: 2,
    poolUniverseGeneratedAt: GENERATED_AT,
  });
  const one = buildStrategyViews([], [v4a], [], {
    blockscanMaxPools: 2,
    poolUniverseGeneratedAt: GENERATED_AT,
  });
  assert(both.blockscan.length === 2, "distinct v4 poolIds sharing PoolManager must both survive");
  assert(
    both.versions.blockscan_view_hash !== one.versions.blockscan_view_hash,
    "blockscan hash must include v4 pool identity, not only PoolManager address",
  );
  console.log("[universe-split] v4 singleton pool identity: PASS");
}

function testHashesDeterministicAndSensitive(): void {
  const { basePools, overrides, universeFile, views } = buildFixture(2);
  const same = buildStrategyViews(basePools, universeFile, overrides, {
    blockscanMaxPools: 2,
    poolUniverseGeneratedAt: GENERATED_AT,
  });
  assert(
    JSON.stringify(views.versions) === JSON.stringify(same.versions),
    "same inputs should produce identical versions",
  );

  const before = buildStrategyViews(basePools, [U_HIGH], overrides, {
    blockscanMaxPools: 2,
    poolUniverseGeneratedAt: GENERATED_AT,
  });
  const after = buildStrategyViews(basePools, [U_HIGH, U_MID], overrides, {
    blockscanMaxPools: 2,
    poolUniverseGeneratedAt: GENERATED_AT,
  });
  assert(
    before.versions.blockscan_view_hash !== after.versions.blockscan_view_hash,
    "adding a universe pool within cap should change blockscan_view_hash",
  );
  assert(
    before.versions.strategy_view_version !== after.versions.strategy_view_version,
    "adding a universe pool within cap should change strategy_view_version",
  );

  const retimed = buildStrategyViews(basePools, universeFile, overrides, {
    blockscanMaxPools: 2,
    poolUniverseGeneratedAt: "2026-07-04T00:01:00.000Z",
  });
  assert(
    views.versions.backrun_view_hash === retimed.versions.backrun_view_hash,
    "generated_at change should not change backrun_view_hash",
  );
  assert(
    views.versions.blockscan_view_hash === retimed.versions.blockscan_view_hash,
    "generated_at change should not change blockscan_view_hash",
  );
  assert(
    views.versions.overrides_hash === retimed.versions.overrides_hash,
    "generated_at change should not change overrides_hash",
  );
  assert(
    views.versions.strategy_view_version !== retimed.versions.strategy_view_version,
    "generated_at change should change only strategy_view_version",
  );
  console.log("[universe-split] hashes deterministic/change-sensitive: PASS");
}

function testEdgeKindFromPoolEntry(): void {
  assertEdgeKind(edgeKindFromPoolEntry({ adapter: "fluid-vault" }), "credit", "fluid-vault");
  assertEdgeKind(
    edgeKindFromPoolEntry({ adapter: "univ3", fixedSlotKind: "lend" }),
    "credit",
    "fixed lend pool",
  );

  for (const adapter of ["univ2", "univ3", "univ4", "curve"] as const) {
    assertEdgeKind(edgeKindFromPoolEntry({ adapter }), "swap", adapter);
  }

  assert(
    edgeKindFromPoolEntry({ adapter: "univ3", fixedSlotKind: "lend" }) === deriveEdgeTaxonomy("lend").edgeKind,
    "pool-entry lend edge kind should agree with deriveEdgeTaxonomy(lend)",
  );
  assert(
    edgeKindFromPoolEntry({ adapter: "univ3", fixedSlotKind: "swap" }) === deriveEdgeTaxonomy("swap").edgeKind,
    "pool-entry swap edge kind should agree with deriveEdgeTaxonomy(swap)",
  );
  console.log("[universe-split] edgeKindFromPoolEntry: PASS");
}

function testTokenGraphHash(): void {
  const edge: TokenEdge = {
    adapterId: "univ3-swap",
    target: address(0x701),
    tokenIn: address(0x702),
    tokenOut: address(0x703),
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  };
  const same = { ...edge };
  const changed = { ...edge, tokenOut: address(0x704) };
  assert(hashTokenGraph([edge]) === hashTokenGraph([same]), "same graph must hash identically");
  assert(hashTokenGraph([edge]) !== hashTokenGraph([changed]), "routing edge change must change graph hash");
  console.log("[universe-split] runtime token graph hash: PASS");
}

async function testPinnedDiscoveryCutoff(): Promise<void> {
  const filters: Array<{ fromBlock: string; toBlock: string }> = [];
  const provider = {
    getBlockNumber(): never {
      throw new Error("getBlockNumber must not run when cutoff is pinned");
    },
    async send(_method: string, args: Array<{ fromBlock: string; toBlock: string }>): Promise<unknown[]> {
      filters.push(args[0]);
      return [];
    },
  };
  await indexFactoryPools(provider as never, 10, 1_000);
  await scanActivePools(provider as never, 10, 10, 1_000);
  assert(filters.length > 0, "pinned discovery should issue log requests");
  assert(filters.every((filter) => filter.toBlock === "0x3e8"), "all discovery requests must stop at pinned head");
  assert(filters.every((filter) => filter.fromBlock === "0x3de"), "all discovery requests must share pinned range");
  console.log("[universe-split] pinned discovery cutoff: PASS");
}

async function testRuntimeV4DiscoveryKeepsPoolIds(): Promise<void> {
  const manager = ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER);
  const initIface = new ethers.Interface([
    "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
  ]);
  const swapIface = new ethers.Interface([
    "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
  ]);
  const initEvent = initIface.getEvent("Initialize")!;
  const swapEvent = swapIface.getEvent("Swap")!;
  const makePool = (n: number) => {
    const currency0 = address(0x8000 + n * 2);
    const currency1 = address(0x8001 + n * 2);
    const fee = 500;
    const tickSpacing = 10;
    const hooks = address(0);
    return {
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks,
      poolId: v4PoolId({ currency0, currency1, fee, tickSpacing, hooks }),
    };
  };
  const pools = [makePool(1), makePool(2)];
  const initLogs = pools.map((pool) => {
    const encoded = initIface.encodeEventLog(initEvent, [
      pool.poolId,
      pool.currency0,
      pool.currency1,
      pool.fee,
      pool.tickSpacing,
      pool.hooks,
      1n << 96n,
      0,
    ]);
    return {
      address: manager,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: "0x3e7",
    };
  });
  const swapLogs = pools.map((pool) => {
    const encoded = swapIface.encodeEventLog(swapEvent, [
      pool.poolId,
      address(0xdead),
      1n,
      -1n,
      1n << 96n,
      1_000n,
      0,
      pool.fee,
    ]);
    return {
      address: manager,
      topics: encoded.topics,
      data: encoded.data,
      blockNumber: "0x3e8",
    };
  });
  const initializeTopic = ethers.id(
    "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
  );
  const swapTopic = ethers.id(
    "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
  );
  const provider = {
    getBlockNumber(): never {
      throw new Error("pinned runtime discovery should not query latest");
    },
    async send(method: string, args: Array<{ address?: string; topics?: string[] }>): Promise<unknown[]> {
      assert(method === "eth_getLogs", `unexpected runtime v4 method ${method}`);
      const filter = args[0];
      if (filter.address?.toLowerCase() !== manager.toLowerCase()) return [];
      if (filter.topics?.[0] === initializeTopic) return initLogs;
      if (filter.topics?.[0] === swapTopic) return swapLogs;
      return [];
    },
  };
  const discovered = await scanActivePools(provider as never, 10, 10, 1_000);
  const v4 = discovered.filter((pool) => pool.adapter === "univ4");
  assert(v4.length === 2, `expected two runtime v4 pools, got ${v4.length}`);
  assert(
    v4.every((pool) => pool.address.toLowerCase() === manager.toLowerCase()),
    "runtime v4 entries should retain the singleton PoolManager target",
  );
  assert(
    new Set(v4.map(poolRegistryKey)).size === 2,
    "distinct v4 poolIds sharing PoolManager must retain distinct registry identities",
  );

  const retainedPools: PoolEntry[] = pools.map((pool) => ({
    address: manager,
    adapter: "univ4",
    venueId: "univ4",
    identitySource: "v4-manager",
    poolId: pool.poolId,
    currency0: pool.currency0,
    currency1: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
    fixedTokenIn: pool.currency0,
    fixedTokenOut: pool.currency1,
  }));
  let historicalBackfills = 0;
  let positionManagerReads = 0;
  let retainedArchiveReads = 0;
  const retainedSourceHash = ethers.keccak256(
    ethers.toUtf8Bytes("retained-source"),
  );
  const retainedHistoricalProvider = {
    async send(): Promise<never> {
      retainedArchiveReads++;
      throw new Error("retained PoolKey must not touch the archive");
    },
  };
  const retainedProvider = {
    getBlockNumber(): never {
      throw new Error("pinned retained runtime discovery should not query latest");
    },
    async send(
      method: string,
      args: Array<{
        address?: string;
        topics?: string[];
        fromBlock?: string;
      }>,
    ): Promise<unknown[]> {
      assert(method === "eth_getLogs", `unexpected retained v4 method ${method}`);
      const filter = args[0];
      if (
        filter.fromBlock !== undefined &&
        parseInt(filter.fromBlock, 16) < 990
      ) {
        historicalBackfills++;
        throw new Error("retained PoolKey must avoid historical Initialize backfill");
      }
      if (filter.address?.toLowerCase() !== manager.toLowerCase()) return [];
      if (filter.topics?.[0] === initializeTopic) return [];
      if (filter.topics?.[0] === swapTopic) return swapLogs;
      return [];
    },
    async call(): Promise<string> {
      positionManagerReads++;
      throw new Error("retained PoolKey must avoid PositionManager lookup");
    },
  };
  const retainedDiscovered = await scanActivePools(
    retainedProvider as never,
    10,
    10,
    1_000,
    {
      retainedPools,
      historicalLogProvider: retainedHistoricalProvider as never,
      historicalLogAnchor: {
        blockNumber: 1_000,
        blockHash: retainedSourceHash,
      },
    },
  );
  assert(
    retainedDiscovered.filter((pool) => pool.adapter === "univ4").length === 2,
    "retained family inventory should resolve both recent V4 poolIds",
  );
  assert(
    historicalBackfills === 0 &&
      positionManagerReads === 0 &&
      retainedArchiveReads === 0,
    "retained V4 identities should not repeat historical/on-chain PoolKey resolution or touch archive",
  );
  console.log(
    "[universe-split] runtime v4 poolId discovery/dedupe/retained reuse: PASS",
  );
}

async function testRuntimeV4DiscoveryUsesHistoricalLogLane(): Promise<void> {
  const manager = ethers.getAddress(ADDR.UNISWAP_V4_POOL_MANAGER);
  const sourceBlock = UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 1_000;
  const initializeBlock = UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK + 100;
  const currency0 = address(0x9100);
  const currency1 = address(0x9101);
  const fee = 500;
  const tickSpacing = 10;
  const hooks = address(0);
  const poolId = v4PoolId({
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
  });
  const initIface = new ethers.Interface([
    "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
  ]);
  const swapIface = new ethers.Interface([
    "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
  ]);
  const initialize = initIface.encodeEventLog(
    initIface.getEvent("Initialize")!,
    [
      poolId,
      currency0,
      currency1,
      fee,
      tickSpacing,
      hooks,
      1n << 96n,
      0,
    ],
  );
  const swap = swapIface.encodeEventLog(swapIface.getEvent("Swap")!, [
    poolId,
    address(0xdead),
    1n,
    -1n,
    1n << 96n,
    1_000n,
    0,
    fee,
  ]);
  const initializeTopic = initialize.topics[0];
  const swapTopic = swap.topics[0];
  const sourceBlockHash = ethers.keccak256(
    ethers.toUtf8Bytes("split-horizon-source"),
  );
  let oldLogReadsOnCurrent = 0;
  let historicalLogReads = 0;
  const currentProvider = {
    getBlockNumber(): never {
      throw new Error("historical-lane fixture must stay source-pinned");
    },
    async send(
      method: string,
      args: Array<{
        address?: string;
        topics?: string[];
        fromBlock?: string;
      }>,
    ): Promise<unknown[]> {
      assert(method === "eth_getLogs", `unexpected current method ${method}`);
      const filter = args[0];
      if (
        filter.fromBlock !== undefined &&
        parseInt(filter.fromBlock, 16) < sourceBlock - 10
      ) {
        oldLogReadsOnCurrent++;
        throw new Error("old V4 Initialize range must use historical lane");
      }
      if (filter.address?.toLowerCase() !== manager.toLowerCase()) return [];
      if (filter.topics?.[0] === swapTopic) {
        return [{
          address: manager,
          topics: swap.topics,
          data: swap.data,
          blockNumber: ethers.toQuantity(sourceBlock),
        }];
      }
      return [];
    },
    async call(): Promise<string> {
      throw new Error("fixture PoolKey is not in PositionManager");
    },
  };
  const historicalLogProvider = {
    async send(
      method: string,
      args: Array<{ topics?: string[] }>,
    ): Promise<unknown> {
      if (method === "eth_getBlockByNumber") {
        return { hash: sourceBlockHash };
      }
      assert(method === "eth_getLogs", `unexpected historical method ${method}`);
      historicalLogReads++;
      return args[0].topics?.[0] === initializeTopic
        ? [{
            address: manager,
            topics: initialize.topics,
            data: initialize.data,
            blockNumber: ethers.toQuantity(initializeBlock),
          }]
        : [];
    },
  };
  const discovered = await scanActivePools(
    currentProvider as never,
    10,
    10,
    sourceBlock,
    {
      historicalLogProvider: historicalLogProvider as never,
      historicalLogAnchor: {
        blockNumber: sourceBlock,
        blockHash: sourceBlockHash,
      },
    },
  );
  assert(
    discovered.some((pool) =>
      pool.adapter === "univ4" && pool.poolId === poolId
    ),
    "missing retained V4 PoolKey should resolve through the historical log lane",
  );
  assert(
    oldLogReadsOnCurrent === 0 && historicalLogReads > 0,
    "only historical Initialize reads may leave the current-state provider",
  );
  let misalignedLogReads = 0;
  let rejectedMisalignment = false;
  const misalignedHistoricalProvider = {
    async send(method: string): Promise<unknown> {
      if (method === "eth_getBlockByNumber") {
        return {
          hash: ethers.keccak256(ethers.toUtf8Bytes("wrong-source")),
        };
      }
      misalignedLogReads++;
      return [];
    },
  };
  try {
    await scanActivePools(
      currentProvider as never,
      10,
      10,
      sourceBlock,
      {
        historicalLogProvider: misalignedHistoricalProvider as never,
        historicalLogAnchor: {
          blockNumber: sourceBlock,
          blockHash: sourceBlockHash,
        },
        strict: true,
      },
    );
  } catch (err) {
    rejectedMisalignment =
      err instanceof Error && err.message.includes("not aligned");
  }
  assert(
    rejectedMisalignment && misalignedLogReads === 0,
    "historical lane must fail closed before reading logs when the source hash differs",
  );
  console.log("[universe-split] runtime v4 split-horizon history: PASS");
}

async function main(): Promise<void> {
  testBackrunIsBasePoolsAsIs();
  testBlockscanSupersetAndOverrides();
  testUniverseCapAndScoreSort();
  testNoDuplicateAddresses();
  testV4SingletonUsesPoolIdentity();
  testHashesDeterministicAndSensitive();
  testEdgeKindFromPoolEntry();
  testTokenGraphHash();
  await testPinnedDiscoveryCutoff();
  await testRuntimeV4DiscoveryKeepsPoolIds();
  await testRuntimeV4DiscoveryUsesHistoricalLogLane();
  console.log("universe-split PASS (11/11)");
}

await main();
