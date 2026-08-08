import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWindow } from "../blockscan-window.js";

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

function state(input: {
  sourceBlock: number;
  generation: number;
  priced: number;
  expected: number;
  status?: "complete" | "degraded" | "incomplete" | "failed";
  hash?: string;
  wallMs?: number;
}): string {
  return `[searcher/blockscan-nminus1-state] ${JSON.stringify({
    sourceBlock: input.sourceBlock,
    generation: input.generation,
    status: input.status ?? "complete",
    priced: input.priced,
    expected: input.expected,
    generationWallMs: input.wallMs ?? 5000,
    ...(input.hash ? { sourceBlockHash: input.hash } : {}),
  })}`;
}

function timing(input: {
  sourceBlock?: number;
  coarseSourceBlock?: number;
  enumeration?: string;
  hash?: string;
  seenAtMs?: number;
}): string {
  return `[searcher/blockscan-family] ${JSON.stringify({
    type: "block_scan_timing",
    ...(input.sourceBlock === undefined
      ? {}
      : { source_block: input.sourceBlock }),
    pass_mode: "periodic",
    startup_warm: false,
    coarse_source_block: input.coarseSourceBlock,
    coarse_source_block_hash: input.hash,
    source_head_seen_at_ms: input.seenAtMs ?? 1_000,
    stages: { enumeration: { status: input.enumeration ?? "ran" } },
  })}`;
}

function processStart(commit = "abc123"): string[] {
  return [
    "[searcher/live] starting V5 searcher",
    `[searcher/live] runtime_commit=${commit}`,
  ];
}

function graph(edges: number, hash: string): string {
  return `[searcher/blockscan] graph built: edges=${edges} from blockscan view=19275 blockscan_graph_hash=${hash}`;
}

test("window tool finds a contiguous 100% valid run and splits long runs", () => {
  const lines: string[] = [
    ...processStart(),
    graph(35_780, HASH_A),
    // invalid first pass (enumeration not ran)
    timing({
      sourceBlock: 100,
      coarseSourceBlock: 99,
      enumeration: "not-run",
    }),
  ];
  for (let block = 101; block <= 135; block++) {
    lines.push(
      state({
        sourceBlock: block - 1,
        generation: block - 100,
        priced: 90,
        expected: 100,
        hash: HASH_A,
        wallMs: 4_000,
      }),
      timing({
        sourceBlock: block,
        coarseSourceBlock: block - 1,
        hash: HASH_A,
        seenAtMs: 1_000 + block * 12_000,
      }),
    );
  }
  // one invalid pass after the run
  lines.push(
    state({
      sourceBlock: 135,
      generation: 36,
      priced: 90,
      expected: 100,
      hash: HASH_A,
    }),
    timing({
      sourceBlock: 136,
      coarseSourceBlock: 135,
      hash: HASH_B,
    }),
  );

  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 30,
  });
  assert.equal(report.scope.runtimeCommit, "abc123");
  assert.equal(report.schema_version, 2);
  assert.equal(report.scope.eligibleForQualification, true);
  assert.equal(report.scope.externalPidBindingRequired, true);
  assert.equal(report.totals.passes, 37);
  assert.equal(report.totals.valid, 35);
  assert.equal(report.totals.enumerationNotRan, 1);
  assert.equal(report.totals.ranMissingState, 1);
  assert.deepEqual(report.invalidByReason, {
    enumeration_not_ran: 1,
    source_block_hash_mismatch: 1,
  });
  assert.notEqual(report.longestRun, null);
  assert.equal(report.longestRun?.count, 35);
  assert.equal(report.longestRun?.valid, 35);
  assert.equal(report.longestRun?.startBlock, 101);
  assert.equal(report.longestRun?.endBlock, 135);
  assert.equal(report.longestRun?.blockSpan, 35);
  assert.equal(report.longestRun?.consecutiveSourceBlocks, true);
  assert.equal(report.longestRun?.pricedExpectedMin, 0.9);
  assert.equal(report.longestRun?.generationWallMsP50, 4_000);
  assert.equal(report.longestRun?.graphEdgesMin, 35_780);
  assert.equal(report.longestRun?.graphEdgesMax, 35_780);
  // min-run 30 with a 35-run: no automatic split (need >= 2*minRun)
  assert.equal(report.qualifyingRuns.length, 1);
  assert.equal(report.qualifyingRuns[0]?.count, 35);
});

