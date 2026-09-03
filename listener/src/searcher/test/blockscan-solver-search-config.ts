import assert from "node:assert/strict";
import { resolveBlockScanSolverSearchConfig } from
  "../blockscan-solver-search-config.js";

assert.deepEqual(resolveBlockScanSolverSearchConfig({}), {
  gridHalfWidth: 2,
  gssMaxTries: 4,
  quoteConcurrency: 16,
});

assert.deepEqual(resolveBlockScanSolverSearchConfig({
  SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH: "3",
  SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES: "8",
  SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY: "12",
}), {
  gridHalfWidth: 3,
  gssMaxTries: 8,
  quoteConcurrency: 12,
});

assert.throws(
  () => resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH: "2.5",
  }),
  /SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH must be an integer in \[0, 16\]/,
);
assert.throws(
  () => resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES: "1",
  }),
  /SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES must be an integer in \[2, 64\]/,
);
assert.throws(
  () => resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH: "17",
  }),
  /SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH must be an integer in \[0, 16\]/,
);
assert.throws(
  () => resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY: "0",
  }),
  /SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY must be an integer in \[1, 64\]/,
);
assert.throws(
  () => resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY: "65",
  }),
  /SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY must be an integer in \[1, 64\]/,
);

console.log("blockscan-solver-search-config PASS (7/7)");
