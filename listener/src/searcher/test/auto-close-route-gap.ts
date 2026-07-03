import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  autoCloseRouteGap,
  type AutoCloseRouteGapResult,
} from "../auto-close-route-gap.js";
import {
  backfillV4PoolId,
  type V4BackfillOptions,
} from "../backfill-v4-poolid.js";
import { loadForceIncludePoolIds } from "../force-include.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertArrayEq(actual: string[], expected: string[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((item, i) => item === expected[i]),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const CFG = ethers.getAddress("0xcccccccccc33d538dbc2ee4feab0a7a1ff4e8a94");
const CFG_V4_POOL_ID = "0x267d01a3b23fe2340482242db5396f7544d36f398862efa591e92a079348cd9c";
const CFG_V4_POOL_KEY = {
  currency0: ethers.ZeroAddress,
  currency1: CFG,
  fee: 10001,
  tickSpacing: 200,
  hooks: ethers.ZeroAddress,
};
const V3_POOL = ethers.getAddress("0x08a10a8b713c03e2fecaa3e355cea18a459ffcbf");

// Real bundle-postmortem schema: the winner's per-pool coverage is analyzed_competitors[].touchedVenues[].
function writeReport(
  path: string,
  routeGapDecisive: boolean,
  touchedVenues: Array<Record<string, unknown>>,
): void {
  writeFileSync(
    path,
    JSON.stringify({
      verdict: { route_gap_decisive: routeGapDecisive, winner: "0xwinner" },
      analyzed_competitors: [
        { hash: "0xwinner", transactionIndex: 25, touchedVenues },
      ],
    }, null, 2) + "\n",
  );
}

function fakeV4Provider(): { provider: ethers.JsonRpcProvider; calls: () => number } {
  let callCount = 0;
  const provider = {
    async send(method: string, params: unknown[]) {
      callCount++;
      assert(method === "eth_call", `expected eth_call, got ${method}`);
      const [call, blockTag] = params as [{ to: string; data: string }, string];
      assert(
        ethers.getAddress(call.to) === ethers.getAddress(ADDR.UNISWAP_V4_POSITION_MANAGER),
        "backfill should query PositionManager",
      );
      assert(blockTag === "latest", "backfill should query latest state");
      assert(
        call.data === "0x86b6be7d" + CFG_V4_POOL_ID.slice(2, 52).padEnd(64, "0"),
        "backfill should call poolKeys(bytes25) for the candidate poolId",
      );
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "uint24", "int24", "address"],
        [
          CFG_V4_POOL_KEY.currency0,
          CFG_V4_POOL_KEY.currency1,
          CFG_V4_POOL_KEY.fee,
          CFG_V4_POOL_KEY.tickSpacing,
          CFG_V4_POOL_KEY.hooks,
        ],
      );
    },
  } as unknown as ethers.JsonRpcProvider;
  return { provider, calls: () => callCount };
}

async function runWithLogs(
  reportPath: string,
  activePoolsPath: string,
  forceIncludePath: string,
  provider: ethers.JsonRpcProvider,
): Promise<{ result: AutoCloseRouteGapResult; logs: string[] }> {
  const logs: string[] = [];
  const result = await autoCloseRouteGap({
    reportPath,
    activePoolsPath,
    forceIncludePath,
    backfillV4PoolIdFn: (poolId: string, opts: V4BackfillOptions) =>
      backfillV4PoolId(poolId, { ...opts, provider }),
    log: (line: string) => logs.push(line),
  });
  return { result, logs };
}

