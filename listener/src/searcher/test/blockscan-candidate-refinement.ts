import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  exactProbePriority,
  refineBlockScanCandidates,
  type BlockScanProbeDiagnostic,
} from "../detector/blockscan-candidate-refinement.js";
import { selectFamilyFairExpansionEdges } from "../detector/blockscan-scanner-core.js";
import {
  BlockScanFamilyAttributedError,
  BlockScanFamilyStageBudget,
  blockScanEdgeInstanceCircuitKey,
  blockScanEdgeFamilyId,
  blockScanFailureCircuitAttribution,
  blockScanRouteFamilyIds,
  selectByBlockScanFamily,
} from "../detector/blockscan-family-budget.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import { buildTokenPaths, type TokenEdge } from "../planner/token-graph.js";
import { canonicalEdgeId } from "../venues/blockscan-state-capability.js";

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
const diagnostics: BlockScanProbeDiagnostic[] = [];
const deadlineAtMs = Date.now() + 80;
const refinement = refineBlockScanCandidates(
  state,
  [delayedOpportunity],
  1,
  deadlineAtMs,
  pricedTokens,
  (diagnostic) => diagnostics.push(diagnostic),
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
assert.deepEqual(
  diagnostics.map(({ status }) => status),
  ["unprobed"],
  "deadline cancellation must remain an unprobed route",
);
assert.equal(diagnostics[0]?.attempted, true);
assert.equal(diagnostics[0]?.failure?.reason, "global_deadline");
assert.equal(diagnostics[0]?.failure?.attributedFamilyId, "univ2-swap");
assert.equal(diagnostics[0]?.failure?.stage, "exact quote");

familyFairAdmissionAndCircuit();
instanceAttributionCannotEscapeCurrentRoute();
singletonManagerInstancesDoNotCollide();
badFamilyHighScoreFloodCannotConsumeExpansionCap();
await failingFamilyCannotConsumeRefinementCap();
await differentInstanceFailuresDoNotOpenFamilyCircuit();
await sameInstanceCircuitDoesNotBlockOppositeDirection();
await neverSettlingFamilyUsesLocalBudget();
await mixedRouteTimeoutIsAttributedToCurrentLeg();
await earlyZeroDoesNotClearUnvisitedInstanceCircuit();
await transientCircuitWaitsForInflightRecovery();
await confirmedPositiveSurvivesLaterInstanceCircuit();

console.log("blockscan-candidate-refinement PASS");

function familyFairAdmissionAndCircuit(): void {
  const items = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `bad-${index}`,
      edges: [familyEdge("bad-family", index)],
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `healthy-${index}`,
      edges: [familyEdge("healthy-family", index)],
    })),
  ];
  const selected = selectByBlockScanFamily(
    items,
    4,
    (item) => blockScanRouteFamilyIds(item.edges),
  );
  assert.deepEqual(
    selected.map((item) => item.id),
    ["bad-0", "healthy-0", "bad-1", "healthy-1"],
    "a large family bucket cannot consume every global admission slot",
  );
  assert.deepEqual(
    selected
      .filter((item) => item.id.startsWith("healthy-"))
      .map((item) => item.id),
    ["healthy-0", "healthy-1"],
    "family admission preserves deterministic order within a healthy bucket",
  );
  const mixed = selectByBlockScanFamily(
    [
      {
        id: "bad-with-a",
        edges: [familyEdge("bad-family", 20), familyEdge("sibling-a", 21)],
      },
      {
        id: "bad-with-b",
        edges: [familyEdge("bad-family", 22), familyEdge("sibling-b", 23)],
      },
      {
        id: "healthy-only",
        edges: [familyEdge("healthy-family", 24)],
      },
    ],
    2,
    (item) => blockScanRouteFamilyIds(item.edges),
  );
  assert.deepEqual(
    mixed.map((item) => item.id),
    ["bad-with-a", "healthy-only"],
    "a bad family cannot evade accounting through distinct dependency sets",
  );
  const sharedHealthyDependency = selectByBlockScanFamily(
    [
      {
        id: "bad-and-healthy-0",
        edges: [familyEdge("bad-family", 30), familyEdge("healthy-family", 31)],
      },
      {
        id: "bad-and-healthy-1",
        edges: [familyEdge("bad-family", 32), familyEdge("healthy-family", 33)],
      },
      {
        id: "healthy-route",
        edges: [familyEdge("healthy-family", 34)],
      },
    ],
    2,
    (item) => blockScanRouteFamilyIds(item.edges),
  );
  assert.deepEqual(
    sharedHealthyDependency.map((item) => item.id),
    ["bad-and-healthy-0", "healthy-route"],
    "a mixed bad route cannot hide the healthy-only route behind shared-family rank",
  );

  const mixedFailureBudget = new BlockScanFamilyStageBudget(3);
  const mixedEdges = [
    familyEdge("bad-family", 40),
    familyEdge("healthy-family", 41),
  ];
  const healthyEdges = [familyEdge("healthy-family", 42)];
  for (let index = 0; index < 3; index++) {
    mixedFailureBudget.recordFailure(mixedEdges);
  }
  assert.equal(mixedFailureBudget.blocks(mixedEdges), true);
  assert.deepEqual(mixedFailureBudget.openFamilyIds(), []);
  assert.equal(
    mixedFailureBudget.openCompositeKeys().length,
    1,
    "an unattributed mixed-route failure must expose the exact dependency-set circuit",
  );
  assert.equal(
    mixedFailureBudget.blocks(healthyEdges),
    false,
    "three unattributed mixed-route failures must not open the healthy family",
  );
  let healthyRuns = 0;
  if (!mixedFailureBudget.blocks(healthyEdges)) healthyRuns++;
  assert.equal(
    healthyRuns,
    1,
    "healthy-only work still runs after the mixed dependency set opens",
  );

  const attributedBudget = new BlockScanFamilyStageBudget(3);
  for (let index = 0; index < 3; index++) {
    attributedBudget.recordFailure(
      mixedEdges,
      new BlockScanFamilyAttributedError(
        "bad-family",
        "test leg",
        new Error("injected"),
      ),
    );
  }
  assert.equal(attributedBudget.blocks(mixedEdges), true);
  assert.equal(
    attributedBudget.blocks(healthyEdges),
    false,
    "typed per-leg failures strike only their owner",
  );
}

