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
interface TestCallControl {
  deadlineAtMs?: number;
  signal?: AbortSignal;
}
let activeCalls = 0;
let token0Calls = 0;
let abortCount = 0;
let observedDeadlineAtMs: number | undefined;
let observedSignal = false;
const state = {
  call(req: { data: string }, control?: TestCallControl): Promise<string> {
    activeCalls++;
    const selector = req.data.slice(0, 10);
    if (selector === pair.getFunction("token0")!.selector) token0Calls++;
    observedDeadlineAtMs = control?.deadlineAtMs;
    observedSignal = control?.signal !== undefined;
    if (!control?.signal) {
      activeCalls--;
      return Promise.reject(new Error("exact probe call did not receive its deadline signal"));
    }
    return new Promise<string>((_resolve, reject) => {
      const abort = () => {
        abortCount++;
        activeCalls--;
        reject(new Error("test transport aborted"));
      };
      if (control.signal!.aborted) abort();
      else control.signal!.addEventListener("abort", abort, { once: true });
    });
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
const diagnostics: string[] = [];
const deadlineAtMs = Date.now() + 80;
const refinement = refineBlockScanCandidates(
  state,
  [delayedOpportunity],
  1,
  deadlineAtMs,
  pricedTokens,
  (diagnostic) => diagnostics.push(diagnostic.status),
  1,
);
let watchdogTimer: ReturnType<typeof setTimeout>;
const watchdog = new Promise<never>((_resolve, reject) => {
  watchdogTimer = setTimeout(
    () => reject(new Error("deadline did not cancel the in-flight quote")),
    1_000,
  );
});
const delayedResult = await Promise.race([refinement, watchdog]);
clearTimeout(watchdogTimer!);
assert.equal(observedDeadlineAtMs, deadlineAtMs, "the absolute refinement deadline must reach call()");
assert.equal(observedSignal, true, "the refinement deadline must carry an AbortSignal");
assert.equal(abortCount, 1, "the in-flight quote transport must be aborted exactly once");
assert.equal(activeCalls, 0, "refinement may return only after the aborted quote settles");
assert.equal(delayedResult.deadlineHit, true, "an aborted deadline quote must stop the solve phase");
assert.equal(delayedResult.attempted, 1);
assert.equal(delayedResult.failed, 0, "deadline is not a quote failure");
assert.equal(token0Calls, 1, "deadline must prevent the next route hop from starting");
assert.deepEqual(diagnostics, ["unprobed"], "deadline cancellation must remain an unprobed route");

console.log("blockscan-candidate-refinement PASS");
