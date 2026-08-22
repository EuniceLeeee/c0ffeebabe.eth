import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePassLatency } from "../blockscan-pass-latency.js";

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