function instanceAttributionCannotEscapeCurrentRoute(): void {
  const edge = familyEdge("owned-family", 70);
  const forged = familyEdge("owned-family", 71);
  const forgedAttribution = blockScanFailureCircuitAttribution(
    [edge],
    new BlockScanFamilyAttributedError(
      "owned-family",
      "test",
      new Error("forged"),
      forged.canonicalEdgeId ?? null,
    ),
  );
  assert.deepEqual(
    forgedAttribution,
    {
      scope: "family",
      key: "owned-family",
      familyId: "owned-family",
    },
    "a canonical edge outside the current route cannot create an orphan instance circuit",
  );

  const wrongOwner = blockScanFailureCircuitAttribution(
    [edge],
    new BlockScanFamilyAttributedError(
      "other-family",
      "test",
      new Error("wrong owner"),
      edge.canonicalEdgeId ?? null,
    ),
  );
  assert.equal(
    wrongOwner.scope,
    "composite",
    "an attributed owner outside the current route must fail safe to the route composite",
  );

  const legacyEdge = {
    ...edge,
    canonicalEdgeId: undefined,
  };
  const legacy = blockScanFailureCircuitAttribution(
    [legacyEdge],
    new BlockScanFamilyAttributedError(
      "owned-family",
      "test",
      new Error("legacy"),
    ),
  );
  assert.equal(legacy.scope, "family");
  assert.equal(legacy.key, "owned-family");
}

