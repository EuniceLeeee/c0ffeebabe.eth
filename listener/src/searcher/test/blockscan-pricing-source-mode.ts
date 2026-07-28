import assert from "node:assert/strict";
import {
  resolveBlockScanPricingSourceMode,
} from "../blockscan-pricing-source-mode.js";

assert.deepEqual(
  resolveBlockScanPricingSourceMode([], undefined),
  { mode: "n", source: "default" },
);
assert.deepEqual(
  resolveBlockScanPricingSourceMode([], "1"),
  { mode: "n-1", source: "environment" },
);
assert.deepEqual(
  resolveBlockScanPricingSourceMode([], "0"),
  { mode: "n", source: "environment" },
);
assert.deepEqual(
  resolveBlockScanPricingSourceMode(
    ["--blockscan-pricing-source", "n"],
    "1",
  ),
  { mode: "n", source: "cli" },
);
assert.deepEqual(
  resolveBlockScanPricingSourceMode(
    ["--blockscan-pricing-source=n-1"],
    "0",
  ),
  { mode: "n-1", source: "cli" },
);
assert.throws(
  () => resolveBlockScanPricingSourceMode(
    ["--blockscan-pricing-source", "n-2"],
    undefined,
  ),
  /must be exactly/,
);
assert.throws(
  () => resolveBlockScanPricingSourceMode(
    [
      "--blockscan-pricing-source=n",
      "--blockscan-pricing-source=n-1",
    ],
    undefined,
  ),
  /only once/,
);
assert.throws(
  () => resolveBlockScanPricingSourceMode([], "true"),
  /must be 0 or 1/,
);

console.log("blockscan-pricing-source-mode PASS (8/8)");
