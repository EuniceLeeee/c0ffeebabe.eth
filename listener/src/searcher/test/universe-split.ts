import type { PoolEntry, TokenEdge } from "../planner/token-graph.js";
import { indexFactoryPools, scanActivePools } from "../active-pool-discovery.js";
import { buildStrategyViews, hashTokenGraph } from "../strategy-views.js";
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
  console.log("universe-split PASS (9/9)");
}

await main();