async function testRouteGapV4AppendsAndBackfills(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "auto-close-route-gap-v4-"));
  try {
    const report = join(dir, "postmortem.json");
    const activePools = join(dir, "active-pools.json");
    const forceInclude = join(dir, "force-include-poolids.json");
    writeReport(report, true, [
      {
        protocol: "univ4",
        id: "0x" + CFG_V4_POOL_ID.slice(2).toUpperCase(),
        in_graph: false,
      },
    ]);

    const fake = fakeV4Provider();
    const first = await runWithLogs(report, activePools, forceInclude, fake.provider);
    assertArrayEq(
      loadForceIncludePoolIds(forceInclude),
      [CFG_V4_POOL_ID],
      "route_gap_decisive v4 candidate should be appended to force-include",
    );
    assertArrayEq(first.result.closedV4PoolIds, [CFG_V4_POOL_ID], "v4 candidate should be backfilled");
    assertArrayEq(first.result.forceIncludeAdded, [CFG_V4_POOL_ID], "v4 candidate should be newly force-included");
    assert(fake.calls() === 1, `expected one PositionManager resolver call, got ${fake.calls()}`);

    const active = JSON.parse(readFileSync(activePools, "utf8")) as { pools: Array<{ poolId?: string }> };
    assert(active.pools.some((pool) => pool.poolId === CFG_V4_POOL_ID), "active-pools should contain the v4 poolId");
    console.log("[auto-close] route_gap true v4 missing poolId appends + backfills: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testRouteGapFalseNoops(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "auto-close-route-gap-noop-"));
  try {
    const report = join(dir, "postmortem.json");
    const activePools = join(dir, "active-pools.json");
    const forceInclude = join(dir, "force-include-poolids.json");
    const unchanged = JSON.stringify([CFG_V4_POOL_ID], null, 2) + "\n";
    writeFileSync(forceInclude, unchanged);
    writeReport(report, false, [
      { protocol: "univ4", id: CFG_V4_POOL_ID, in_graph: false },
    ]);

    const fake = fakeV4Provider();
    const { result, logs } = await runWithLogs(report, activePools, forceInclude, fake.provider);
    assert(!result.routeGapDecisive, "route_gap false result should be marked no-op");
    assert(readFileSync(forceInclude, "utf8") === unchanged, "route_gap false should not rewrite force-include");
    assert(fake.calls() === 0, "route_gap false should not call backfill");
    assert(logs.includes("no route_gap_decisive, nothing to close"), "route_gap false should log no-op");
    console.log("[auto-close] route_gap false no-op leaves force-include unchanged: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testAlreadyInGraphSkips(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "auto-close-route-gap-ingraph-"));
  try {
    const report = join(dir, "postmortem.json");
    const activePools = join(dir, "active-pools.json");
    const forceInclude = join(dir, "force-include-poolids.json");
    const unchanged = JSON.stringify([], null, 2) + "\n";
    writeFileSync(forceInclude, unchanged);
    writeReport(report, true, [
      { protocol: "univ4", id: CFG_V4_POOL_ID, in_graph: true },
    ]);

    const fake = fakeV4Provider();
    const { result } = await runWithLogs(report, activePools, forceInclude, fake.provider);
    assert(result.routeGapDecisive, "route_gap true result should remain decisive");
    assertArrayEq(result.forceIncludeAdded, [], "in-graph candidate should not append");
    assert(readFileSync(forceInclude, "utf8") === unchanged, "in-graph candidate should not rewrite force-include");
    assert(fake.calls() === 0, "in-graph candidate should not call backfill");
    console.log("[auto-close] already-in-graph candidate skipped: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testV3AppendsAndLogsActivePoolsNote(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "auto-close-route-gap-v3-"));
  try {
    const report = join(dir, "postmortem.json");
    const activePools = join(dir, "active-pools.json");
    const forceInclude = join(dir, "force-include-poolids.json");
    writeReport(report, true, [
      { protocol: "univ3", id: V3_POOL.toLowerCase(), in_graph: false },
    ]);

    const fake = fakeV4Provider();
    const { result, logs } = await runWithLogs(report, activePools, forceInclude, fake.provider);
    assertArrayEq(
      loadForceIncludePoolIds(forceInclude),
      [V3_POOL],
      "v3 missing pool should be appended to force-include",
    );
    assertArrayEq(result.forceIncludeAdded, [V3_POOL], "v3 missing pool should count as force-include append");
    assert(
      result.needsActivePools.includes(`needs_active_pools:${V3_POOL}`),
      "v3 missing pool should record active-pools follow-up",
    );
    assert(
      logs.includes(`needs_active_pools:${V3_POOL}`),
      "v3 missing pool should log active-pools follow-up",
    );
    assert(fake.calls() === 0, "v3 missing pool should not call v4 backfill");
    console.log("[auto-close] v3 missing pool appends and logs active-pools note: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testIdempotentRunningTwiceAppendsOnce(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "auto-close-route-gap-idempotent-"));
  try {
    const report = join(dir, "postmortem.json");
    const activePools = join(dir, "active-pools.json");
    const forceInclude = join(dir, "force-include-poolids.json");
    writeReport(report, true, [
      { protocol: "univ4", id: CFG_V4_POOL_ID, in_graph: false },
    ]);

    const fake = fakeV4Provider();
    await runWithLogs(report, activePools, forceInclude, fake.provider);
    const second = await runWithLogs(report, activePools, forceInclude, fake.provider);
    assertArrayEq(
      loadForceIncludePoolIds(forceInclude),
      [CFG_V4_POOL_ID],
      "running twice should leave one force-include entry",
    );
    assertArrayEq(second.result.closedV4PoolIds, [], "second run should not backfill an existing active pool");
    assertArrayEq(second.result.forceIncludeAdded, [], "second run should not append a duplicate force-include entry");
    assert(fake.calls() === 1, `idempotent active-pools skip should avoid second resolver call, got ${fake.calls()}`);
    console.log("[auto-close] idempotent repeat appends once and backfills once: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testRouteGapV4AppendsAndBackfills();
  await testRouteGapFalseNoops();
  await testAlreadyInGraphSkips();
  await testV3AppendsAndLogsActivePoolsNote();
  await testIdempotentRunningTwiceAppendsOnce();
  console.log(
    "expected_transition: route_gap_decisive post-mortem output -> " +
      "auto-appended force-include (loop improve-half closes automatically)",
  );
  console.log("verdict: fixed");
  console.log("auto-close-route-gap PASS (5/5)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
