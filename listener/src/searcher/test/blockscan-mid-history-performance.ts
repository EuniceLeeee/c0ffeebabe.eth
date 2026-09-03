import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  initBlockScanEnumerationSolverTelemetry,
  type BlockScanRouteTelemetrySink,
} from "../blockscan-enumeration-solver-telemetry.js";
import type { StrictPricingPublication } from
  "../strict-current-runtime-coordinator.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";

const EDGE_COUNT = 35_312;
const UPDATE_COUNT = 100;
const RUNS = 40;
const P95_LIMIT_MS = 1;

const keepAlive = setInterval(() => {}, 1_000);
const directory = await mkdtemp(join(tmpdir(), "mev-mid-history-perf-"));
try {
  const eventsPath = join(directory, "events.jsonl");
  await writeFile(eventsPath, "");
  const enabled = await initBlockScanEnumerationSolverTelemetry({
    path: join(directory, "routes.jsonl"),
    midHistoryPath: join(directory, "mids.jsonl"),
    eventsPath,
    runId: "mid-history-performance",
    minFreeBytes: 1,
  });
  const disabled = await initBlockScanEnumerationSolverTelemetry({
    path: "",
    eventsPath,
    runId: "disabled",
  });
  const stableMid = mid(1);
  const mids = new Map<string, RouteVenueMid>();
  for (let index = 0; index < EDGE_COUNT; index++) {
    mids.set(`edge-${index.toString().padStart(5, "0")}`, stableMid);
  }
  enabled.recordPricing(baseline(1_000, mids));
  await waitFor(() => enabled.telemetry().acknowledged === 1, 15_000);
  const baselineBytes = enabled.telemetry().midBytesWritten;

  const enabledSamples: number[] = [];
  const disabledSamples: number[] = [];
  for (let index = 0; index < RUNS; index++) {
    const block = 1_001 + index;
    const updates = Array.from(
      { length: UPDATE_COUNT },
      (_, edgeIndex) => [
        `edge-${edgeIndex.toString().padStart(5, "0")}`,
        mid(1 + block / 1_000_000 + edgeIndex / 10_000_000),
      ] as const,
    );
    const publication = delta(block - 1, block, mids, updates);
    disabledSamples.push(measure(disabled, publication));
    const beforeAck = enabled.telemetry().acknowledged;
    enabledSamples.push(measure(enabled, publication));
    await waitFor(() => enabled.telemetry().acknowledged === beforeAck + 1);
  }
  await enabled.shutdown(5_000);
  await disabled.shutdown();
  const overhead = enabledSamples.map((value, index) =>
    Math.max(0, value - disabledSamples[index]!)
  );
  const p95Ms = nearestRank(overhead, 0.95);
  assert(
    p95Ms < P95_LIMIT_MS,
    `mid history delta enqueue p95 ${p95Ms.toFixed(3)}ms exceeds ${P95_LIMIT_MS}ms`,
  );
  assert.equal(enabled.telemetry().droppedMidPublications, 0);
  console.log(
    `[blockscan-mid-history-performance] PASS ${JSON.stringify({
      edgeCount: EDGE_COUNT,
      updateCount: UPDATE_COUNT,
      runs: RUNS,
      enqueueP95Ms: Number(p95Ms.toFixed(3)),
      baselineBytes,
    })}`,
  );
} finally {
  clearInterval(keepAlive);
  await rm(directory, { recursive: true, force: true });
}

function measure(
  sink: BlockScanRouteTelemetrySink,
  publication: StrictPricingPublication,
): number {
  const started = performance.now();
  sink.recordPricing(publication);
  return performance.now() - started;
}

function baseline(
  block: number,
  mids: ReadonlyMap<string, RouteVenueMid>,
): StrictPricingPublication {
  return {
    kind: "baseline",
    graphFingerprint: "graph-performance",
    snapshot: snapshot(block, mids),
  };
}

function delta(
  previousBlock: number,
  block: number,
  mids: ReadonlyMap<string, RouteVenueMid>,
  updates: readonly (readonly [string, RouteVenueMid])[],
): StrictPricingPublication {
  return {
    kind: "delta",
    graphFingerprint: "graph-performance",
    previousGeneration: previousBlock,
    previousSourceBlock: previousBlock,
    previousSourceBlockHash: blockHash(previousBlock),
    updates,
    removals: [],
    snapshot: snapshot(block, mids),
  };
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

function mid(price: number): RouteVenueMid {
  return {
    kind: "v2",
    pool: "0xpool",
    edges: [],
    mid: price,
    feeBps: 30,
    reserveA: 1_000_000n,
    reserveB: 2_000_000n,
    depthProxy: 1_000_000,
  };
}

function blockHash(block: number): string {
  return `0x${block.toString(16).padStart(64, "0")}`;
}

function nearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentile) - 1]!;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