function singletonManagerInstancesDoNotCollide(): void {
  const target = "0x0000000000000000000000000000000000000075";
  const first = familyEdge("singleton-family", 75, {
    target,
    poolId: `0x${"01".padStart(64, "0")}`,
  });
  const second = familyEdge("singleton-family", 75, {
    target,
    poolId: `0x${"02".padStart(64, "0")}`,
  });
  assert.notEqual(first.canonicalEdgeId, second.canonicalEdgeId);
  assert.notEqual(
    blockScanEdgeInstanceCircuitKey(first),
    blockScanEdgeInstanceCircuitKey(second),
    "singleton-manager pools sharing one target must retain distinct instance circuits",
  );
}

async function failingFamilyCannotConsumeRefinementCap(): Promise<void> {
  const poolA = "0x00000000000000000000000000000000000000b1";
  const poolB = "0x00000000000000000000000000000000000000b2";
  const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
  const healthy = {
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: "healthy",
    cycleFingerprint: "healthy",
    seedEdges: [
      familyEdge("healthy-family", 0, {
        adapterId: "univ2-swap",
        target: poolA,
        tokenIn: TOKEN_6,
        tokenOut: TOKEN_18,
      }),
      familyEdge("healthy-family", 1, {
        adapterId: "univ2-swap",
        target: poolB,
        tokenIn: TOKEN_18,
        tokenOut: TOKEN_6,
      }),
    ],
  } satisfies BlockScanOpportunity;
  const bad = Array.from({ length: 6 }, (_, index): BlockScanOpportunity => ({
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: `bad-${index}`,
    cycleFingerprint: `bad-${index}`,
    seedEdges: [familyEdge("bad-family", index, {
      adapterId: "bad-family-edge",
    })],
  }));
  const exactState = {
    async call(req: { to: string; data: string }): Promise<string> {
      const selector = req.data.slice(0, 10);
      if (selector === pair.getFunction("token0")!.selector) {
        return pair.encodeFunctionResult("token0", [TOKEN_6]);
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return pair.encodeFunctionResult(
          "getReserves",
          req.to.toLowerCase() === poolA.toLowerCase()
            ? [1_000_000n, 2_000_000n, 0]
            : [1_000_000n, 1_000_000n, 0],
        );
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return pair.encodeFunctionResult("factory", [factory]);
      }
      throw new Error(`unexpected exact quote selector ${selector}`);
    },
  } as StateBackend;
  const probeDiagnostics: BlockScanProbeDiagnostic[] = [];
  const result = await refineBlockScanCandidates(
    exactState,
    [...bad, healthy],
    4,
    Date.now() + 2_000,
    pricedTokens,
    (diagnostic) => probeDiagnostics.push(diagnostic),
    1,
  );
  assert.equal(result.deadlineHit, false);
  assert.equal(result.attempted, 4, "the breaker stops new bad-family quote probes");
  assert.deepEqual(result.openFamilyIds, ["bad-family"]);
  assert.deepEqual(result.openInstanceCircuitKeys, []);
  assert(
    probeDiagnostics.some(({ attempted, failure }) =>
      attempted &&
      failure?.reason === "quote_error" &&
      failure.attributedFamilyId === "bad-family" &&
      failure.blockingCircuitScope === "family" &&
      failure.stage === "exact quote"
    ),
    "direct adapter quote failures must carry their family and stage",
  );
  assert(
    probeDiagnostics.some(({ attempted, failure }) =>
      !attempted &&
      failure?.reason === "family_circuit_open" &&
      failure.blockingCircuitScope === "family" &&
      failure.familyIds.includes("bad-family")
    ),
    "circuit-skipped routes must be distinguishable from attempted quote failures",
  );
  assert.deepEqual(
    result.opportunities.map((item) => item.cycleId),
    ["healthy"],
    "exact failures fail closed while the interleaved healthy family survives",
  );
}

