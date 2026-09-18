import assert from "node:assert/strict";
import { resolveBlockScanSolverSearchConfig } from
  "../blockscan-solver-search-config.js";

assert.deepEqual(resolveBlockScanSolverSearchConfig({}), {
  amountGrid: "multiples",
  gridHalfWidth: 2,
  gssMaxTries: 4,
  quoteConcurrency: 16,
  quoteToleranceRawUnits: 0n,
});

assert.deepEqual(resolveBlockScanSolverSearchConfig({
  SEARCHER_BLOCKSCAN_SOLVER_GRID_HALF_WIDTH: "3",
  SEARCHER_BLOCKSCAN_SOLVER_GSS_MAX_TRIES: "8",
  SEARCHER_BLOCKSCAN_SOLVER_QUOTE_CONCURRENCY: "12",
}), {
  amountGrid: "multiples",
  gridHalfWidth: 3,
  gssMaxTries: 8,
  quoteConcurrency: 12,
  quoteToleranceRawUnits: 0n,
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

for (const flag of ["1", "true"]) {
  assert.equal(resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: flag,
  }).quoteToleranceRawUnits, 1n);
  assert.equal(resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: flag,
    SEARCHER_QUOTE_SAFETY_BPS: "9998",
  }).quoteToleranceRawUnits, 1n, "percentage settings must not widen the one-unit tolerance");
  assert.equal(resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: flag,
    SEARCHER_BLOCKSCAN_QUOTE_SAFETY_PPM: "999999",
    SEARCHER_QUOTE_SAFETY_BPS: "9998",
  }).quoteToleranceRawUnits, 1n, "obsolete PPM settings must not change absolute tolerance");
  assert.equal(resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: flag,
    SEARCHER_BLOCKSCAN_QUOTE_SAFETY_PPM: "1000000",
  }).quoteToleranceRawUnits, 1n);
}
for (const flag of [undefined, "0", "false"]) {
  assert.equal(resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: flag,
    SEARCHER_QUOTE_SAFETY_BPS: "9998",
    SEARCHER_BLOCKSCAN_QUOTE_SAFETY_PPM: "999999",
  }).quoteToleranceRawUnits, 0n, "off preserves existing blockscan behavior");
}
for (const value of ["", "yes", "TRUE", "2"]) {
  assert.throws(() => resolveBlockScanSolverSearchConfig({
    SEARCHER_BLOCKSCAN_QUOTE_TOLERANCE_ENABLED: value,
  }), /QUOTE_TOLERANCE_ENABLED must be/);
}
console.log("blockscan-solver-search-config PASS (search + one-raw-unit tolerance on/off/validation)");
