import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  link,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BlockScanOpportunity } from "../detector/detector.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  blockScanRouteId,
  blockScanRouteLocator,
} from "../blockscan-route-identity.js";
import { initBlockScanEnumerationSolverTelemetry } from
  "../blockscan-enumeration-solver-telemetry.js";

test(
  "worker truncates on startup, writes ordered Enumeration/Solver refs, and cleans its lock",
  async () => {
    await withTempDir(async (dir) => {
      const eventsPath = join(dir, "events.jsonl");
      const routePath = join(dir, "blockscan-routes.jsonl");
      const formalEvents = '{"type":"searcher_start","run_id":"run-functional"}\n';
      await writeFile(eventsPath, formalEvents);
      await writeFile(routePath, "stale route data from an earlier process\n");

      const first = await initBlockScanEnumerationSolverTelemetry({
        path: routePath,
        eventsPath,
        runId: "run-functional",
        minFreeBytes: 1,
      });
      assert.equal(first.enabled, true);
      assert.equal(
        await readFile(routePath, "utf8"),
        "",
        "worker ready must mean stale sidecar content is already truncated",
      );
      assert.equal(
        await readFile(eventsPath, "utf8"),
        formalEvents,
        "route startup must not alter formal events",
      );

      const routeA = opportunity(
        100,
        [
          edge("adapter-a", address(101), address(1), address(2)),
          edge("adapter-b", address(102), address(2), address(1)),
        ],
      );
      const routeB = opportunity(
        100,
        [
          edge("adapter-c", address(103), address(1), address(3)),
          edge("adapter-d", address(104), address(3), address(1)),
        ],
      );
      const pass = first.beginPass(100);
      assert.ok(pass);
      pass.recordEnumeration([routeA, routeB]);
      pass.recordSolver(routeB);
      pass.recordSolver(routeA);
      pass.finish({
        sourceBlockHash: `0x${"ab".repeat(32)}`,
        pricingMode: "n_minus_one_coarse_current_n_exact",
        passOutcome: "completed",
        passReason: null,
      });
      first.recordNotStarted({
        sourceBlock: 101,
        sourceBlockHash: null,
        pricingMode: null,
        passOutcome: "not_started",
        passReason: "scheduler_coalesced",
      });
      await first.shutdown(5_000);

      const rawRouteEvents = await readFile(routePath, "utf8");
      const routeEventLines = rawRouteEvents.trimEnd().split("\n");
      const records = routeEventLines.map(
        (line) => JSON.parse(line) as Record<string, unknown>,
      );
      const catalogs = records.filter((row) =>
        row.type === "block_scan_route_catalog"
      );
      const blocks = records.filter((row) =>
        row.type === "block_scan_enumeration_solver"
      );
      assert.equal(catalogs.length, 2);
      assert.equal(blocks.length, 2);
      assert.deepEqual(
        catalogs.map((row) => ({
          ref: row.route_ref,
          routeId: row.route_id,
        })),
        [
          { ref: 1, routeId: blockScanRouteId(routeA.seedEdges) },
          { ref: 2, routeId: blockScanRouteId(routeB.seedEdges) },
        ],
      );
      assert.deepEqual(blocks[0], {
        type: "block_scan_enumeration_solver",
        schema_version: 1,
        run_id: "run-functional",
        catalog_epoch: 1,
        source_block: 100,
        source_block_hash: `0x${"ab".repeat(32)}`,
        pricing_mode: "n_minus_one_coarse_current_n_exact",
        pass_outcome: "completed",
        pass_reason: null,
        enumeration: [1, 2],
        solver: [2, 1],
        encoded_bytes: blocks[0]!.encoded_bytes,
      });
      assert.equal(typeof blocks[0]!.encoded_bytes, "number");
      assert.ok((blocks[0]!.encoded_bytes as number) > 0);
      assert.equal(
        blocks[0]!.encoded_bytes,
        Buffer.byteLength(`${routeEventLines.slice(0, 3).join("\n")}\n`),
        "encoded_bytes must include the new catalog and lifecycle lines exactly",
      );
      assert.deepEqual(blocks[1], {
        type: "block_scan_enumeration_solver",
        schema_version: 1,
        run_id: "run-functional",
        catalog_epoch: 1,
        source_block: 101,
        source_block_hash: null,
        pricing_mode: null,
        pass_outcome: "not_started",
        pass_reason: "scheduler_coalesced",
        enumeration: [],
        solver: [],
        encoded_bytes: blocks[1]!.encoded_bytes,
      });
      assert.equal(
        blocks[1]!.encoded_bytes,
        Buffer.byteLength(`${routeEventLines[3]}\n`),
        "encoded_bytes must equal the exact persisted lifecycle payload",
      );
      assert.equal(await readFile(eventsPath, "utf8"), formalEvents);
      await assertMissing(`${routePath}.lock`);

      const restarted = await initBlockScanEnumerationSolverTelemetry({
        path: routePath,
        eventsPath,
        runId: "run-restarted",
        minFreeBytes: 1,
      });
      assert.equal(restarted.enabled, true);
      assert.equal(
        await readFile(routePath, "utf8"),
        "",
        "each process restart must remove the previous process sidecar",
      );
      restarted.recordNotStarted({
        sourceBlock: 102,
        sourceBlockHash: null,
        pricingMode: null,
        passOutcome: "not_started",
        passReason: "shutdown_pending_dropped",
      });
      await restarted.shutdown(5_000);

      const restartedRecords = await readJsonl(routePath);
      assert.equal(restartedRecords.length, 1);
      assert.equal(restartedRecords[0]!.run_id, "run-restarted");
      assert.equal(restartedRecords[0]!.source_block, 102);
      assert.equal(restartedRecords[0]!.pricing_mode, null);
      assert.equal(await readFile(eventsPath, "utf8"), formalEvents);
      await assertMissing(`${routePath}.lock`);
    });
  },
);

