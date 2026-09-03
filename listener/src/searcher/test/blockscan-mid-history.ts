import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  initBlockScanEnumerationSolverTelemetry,
} from "../blockscan-enumeration-solver-telemetry.js";
import type { StrictPricingPublication } from
  "../strict-current-runtime-coordinator.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";

test("writes one baseline followed by compact ordered deltas", async () => {
  await withTempDir(async (directory) => {
    const historyPath = join(directory, "mids.jsonl");
    const routePath = join(directory, "routes.jsonl");
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath,
      midHistoryPath: historyPath,
      eventsPath,
      runId: "mid-history-functional",
      minFreeBytes: 1,
    });
    assert.equal(sink.enabled, true);

    const midA = mid("v2", 2, 30, 1_000n, 2_000n);
    const midB = mid("v3", 3, 5, 3_000n, 9_000n);
    sink.recordPricing(baseline(100, new Map([
      ["edge-a", midA],
      ["edge-b", midB],
    ])));
    sink.recordNotStarted({
      sourceBlock: 100,
      sourceBlockHash: null,
      pricingMode: null,
      passOutcome: "not_started",
      passReason: "scheduler_coalesced",
    });
    const refreshedA = mid("v2", 2.5, 30, 1_000n, 2_500n);
    sink.recordPricing(delta({
      previousBlock: 100,
      block: 101,
      updates: [["edge-a", refreshedA]],
      removals: ["edge-b"],
      mids: new Map([["edge-a", refreshedA]]),
    }));
    await sink.shutdown(5_000);

    const records = await readJsonl(historyPath);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], {
      type: "block_scan_mid_baseline",
      schema_version: 1,
      run_id: "mid-history-functional",
      sequence: 1,
      source_block: 100,
      source_block_hash: blockHash(100),
      generation: 100,
      graph_fingerprint: "graph-v1",
      mid_count: 2,
      mids: [
        ["edge-a", {
          kind: "v2",
          mid: 2,
          fee_bps: 30,
          reserve_a: "1000",
          reserve_b: "2000",
          depth_proxy: 1000,
        }],
        ["edge-b", {
          kind: "v3",
          mid: 3,
          fee_bps: 5,
          reserve_a: "3000",
          reserve_b: "9000",
          depth_proxy: 3000,
        }],
      ],
    });
    assert.deepEqual(records[1], {
      type: "block_scan_mid_delta",
      schema_version: 1,
      run_id: "mid-history-functional",
      sequence: 3,
      source_block: 101,
      source_block_hash: blockHash(101),
      generation: 101,
      graph_fingerprint: "graph-v1",
      previous_source_block: 100,
      previous_source_block_hash: blockHash(100),
      previous_generation: 100,
      update_count: 1,
      removal_count: 1,
      updates: [["edge-a", {
        kind: "v2",
        mid: 2.5,
        fee_bps: 30,
        reserve_a: "1000",
        reserve_b: "2500",
        depth_proxy: 1000,
      }]],
      removals: ["edge-b"],
    });
    assert.equal(sink.telemetry().droppedMidPublications, 0);
    assert.equal(sink.telemetry().midBaselines, 1);
    assert.equal(sink.telemetry().midDeltas, 1);
    const routeRecords = await readJsonl(routePath);
    assert.equal(routeRecords.length, 1);
    assert.equal(routeRecords[0]!.type, "block_scan_enumeration_solver");
    assert.equal(routeRecords[0]!.sequence, undefined);
  });
});

