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