async function differentInstanceFailuresDoNotOpenFamilyCircuit(): Promise<void> {
  const pools = Array.from(
    { length: 4 },
    (_, index) =>
      `0x${(0x120 + index).toString(16).padStart(40, "0")}`,
  );
  const failingPools = new Set(pools.slice(0, 3).map((pool) => pool.toLowerCase()));
  const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      if (failingPools.has(req.to.toLowerCase())) {
        throw new Error("injected unrelated instance failure");
      }
      assert.equal(req.to.toLowerCase(), pools[3]);
      const selector = req.data.slice(0, 10);
      if (selector === pair.getFunction("token0")!.selector) {
        return pair.encodeFunctionResult("token0", [TOKEN_6]);
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return pair.encodeFunctionResult(
          "getReserves",
          [1_000_000n, 2_000_000n, 0],
        );
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return pair.encodeFunctionResult("factory", [factory]);
      }
      throw new Error(`unexpected different-instance selector ${selector}`);
    },
  } as StateBackend;
  const opportunities = pools.map((pool, index): BlockScanOpportunity => ({
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: index === 3 ? "target-instance" : `unrelated-failure-${index}`,
    cycleFingerprint: `different-instance-${index}`,
    seedEdges: [familyEdge("univ2-standard", 400 + index, {
      adapterId: "univ2-swap",
      target: pool,
      tokenIn: TOKEN_6,
      tokenOut: TOKEN_18,
    })],
  }));
  const result = await refineBlockScanCandidates(
    state,
    opportunities,
    opportunities.length,
    Date.now() + 2_000,
    pricedTokens,
    undefined,
    1,
    {
      familyTimeoutMs: 500,
      maxConcurrentPerFamily: 1,
    },
  );
  assert.equal(result.attempted, 4);
  assert.equal(result.positive, 1);
  assert.deepEqual(result.openFamilyIds, []);
  assert.deepEqual(result.openInstanceCircuitKeys, []);
  assert.deepEqual(
    result.opportunities.map(({ cycleId }) => cycleId),
    ["target-instance"],
    "three unrelated failures must not suppress the exact-positive target instance",
  );
}

async function sameInstanceCircuitDoesNotBlockOppositeDirection(): Promise<void> {
  const pool = "0x0000000000000000000000000000000000000150";
  const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
  let token0Calls = 0;
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      assert.equal(req.to.toLowerCase(), pool);
      const selector = req.data.slice(0, 10);
      if (selector === pair.getFunction("token0")!.selector) {
        if (token0Calls++ < 3) {
          throw new Error("injected forward-instance failure");
        }
        return pair.encodeFunctionResult("token0", [TOKEN_6]);
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return pair.encodeFunctionResult(
          "getReserves",
          [2_000_000n, 1_000_000n, 0],
        );
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return pair.encodeFunctionResult("factory", [factory]);
      }
      throw new Error(`unexpected opposite-direction selector ${selector}`);
    },
  } as StateBackend;
  const forward = (index: number): BlockScanOpportunity => ({
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: `forward-${index}`,
    cycleFingerprint: `forward-${index}`,
    seedEdges: [familyEdge("shared-direction-family", 430, {
      adapterId: "univ2-swap",
      target: pool,
      tokenIn: TOKEN_6,
      tokenOut: TOKEN_18,
    })],
  });
  const reverse: BlockScanOpportunity = {
    ...opportunity(TOKEN_18, 1_024n),
    cycleId: "reverse-target",
    cycleFingerprint: "reverse-target",
    seedEdges: [familyEdge("shared-direction-family", 430, {
      adapterId: "univ2-swap",
      target: pool,
      tokenIn: TOKEN_18,
      tokenOut: TOKEN_6,
    })],
  };
  const diagnostics = new Map<number, BlockScanProbeDiagnostic>();
  const result = await refineBlockScanCandidates(
    state,
    [forward(0), forward(1), forward(2), forward(3), reverse],
    5,
    Date.now() + 2_000,
    pricedTokens,
    (diagnostic) => diagnostics.set(diagnostic.index, diagnostic),
    1,
    {
      familyTimeoutMs: 500,
      maxConcurrentPerFamily: 1,
    },
  );
  assert.equal(result.attempted, 4);
  assert.equal(result.positive, 1);
  assert.deepEqual(result.openFamilyIds, []);
  assert.equal(result.openInstanceCircuitKeys.length, 1);
  assert.equal(diagnostics.get(3)?.attempted, false);
  assert.equal(diagnostics.get(3)?.failure?.reason, "instance_circuit_open");
  assert.equal(diagnostics.get(3)?.failure?.blockingCircuitScope, "instance");
  assert.equal(diagnostics.get(4)?.status, "positive");
  assert.deepEqual(
    result.opportunities.map(({ cycleId }) => cycleId),
    ["reverse-target"],
    "a directed-edge circuit must not suppress the same pool in the opposite direction",
  );
}