test("window tool splits a run of 2x min-run into two non-overlapping windows", () => {
  const lines: string[] = processStart();
  for (let block = 200; block <= 239; block++) {
    lines.push(
      state({
        sourceBlock: block - 1,
        generation: block - 199,
        priced: 85,
        expected: 100,
      }),
      timing({
        sourceBlock: block,
        coarseSourceBlock: block - 1,
      }),
    );
  }
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 10,
  });
  assert.equal(report.longestRun?.count, 40);
  assert.equal(report.qualifyingRuns.length, 2);
  assert.equal(report.qualifyingRuns[0]?.count, 10);
  assert.equal(report.qualifyingRuns[1]?.count, 30);
  assert.equal(report.qualifyingRuns[0]?.startBlock, 200);
  assert.equal(report.qualifyingRuns[1]?.startBlock, 210);
});

test("window tool rejects the exact 80% boundary and accepts 81%", () => {
  const lines = [
    ...processStart(),
    state({
      sourceBlock: 249,
      generation: 1,
      priced: 80,
      expected: 100,
    }),
    timing({
      sourceBlock: 250,
      coarseSourceBlock: 249,
    }),
    state({
      sourceBlock: 250,
      generation: 2,
      priced: 81,
      expected: 100,
    }),
    timing({
      sourceBlock: 251,
      coarseSourceBlock: 250,
    }),
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 1,
  });
  assert.equal(report.totals.passes, 2);
  assert.equal(report.totals.valid, 1);
  assert.equal(report.totals.ranLowCoverage, 1);
  assert.deepEqual(report.invalidByReason, {
    below_eighty_percent: 1,
  });
  assert.equal(report.longestRun?.count, 1);
  assert.equal(report.longestRun?.startBlock, 251);
});

test("window tool classifies hash mismatch and low coverage as invalid", () => {
  const lines = [
    ...processStart(),
    state({
      sourceBlock: 300,
      generation: 1,
      priced: 70,
      expected: 100,
      hash: HASH_A,
    }),
    timing({
      sourceBlock: 301,
      coarseSourceBlock: 300,
      hash: HASH_B,
    }),
    state({
      sourceBlock: 301,
      generation: 2,
      priced: 90,
      expected: 100,
      hash: HASH_A,
    }),
    timing({
      sourceBlock: 302,
      coarseSourceBlock: 301,
      hash: HASH_A,
    }),
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 3,
  });
  assert.equal(report.totals.passes, 2);
  assert.equal(report.totals.valid, 1);
  assert.equal(report.totals.ranMissingState, 1);
  assert.equal(report.totals.ranLowCoverage, 0);
  assert.deepEqual(report.invalidByReason, {
    source_block_hash_mismatch: 1,
  });
  assert.equal(report.longestRun, null);
});

test("window tool breaks a streak across a missing source block", () => {
  const lines = [...processStart()];
  for (const block of [100, 101, 103]) {
    lines.push(
      state({
        sourceBlock: block - 1,
        generation: block,
        priced: 90,
        expected: 100,
      }),
      timing({ sourceBlock: block, coarseSourceBlock: block - 1 }),
    );
  }
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 2,
  });
  assert.equal(report.longestRun?.count, 2);
  assert.equal(report.longestRun?.blockSpan, 2);
  assert.equal(report.qualifyingRuns.length, 1);
  assert.deepEqual(report.continuityBreaks, { source_block_gap: 1 });
});

test("window tool does not inflate a streak with duplicate source blocks", () => {
  const lines = [...processStart()];
  for (const [generation, block] of [200, 200, 201].entries()) {
    lines.push(
      state({
        sourceBlock: block - 1,
        generation,
        priced: 90,
        expected: 100,
      }),
      timing({ sourceBlock: block, coarseSourceBlock: block - 1 }),
    );
  }
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 3,
  });
  assert.equal(report.longestRun, null);
  assert.equal(report.qualifyingRuns.length, 0);
  assert.deepEqual(report.continuityBreaks, {
    source_block_duplicate_or_regression: 1,
  });
});