test("a full queue records a gap and resumes only with a fresh baseline", async () => {
  await withTempDir(async (directory) => {
    const historyPath = join(directory, "mids.jsonl");
    const routePath = join(directory, "routes.jsonl");
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "");
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath,
      midHistoryPath: historyPath,
      eventsPath,
      runId: "mid-history-gap",
      queueCredits: 2,
      minFreeBytes: 1,
    });
    const initial = mid("v2", 1, 30, 100n, 100n);
    sink.recordPricing(baseline(200, new Map([["edge-a", initial]])));
    sink.recordPricing(delta({
      previousBlock: 200,
      block: 201,
      updates: [],
      removals: [],
      mids: new Map([["edge-a", initial]]),
    }));
    sink.recordPricing(delta({
      previousBlock: 201,
      block: 202,
      updates: [],
      removals: [],
      mids: new Map([["edge-a", initial]]),
    }));
    sink.recordPricing(delta({
      previousBlock: 202,
      block: 203,
      updates: [],
      removals: [],
      mids: new Map([["edge-a", initial]]),
    }));
    assert.equal(sink.telemetry().droppedMidPublications, 2);
    await waitFor(() => sink.telemetry().acknowledged === 2);
    const recovered = mid("v2", 1.5, 30, 100n, 150n);
    sink.recordPricing(delta({
      previousBlock: 203,
      block: 204,
      updates: [["edge-a", recovered]],
      removals: [],
      mids: new Map([["edge-a", recovered]]),
    }));
    await sink.shutdown(5_000);

    const records = await readJsonl(historyPath);
    assert.equal(records.length, 3);
    assert.equal(records[2]!.type, "block_scan_mid_baseline");
    assert.equal(records[2]!.source_block, 204);
    assert.equal(records[2]!.dropped_publications_before, 2);
    assert.equal(records[2]!.first_dropped_block, 202);
    assert.equal(records[2]!.last_dropped_block, 203);
  });
});

test("disabled history is a zero-work sink", async () => {
  const sink = await initBlockScanEnumerationSolverTelemetry({
    path: "",
    midHistoryPath: "",
    eventsPath: "unused",
    runId: "run",
  });
  assert.equal(sink.enabled, false);
  sink.recordPricing(baseline(1, new Map()));
  await sink.shutdown();
  assert.equal(sink.telemetry().midBaselines, 0);
});

test("an event-file hardlink is rejected without truncating the event file", async () => {
  await withTempDir(async (directory) => {
    const eventsPath = join(directory, "events.jsonl");
    const routePath = join(directory, "routes.jsonl");
    const historyPath = join(directory, "mids-hardlink.jsonl");
    const formalEvents = '{"type":"must-survive"}\n';
    await writeFile(eventsPath, formalEvents);
    await link(eventsPath, historyPath);
    const warnings: string[] = [];
    const sink = await initBlockScanEnumerationSolverTelemetry({
      path: routePath,
      midHistoryPath: historyPath,
      eventsPath,
      runId: "mid-history-hardlink",
      minFreeBytes: 1,
      onWarning: (warning) => warnings.push(warning),
    });
    assert.equal(sink.enabled, false);
    assert.match(warnings.join("\n"), /one link|aliases formal events inode/);
    assert.equal(await readFile(eventsPath, "utf8"), formalEvents);
  });
});

function baseline(
  block: number,
  mids: ReadonlyMap<string, RouteVenueMid>,
): StrictPricingPublication {
  return Object.freeze({
    kind: "baseline" as const,
    graphFingerprint: "graph-v1",
    snapshot: snapshot(block, mids),
  });
}

function delta(input: {
  readonly previousBlock: number;
  readonly block: number;
  readonly updates: readonly (readonly [string, RouteVenueMid])[];
  readonly removals: readonly string[];
  readonly mids: ReadonlyMap<string, RouteVenueMid>;
}): StrictPricingPublication {
  return Object.freeze({
    kind: "delta" as const,
    graphFingerprint: "graph-v1",
    previousGeneration: input.previousBlock,
    previousSourceBlock: input.previousBlock,
    previousSourceBlockHash: blockHash(input.previousBlock),
    updates: input.updates,
    removals: input.removals,
    snapshot: snapshot(input.block, input.mids),
  });
}

function snapshot(
  block: number,
  mids: ReadonlyMap<string, RouteVenueMid>,
): StrictPricingPublication["snapshot"] {
  return {
    generation: block,
    sourceBlock: block,
    sourceBlockHash: blockHash(block),
    mids,
  } as StrictPricingPublication["snapshot"];
}

function mid(
  kind: RouteVenueMid["kind"],
  price: number,
  feeBps: number,
  reserveA: bigint,
  reserveB: bigint,
): RouteVenueMid {
  return Object.freeze({
    kind,
    pool: "0xpool",
    edges: [],
    mid: price,
    feeBps,
    reserveA,
    reserveB,
    depthProxy: Number(reserveA < reserveB ? reserveA : reserveB),
  });
}

function blockHash(block: number): string {
  return `0x${block.toString(16).padStart(64, "0")}`;
}

async function readJsonl(path: string): Promise<JsonRecord[]> {
  return (await readFile(path, "utf8")).trim().split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withTempDir(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mev-mid-history-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type JsonRecord = Record<string, unknown>;