function badFamilyHighScoreFloodCannotConsumeExpansionCap(): void {
  const badEdges = Array.from({ length: 40 }, (_, index) =>
    familyEdge("bad-family", 100 + index, {
      score: 10_000 - index,
    })
  );
  const healthyEdge = familyEdge("healthy-family", 200, {
    score: 1,
  });
  const selected = selectFamilyFairExpansionEdges({
    edges: [...badEdges, healthyEdge],
    profitToken: TOKEN_18,
    maxPoolsPerToken: 20,
    pinnedOutsideBudget: false,
    preferDirectClosure: true,
  });
  assert.equal(selected.length, 20);
  assert(
    selected.includes(healthyEdge),
    "one high-score family flood cannot consume the pre-DFS expansion cap",
  );
  const paths = buildTokenPaths(selected, TOKEN_6, TOKEN_18, {
    maxHops: 1,
    maxPoolsPerToken: Infinity,
    maxPaths: 100,
  });
  assert(
    paths.some(({ edges }) =>
      edges.length === 1 &&
      blockScanEdgeFamilyId(edges[0]) === "healthy-family"
    ),
    "the lower-score healthy family must remain reachable by expensive DFS",
  );
}

async function neverSettlingFamilyUsesLocalBudget(): Promise<void> {
  const healthyPoolA = "0x00000000000000000000000000000000000000d1";
  const healthyPoolB = "0x00000000000000000000000000000000000000d2";
  const badPools = Array.from(
    { length: 4 },
    (_, index) =>
      `0x${(0xe0 + index).toString(16).padStart(40, "0")}`,
  );
  const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
  const badPoolSet = new Set(badPools.map((pool) => pool.toLowerCase()));
  let badCalls = 0;
  let healthyCalls = 0;
  const neverSettlingState = {
    call(req: { to: string; data: string }): Promise<string> {
      if (badPoolSet.has(req.to.toLowerCase())) {
        badCalls++;
        // Deliberately ignore AbortSignal/deadline to prove the scheduler's
        // family-local fence does not depend on transport cooperation.
        return new Promise<string>(() => {});
      }
      healthyCalls++;
      const selector = req.data.slice(0, 10);
      if (selector === pair.getFunction("token0")!.selector) {
        return Promise.resolve(pair.encodeFunctionResult("token0", [TOKEN_6]));
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return Promise.resolve(pair.encodeFunctionResult(
          "getReserves",
          req.to.toLowerCase() === healthyPoolA.toLowerCase()
            ? [1_000_000n, 2_000_000n, 0]
            : [1_000_000n, 1_000_000n, 0],
        ));
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return Promise.resolve(pair.encodeFunctionResult("factory", [factory]));
      }
      return Promise.reject(new Error(`unexpected exact quote selector ${selector}`));
    },
  } as StateBackend;
  const bad = badPools.map((pool, index): BlockScanOpportunity => ({
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: `never-${index}`,
    cycleFingerprint: `never-${index}`,
    seedEdges: [familyEdge("bad-family", 300 + index, {
      adapterId: "univ2-swap",
      target: pool,
    })],
  }));
  const healthy = {
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: "healthy-after-never",
    cycleFingerprint: "healthy-after-never",
    seedEdges: [
      familyEdge("healthy-family", 310, {
        adapterId: "univ2-swap",
        target: healthyPoolA,
        tokenIn: TOKEN_6,
        tokenOut: TOKEN_18,
      }),
      familyEdge("healthy-family", 311, {
        adapterId: "univ2-swap",
        target: healthyPoolB,
        tokenIn: TOKEN_18,
        tokenOut: TOKEN_6,
      }),
    ],
  } satisfies BlockScanOpportunity;
  const startedAtMs = Date.now();
  const result = await refineBlockScanCandidates(
    neverSettlingState,
    [...bad, healthy],
    4,
    Date.now() + 2_000,
    pricedTokens,
    undefined,
    4,
    {
      familyTimeoutMs: 25,
      maxConcurrentPerFamily: 1,
    },
  );
  const elapsedMs = Date.now() - startedAtMs;
  assert(
    elapsedMs < 500,
    `family-local timeout must return before the global deadline (elapsed ${elapsedMs}ms)`,
  );
  assert.equal(result.deadlineHit, false);
  assert.equal(
    result.attempted,
    5,
    "instance-local timeouts remain bounded without suppressing another family",
  );
  assert.equal(badCalls, 4);
  assert(healthyCalls > 0, "healthy family exact reads must still execute");
  assert.deepEqual(result.openFamilyIds, []);
  assert.deepEqual(result.openInstanceCircuitKeys, []);
  assert.deepEqual(
    result.opportunities.map((item) => item.cycleId),
    ["healthy-after-never"],
    "a non-cooperative bad family cannot suppress the healthy candidate",
  );
}