test(
  "route identity is stable and changes with venue or direction",
  () => {
    const baseEdges = [
      edge("adapter-a", address(201), address(10), address(11)),
      edge("adapter-b", address(202), address(11), address(10)),
    ];
    const identicalEdges = baseEdges.map((item) => ({ ...item }));
    const changedVenue = [
      { ...baseEdges[0]!, target: address(203) },
      baseEdges[1]!,
    ];
    const reversedDirection = [
      edge("adapter-b", address(202), address(10), address(11)),
      edge("adapter-a", address(201), address(11), address(10)),
    ];

    assert.equal(blockScanRouteId(baseEdges), blockScanRouteId(identicalEdges));
    assert.notEqual(blockScanRouteId(baseEdges), blockScanRouteId(changedVenue));
    assert.notEqual(
      blockScanRouteId(baseEdges),
      blockScanRouteId(reversedDirection),
    );
    assert.deepEqual(
      blockScanRouteLocator(opportunity(200, baseEdges)),
      blockScanRouteLocator(opportunity(200, identicalEdges)),
    );
  },
);

test(
  "same-path and hardlink aliases disable without truncating formal events",
  async () => {
    await withTempDir(async (dir) => {
      const eventsPath = join(dir, "events.jsonl");
      const hardlinkPath = join(dir, "route-hardlink.jsonl");
      const formalEvents = '{"type":"formal","payload":"must-survive"}\n';
      await writeFile(eventsPath, formalEvents);

      const samePathWarnings: string[] = [];
      const samePath = await initBlockScanEnumerationSolverTelemetry({
        path: eventsPath,
        eventsPath,
        runId: "run-same-path",
        minFreeBytes: 1,
        onWarning: (message) => samePathWarnings.push(message),
      });
      assert.equal(samePath.enabled, false);
      assert.match(samePathWarnings.join("\n"), /equals SEARCHER_EVENTS_PATH/);
      assert.equal(await readFile(eventsPath, "utf8"), formalEvents);

      await link(eventsPath, hardlinkPath);
      const hardlinkWarnings: string[] = [];
      const hardlink = await initBlockScanEnumerationSolverTelemetry({
        path: hardlinkPath,
        eventsPath,
        runId: "run-hardlink",
        minFreeBytes: 1,
        onWarning: (message) => hardlinkWarnings.push(message),
      });
      assert.equal(hardlink.enabled, false);
      assert.match(
        hardlinkWarnings.join("\n"),
        /one link|aliases formal events inode/,
      );
      assert.equal(await readFile(eventsPath, "utf8"), formalEvents);
      assert.equal(await readFile(hardlinkPath, "utf8"), formalEvents);
      await assertMissing(`${hardlinkPath}.lock`);
    });
  },
);

test(
  "worker construction and option failures disable telemetry without failing startup",
  async () => {
    await withTempDir(async (dir) => {
      const eventsPath = join(dir, "events.jsonl");
      const formalEvents = '{"type":"formal","payload":"must-survive"}\n';
      await writeFile(eventsPath, formalEvents);

      const optionWarnings: string[] = [];
      const invalidOptions = await initBlockScanEnumerationSolverTelemetry({
        path: join(dir, "invalid-options.jsonl"),
        eventsPath,
        runId: "run-invalid-options",
        queueCredits: 0,
        minFreeBytes: 1,
        onWarning: (message) => optionWarnings.push(message),
      });
      assert.equal(invalidOptions.enabled, false);
      assert.match(optionWarnings.join("\n"), /invalid queue credits/);

      const workerWarnings: string[] = [];
      const missingWorker = await initBlockScanEnumerationSolverTelemetry({
        path: join(dir, "missing-worker.jsonl"),
        eventsPath,
        runId: "run-missing-worker",
        workerUrl: new URL("file:///definitely/missing/route-worker.js"),
        minFreeBytes: 1,
        onWarning: (message) => workerWarnings.push(message),
      });
      assert.equal(missingWorker.enabled, false);
      assert.match(workerWarnings.join("\n"), /disabled:/);
      assert.equal(await readFile(eventsPath, "utf8"), formalEvents);
    });
  },
);

function edge(
  adapterId: string,
  target: string,
  tokenIn: string,
  tokenOut: string,
): TokenEdge {
  return {
    adapterId,
    target,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  };
}

function opportunity(
  sourceBlock: number,
  seedEdges: TokenEdge[],
): BlockScanOpportunity {
  return {
    kind: "block-scan-arb",
    sourceBlock,
    stateBlock: sourceBlock,
    cycleId: `cycle-${sourceBlock}-${blockScanRouteId(seedEdges)}`,
    cycleFingerprint: `fingerprint-${sourceBlock}-${blockScanRouteId(seedEdges)}`,
    seedEdges,
    flashToken: seedEdges[0]!.tokenIn,
    searchSeed: {
      startToken: seedEdges[0]!.tokenIn,
      searchCenter: 1n,
      maxInput: 2n,
    },
    leavesStandingPosition: false,
  };
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

async function readJsonl(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(
    access(path, constants.F_OK),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

async function withTempDir(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mev-route-telemetry-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