test("window tool rejects a timing record without source_block", () => {
  const lines = [
    ...processStart(),
    state({
      sourceBlock: 299,
      generation: 1,
      priced: 90,
      expected: 100,
    }),
    timing({ coarseSourceBlock: 299 }),
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 1,
  });
  assert.equal(report.totals.valid, 0);
  assert.deepEqual(report.invalidByReason, { missing_source_block: 1 });
  assert.equal(report.longestRun, null);
});

test("window tool fails closed across a same-commit process restart", () => {
  const lines = [
    ...processStart(),
    state({ sourceBlock: 399, generation: 1, priced: 90, expected: 100 }),
    timing({ sourceBlock: 400, coarseSourceBlock: 399 }),
    ...processStart(),
    // State published by the prior process must not satisfy this pass.
    timing({ sourceBlock: 401, coarseSourceBlock: 400 }),
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 1,
  });
  assert.equal(report.scope.processStartCount, 2);
  assert.equal(report.scope.eligibleForQualification, false);
  assert.equal(report.scope.ineligibleReason, "expected_one_process_start:2");
  assert.equal(report.totals.ranMissingState, 1);
  assert.equal(report.longestRun, null);
  assert.equal(report.qualifyingRuns.length, 0);
});

test("window tool fails closed when runtime commit changes inside the scope", () => {
  const lines = [
    ...processStart("commit-a"),
    state({ sourceBlock: 499, generation: 1, priced: 90, expected: 100 }),
    timing({ sourceBlock: 500, coarseSourceBlock: 499 }),
    "[searcher/live] runtime_commit=commit-b",
    state({ sourceBlock: 500, generation: 2, priced: 90, expected: 100 }),
    timing({ sourceBlock: 501, coarseSourceBlock: 500 }),
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 1,
  });
  assert.equal(report.scope.runtimeCommit, null);
  assert.equal(report.scope.eligibleForQualification, false);
  assert.equal(
    report.scope.ineligibleReason,
    "expected_one_nonempty_runtime_commit_line:2/2",
  );
  assert.equal(report.longestRun, null);
  assert.equal(report.qualifyingRuns.length, 0);
});

test("window tool requires the coarse source to be the exact predecessor", () => {
  const lines = [
    ...processStart(),
    state({ sourceBlock: 600, generation: 1, priced: 90, expected: 100 }),
    timing({ sourceBlock: 602, coarseSourceBlock: 600 }),
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 1,
  });
  assert.equal(report.totals.valid, 0);
  assert.deepEqual(report.invalidByReason, {
    coarse_source_not_predecessor: 1,
  });
  assert.equal(report.longestRun, null);
});

test("window tool does not attribute pre-banner records to a later commit", () => {
  const lines = [
    "[searcher/live] starting V5 searcher",
    state({ sourceBlock: 699, generation: 1, priced: 90, expected: 100 }),
    timing({ sourceBlock: 700, coarseSourceBlock: 699 }),
    "[searcher/live] runtime_commit=abc123",
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 1,
  });
  assert.equal(report.scope.recordsBeforeRuntimeCommit, 2);
  assert.equal(report.scope.eligibleForQualification, false);
  assert.equal(report.scope.ineligibleReason, "records_before_runtime_commit:2");
  assert.equal(report.totals.passes, 0);
  assert.equal(report.longestRun, null);
});

test("window tool fails closed on an empty second runtime banner", () => {
  const lines = [
    ...processStart(),
    state({ sourceBlock: 799, generation: 1, priced: 90, expected: 100 }),
    timing({ sourceBlock: 800, coarseSourceBlock: 799 }),
    "[searcher/live] runtime_commit=",
  ];
  const report = analyzeWindow(lines.join("\n"), {
    startLine: 1,
    minRun: 1,
  });
  assert.equal(report.scope.runtimeCommitLines, 2);
  assert.equal(report.scope.eligibleForQualification, false);
  assert.equal(
    report.scope.ineligibleReason,
    "expected_one_nonempty_runtime_commit_line:2/1",
  );
  assert.equal(report.longestRun, null);
});