async function mixedRouteTimeoutIsAttributedToCurrentLeg(): Promise<void> {
  const diagnostics: BlockScanProbeDiagnostic[] = [];
  const neverSettlingState = {
    call(_req: { to: string; data: string }): Promise<string> {
      return new Promise<string>(() => {});
    },
  } as StateBackend;
  const mixed = {
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: "mixed-timeout",
    cycleFingerprint: "mixed-timeout",
    seedEdges: [
      familyEdge("bad-family", 320, {
        adapterId: "univ2-swap",
        tokenIn: TOKEN_6,
        tokenOut: TOKEN_18,
      }),
      familyEdge("healthy-family", 321, {
        adapterId: "univ2-swap",
        tokenIn: TOKEN_18,
        tokenOut: TOKEN_6,
      }),
    ],
  } satisfies BlockScanOpportunity;
  const result = await refineBlockScanCandidates(
    neverSettlingState,
    [mixed],
    1,
    Date.now() + 2_000,
    pricedTokens,
    (diagnostic) => diagnostics.push(diagnostic),
    1,
    {
      familyTimeoutMs: 25,
      maxConcurrentPerFamily: 1,
    },
  );
  assert.equal(result.deadlineHit, false);
  assert.deepEqual(result.openCompositeKeys, []);
  assert.equal(diagnostics[0]?.failure?.reason, "family_timeout");
  assert.equal(diagnostics[0]?.failure?.attributedFamilyId, "bad-family");
  assert.equal(diagnostics[0]?.failure?.blockingCircuitScope, "instance");
  assert.match(
    diagnostics[0]?.failure?.attributedInstanceCircuitKey ?? "",
    /^\u0000blockscan-edge:/,
  );
  assert.equal(diagnostics[0]?.failure?.stage, "exact quote");
}

