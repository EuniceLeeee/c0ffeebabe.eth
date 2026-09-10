import assert from "node:assert/strict";
import { once } from "node:events";
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
import { Worker } from "node:worker_threads";
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
      pass.recordExact(routeB, {
        index: 1,
        status: "failed",
        marginBps: null,
        attempted: false,
        failure: {
          reason: "instance_circuit_open",
          familyIds: ["adapter-c"],
          attributedFamilyId: "adapter-c",
          attributedInstanceCircuitKey: "adapter-c:0xpool",
          blockingCircuitScope: "instance",
          stage: null,
          causeName: null,
          causeCode: null,
          causeKind: null,
        },
      });
      pass.recordExact(routeA, {
        index: 0,
        status: "positive",
        marginBps: 125,
        wallMs: 201,
        attempted: true,
        failure: null,
      });
      pass.recordPlanner(routeA);
      pass.recordSolver(routeA);
      pass.finish({
        sourceBlockHash: `0x${"ab".repeat(32)}`,
        midSourceBlock: 99,
        midSourceBlockHash: `0x${"cd".repeat(32)}`,
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
      assert.ok(catalogs.every((row) => row.schema_version === 2));
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
      assert.deepEqual(catalogs[0]!.edge_ids, blockScanRouteLocator(routeA).edgeIds);
      assert.deepEqual(catalogs[1]!.edge_ids, blockScanRouteLocator(routeB).edgeIds);
      assert.deepEqual(blocks[0], {
        type: "block_scan_enumeration_solver",
        schema_version: 2,
        run_id: "run-functional",
        catalog_epoch: 1,
        source_block: 100,
        source_block_hash: `0x${"ab".repeat(32)}`,
        mid_source_block: 99,
        mid_source_block_hash: `0x${"cd".repeat(32)}`,
        pricing_mode: "n_minus_one_coarse_current_n_exact",
        pass_outcome: "completed",
        pass_reason: null,
        enumeration: [1, 2],
        exact: [1, 1, 125, 0, 3, 0, null, 3],
        exact_probe_wall_ms: [201, null],
        planner: [1],
        solver: [1],
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
        schema_version: 2,
        run_id: "run-functional",
        catalog_epoch: 1,
        source_block: 101,
        source_block_hash: null,
        mid_source_block: null,
        mid_source_block_hash: null,
        pricing_mode: null,
        pass_outcome: "not_started",
        pass_reason: "scheduler_coalesced",
        enumeration: [],
        exact: [],
        planner: [],
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

test("worker preserves amount-cap evidence, healthy siblings, and legacy reason codes", async () => {
  await withTempDir(async (dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const routePath = join(dir, "blockscan-routes.jsonl");
    await writeFile(eventsPath, '{"type":"searcher_start"}\n');
    const reasons = [
      "exact_not_admitted", "family_circuit_open", "instance_circuit_open",
      "composite_circuit_open", "probe_timeout", "global_deadline", "quote_error",
      "amount_reference_over_cap",
    ] as const;
    const routes = Array.from({ length: reasons.length + 1 }, (_, index) =>
      opportunity(100, [edge("adapter-a", address(301 + index), address(1), address(2))])
    );
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath, eventsPath, runId: "run-exact-reason-codes", minFreeBytes: 1,
    });
    try {
      const pass = sink.beginPass(100);
      assert.ok(pass);
      pass.recordEnumeration(routes);
      // Cap exclusions arrive before healthy quotes, regardless of route rank.
      for (let index = reasons.length - 1; index >= 0; index--) {
        pass.recordExact(routes[index + 1]!, {
          index: index + 1, status: "unprobed", attempted: false, marginBps: null,
          failure: {
            reason: reasons[index]!, familyIds: [], attributedFamilyId: null,
            attributedInstanceCircuitKey: null, blockingCircuitScope: null,
            stage: null, causeName: null, causeCode: null, causeKind: null,
          },
        });
      }
      pass.recordExact(routes[0]!, {
        index: 0, status: "positive", attempted: true, marginBps: 125, failure: null,
      });
      pass.recordPlanner(routes[0]!);
      pass.recordSolver(routes[0]!);
      pass.finish({
        sourceBlockHash: "0xsource100", midSourceBlock: 99,
        midSourceBlockHash: "0xsource99", pricingMode: "source_n",
        passOutcome: "ran", passReason: null,
      });
    } finally {
      await sink.shutdown(5_000);
    }
    const records = await readJsonl(routePath);
    const catalogs = records.filter((row) => row.type === "block_scan_route_catalog");
    const blocks = records.filter((row) => row.type === "block_scan_enumeration_solver");
    assert.equal(catalogs.length, routes.length);
    assert.equal(blocks.length, 1);
    assert.deepEqual(catalogs.map((row) => row.route_id), routes.map((route) => blockScanRouteId(route.seedEdges)));
    assert.deepEqual(blocks[0]!.enumeration, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(blocks[0]!.exact, [
      1, 1, 125, 0,
      4, 0, null, 1, 4, 0, null, 2, 4, 0, null, 3, 4, 0, null, 4,
      4, 0, null, 5, 4, 0, null, 6, 4, 0, null, 7, 4, 0, null, 8,
    ]);
    assert.deepEqual(blocks[0]!.planner, [1]);
    assert.deepEqual(blocks[0]!.solver, [1]);
    assert.equal(blocks[0]!.dropped_batches, undefined);
    assert.equal(sink.telemetry().droppedBatches, 0);
    assert.equal(sink.telemetry().acknowledged, 1);
    assert.equal(sink.telemetry().failed, false);
    await assertMissing(`${routePath}.lock`);
  });
});

test("worker rejects unknown compact exact reason code 9 without writing route evidence", async () => {
  await withTempDir(async (dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const routePath = join(dir, "blockscan-routes.jsonl");
    await writeFile(eventsPath, '{"type":"searcher_start"}\n');
    const worker = new Worker(new URL("../blockscan-enumeration-solver-worker.ts", import.meta.url), {
      execArgv: ["--import", "tsx"],
      workerData: {
        routePath, eventsPath, midHistoryPath: "", runId: "run-invalid-exact-code",
        maxFileBytes: 1_048_576, maxMidFileBytes: 1_048_576,
        maxMidRecordBytes: 1_048_576, maxCatalogEntries: 10,
        minFreeBytes: 1, epochMs: 60_000, maxEncodedBatchBytes: 1_048_576,
      },
    });
    const signal = AbortSignal.timeout(5_000);
    try {
      const [ready] = await once(worker, "message", { signal });
      assert.deepEqual(ready, { type: "ready", enabled: true });
      const reply = once(worker, "message", { signal });
      worker.postMessage({
        type: "batch",
        batch: {
          kind: "route", sequence: 1, sourceBlock: 100,
          sourceBlockHash: "0xsource100", midSourceBlock: 99,
          midSourceBlockHash: "0xsource99", pricingMode: "source_n",
          passOutcome: "ran", passReason: null, gapBefore: null,
          routes: [blockScanRouteLocator(opportunity(100, [
            edge("adapter-a", address(301), address(1), address(2)),
          ]))],
          enumeration: [0], exact: [4, 0, null, 9], planner: [], solver: [],
        },
      });
      const [ack] = await reply;
      assert.equal(ack.type, "ack");
      assert.equal(ack.sequence, 1);
      assert.equal(ack.ok, false);
      assert.match(ack.reason, /route telemetry batch has invalid route index/);
      assert.equal(ack.bytesWritten, 0);
      assert.equal(await readFile(routePath, "utf8"), "");
    } finally {
      const stopped = once(worker, "exit", { signal: AbortSignal.timeout(5_000) });
      worker.postMessage({ type: "shutdown" });
      await stopped;
    }
    await assertMissing(`${routePath}.lock`);
  });
});

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

test("full coarse catalog includes capped routes without changing Exact alignment", async () => {
  await withTempDir(async (dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const routePath = join(dir, "routes.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath, eventsPath, runId: "full-coarse", minFreeBytes: 1,
    });
    const all = Array.from({ length: 646 }, (_, index) => opportunity(199, [
      edge("adapter-a", address(1_000 + index), address(1), address(2)),
      edge("adapter-b", address(2_000 + index), address(2), address(1)),
    ]));
    // N-1 rebasing can omit a coarse-selected route and replace object identities.
    const forwarded = all.slice(1, 512).map((route) => ({ ...route, sourceBlock: 200 }));
    const pass = sink.beginPass(200);
    assert.ok(pass);
    pass.recordEnumeration(forwarded, all, 512);
    for (let index = forwarded.length - 1; index >= 0; index--) {
      pass.recordExact(forwarded[index]!, {
        index, status: "positive", marginBps: index + 10,
        attempted: true, failure: null,
      });
    }
    pass.recordPlanner(forwarded[0]!);
    pass.recordSolver(forwarded[0]!);
    pass.finish({ sourceBlockHash: `0x${"12".repeat(32)}`, midSourceBlock: 199,
      midSourceBlockHash: `0x${"34".repeat(32)}`, pricingMode: "n_minus_one_coarse_current_n_exact",
      passOutcome: "ran", passReason: null });
    await sink.shutdown(5_000);
    const rows = await readJsonl(routePath);
    const catalogs = rows.filter((row) => row.type === "block_scan_route_catalog");
    const lifecycle = rows.find((row) => row.type === "block_scan_enumeration_solver")!;
    const byRef = new Map(catalogs.map((row) => [row.route_ref, row]));
    assert.equal(catalogs.length, 646);
    assert.equal(lifecycle.coarse_selected_count, 512);
    assert.deepEqual((lifecycle.coarse_enumeration as number[]).map(
      (ref) => byRef.get(ref)!.route_id,
    ), all.map((route) => blockScanRouteId(route.seedEdges)));
    assert.deepEqual((lifecycle.enumeration as number[]).map(
      (ref) => byRef.get(ref)!.route_id,
    ), forwarded.map((route) => blockScanRouteId(route.seedEdges)));
    assert.deepEqual(lifecycle.exact, forwarded.flatMap((_, index) => [1, 1, index + 10, 0]));
    assert.deepEqual(lifecycle.planner, [1]);
    assert.deepEqual(lifecycle.solver, [1]);
    assert.equal(sink.telemetry().droppedBatches, 0);
  });
});

test("malformed or oversized coarse evidence drops visibly, never silently truncates", async () => {
  const a = opportunity(200, [edge("adapter-a", address(301), address(1), address(2))]);
  const b = opportunity(200, [edge("adapter-b", address(302), address(2), address(1))]);
  for (const [all, count] of [
    [[a, b], 0], [[a, b], 3], [[a, b], 0.5], [[a, a], 1],
    [[b, a], 1], [undefined, 1], [Array(2_049).fill(a), 1],
  ] as const) await withTempDir(async (dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const routePath = join(dir, "routes.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath, eventsPath, runId: "invalid-coarse", minFreeBytes: 1,
    });
    const pass = sink.beginPass(200);
    assert.ok(pass);
    pass.recordEnumeration([a], all, count);
    pass.finish({ sourceBlockHash: null, pricingMode: null,
      midSourceBlock: null, midSourceBlockHash: null,
      passOutcome: "cancelled", passReason: "new_head" });
    sink.recordNotStarted({ sourceBlock: 201, sourceBlockHash: null,
      pricingMode: null, passOutcome: "not_started", passReason: "scheduler_coalesced" });
    await sink.shutdown(5_000);
    const rows = await readJsonl(routePath);
    assert.equal(rows.length, 1, "invalid batch must not persist a partial route catalog");
    assert.equal(rows[0]!.source_block, 201);
    assert.equal(rows[0]!.dropped_batches, 1);
    assert.equal(rows[0]!.first_dropped_block, 200);
    assert.equal(sink.telemetry().droppedBatches, 1);
  });
});

test("encoded overflow drops only that batch, restores prior gaps, and keeps the writer usable", async () => {
  await withTempDir(async (dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const routePath = join(dir, "routes.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath, eventsPath, runId: "encoded-overflow", minFreeBytes: 1,
      maxBatchBytes: 100_000,
    });
    const all = Array.from({ length: 100 }, (_, index) => opportunity(199, [
      edge("adapter-a", address(1_000 + index), address(1), address(2)),
      edge("adapter-b", address(2_000 + index), address(2), address(1)),
    ]));
    const finish = { sourceBlockHash: null, midSourceBlock: null,
      midSourceBlockHash: null, pricingMode: null,
      passOutcome: "cancelled", passReason: "new_head" };
    const invalid = sink.beginPass(198)!;
    invalid.recordEnumeration([all[0]!], all, -1);
    invalid.finish(finish);
    const oversized = sink.beginPass(199)!;
    oversized.recordEnumeration([all[0]!], all, 1);
    oversized.finish(finish);
    assert.equal(sink.telemetry().scheduled, 1,
      "oversized encoded payload must pass main-thread estimate and reach the real worker");
    const next = sink.beginPass(200)!;
    next.recordEnumeration([all[0]!], [all[0]!], 1);
    next.finish(finish);
    await sink.shutdown(5_000);
    assert.equal(sink.telemetry().failed, false);
    assert.equal(sink.telemetry().droppedBatches, 2);
    const rows = await readJsonl(routePath);
    assert.equal(rows.length, 2, "discarded staged catalogs must never be published");
    assert.equal(rows[0]!.route_ref, 1, "discarded batch must not consume refs");
    assert.equal(rows[1]!.source_block, 200);
    assert.equal(rows[1]!.dropped_batches, 2);
    assert.equal(rows[1]!.first_dropped_block, 198);
    assert.equal(rows[1]!.last_dropped_block, 199);
  });
});

