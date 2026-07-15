import assert from "node:assert/strict";
import { exactProbePriority } from "../detector/blockscan-candidate-refinement.js";
import type { BlockScanOpportunity } from "../detector/detector.js";

const TOKEN_6 = "0x0000000000000000000000000000000000000006";
const TOKEN_18 = "0x0000000000000000000000000000000000000018";

function opportunity(flashToken: string, searchCenter: bigint): BlockScanOpportunity {
  return {
    kind: "block-scan-arb",
    sourceBlock: 1,
    stateBlock: 1,
    cycleId: flashToken,
    cycleFingerprint: flashToken,
    seedEdges: [],
    flashToken,
    searchSeed: { startToken: flashToken, searchCenter, maxInput: searchCenter },
    leavesStandingPosition: false,
  };
}

const pricedTokens = new Map([
  [TOKEN_6, { maxBorrow: 5_000_000n * 10n ** 6n }],
  [TOKEN_18, { maxBorrow: 5_000_000n * 10n ** 18n }],
]);

const sixDecimal = exactProbePriority(
  opportunity(TOKEN_6, 500_000n * 10n ** 6n),
  100,
  pricedTokens,
);
const eighteenDecimal = exactProbePriority(
  opportunity(TOKEN_18, 500_000n * 10n ** 18n),
  100,
  pricedTokens,
);
assert.equal(sixDecimal, eighteenDecimal, "priority must not depend on token decimals");

const highMarginDust = exactProbePriority(
  opportunity(TOKEN_6, 1_000n * 10n ** 6n),
  1_000,
  pricedTokens,
);
assert(
  sixDecimal > highMarginDust,
  "normalized expected return should outrank a higher-margin route with negligible capacity",
);
assert.equal(exactProbePriority(opportunity(TOKEN_6, 1n), 100, new Map()), 0);

console.log("blockscan-candidate-refinement PASS");