async function earlyZeroDoesNotClearUnvisitedInstanceCircuit(): Promise<void> {
  const zeroPool = "0x0000000000000000000000000000000000000170";
  const failedPool = "0x0000000000000000000000000000000000000171";
  const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
  const zeroStarted = deferred<void>();
  const releaseZero = deferred<void>();
  const diagnostics = new Map<number, BlockScanProbeDiagnostic>();
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      const selector = req.data.slice(0, 10);
      if (req.to.toLowerCase() === failedPool) {
        throw new Error("injected unvisited-instance failure");
      }
      assert.equal(req.to.toLowerCase(), zeroPool);
      if (selector === pair.getFunction("token0")!.selector) {
        zeroStarted.resolve();
        await releaseZero.promise;
        return pair.encodeFunctionResult("token0", [TOKEN_6]);
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return pair.encodeFunctionResult("getReserves", [1_000_000n, 1n, 0]);
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return pair.encodeFunctionResult("factory", [factory]);
      }
      throw new Error(`unexpected early-zero selector ${selector}`);
    },
  } as StateBackend;
  const failedEdge = familyEdge("early-zero-family", 461, {
    adapterId: "univ2-swap",
    target: failedPool,
    tokenIn: TOKEN_18,
    tokenOut: TOKEN_6,
  });
  const earlyRoute: BlockScanOpportunity = {
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: "early-zero-route",
    cycleFingerprint: "early-zero-route",
    seedEdges: [
      familyEdge("early-zero-family", 460, {
        adapterId: "univ2-swap",
        target: zeroPool,
        tokenIn: TOKEN_6,
        tokenOut: TOKEN_18,
      }),
      failedEdge,
    ],
  };
  const failures = Array.from({ length: 3 }, (_, index): BlockScanOpportunity => ({
    ...opportunity(TOKEN_18, 1_024n),
    cycleId: `unvisited-failure-${index}`,
    cycleFingerprint: `unvisited-failure-${index}`,
    seedEdges: [failedEdge],
  }));
  const refinement = refineBlockScanCandidates(
    state,
    [earlyRoute, ...failures],
    4,
    Date.now() + 2_000,
    pricedTokens,
    (diagnostic) => diagnostics.set(diagnostic.index, diagnostic),
    4,
    {
      familyTimeoutMs: 1_000,
      maxConcurrentPerFamily: 4,
    },
  );
  await zeroStarted.promise;
  await waitUntil(
    () => diagnostics.get(3)?.status === "failed",
    "three sibling failures did not open the unvisited instance circuit",
  );
  releaseZero.resolve();
  const result = await refinement;
  assert.equal(diagnostics.get(0)?.status, "negative");
  assert.deepEqual(result.openFamilyIds, []);
  assert.deepEqual(
    result.openInstanceCircuitKeys,
    [blockScanEdgeInstanceCircuitKey(failedEdge)],
    "an early-zero route may clear only the leg it actually quoted",
  );
}

async function transientCircuitWaitsForInflightRecovery(): Promise<void> {
  const pool = "0x0000000000000000000000000000000000000180";
  const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
  const starts = Array.from({ length: 6 }, () => deferred<void>());
  const calls = Array.from({ length: 6 }, () => deferred<void>());
  const started = new Set<number>();
  let token0CallIndex = 0;
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      assert.equal(req.to.toLowerCase(), pool);
      const selector = req.data.slice(0, 10);
      if (selector === pair.getFunction("token0")!.selector) {
        const index = token0CallIndex++;
        assert(index < starts.length, "unexpected extra token0 probe");
        started.add(index);
        starts[index].resolve();
        await calls[index].promise;
      }
      if (selector === pair.getFunction("token0")!.selector) {
        return pair.encodeFunctionResult("token0", [TOKEN_6]);
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return pair.encodeFunctionResult("getReserves", [1_000_000n, 2_000_000n, 0]);
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return pair.encodeFunctionResult("factory", [factory]);
      }
      throw new Error(`unexpected transient-circuit selector ${selector}`);
    },
  } as StateBackend;
  const opportunities = Array.from({ length: 6 }, (_, index): BlockScanOpportunity => ({
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: `transient-${index}`,
    cycleFingerprint: `transient-${index}`,
    seedEdges: [familyEdge("transient-family", 340, {
      adapterId: "univ2-swap",
      target: pool,
      tokenIn: TOKEN_6,
      tokenOut: TOKEN_18,
    })],
  }));
  const diagnostics = new Map<number, BlockScanProbeDiagnostic>();
  const refinement = refineBlockScanCandidates(
    state,
    opportunities,
    opportunities.length,
    Date.now() + 2_000,
    pricedTokens,
    (diagnostic) => diagnostics.set(diagnostic.index, diagnostic),
    3,
    {
      familyTimeoutMs: 500,
      maxConcurrentPerFamily: 3,
    },
  );
  await Promise.all(starts.slice(0, 3).map(({ promise }) => promise));
  calls[0].reject(new Error("injected sibling failure A"));
  await starts[3].promise;
  calls[1].reject(new Error("injected sibling failure B"));
  await starts[4].promise;
  calls[2].reject(new Error("injected sibling failure C"));
  await waitUntil(
    () => diagnostics.get(2)?.status === "failed",
    "third sibling failure did not open the transient circuit",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    started.has(5),
    false,
    "the pending target must wait while its instance circuit is open",
  );
  calls[3].resolve();
  await starts[5].promise;
  calls[4].resolve();
  calls[5].resolve();
  const result = await refinement;
  assert.deepEqual(result.openFamilyIds, []);
  assert.deepEqual(result.openInstanceCircuitKeys, []);
  assert.deepEqual(result.openCompositeKeys, []);
  assert.equal(diagnostics.get(5)?.status, "positive");
  assert.equal(diagnostics.get(5)?.attempted, true);
  assert(
    result.opportunities.some((item) =>
      item.cycleId === "transient-5"
    ),
    "a pending route must run after an in-flight success closes its transient circuit",
  );
}