test("invalid probe timings are dropped with the existing writer gap", async () => {
  for (const wallMs of [-1, NaN, Infinity]) await withTempDir(async (dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const routePath = join(dir, "routes.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath, eventsPath, runId: "invalid-timing", minFreeBytes: 1,
    });
    const route = opportunity(200, [edge("adapter-a", address(301), address(1), address(2))]);
    const pass = sink.beginPass(200);
    assert.ok(pass);
    pass.recordEnumeration([route]);
    pass.recordExact(route, { index: 0, status: "positive", marginBps: 10,
      attempted: true, failure: null, wallMs });
    pass.finish({ sourceBlockHash: `0x${"12".repeat(32)}`, midSourceBlock: 200,
      midSourceBlockHash: `0x${"12".repeat(32)}`, pricingMode: "source_n",
      passOutcome: "ran", passReason: null });
    sink.recordNotStarted({ sourceBlock: 201, sourceBlockHash: null,
      pricingMode: null, passOutcome: "not_started", passReason: "scheduler_coalesced" });
    await sink.shutdown(5_000);
    const rows = await readJsonl(routePath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.source_block, 201);
    assert.equal(rows[0]!.dropped_batches, 1);
    assert.equal(sink.telemetry().droppedBatches, 1);
  });
});

test("partial exact evidence drops the whole pass and persists a writer gap", async () => {
  await withTempDir(async (dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const routePath = join(dir, "blockscan-routes.jsonl");
    await writeFile(eventsPath, '{"type":"searcher_start"}\n');
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath,
      eventsPath,
      runId: "run-partial-exact",
      minFreeBytes: 1,
    });
    const routeA = opportunity(200, [
      edge("adapter-a", address(301), address(1), address(2)),
    ]);
    const routeB = opportunity(200, [
      edge("adapter-b", address(302), address(2), address(1)),
    ]);
    const pass = sink.beginPass(200);
    assert.ok(pass);
    pass.recordEnumeration([routeA, routeB]);
    pass.recordExact(routeA, {
      index: 0,
      status: "positive",
      marginBps: 10,
      attempted: true,
      failure: null,
    });
    pass.finish({
      sourceBlockHash: `0x${"12".repeat(32)}`,
      midSourceBlock: 199,
      midSourceBlockHash: `0x${"34".repeat(32)}`,
      pricingMode: "n_minus_one_coarse_current_n_exact",
      passOutcome: "ran",
      passReason: null,
    });
    sink.recordNotStarted({
      sourceBlock: 201,
      sourceBlockHash: null,
      pricingMode: null,
      passOutcome: "not_started",
      passReason: "scheduler_coalesced",
    });
    await sink.shutdown(5_000);

    const records = await readJsonl(routePath);
    assert.equal(records.length, 1, "invalid pass must persist no partial catalog");
    assert.equal(records[0]!.source_block, 201);
    assert.equal(records[0]!.dropped_batches, 1);
    assert.equal(records[0]!.first_dropped_block, 200);
    assert.equal(records[0]!.last_dropped_block, 200);
  });
});

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
