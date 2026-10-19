import { test } from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePassLatency, createPassLatencyAnalyzer } from "../blockscan-pass-latency.js";

const PROCESS = "[searcher/live] starting V5 searcher";
const COMMIT = "[searcher/live] runtime_commit=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TIMING = "[searcher/blockscan-family] ";

function passRecord(
  sourceBlock: number,
  totalMs: number,
  extra?: Record<string, unknown>,
): string {
  return TIMING + JSON.stringify({
    type: "block_scan_timing",
    source_block: sourceBlock,
    outcome: "complete",
    source_head_seen_at_ms: 1_700_000_000_000 + sourceBlock,
    stage_timing_ms: { state: 200 },
    total_ms: totalMs,
    ...extra,
  });
}

function fastLog(count: number, totalMs = 9000): string {
  const lines = [PROCESS, COMMIT];
  for (let block = 1_000; block < 1_000 + count; block++) {
    lines.push(passRecord(block, totalMs));
  }
  return lines.join("\n") + "\n";
}

test("pass latency window qualifies a contiguous fast run", () => {
  const report = analyzePassLatency(fastLog(120), {
    startLine: 1,
    minRun: 100,
    thresholdMs: 10_000,
  });
  assert.equal(report.scope.eligibleForQualification, true);
  assert.equal(report.scope.runtimeCommit?.startsWith("0x"), false);
  assert.equal(report.scope.runtimeCommit, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.equal(report.totals.passes, 120);
  assert.equal(report.totals.fast, 120);
  assert.equal(report.longestRun?.count, 120);
  assert.equal(report.longestRun?.consecutiveSourceBlocks, true);
  assert.equal(report.longestRun?.startBlock, 1_000);
  assert.equal(report.longestRun?.endBlock, 1_119);
  assert.equal(report.longestRun?.totalMsMax, 9_000);
  assert.equal(report.qualifyingRuns.length, 1);
  assert.equal(report.qualifyingRuns[0]?.count, 120);
});

test("pass latency window summarizes detailed solver telemetry", () => {
  const detail = {
    plannerBuildMs: 12,
    solverWallMs: 2_500,
    solverQuoteMs: 8_000,
    solverPlanBuildMs: 40,
    solverPlans: 100,
    solverAmountPoints: 900,
    solverHopExactCalls: 2_400,
    solverGssPoints: 400,
    preSimMs: 8_900,
    finalSimMs: 600,
    totalMs: 9_700,
  };
  const report = analyzePassLatency([
    PROCESS,
    COMMIT,
    passRecord(1_000, 9_700, {
      stage_timing_ms: {
        state: 200,
        enumeration: 300,
        exact_refine: 3_000,
        planner_solver: 2_512,
        final_sim: 600,
      },
      planner_solver_detail: detail,
    }),
  ].join("\n") + "\n", {
    startLine: 1,
    minRun: 1,
    thresholdMs: 10_000,
  });

  assert.deepEqual(report.metrics.solverAmountPoints, {
    samples: 1,
    p50: 900,
    p95: 900,
    max: 900,
  });
  assert.equal(report.metrics.plannerBuildMs.p50, 12);
  assert.equal(report.metrics.solverWallMs.p95, 2_500);
  assert.equal(report.metrics.solverQuoteMs.max, 8_000);
  assert.equal(report.metrics.preSimMs.p50, 8_900);
  assert.equal(report.metrics.finalSimMs.p50, 600);
});

test("over-threshold pass breaks the run and is counted", () => {
  const lines = [PROCESS, COMMIT];
  for (let block = 1_000; block < 1_050; block++) {
    lines.push(passRecord(block, block === 1_020 ? 12_000 : 9_000));
  }
  const report = analyzePassLatency(lines.join("\n") + "\n", {
    startLine: 1,
    minRun: 100,
    thresholdMs: 10_000,
  });
  assert.equal(report.totals.overThreshold, 1);
  assert.equal(report.totals.fast, 49);
  assert.equal(report.longestRun, null);
  assert.equal(report.invalidByReason.over_threshold, 1);
});

test("process restart inside the window disqualifies continuity", () => {
  const lines = [PROCESS, COMMIT];
  for (let block = 1_000; block < 1_050; block++) {
    lines.push(passRecord(block, 9_000));
  }
  lines.push(PROCESS, COMMIT);
  for (let block = 1_050; block < 1_200; block++) {
    lines.push(passRecord(block, 9_000));
  }
  const report = analyzePassLatency(lines.join("\n") + "\n", {
    startLine: 1,
    minRun: 100,
    thresholdMs: 10_000,
  });
  assert.equal(report.scope.eligibleForQualification, false);
  assert.match(report.scope.ineligibleReason ?? "", /expected_one_process_start:2/);
  assert.equal(report.longestRun, null);
  assert.equal(report.continuityBreaks.process_or_runtime_boundary, 1);
});

test("missing total_ms is invalid and never fast", () => {
  const lines = [
    PROCESS,
    COMMIT,
    TIMING + JSON.stringify({
      type: "block_scan_timing",
      source_block: 1_000,
      outcome: "complete",
    }),
  ];
  const report = analyzePassLatency(lines.join("\n") + "\n", {
    startLine: 1,
    minRun: 2,
    thresholdMs: 10_000,
  });
  assert.equal(report.totals.missingTotalMs, 1);
  assert.equal(report.totals.passes, 1);
  assert.equal(report.invalidByReason.missing_total_ms, 1);
  assert.equal(report.longestRun, null);
});

test("duplicate source block breaks consecutive continuity", () => {
  const lines = [
    PROCESS,
    COMMIT,
    passRecord(1_000, 9_000),
    passRecord(1_001, 9_000),
    passRecord(1_001, 9_000),
    passRecord(1_002, 9_000),
    passRecord(1_003, 9_000),
  ];
  const report = analyzePassLatency(lines.join("\n") + "\n", {
    startLine: 1,
    minRun: 2,
    thresholdMs: 10_000,
  });
  assert.equal(report.longestRun?.count, 3);
  assert.equal(report.longestRun?.startBlock, 1_001);
  assert.equal(report.continuityBreaks.source_block_duplicate_or_regression, 1);
});

test("sliced CLI stream matches the string API with relative line numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "blockscan-pass-latency-"));
  try {
    const log = join(dir, "live.log");
    const lines = ["unrelated first", "unrelated second", PROCESS, COMMIT,
      passRecord(1_000, 8_000), passRecord(1_001, 9_000), "", "after window"];
    writeFileSync(log, lines.join("\n") + "\n");
    const cli = fileURLToPath(new URL("../cli/blockscan-pass-latency.ts", import.meta.url));
    const report = JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", cli, "--log", log, "--start-line", "3", "--end-line", "6", "--min-run", "2"],
      { encoding: "utf8" }));
    const expected = analyzePassLatency(lines.slice(2, 6).join("\n") + "\n", {
      startLine: 1, logStartLine: 3, minRun: 2, thresholdMs: 10_000,
    });
    assert.deepEqual(report, expected);
    assert.equal(report.longestRun?.startLine, 3);
    assert.equal(report.scope.logStartLine, 3);
    const trailingBlank = JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", cli, "--log", log, "--start-line", "3", "--end-line", "7", "--min-run", "2"],
      { encoding: "utf8" }));
    assert.deepEqual(trailingBlank, expected);
    const emptyWindow = JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", cli, "--log", log, "--start-line", "100", "--min-run", "2"],
      { encoding: "utf8" }));
    assert.deepEqual(emptyWindow, analyzePassLatency("\n", {
      startLine: 1, logStartLine: 100, minRun: 2, thresholdMs: 10_000,
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("incremental analysis handles a logical window larger than V8's string limit", () => {
  const analyzer = createPassLatencyAnalyzer({
    startLine: 1, minRun: 100, thresholdMs: 10_000,
  });
  analyzer.pushLine(PROCESS);
  analyzer.pushLine(COMMIT);
  for (let block = 1_000; block < 1_249; block++) {
    analyzer.pushLine(passRecord(block, 9_000));
  }
  const irrelevant = "x".repeat(1024 * 1024);
  for (let index = 0; index <= Math.floor(constants.MAX_STRING_LENGTH / irrelevant.length); index++) {
    analyzer.pushLine(irrelevant);
  }
  const report = analyzer.finish();
  assert.equal(report.totals.passes, 249);
  assert.equal(report.longestRun?.count, 249);
  assert.equal(report.scope.eligibleForQualification, true);
});

const boundaryHash = `0x${"ab".repeat(32)}`;
const boundaryClock = { pid: 17, timeOrigin: 10000 };
const boundarySource = { sourceBlock: 1000, sourceBlockHash: boundaryHash, generation: 10 };
const boundaryEvent = (marker: string, value: Record<string, unknown>) => marker + JSON.stringify({ ...boundaryClock, ...value });
function boundaryFixture(extra: Record<string, unknown> = {}) {
  return [PROCESS, COMMIT,
    boundaryEvent("[searcher/live-head-window] ", { event: "head", number: 1000, hash: boundaryHash, observedAtMs: 10100, observedAtMonotonicMs: 100 }),
    boundaryEvent("[searcher/effective-mid] ", { ...boundarySource, quoted: 5, carried: 2, byStatus: { quoted: 5, "quote-failed": 1 } }),
    boundaryEvent("[searcher/pricing-publication] ", { ...boundarySource, effectiveComplete: true, atMs: 11400, atMonotonicMs: 1400 }),
    passRecord(1000, 7900, { source_block_hash: boundaryHash, source_generation: 10, pid: 17, time_origin: 10000,
      source_head_seen_at_ms: 10100, source_head_seen_at_monotonic_ms: 100,
      pricing_source_block: 1000, pricing_source_block_hash: boundaryHash, pricing_source_generation: 10,
      sizing_started_at_ms: 12400, sizing_started_at_monotonic_ms: 2400,
      pass_drained_at_ms: 18000, pass_drained_at_monotonic_ms: 8000,
      planner_solver_detail: { solverPlans: 1, solverAmountPoints: 3, solverHopExactCalls: 0 }, ...extra }),
    // Producer completion can arrive after the pass record; finish must join the exact source, not log proximity.
    boundaryEvent("[searcher/pricing-drain] ", { ...boundarySource, backendDrained: true, simulationDrained: true, atMs: 11600, atMonotonicMs: 1600 }),
    boundaryEvent("[searcher/live-head-window] ", { event: "next_head", number: 1001, observedAtMs: 22100, observedAtMonotonicMs: 12100 }),
    boundaryEvent("[searcher/sim-amount] ", { ...boundarySource, type: "sim_amount_construction", mode: "runtime-actual", atMonotonicMs: 2500 }),
    boundaryEvent("[searcher/sim-amount] ", { ...boundarySource, type: "sim_amount_execution", mode: "runtime-actual", atMonotonicMs: 4000 }),
  ];
}
const boundaryReport = (lines: readonly string[]) => analyzePassLatency(lines.join("\n"), { startLine: 1, minRun: 1, thresholdMs: 11000 });

test("production boundary join retains receipt, publication, backend/sim drain, sizing drain, and actual next head", () => {
  const report = boundaryReport(boundaryFixture());
  const row = report.productionBoundaries.rows[0]!;
  assert.equal(row.pricingStatus, "verified-boundaries");
  assert.equal(row.headToPublicationMs, 1300);
  assert.equal(row.headToPricingDrainMs, 1500);
  assert.equal(row.sizingToPassDrainMs, 5600);
  assert.equal(row.completedBeforeNextHead, true);
  assert.equal(row.effectiveFreshQuoted, 3);
  assert.equal(row.effectiveCarriedQuoted, 2);
  assert.equal(row.simExecutions, 1);
  assert.equal(row.runtimeNoQuotedFallback, true);
  assert.deepEqual(row.effectiveByStatus, { quoted: 5, "quote-failed": 1 });
});

for (const changed of [{ pid: 18 }, { timeOrigin: 20000 }, { generation: 11 }, { sourceBlock: 999 }, { sourceBlockHash: `0x${"cd".repeat(32)}` }]) {
  test(`production boundary rejects a nearby publication from another identity ${JSON.stringify(changed)}`, () => {
    const lines = boundaryFixture();
    lines[4] = boundaryEvent("[searcher/pricing-publication] ", { ...boundarySource, ...changed, effectiveComplete: true, atMonotonicMs: 1400 });
    const row = boundaryReport(lines).productionBoundaries.rows[0]!;
    assert.equal(row.pricingStatus, "unverified");
    assert.equal(row.headToPublicationMs, null);
  });
}

test("missing, incomplete, ambiguous, reversed and reorg boundaries never manufacture timing", () => {
  for (const mutation of ["missing", "incomplete", "ambiguous", "reversed", "reorg"]) {
    const lines = boundaryFixture();
    if (mutation === "missing") lines.splice(6, 1);
    if (mutation === "incomplete") lines[6] = boundaryEvent("[searcher/pricing-drain] ", { ...boundarySource, backendDrained: false, simulationDrained: true, atMonotonicMs: 1600 });
    if (mutation === "ambiguous") lines.push(lines[4]!);
    if (mutation === "reversed") lines[6] = boundaryEvent("[searcher/pricing-drain] ", { ...boundarySource, backendDrained: true, simulationDrained: true, atMonotonicMs: 1300 });
    if (mutation === "reorg") lines.push(boundaryEvent("[searcher/live-head-window] ", { event: "reorg", number: 1000, hash: `0x${"cd".repeat(32)}` }));
    const row = boundaryReport(lines).productionBoundaries.rows[0]!;
    assert.equal(row.pricingStatus, "unverified", mutation);
    assert.equal(row.headToPricingDrainMs, null, mutation);
  }
});

test("warm, failed-fast, carried-only, and no-sim work remain visible without changing timing-only fast", () => {
  const lines = boundaryFixture({ outcome: "degraded", planner_solver_detail: { solverPlans: 0, solverAmountPoints: 0 } })
    .filter(line => !line.startsWith("[searcher/sim-amount] "));
  lines[3] = boundaryEvent("[searcher/effective-mid] ", { ...boundarySource, quoted: 5, carried: 5 });
  lines.push(passRecord(999, 100, { outcome: "startup_warm", startup_warm: true }));
  const report = boundaryReport(lines);
  assert.equal(report.totals.fast, 2);
  assert.deepEqual(report.productionBoundaries.counts, { startupWarm: 1, failed: 1, noSimWork: 1, pricingUnverified: 0, carriedOnly: 1 });
  assert.equal(report.productionBoundaries.rows[0]!.simStatus, "not-run");
  assert.equal(report.productionBoundaries.rows[0]!.sizingToPassDrainMs, null);
});

test("source-N price drain includes shared simulation tail and unprocessed head remains recorded", () => {
  const lines = boundaryFixture();
  lines[6] = boundaryEvent("[searcher/blockscan-source-n-call-stats-final] ", { ...boundarySource, atMonotonicMs: 7800 });
  lines.push(boundaryEvent("[searcher/live-head-window] ", { event: "head", number: 1002, observedAtMonotonicMs: 24100 }));
  const report = boundaryReport(lines), row = report.productionBoundaries.rows[0]!;
  assert.equal(row.headToPricingDrainMs, 7900);
  assert.equal(row.pricingDrainScope, "source-n-backend-and-shared-pass-simulation");
  assert.deepEqual(report.productionBoundaries.headsWithoutPass, [1002]);
});

test("N-1 joins the actual adopted pricing generation separately from current execution generation", () => {
  const predecessor = { sourceBlock: 999, sourceBlockHash: `0x${"cd".repeat(32)}`, generation: 90 };
  const lines = boundaryFixture({ pricing_source_block: predecessor.sourceBlock,
    pricing_source_block_hash: predecessor.sourceBlockHash, pricing_source_generation: predecessor.generation });
  lines[3] = boundaryEvent("[searcher/effective-mid] ", { ...predecessor, quoted: 2, carried: 0 });
  lines[4] = boundaryEvent("[searcher/pricing-publication] ", { ...predecessor, effectiveComplete: true, atMonotonicMs: 40 });
  lines[6] = boundaryEvent("[searcher/pricing-drain] ", { ...predecessor, backendDrained: true, simulationDrained: true, atMonotonicMs: 60 });
  lines.splice(2, 0, boundaryEvent("[searcher/live-head-window] ", { event: "head", number: 999, hash: predecessor.sourceBlockHash, observedAtMs: 10000, observedAtMonotonicMs: 0 }));
  const row = boundaryReport(lines).productionBoundaries.rows[0]!;
  assert.equal(row.pricingStatus, "verified-boundaries");
  assert.equal(row.sourceGeneration, 10);
  assert.equal(row.pricingSource.generation, 90);
  assert.equal(row.pricingHeadBlock, 999);
  assert.equal(row.headToPublicationMs, 40);
  assert.equal(row.headToPricingDrainMs, 60);
  const missingHead = lines.filter(line => !line.includes('"number":999'));
  assert.equal(boundaryReport(missingHead).productionBoundaries.rows[0]!.pricingStatus, "unverified");
});

test("requested amount points without a returned sim are not actual work, and quoted fallback stays visible", () => {
  const noExecution = boundaryFixture().filter(line => !line.includes('"type":"sim_amount_execution"'));
  const absent = boundaryReport(noExecution).productionBoundaries.rows[0]!;
  assert.equal(absent.noSimWork, true);
  assert.equal(absent.simStatus, "unverified");
  assert.equal(absent.sizingToPassDrainMs, null);
  const quoted = boundaryFixture();
  quoted[9] = boundaryEvent("[searcher/sim-amount] ", { ...boundarySource, type: "sim_amount_execution", mode: "quoted", atMonotonicMs: 4000 });
  const row = boundaryReport(quoted).productionBoundaries.rows[0]!;
  assert.equal(row.quotedExecutions, 1);
  assert.equal(row.runtimeNoQuotedFallback, false);
});


test("a failed quoted construction remains a fallback attempt before a later runtime execution", () => {
  const lines = boundaryFixture();
  lines.push(boundaryEvent("[searcher/sim-amount] ", { ...boundarySource, type: "sim_amount_construction", mode: "quoted", atMonotonicMs: 2450 }));
  lines.push(boundaryEvent("[searcher/sim-amount] ", { ...boundarySource, type: "sim_amount_failure", atMonotonicMs: 2475 }));
  const row = boundaryReport(lines).productionBoundaries.rows[0]!;
  assert.equal(row.runtimeConstructions, 1);
  assert.equal(row.quotedConstructions, 1);
  assert.equal(row.quotedAttempts, 1);
  assert.equal(row.simFailures, 1);
  assert.equal(row.runtimeExecutions, 1);
  assert.equal(row.quotedExecutions, 0);
  assert.equal(row.runtimeNoQuotedFallback, false);
  assert.equal(row.runtimeConstructionStatus, "violated");
});

test("runtime observations require explicit construction mode and zero Exact count", () => {
  const missingExact = boundaryFixture({ planner_solver_detail: { solverPlans: 1, solverAmountPoints: 3 } });
  const unknown = boundaryReport(missingExact).productionBoundaries.rows[0]!;
  assert.equal(unknown.simHopExactCalls, null);
  assert.equal(unknown.runtimeNoQuotedFallback, null);
  assert.equal(unknown.runtimeConstructionStatus, "unverified");
  const nonzero = boundaryFixture({ planner_solver_detail: { solverPlans: 1, solverAmountPoints: 3, solverHopExactCalls: 1 } });
  assert.equal(boundaryReport(nonzero).productionBoundaries.rows[0]!.runtimeNoQuotedFallback, false);
  const noMode = boundaryFixture();
  noMode[8] = boundaryEvent("[searcher/sim-amount] ", { ...boundarySource, type: "sim_amount_construction", atMonotonicMs: 2500 });
  assert.equal(boundaryReport(noMode).productionBoundaries.rows[0]!.runtimeNoQuotedFallback, null);
  const noConstruction = boundaryFixture().filter(line => !line.includes('"type":"sim_amount_construction"'));
  assert.equal(boundaryReport(noConstruction).productionBoundaries.rows[0]!.runtimeNoQuotedFallback, null);
  assert.equal(boundaryReport(boundaryFixture()).productionBoundaries.rows[0]!.runtimeNoQuotedFallback, true);
});
