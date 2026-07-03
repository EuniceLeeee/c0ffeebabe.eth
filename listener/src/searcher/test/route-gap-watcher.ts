import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  routeGapWatcher,
  type AutoCloseRunnerResult,
} from "../route-gap-watcher.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function assertArrayEq(actual: string[], expected: string[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((item, i) => item === expected[i]),
    `${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const TX_SUBMITTED = "0x" + "0".repeat(64);
const TX_A = "0x" + "a".repeat(64);
const TX_B = "0x" + "b".repeat(64);
const TX_C = "0x" + "c".repeat(64);
const POOL_A = "0x1111111111111111111111111111111111111111111111111111111111111111";
const POOL_C = "0x3333333333333333333333333333333333333333333333333333333333333333";

function writeJsonl(path: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

function writeReport(
  path: string,
  routeGapDecisive: boolean,
  poolId?: string,
): void {
  writeFileSync(
    path,
    JSON.stringify({
      verdict: { route_gap_decisive: routeGapDecisive },
      analyzed_competitors: poolId
        ? [
            {
              hash: "0xwinner",
              touchedVenues: [
                { protocol: "univ4", id: poolId, in_graph: false },
              ],
            },
          ]
        : [],
    }, null, 2) + "\n",
  );
}

function loadPending(path: string): Array<{ poolIds?: string[]; writtenAt?: string }> {
  return JSON.parse(readFileSync(path, "utf8")) as Array<{
    poolIds?: string[];
    writtenAt?: string;
  }>;
}

async function testRouteGapWatcherOrchestration(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "route-gap-watcher-"));
  try {
    const eventsPath = join(dir, "events.jsonl");
    const checkpointPath = join(dir, "checkpoint.json");
    const pendingDeployPath = join(dir, "pending-deploy.json");
    const reportsDir = join(dir, "reports");
    writeJsonl(eventsPath, [
      { type: "bundle_submitted", tx_hash: TX_SUBMITTED, target_block: 100 },
      { type: "bundle_not_included", tx_hash: TX_A, target_block: 101 },
      { type: "bundle_not_included", tx_hash: TX_B, target_block: 102 },
    ]);

    const postmortemCalls: string[] = [];
    const autoCloseCalls: string[] = [];
    const logs: string[] = [];
    const runPostmortem = async (txHash: string): Promise<string> => {
      postmortemCalls.push(txHash);
      const reportPath = join(reportsDir, `pm-${txHash.slice(2, 8)}.json`);
      if (txHash === TX_A) writeReport(reportPath, true, POOL_A);
      else if (txHash === TX_B) writeReport(reportPath, false);
      else if (txHash === TX_C) writeReport(reportPath, true, POOL_C);
      else throw new Error(`unexpected postmortem tx ${txHash}`);
      return reportPath;
    };
    const runAutoClose = async (reportPath: string): Promise<AutoCloseRunnerResult> => {
      autoCloseCalls.push(reportPath);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        analyzed_competitors: Array<{
          touchedVenues: Array<{ id: string }>;
        }>;
      };
      const poolId = report.analyzed_competitors[0]?.touchedVenues[0]?.id;
      assert(Boolean(poolId), "auto-close mock expected one missing poolId");
      return { closedV4PoolIds: [poolId], forceIncludeAdded: [poolId] };
    };

    const first = await routeGapWatcher({
      eventsPath,
      rpcUrl: "http://127.0.0.1:8545",
      checkpointPath,
      pendingDeployPath,
      reportsDir,
      runPostmortem,
      runAutoClose,
      log: (line) => logs.push(line),
      now: () => new Date("2026-07-03T00:00:00.000Z"),
    });

    assert(first.eventsScanned === 3, "first run should scan all three new events");
    assert(first.notIncludedSeen === 2, "first run should see two bundle_not_included events");
    assert(first.routeGapDecisive === 1, "only tx A should be route_gap_decisive");
    assert(first.routeGapsClosed === 1, "only tx A should auto-close a route gap");
    assert(first.pendingDeployWritten, "first run should write pending deploy marker");
    assertArrayEq(postmortemCalls, [TX_A, TX_B], "postmortem should run for A and B");
    assert(autoCloseCalls.length === 1, "auto-close should run only once");
    assert(autoCloseCalls[0].includes("pm-aaaaaa.json"), "auto-close should use tx A report");
    const firstPending = loadPending(pendingDeployPath);
    assert(firstPending.length === 1, "first run should append one pending-deploy entry");
    assertArrayEq(firstPending[0].poolIds ?? [], [POOL_A], "pending marker should contain tx A poolId");
    assert(firstPending[0].writtenAt === "2026-07-03T00:00:00.000Z", "pending marker should include timestamp");
    assert(
      logs.some((line) => line === `[route-gap-watcher] 1 poolIds closed, pending deploy: ${POOL_A}`),
      "first run should log closed poolIds",
    );
    assert(
      logs.some((line) =>
        line.includes("events_scanned=3") &&
        line.includes("not_included_seen=2") &&
        line.includes("route_gaps_closed=1") &&
        line.includes("pending_deploy_written=yes"),
      ),
      "first run should log summary",
    );
    console.log("[route-gap-watcher] chains decisive route gap to pending deploy: PASS");

    postmortemCalls.length = 0;
    autoCloseCalls.length = 0;
    logs.length = 0;
    const second = await routeGapWatcher({
      eventsPath,
      rpcUrl: "http://127.0.0.1:8545",
      checkpointPath,
      pendingDeployPath,
      reportsDir,
      runPostmortem,
      runAutoClose,
      log: (line) => logs.push(line),
      now: () => new Date("2026-07-03T00:01:00.000Z"),
    });

    assert(second.eventsScanned === 0, "second run should scan zero new events");
    assert(second.notIncludedSeen === 0, "second run should see zero not-included events");
    assert(!second.pendingDeployWritten, "second run should not write pending deploy marker");
    assertArrayEq(postmortemCalls, [], "second run should not rerun postmortem");
    assertArrayEq(autoCloseCalls, [], "second run should not rerun auto-close");
    assert(loadPending(pendingDeployPath).length === 1, "second run should not duplicate pending deploy entry");
    console.log("[route-gap-watcher] checkpoint idempotency skips already processed events: PASS");

    appendFileSync(
      eventsPath,
      JSON.stringify({ type: "bundle_not_included", tx_hash: TX_C, target_block: 103 }) + "\n",
    );
    postmortemCalls.length = 0;
    autoCloseCalls.length = 0;
    logs.length = 0;
    const third = await routeGapWatcher({
      eventsPath,
      rpcUrl: "http://127.0.0.1:8545",
      checkpointPath,
      pendingDeployPath,
      reportsDir,
      runPostmortem,
      runAutoClose,
      log: (line) => logs.push(line),
      now: () => new Date("2026-07-03T00:02:00.000Z"),
    });

    assert(third.eventsScanned === 1, "third run should scan only the appended event");
    assert(third.notIncludedSeen === 1, "third run should process the appended not-included event");
    assert(third.routeGapsClosed === 1, "third run should close the appended route gap");
    assertArrayEq(postmortemCalls, [TX_C], "third run should postmortem only tx C");
    assert(autoCloseCalls.length === 1, "third run should auto-close only tx C");
    const finalPending = loadPending(pendingDeployPath);
    assert(finalPending.length === 2, "third run should append exactly one new pending marker");
    assertArrayEq(finalPending[0].poolIds ?? [], [POOL_A], "first pending marker should remain unchanged");
    assertArrayEq(finalPending[1].poolIds ?? [], [POOL_C], "third run should add tx C poolId");
    console.log("[route-gap-watcher] appended event after checkpoint is processed once: PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testRouteGapWatcherOrchestration();
  console.log(
    "expected_transition: bundle_not_included event -> " +
      "(auto) diagnose+close -> pending-deploy marker",
  );
  console.log("verdict: fixed");
  console.log("route-gap-watcher PASS (3/3)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
