import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBlockScanKpiLog } from "../blockscan-kpi.js";

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

function state(input: {
  sourceBlock: number;
  generation: number;
  priced: number;
  expected: number;
  status?: "complete" | "degraded" | "incomplete" | "failed";
  hash?: string;
}): string {
  return `[searcher/blockscan-nminus1-state] ${JSON.stringify({
    sourceBlock: input.sourceBlock,
    generation: input.generation,
    status: input.status ?? "complete",
    priced: input.priced,
    expected: input.expected,
    ...(input.hash ? { sourceBlockHash: input.hash } : {}),
  })}`;
}

function timing(input: {
  coarseSourceBlock?: number;
  enumeration?: string;
  passMode?: string;
  startupWarm?: boolean;
  hash?: string;
}): string {
  return `[searcher/blockscan-family] ${JSON.stringify({
    type: "block_scan_timing",
    pass_mode: input.passMode ?? "periodic",
    startup_warm: input.startupWarm ?? false,
    coarse_source_block: input.coarseSourceBlock,
    coarse_source_block_hash: input.hash,
    stages: { enumeration: { status: input.enumeration ?? "ran" } },
  })}`;
}

test("KPI uses only the latest process window and partitions its periodic non-warm cohort", () => {
  const log = [
    "[searcher/live] starting V5 searcher",
    "[searcher/live] runtime_commit=old",
    state({ sourceBlock: 99, generation: 1, priced: 100, expected: 100 }),
    timing({ coarseSourceBlock: 99 }),
    "[searcher/live] starting V5 searcher",
    "[searcher/live] runtime_commit=new",
    "[searcher/blockscan-family] block=100 degraded reason=state",
    state({ sourceBlock: 100, generation: 1, priced: 81, expected: 100 }),
    timing({ coarseSourceBlock: 100 }),
    state({ sourceBlock: 101, generation: 2, priced: 79, expected: 100 }),
    timing({ coarseSourceBlock: 101 }),
    timing({ coarseSourceBlock: 100, enumeration: "not-run" }),
    timing({ coarseSourceBlock: 102 }),
    timing({ coarseSourceBlock: 100, passMode: "evidence" }),
    timing({ coarseSourceBlock: 100, startupWarm: true }),
  ].join("\n");

  const report = analyzeBlockScanKpiLog(log);
  assert.equal(report.scope.process_window_start_line, 5);
  assert.equal(report.scope.process_start_marker_found, true);
  assert.equal(report.scope.runtime_commit, "new");
  assert.deepEqual(report.counts, {
    cohort: 4,
    valid: 1,
    ran_low_coverage: 1,
    ran_missing_state: 1,
    enumeration_not_ran: 1,
    valid_bps: 2_500,
  });
  assert.equal(report.exclusions.non_periodic_or_missing_mode, 1);
  assert.equal(report.exclusions.startup_warm, 1);
  assert.equal(report.exclusions.malformed_timing_json, 0);
  assert.equal(report.join.block_number_only, 2);
  assert.match(report.join.caveats[0] ?? "", /source block number only/);
});

test("KPI rejects the exact 80% boundary and accepts the first ratio above it", () => {
  const log = [
    "[searcher/live] starting V5 searcher",
    state({ sourceBlock: 110, generation: 1, priced: 80, expected: 100 }),
    timing({ coarseSourceBlock: 110 }),
    state({ sourceBlock: 111, generation: 2, priced: 81, expected: 100 }),
    timing({ coarseSourceBlock: 111 }),
  ].join("\n");

  const report = analyzeBlockScanKpiLog(log);
  assert.equal(
    report.cohort_definition.threshold,
    "expected > 0 and priced / expected > 0.80",
  );
  assert.equal(report.counts.cohort, 2);
  assert.equal(report.counts.valid, 1);
  assert.equal(report.counts.ran_low_coverage, 1);
  assert.equal(report.ran_low_coverage_reasons.below_eighty_percent, 1);
});

test("KPI selects the latest preceding published generation and never a future state", () => {
  const log = [
    "[searcher/live] starting V5 searcher",
    state({ sourceBlock: 200, generation: 10, priced: 100, expected: 100 }),
    state({ sourceBlock: 200, generation: 11, priced: 10, expected: 100 }),
    state({
      sourceBlock: 200,
      generation: 12,
      priced: 100,
      expected: 100,
      status: "incomplete",
    }),
    timing({ coarseSourceBlock: 200 }),
    timing({ coarseSourceBlock: 201 }),
    state({ sourceBlock: 201, generation: 13, priced: 100, expected: 100 }),
  ].join("\n");

  const report = analyzeBlockScanKpiLog(log);
  assert.equal(report.counts.valid, 0);
  assert.equal(report.counts.ran_low_coverage, 1);
  assert.equal(report.counts.ran_missing_state, 1);
  assert.equal(report.ran_missing_state_reasons.no_preceding_published_state, 1);
  assert.equal(report.join.latest_preceding_generation, 1);
});

test("KPI requires equal source hashes when both telemetry records expose them", () => {
  const log = [
    "[searcher/live] starting V5 searcher",
    state({ sourceBlock: 300, generation: 1, priced: 100, expected: 100, hash: HASH_A }),
    timing({ coarseSourceBlock: 300, hash: HASH_A.toUpperCase().replace("0X", "0x") }),
    state({ sourceBlock: 301, generation: 2, priced: 100, expected: 100, hash: HASH_A }),
    timing({ coarseSourceBlock: 301, hash: HASH_B }),
  ].join("\n");

  const report = analyzeBlockScanKpiLog(log);
  assert.equal(report.counts.valid, 1);
  assert.equal(report.counts.ran_missing_state, 1);
  assert.equal(report.join.hash_matched, 1);
  assert.equal(report.join.hash_mismatch, 1);
  assert.equal(report.ran_missing_state_reasons.source_block_hash_mismatch, 1);
  assert.equal(report.join.block_number_only, 0);
});

test("explicit start line cannot pull a state from before the selected scope", () => {
  const log = [
    state({ sourceBlock: 400, generation: 1, priced: 100, expected: 100 }),
    "noise",
    timing({ coarseSourceBlock: 400 }),
  ].join("\n");
  const report = analyzeBlockScanKpiLog(log, { startLine: 2 });
  assert.equal(report.scope.process_window_start_line, 2);
  assert.equal(report.scope.process_start_marker_found, false);
  assert.equal(report.counts.ran_missing_state, 1);
  assert.ok(report.join.caveats.some((value) => value.includes("process-start marker")));
});

test("a start line past EOF yields an empty cohort instead of pulling older records", () => {
  const report = analyzeBlockScanKpiLog(timing({ coarseSourceBlock: 1 }), {
    startLine: 100,
  });
  assert.equal(report.scope.process_window_start_line, 100);
  assert.equal(report.counts.cohort, 0);
});
