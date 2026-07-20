import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  exactProbePriority,
  refineBlockScanCandidates,
} from "../detector/blockscan-candidate-refinement.js";
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

const pair = new ethers.Interface([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
]);
const target = "0x00000000000000000000000000000000000000a1";
let releaseCall!: () => void;
const callBarrier = new Promise<void>((resolve) => { releaseCall = resolve; });
let activeCalls = 0;
let token0Calls = 0;
const state = {
  async call(req: { data: string }): Promise<string> {
    activeCalls++;
    try {
      await callBarrier;
      const selector = req.data.slice(0, 10);
      if (selector === pair.getFunction("token0")!.selector) {
        token0Calls++;
        return pair.encodeFunctionResult("token0", [TOKEN_6]);
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return pair.encodeFunctionResult("getReserves", [1_000_000n, 2_000_000n, 0]);
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return pair.encodeFunctionResult("factory", [ethers.ZeroAddress]);
      }
      throw new Error(`unexpected call ${req.data}`);
    } finally {
      activeCalls--;
    }
  },
} as StateBackend;
const delayedOpportunity: BlockScanOpportunity = {
  ...opportunity(TOKEN_6, 1_024n),
  seedEdges: [{
    adapterId: "univ2-swap",
    target,
    tokenIn: TOKEN_6,
    tokenOut: TOKEN_18,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  }, {
    adapterId: "univ2-swap",
    target,
    tokenIn: TOKEN_18,
    tokenOut: TOKEN_6,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  }],
};
let refinementSettled = false;
const refinement = refineBlockScanCandidates(
  state,
  [delayedOpportunity],
  1,
  Date.now() + 30,
  pricedTokens,
  undefined,
  1,
).then((result) => {
  refinementSettled = true;
  return result;
});
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(refinementSettled, false, "deadline must not detach an in-flight quote");
assert.equal(activeCalls, 1, "the real quote must remain owned by the refinement phase");
releaseCall();
const delayedResult = await refinement;
assert.equal(activeCalls, 0, "refinement may return only after all exact quotes settle");
assert.equal(delayedResult.deadlineHit, true, "an over-deadline owned quote must stop the solve phase");
assert.equal(delayedResult.attempted, 1);
assert.equal(delayedResult.failed, 0, "deadline is not a quote failure");
assert.equal(token0Calls, 1, "deadline must prevent the next route hop from starting");

console.log("blockscan-candidate-refinement PASS");
