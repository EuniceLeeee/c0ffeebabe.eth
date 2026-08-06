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
  sourceBlock: number;
  coarseSourceBlock: number;
  enumeration?: string;
  hash?: string;
  seenAtMs?: number;
}): string {
  return `[searcher/blockscan-family] ${JSON.stringify({
    type: "block_scan_timing",
    source_block: input.sourceBlock,
    pass_mode: "periodic",
    startup_warm: false,
    coarse_source_block: input.coarseSourceBlock,
    coarse_source_block_hash: input.hash,
    source_head_seen_at_ms: input.seenAtMs ?? 1_000,
    stages: { enumeration: { status: input.enumeration ?? "ran" } },
  })}`;
}

function graph(edges: number, hash: string): string {
  return `[searcher/blockscan] graph built: edges=${edges} from blockscan view=19275 blockscan_graph_hash=${hash}`;
}

test("window tool finds a contiguous 100% valid run and splits long runs", () => {
  const lines: string[] = [
    "[searcher/live] starting V5 searcher",
    "[searcher/live] runtime_commit=abc123",
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
  assert.equal(report.longestRun?.pricedExpectedMin, 0.9);
  assert.equal(report.longestRun?.generationWallMsP50, 4_000);
  assert.equal(report.longestRun?.graphEdgesMin, 35_780);
  assert.equal(report.longestRun?.graphEdgesMax, 35_780);
  // min-run 30 with a 35-run: no automatic split (need >= 2*minRun)
  assert.equal(report.qualifyingRuns.length, 1);
  assert.equal(report.qualifyingRuns[0]?.count, 35);
});

test("window tool splits a run of 2x min-run into two non-overlapping windows", () => {
  const lines: string[] = [];
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

test("window tool classifies hash mismatch and low coverage as invalid", () => {
  const lines = [
    "[searcher/live] starting V5 searcher",
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
