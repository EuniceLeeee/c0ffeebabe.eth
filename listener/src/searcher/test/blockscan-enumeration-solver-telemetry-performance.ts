import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { BlockScanOpportunity } from "../detector/detector.js";
import type { TokenEdge } from "../planner/token-graph.js";
import {
  initBlockScanEnumerationSolverTelemetry,
  type BlockScanRouteTelemetrySink,
} from "../blockscan-enumeration-solver-telemetry.js";

const RUN_COUNT = 20;
const WARMUP_COUNT = 3;
const ROUTE_COUNT = 512;
const SOLVER_COUNT = 100;
const ROUTE_LEGS = 4;
const BLOCKS_PER_DAY = 7_200;
const FILE_CAP_BYTES = 100 * 1024 * 1024;
const CATALOG_CAP = 50_000;
const ORDER_SEED = 0x5eed_2026;
const P95_LIMIT_MS = 5;
const P99_LIMIT_MS = 10;

assert.equal(
  nearestRank(Array.from({ length: RUN_COUNT }, (_, index) => index + 1), 0.95),
  19,
);
assert.equal(
  nearestRank(Array.from({ length: RUN_COUNT }, (_, index) => index + 1), 0.99),
  20,
);

const testKeepAlive = setInterval(() => {}, 1_000);
try {
  const opportunities = makeOpportunities(ROUTE_COUNT, ROUTE_LEGS);
  const healthy = await healthyBenchmark(opportunities);
  const blocked = await blockedWorkerContract(opportunities);
  await crashingWorkerContract(opportunities);
  await hardFileCapContract(opportunities);

  console.log(
    `[blockscan-enumeration-solver-telemetry-performance] PASS ` +
      `${JSON.stringify({
        runCount: RUN_COUNT,
        orderSeed: `0x${ORDER_SEED.toString(16)}`,
        routeCount: ROUTE_COUNT,
        routeLegs: ROUTE_LEGS,
        exactCount: ROUTE_COUNT,
        plannerCount: SOLVER_COUNT,
        p95DeltaMs: rounded(healthy.p95DeltaMs),
        p99DeltaMs: rounded(healthy.p99DeltaMs),
        blockedP99Ms: rounded(blocked.p99Ms),
        projected24hBytes: healthy.projected24hBytes,
        hardCapBytes: FILE_CAP_BYTES,
      })}`,
  );
} finally {
  clearInterval(testKeepAlive);
}