async function confirmedPositiveSurvivesLaterInstanceCircuit(): Promise<void> {
  const pool = "0x00000000000000000000000000000000000001a0";
  const factory = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
  let token0Calls = 0;
  const state = {
    async call(req: { to: string; data: string }): Promise<string> {
      assert.equal(req.to.toLowerCase(), pool);
      const selector = req.data.slice(0, 10);
      if (selector === pair.getFunction("token0")!.selector) {
        if (token0Calls++ > 0) {
          throw new Error("injected later instance failure");
        }
        return pair.encodeFunctionResult("token0", [TOKEN_6]);
      }
      if (selector === pair.getFunction("getReserves")!.selector) {
        return pair.encodeFunctionResult(
          "getReserves",
          [1_000_000n, 2_000_000n, 0],
        );
      }
      if (selector === pair.getFunction("factory")!.selector) {
        return pair.encodeFunctionResult("factory", [factory]);
      }
      throw new Error(`unexpected retained-positive selector ${selector}`);
    },
  } as StateBackend;
  const opportunities = Array.from({ length: 4 }, (_, index): BlockScanOpportunity => ({
    ...opportunity(TOKEN_6, 1_024n),
    cycleId: index === 0 ? "confirmed-positive" : `later-failure-${index}`,
    cycleFingerprint: `retained-${index}`,
    seedEdges: [familyEdge("shared-family", 380, {
      adapterId: "univ2-swap",
      target: pool,
      tokenIn: TOKEN_6,
      tokenOut: TOKEN_18,
    })],
  }));
  const result = await refineBlockScanCandidates(
    state,
    opportunities,
    opportunities.length,
    Date.now() + 2_000,
    pricedTokens,
    undefined,
    1,
    {
      familyTimeoutMs: 500,
      maxConcurrentPerFamily: 1,
    },
  );
  assert.deepEqual(result.openFamilyIds, []);
  assert.equal(result.openInstanceCircuitKeys.length, 1);
  assert.equal(result.positive, 1);
  assert.deepEqual(
    result.opportunities.map(({ cycleId }) => cycleId),
    ["confirmed-positive"],
    "later failures may stop future probes but cannot erase an exact-positive route",
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value?: T) => resolve(value as T),
    reject,
  };
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadlineAtMs = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadlineAtMs) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function familyEdge(
  familyId: string,
  index: number,
  overrides: Partial<TokenEdge> = {},
): TokenEdge {
  const edge: TokenEdge = {
    adapterId: familyId,
    target: `0x${(0xc0 + index).toString(16).padStart(40, "0")}`,
    tokenIn: TOKEN_6,
    tokenOut: TOKEN_18,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
    ...overrides,
  };
  return { ...edge, canonicalEdgeId: canonicalEdgeId(familyId, edge) };
}