async function healthyBenchmark(
  fixture: readonly BlockScanOpportunity[],
): Promise<{
  readonly p95DeltaMs: number;
  readonly p99DeltaMs: number;
  readonly projected24hBytes: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mev-route-telemetry-perf-"));
  const routePath = join(directory, "routes.jsonl");
  const eventsPath = join(directory, "events.jsonl");
  await writeFile(eventsPath, "");
  const warnings: string[] = [];
  const enabled = await initBlockScanEnumerationSolverTelemetry({
    path: routePath,
    eventsPath,
    runId: "performance-run",
    minFreeBytes: 1,
    onWarning: (message) => warnings.push(message),
  });
  const disabled = await initBlockScanEnumerationSolverTelemetry({
    path: "",
    eventsPath,
    runId: "performance-disabled",
  });
  assert.equal(enabled.enabled, true);
  assert.equal(disabled.enabled, false);

  let nextBlock = 30_000_000;
  try {
    for (let index = 0; index < WARMUP_COUNT; index++) {
      await measuredPass(enabled, fixture, nextBlock++, true);
      await measuredPass(disabled, fixture, nextBlock, false);
    }

    const enabledFirst = seededPairOrder(RUN_COUNT, ORDER_SEED);
    const deltas: number[] = [];
    for (let index = 0; index < RUN_COUNT; index++) {
      const block = nextBlock++;
      let enabledMs: number;
      let disabledMs: number;
      if (enabledFirst[index]) {
        enabledMs = await measuredPass(enabled, fixture, block, true);
        disabledMs = await measuredPass(disabled, fixture, block, false);
      } else {
        disabledMs = await measuredPass(disabled, fixture, block, false);
        enabledMs = await measuredPass(enabled, fixture, block, true);
      }
      deltas.push(enabledMs - disabledMs);
    }

    const p95DeltaMs = nearestRank(deltas, 0.95);
    const p99DeltaMs = nearestRank(deltas, 0.99);
    assert(
      p95DeltaMs <= P95_LIMIT_MS,
      distributionFailure("p95", p95DeltaMs, P95_LIMIT_MS, deltas),
    );
    assert(
      p99DeltaMs <= P99_LIMIT_MS,
      distributionFailure("p99", p99DeltaMs, P99_LIMIT_MS, deltas),
    );

    const beforeShutdown = enabled.telemetry();
    assert.equal(beforeShutdown.failed, false);
    assert.equal(beforeShutdown.droppedBatches, 0);
    assert.equal(beforeShutdown.scheduled, WARMUP_COUNT + RUN_COUNT);
    assert.equal(beforeShutdown.acknowledged, beforeShutdown.scheduled);
    assert.equal(beforeShutdown.reserved, 0);
    assert.equal(beforeShutdown.queued, 0);
    assert.equal(beforeShutdown.outstanding, false);
    assert(beforeShutdown.bytesWritten > 0);
    assert.deepEqual(warnings, []);

    await enabled.shutdown();
    await disabled.shutdown();

    const raw = await readFile(routePath, "utf8");
    const lines = raw.trimEnd().split("\n");
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const catalog = records.filter(
      (record) => record.type === "block_scan_route_catalog",
    );
    const lifecycle = records.filter(
      (record) => record.type === "block_scan_enumeration_solver",
    );
    assert.equal(catalog.length, ROUTE_COUNT);
    assert.equal(lifecycle.length, WARMUP_COUNT + RUN_COUNT);
    for (const record of lifecycle) {
      assert.equal((record.enumeration as unknown[]).length, ROUTE_COUNT);
      assert.equal((record.exact as unknown[]).length, ROUTE_COUNT * 4);
      assert.equal((record.planner as unknown[]).length, SOLVER_COUNT);
      assert.equal((record.solver as unknown[]).length, SOLVER_COUNT);
      assert.equal("writer_gap_before" in record, false);
    }

    const catalogBytes = lines.reduce(
      (total, line, index) =>
        records[index]?.type === "block_scan_route_catalog"
          ? total + Buffer.byteLength(`${line}\n`)
          : total,
      0,
    );
    const lifecycleBytes = lines
      .filter((_, index) =>
        records[index]?.type === "block_scan_enumeration_solver"
      )
      .map((line) => Buffer.byteLength(`${line}\n`));
    const maxLifecycleBytes = Math.max(...lifecycleBytes);
    const projected24hBytes =
      catalogBytes + maxLifecycleBytes * BLOCKS_PER_DAY;
    assert(
      projected24hBytes <= FILE_CAP_BYTES,
      `24h projection ${projected24hBytes} exceeds ${FILE_CAP_BYTES}`,
    );

    const firstBatchBytes = lines
      .slice(0, ROUTE_COUNT + 1)
      .reduce((total, line) => total + Buffer.byteLength(`${line}\n`), 0);
    assert(
      firstBatchBytes * BLOCKS_PER_DAY > FILE_CAP_BYTES,
      "all-new-route churn fixture must exercise the hard-cap branch",
    );
    assert(
      Math.floor(CATALOG_CAP / ROUTE_COUNT) < BLOCKS_PER_DAY,
      "catalog hard cap must stop adversarial all-new-route churn within one epoch",
    );
    return { p95DeltaMs, p99DeltaMs, projected24hBytes };
  } finally {
    await enabled.shutdown().catch(() => {});
    await disabled.shutdown().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function blockedWorkerContract(
  fixture: readonly BlockScanOpportunity[],
): Promise<{ readonly p99Ms: number }> {
  const directory = await mkdtemp(join(tmpdir(), "mev-route-telemetry-blocked-"));
  const eventsPath = join(directory, "events.jsonl");
  await writeFile(eventsPath, "");
  const warnings: string[] = [];
  const sink = await initBlockScanEnumerationSolverTelemetry({
    path: join(directory, "routes.jsonl"),
    eventsPath,
    runId: "blocked-worker-run",
    workerUrl: workerFixtureUrl(
      "blockscan-enumeration-solver-blocked-worker",
    ),
    queueCredits: 5,
    minFreeBytes: 1,
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(sink.enabled, true);

  try {
    for (let index = 0; index < 5; index++) {
      enqueuePass(sink, fixture, 31_000_000 + index);
    }
    await immediate();
    assert.deepEqual(
      pickQueueState(sink),
      { reserved: 5, queued: 4, outstanding: true },
    );

    const blockedTimes: number[] = [];
    for (let index = 0; index < RUN_COUNT; index++) {
      const started = performance.now();
      const pass = sink.beginPass(31_001_000 + index);
      blockedTimes.push(performance.now() - started);
      assert.equal(pass, null, "full queue must drop before locator construction");
    }
    const p99Ms = nearestRank(blockedTimes, 0.99);
    assert(
      p99Ms <= P99_LIMIT_MS,
      distributionFailure("blocked p99", p99Ms, P99_LIMIT_MS, blockedTimes),
    );
    assert.equal(sink.telemetry().droppedBatches, RUN_COUNT);

    const keepAlive = setInterval(() => {}, 1_000);
    try {
      await sink.shutdown(25);
    } finally {
      clearInterval(keepAlive);
    }
    const after = sink.telemetry();
    assert.equal(after.failed, true);
    assert.equal(after.accepting, false);
    assert.equal(after.reserved, 0, "shutdown timeout must release all credits");
    assert.equal(after.queued, 0, "shutdown timeout must release pending batches");
    assert.equal(
      after.outstanding,
      false,
      "shutdown timeout must release the active batch",
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /incomplete/);
    return { p99Ms };
  } finally {
    await sink.shutdown(25).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function crashingWorkerContract(
  fixture: readonly BlockScanOpportunity[],
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mev-route-telemetry-crash-"));
  const eventsPath = join(directory, "events.jsonl");
  await writeFile(eventsPath, "");
  const warnings: string[] = [];
  const sink = await initBlockScanEnumerationSolverTelemetry({
    path: join(directory, "routes.jsonl"),
    eventsPath,
    runId: "crashing-worker-run",
    workerUrl: workerFixtureUrl(
      "blockscan-enumeration-solver-crash-worker",
    ),
    minFreeBytes: 1,
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(sink.enabled, true);

  try {
    enqueuePass(sink, fixture, 32_000_000);
    await waitFor(() => sink.telemetry().failed);
    const failed = sink.telemetry();
    assert.equal(failed.accepting, false);
    assert.equal(failed.reserved, 0);
    assert.equal(failed.queued, 0);
    assert.equal(failed.outstanding, false);
    assert.equal(failed.droppedBatches, 1);
    assert.equal(warnings.length, 1);
    assert.equal(sink.beginPass(32_000_001), null);
  } finally {
    await sink.shutdown(100).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function hardFileCapContract(
  fixture: readonly BlockScanOpportunity[],
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mev-route-telemetry-cap-"));
  const routePath = join(directory, "routes.jsonl");
  const eventsPath = join(directory, "events.jsonl");
  await writeFile(eventsPath, "");
  const warnings: string[] = [];
  const sink = await initBlockScanEnumerationSolverTelemetry({
    path: routePath,
    eventsPath,
    runId: "hard-cap-run",
    maxFileBytes: 1_024,
    minFreeBytes: 1,
    onWarning: (message) => warnings.push(message),
  });
  assert.equal(sink.enabled, true);

  try {
    enqueuePass(sink, fixture, 33_000_000);
    await waitFor(() => sink.telemetry().failed);
    const failed = sink.telemetry();
    assert.equal(failed.accepting, false);
    assert.equal(failed.reserved, 0);
    assert.equal(failed.queued, 0);
    assert.equal(failed.outstanding, false);
    assert.equal(failed.acknowledged, 0);
    assert.equal(failed.droppedBatches, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /epoch byte cap reached/);
    assert.equal((await stat(routePath)).size, 0);
  } finally {
    await sink.shutdown(100).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function measuredPass(
  sink: BlockScanRouteTelemetrySink,
  fixture: readonly BlockScanOpportunity[],
  sourceBlock: number,
  expectEnabled: boolean,
): Promise<number> {
  const before = sink.telemetry();
  const started = performance.now();
  const pass = sink.beginPass(sourceBlock);
  if (pass) {
    pass.recordEnumeration(fixture);
    for (let index = 0; index < fixture.length; index++) {
      pass.recordExact(fixture[index]!, {
        index,
        status: "positive",
        marginBps: index + 1,
        attempted: true,
        failure: null,
      });
    }
    for (let index = 0; index < SOLVER_COUNT; index++) {
      pass.recordPlanner(fixture[index]!);
      pass.recordSolver(fixture[index]!);
    }
    pass.finish({
      sourceBlockHash: blockHash(sourceBlock),
      midSourceBlock: sourceBlock,
      midSourceBlockHash: blockHash(sourceBlock),
      pricingMode: "source_n",
      passOutcome: "ran",
      passReason: null,
    });
  }
  // The writer schedules postMessage with setImmediate. Registering this after
  // finish brackets structured-clone through postMessage return without waiting
  // for worker serialization, fsync or acknowledgement.
  await immediate();
  const elapsed = performance.now() - started;
  if (expectEnabled) {
    assert(pass, "enabled sink must reserve one batch");
    await waitFor(
      () => sink.telemetry().acknowledged === before.acknowledged + 1,
    );
  } else {
    assert.equal(pass, null);
  }
  return elapsed;
}

function enqueuePass(
  sink: BlockScanRouteTelemetrySink,
  fixture: readonly BlockScanOpportunity[],
  sourceBlock: number,
): void {
  const pass = sink.beginPass(sourceBlock);
  assert(pass, `expected queue credit for block ${sourceBlock}`);
  pass.recordEnumeration(fixture);
  for (let index = 0; index < fixture.length; index++) {
    pass.recordExact(fixture[index]!, {
      index,
      status: "positive",
      marginBps: index + 1,
      attempted: true,
      failure: null,
    });
  }
  for (let index = 0; index < SOLVER_COUNT; index++) {
    pass.recordPlanner(fixture[index]!);
    pass.recordSolver(fixture[index]!);
  }
  pass.finish({
    sourceBlockHash: blockHash(sourceBlock),
    midSourceBlock: sourceBlock,
    midSourceBlockHash: blockHash(sourceBlock),
    pricingMode: "source_n",
    passOutcome: "ran",
    passReason: null,
  });
}

function makeOpportunities(
  count: number,
  legs: number,
): readonly BlockScanOpportunity[] {
  return Object.freeze(
    Array.from({ length: count }, (_, routeIndex) => {
      const tokens = Array.from(
        { length: legs },
        (_, tokenIndex) => address(100_000 + routeIndex * legs + tokenIndex),
      );
      const seedEdges: TokenEdge[] = Array.from(
        { length: legs },
        (_, legIndex) => ({
          adapterId: `perf-adapter-${legIndex}`,
          target: address(10_000_000 + routeIndex * legs + legIndex),
          tokenIn: tokens[legIndex]!,
          tokenOut: tokens[(legIndex + 1) % legs]!,
          slotKind: "swap",
          edgeKind: "swap",
          leavesStandingPosition: false,
          v3Fee: 500 + legIndex,
        }),
      );
      return Object.freeze({
        kind: "block-scan-arb" as const,
        sourceBlock: 29_999_999,
        stateBlock: 29_999_999,
        cycleId: `perf-cycle-${routeIndex}`,
        cycleFingerprint: `perf-fingerprint-${routeIndex}`,
        seedEdges,
        flashToken: tokens[0]!,
        searchSeed: {
          startToken: tokens[0]!,
          searchCenter: 1_000_000n,
          maxInput: 10_000_000n,
        },
        leavesStandingPosition: false,
        affectedPools: seedEdges.map((edge) => edge.target),
        affectedTokens: [...tokens],
      });
    }),
  );
}

function seededPairOrder(count: number, seed: number): readonly boolean[] {
  let state = seed >>> 0;
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return Boolean((state ^ index) & 1);
    }),
  );
}

function nearestRank(samples: readonly number[], percentile: number): number {
  assert(samples.length > 0, "nearest-rank requires samples");
  assert(percentile > 0 && percentile <= 1, "invalid percentile");
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

function workerFixtureUrl(basename: string): URL {
  const extension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  return new URL(`./${basename}${extension}`, import.meta.url);
}

function pickQueueState(sink: BlockScanRouteTelemetrySink): {
  readonly reserved: number;
  readonly queued: number;
  readonly outstanding: boolean;
} {
  const telemetry = sink.telemetry();
  return {
    reserved: telemetry.reserved,
    queued: telemetry.queued,
    outstanding: telemetry.outstanding,
  };
}

function blockHash(block: number): string {
  return `0x${block.toString(16).padStart(64, "0")}`;
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

function distributionFailure(
  label: string,
  actual: number,
  limit: number,
  samples: readonly number[],
): string {
  return `${label} ${rounded(actual)}ms exceeds ${limit}ms; ` +
    `samples=${JSON.stringify(samples.map(rounded))}`;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}
