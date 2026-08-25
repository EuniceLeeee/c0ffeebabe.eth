import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  buildFamilyRouteGraphView,
} from "../adapter-family-graph-runtime.js";
import {
  runUniv2Lifecycle,
  UNIV2_FIXTURE_FACTORY,
  UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";
import { createStrictCentralAdapterRuntime } from
  "../strict-central-adapter-runtime.js";
import { StrictProductionRuntimeRoot } from
  "../strict-production-runtime-session.js";
import { StrictCurrentRuntimeCoordinator } from
  "../strict-current-runtime-coordinator.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from
  "../runtime-evidence.js";
import { executeFamilyExactQuote } from
  "../venues/adapter-family-runtime.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import { createVerifiedGraphView } from
  "../venues/blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../venues/production-family-composition.js";
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
} from "../venues/route-leg-adapter.js";
import { UNIV2_PAIR_INTERFACE } from
  "../venues/swaps/univ2-family/codec.js";

const STARTUP: CanonicalSource = Object.freeze({
  number: 25_800_000,
  hash: `0x${"61".repeat(32)}`,
  generation: 1,
});
const CURRENT: CanonicalSource = Object.freeze({
  number: 25_800_007,
  hash: `0x${"62".repeat(32)}`,
  generation: 2,
});
const WRONG_HASH: CanonicalSource = Object.freeze({
  ...CURRENT,
  hash: `0x${"63".repeat(32)}`,
});
const EXECUTOR = `0x${"64".repeat(20)}`;
const ERC20_BALANCE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

const pool = Object.freeze({
  pool: UNIV2_FIXTURE_POOL,
  factory: UNIV2_FIXTURE_FACTORY,
  token0: UNIV2_FIXTURE_TOKEN0,
  token1: UNIV2_FIXTURE_TOKEN1,
  reserves: Object.freeze({
    reserve0: 1_000_000_000n,
    reserve1: 2_000_000_000n,
    blockTimestampLast: 1,
  }),
});

const publication = await runUniv2Lifecycle(STARTUP, pool);
const family = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
  publication.familyId,
);
const startupView = buildFamilyRouteGraphView({
  routes: publication.instances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family,
      descriptor: instance.descriptor,
      route,
      handle: instance.routeHandles[index],
    }))
  ),
});
const readyFundingAssets = Object.freeze(
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll()
    .filter((candidate) => candidate.plugin.manifest.domain === "funding")
    .map((candidate) => Object.freeze({
      familyId: candidate.plugin.manifest.familyId,
      asset: UNIV2_FIXTURE_TOKEN0,
    })),
);
const root = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: startupView.edges,
  readyInstances: publication.instances,
  readyFundingAssets,
});

function runtime(
  source: CanonicalSource,
  options: {
    readonly reserves?: Readonly<{
      readonly reserve0: bigint;
      readonly reserve1: bigint;
      readonly blockTimestampLast: number;
    }>;
    readonly onCurrentPricingRead?: () => void;
    readonly onCurrentPricingReadStart?: (target: string) => void;
    readonly onCurrentPricingReadEnd?: (target: string) => void;
    readonly onFundingRead?: () => void;
    readonly currentPricingDelayMs?: number;
    readonly failCurrentPricing?: boolean;
    readonly failFunding?: boolean;
  } = {},
) {
  const reserves = options.reserves ?? pool.reserves;
  return createStrictCentralAdapterRuntime({
    provider: {
      call: async (request) => {
        if (
          request.data.slice(0, 10).toLowerCase() ===
            UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector.toLowerCase()
        ) {
          const target = request.to.toLowerCase();
          options.onCurrentPricingReadStart?.(target);
          try {
            if ((options.currentPricingDelayMs ?? 0) > 0) {
              await new Promise((resolve) => setTimeout(
                resolve,
                options.currentPricingDelayMs,
              ));
            }
            options.onCurrentPricingRead?.();
            if (options.failCurrentPricing === true) {
              throw new Error("current pricing transport failed");
            }
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult(
              "getReserves",
              [
                reserves.reserve0,
                reserves.reserve1,
                reserves.blockTimestampLast,
              ],
            );
          } finally {
            options.onCurrentPricingReadEnd?.(target);
          }
        }
        if (options.failFunding === true) {
          throw new Error("current Funding transport failed");
        }
        options.onFundingRead?.();
        return ERC20_BALANCE.encodeFunctionResult("balanceOf", [10n ** 24n]);
      },
      getCode: async () => "0x01",
      getStorage: async () => `0x${"00".repeat(32)}`,
    },
    executor: EXECUTOR,
    generationFence: Object.freeze({
      assertCurrent(generation: number, candidate: CanonicalSource) {
        if (
          generation !== source.generation ||
          candidate.number !== source.number ||
          candidate.hash.toLowerCase() !== source.hash.toLowerCase() ||
          candidate.generation !== source.generation
        ) {
          throw new Error("test generation fence rejected stale source");
        }
      },
    }),
  });
}

let currentPricingReads = 0;
const strictRuntime = runtime(CURRENT, {
  reserves: Object.freeze({
    reserve0: pool.reserves.reserve0 * 3n,
    reserve1: pool.reserves.reserve1,
    blockTimestampLast: pool.reserves.blockTimestampLast + 1,
  }),
  onCurrentPricingRead() {
    currentPricingReads++;
  },
});
await assert.rejects(
  root.createSession({
    source: WRONG_HASH,
    runtime: strictRuntime,
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  }),
  /generation fence rejected stale source/,
);

const session = await root.createSession({
  source: CURRENT,
  runtime: strictRuntime,
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});

let familyScopedFundingReads = 0;
const oneFundingFamilyRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: startupView.edges,
  readyInstances: publication.instances,
  readyFundingAssets: Object.freeze([readyFundingAssets[0]!]),
});
await oneFundingFamilyRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    onFundingRead() {
      familyScopedFundingReads++;
    },
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.equal(
  familyScopedFundingReads,
  1,
  "a Funding Family may query only assets admitted for that Family",
);

// Performance contract: independent ready instances refresh under the
// bounded pool, each exactly once, while the resulting strict topology keeps
// deterministic ready order. This checks concurrency directly rather than
// relying on a machine-dependent wall-clock threshold.
const parallelPublications = await Promise.all(Array.from(
  { length: 20 },
  (_, index) => runUniv2Lifecycle(STARTUP, Object.freeze({
    ...pool,
    pool: `0x${(0x1000 + index).toString(16).padStart(40, "0")}`,
  })),
));
const parallelReadyInstances = Object.freeze(parallelPublications.flatMap(
  (candidate) => candidate.instances,
));
const parallelStartupView = buildFamilyRouteGraphView({
  routes: parallelReadyInstances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family,
      descriptor: instance.descriptor,
      route,
      handle: instance.routeHandles[index],
    }))
  ),
});
const parallelRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: parallelStartupView.edges,
  readyInstances: parallelReadyInstances,
  readyFundingAssets,
});
let activePricingReads = 0;
let maxActivePricingReads = 0;
let totalParallelPricingReads = 0;
const parallelSession = await parallelRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    currentPricingDelayMs: 5,
    onCurrentPricingReadStart() {
      activePricingReads++;
      maxActivePricingReads = Math.max(
        maxActivePricingReads,
        activePricingReads,
      );
    },
    onCurrentPricingReadEnd() {
      activePricingReads--;
    },
    onCurrentPricingRead() {
      totalParallelPricingReads++;
    },
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.equal(
  totalParallelPricingReads,
  parallelReadyInstances.length,
  "each ready instance must perform exactly one current pricing read",
);
assert.ok(
  maxActivePricingReads > 1,
  "ready instance refresh must make real concurrent progress",
);
assert.ok(
  maxActivePricingReads <= 128,
  "ready instance refresh must respect the bounded concurrency cap",
);
assert.deepEqual(
  parallelSession.edges.map((candidate) => candidate.canonicalEdgeId),
  parallelStartupView.edges.map((candidate) => candidate.canonicalEdgeId),
  "concurrent refresh must preserve deterministic ready edge order",
);
let exactPricingReads = 0;
const exactSession = await parallelRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    onCurrentPricingRead() {
      exactPricingReads++;
    },
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  kind: "exact",
});
assert.equal(
  exactPricingReads,
  0,
  "exact session must not refresh the full ready pricing set",
);
assert.equal(
  exactSession.currentPricingForEdge(exactSession.edges[0]!),
  null,
  "exact session must not pretend to own coarse current mids",
);
assert.equal(session.edges.length, startupView.edges.length);
assert.deepEqual(
  session.edges.map((edge) => edge.canonicalEdgeId).sort(),
  startupView.edges.map((edge) => edge.canonicalEdgeId).sort(),
);
assert(session.edges.every((edge) =>
  session.familyIdForEdge(edge) === publication.familyId
));
assert.deepEqual(
  session.fundingActionIds(UNIV2_FIXTURE_TOKEN0),
  ["morpho-flash", "balancer-flash"],
);
const fundingRoot = session.buildFundingRoot({
  actionAdapterId: "morpho-flash",
  asset: UNIV2_FIXTURE_TOKEN0,
  amount: 1_000_000n,
  minProfit: 1n,
  children: Object.freeze([]),
});
assert.equal(fundingRoot.adapterId, "morpho-flash");
assert.equal(fundingRoot.tokenIn.toLowerCase(), UNIV2_FIXTURE_TOKEN0.toLowerCase());
assert.throws(
  () => session.buildFundingRoot({
    actionAdapterId: "missing-funding-action",
    asset: UNIV2_FIXTURE_TOKEN0,
    amount: 1_000_000n,
    minProfit: 1n,
    children: Object.freeze([]),
  }),
  /no Funding offer/,
);
assert.throws(
  () => session.buildFundingRoot({
    actionAdapterId: "morpho-flash",
    asset: UNIV2_FIXTURE_TOKEN1,
    amount: 1_000_000n,
    minProfit: 1n,
    children: Object.freeze([]),
  }),
  /no Funding offer/,
);
assert.throws(
  () => session.buildFundingRoot({
    actionAdapterId: "morpho-flash",
    asset: UNIV2_FIXTURE_TOKEN0,
    amount: 10n ** 24n + 1n,
    minProfit: 1n,
    children: Object.freeze([]),
  }),
  /no Funding offer/,
);

const pendingPayload = ethers.toBeHex(0x1234, 32);
const pendingPayloadHash = ethers.keccak256(pendingPayload);
const pendingTxHash = `0x${"65".repeat(32)}`;
const pendingFamilyId = publication.familyId as ExecutionFamilyId;
const pendingEvidenceHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "bytes32", "uint256", "bytes32", "bytes32"],
    [
      pendingFamilyId,
      pendingTxHash,
      CURRENT.number,
      CURRENT.hash,
      pendingPayloadHash,
    ],
  ),
);
const pendingEvidence: PendingExecutionEvidence = Object.freeze({
  familyId: pendingFamilyId,
  txHash: pendingTxHash,
  headBlockNumber: CURRENT.number,
  headHash: CURRENT.hash,
  canonicalPayload: pendingPayload,
  payloadHash: pendingPayloadHash,
  evidenceHash: pendingEvidenceHash,
});
const boundPending = session.runtimeEvidenceFromPendingExecution([
  pendingEvidence,
]);
assert.equal(boundPending.length, 1);
assert.deepEqual(boundPending[0], {
  evidenceId: `pending:${pendingTxHash}`,
  familyId: publication.familyId,
  kind: PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND,
  scope: "transaction",
  source: CURRENT,
  txHash: pendingTxHash,
  evidenceHash: pendingEvidenceHash,
  sealedPayloadRef: pendingPayload,
});
assert.throws(
  () => session.runtimeEvidenceFromPendingExecution([Object.freeze({
    ...pendingEvidence,
    headHash: WRONG_HASH.hash,
  })]),
  /differs from strict source/,
);
assert.throws(
  () => session.runtimeEvidenceFromPendingExecution([Object.freeze({
    ...pendingEvidence,
    evidenceHash: `0x${"00".repeat(32)}`,
  })]),
  /hash mismatch/,
);

const edge = session.edges.find((candidate) =>
  candidate.tokenIn.toLowerCase() === UNIV2_FIXTURE_TOKEN0.toLowerCase()
)!;
assert.equal(currentPricingReads, 1, "one current pricing shard read per session");
const currentPricing = session.currentPricingForEdge(edge);
assert.equal(currentPricing?.status, "priced");
const startupRouteKey = startupView.handleByCanonicalEdgeId.get(
  edge.canonicalEdgeId!,
)!.routeKey;
const startupMid = publication.instances[0].pricingInstances
  .find((pricing) => pricing.mids.has(startupRouteKey))!
  .mids.get(startupRouteKey)!;
if (currentPricing?.status === "priced") {
  assert.notEqual(
    currentPricing.mid.mid,
    startupMid.mid,
    "current session must not reuse the startup pricing snapshot",
  );
  assert.equal(
    currentPricing.mid.edges[0],
    edge,
    "current pricing must bind the exact strict-session edge object",
  );
}

const currentGraph = createVerifiedGraphView({
  id: "strict-current-runtime-test",
  generation: CURRENT.generation,
  sourceBlock: CURRENT.number,
  sourceBlockHash: CURRENT.hash,
  completenessWatermark: CURRENT.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-ready-test",
    sourceFingerprint: "strict-ready-test-v1",
    completeThroughBlock: CURRENT.number,
    completeThroughHash: CURRENT.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: startupView.edges,
});
let resetCount = 0;
const currentCoordinator = new StrictCurrentRuntimeCoordinator(
  async (source, control) => await root.createSession({
    source,
    runtime: strictRuntime,
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    ...(control === undefined ? {} : { control }),
  }),
  () => {
    resetCount++;
  },
);
const currentRuntime = await currentCoordinator.prepare({
  graph: currentGraph,
  fundingTokens: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(currentRuntime.status, "complete");
assert.equal(currentRuntime.snapshot.graph, currentGraph);
assert.equal(
  currentRuntime.snapshot.pricing.coverage.expectedEdgeKeys.length,
  currentGraph.scannerEdgeCount,
);
for (const graphEdge of currentGraph.edges) {
  const mid = currentRuntime.snapshot.pricing.mids.get(
    graphEdge.canonicalEdgeId!,
  );
  assert(mid);
  assert.equal(mid.edges[0], graphEdge);
}
assert.equal(
  currentCoordinator.latestPricingSnapshot()?.sourceBlock,
  CURRENT.number,
);
await currentCoordinator.resetDynamicStateForReplay();
assert.equal(currentCoordinator.latestPricingSnapshot(), null);
assert.equal(resetCount, 1);

const failingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (source, control) => await root.createSession({
    source,
    runtime: runtime(CURRENT, { failCurrentPricing: true }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    ...(control === undefined ? {} : { control }),
  }),
  () => {},
);
await assert.rejects(
  failingCoordinator.prepareCoarsePricing({
    graph: currentGraph,
    deadlineAtMs: Date.now() + 10_000,
  }),
  /strict current pricing incomplete/,
);
assert.equal(
  failingCoordinator.latestPricingSnapshot(),
  null,
  "failed strict pricing cannot publish a partial snapshot",
);
let failAfterPublication = false;
const retainingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (source, control) => await root.createSession({
    source,
    runtime: runtime(CURRENT, {
      failCurrentPricing: failAfterPublication,
    }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    ...(control === undefined ? {} : { control }),
  }),
  () => {},
);
await retainingCoordinator.prepareCoarsePricing({
  graph: currentGraph,
  deadlineAtMs: Date.now() + 10_000,
});
const retainedPricing = retainingCoordinator.latestPricingSnapshot();
assert(retainedPricing);
failAfterPublication = true;
await assert.rejects(
  retainingCoordinator.prepareCoarsePricing({
    graph: currentGraph,
    deadlineAtMs: Date.now() + 10_000,
  }),
  /strict current pricing incomplete/,
);
assert.strictEqual(
  retainingCoordinator.latestPricingSnapshot(),
  retainedPricing,
  "failed strict refresh cannot replace the last atomic pricing snapshot",
);
const failingFundingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (source, control) => await root.createSession({
    source,
    runtime: runtime(CURRENT, { failFunding: true }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    ...(control === undefined ? {} : { control }),
  }),
  () => {},
);
await assert.rejects(
  failingFundingCoordinator.prepare({
    graph: currentGraph,
    fundingTokens: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    deadlineAtMs: Date.now() + 10_000,
  }),
  /strict current Funding incomplete/,
);
assert.equal(
  failingFundingCoordinator.latestPricingSnapshot(),
  null,
  "Funding failure cannot publish pricing with invented zero liquidity",
);
assert(session.supportsVictimReplay(edge));
const victim = session.replayVictim({
  edge,
  impact: Object.freeze({
    pool: UNIV2_FIXTURE_POOL,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    amountIn: 1_000_000n,
    exactPostState: Object.freeze({
      reserve0: pool.reserves.reserve0 + 1_000_000n,
      reserve1: pool.reserves.reserve1 - 1_000n,
      feeBps: 30n,
      blockTimestampLast: pool.reserves.blockTimestampLast,
    }),
  }),
  preState: null,
  validUntil: 1_800_000_000n,
});
assert.equal(victim.status, "resolved");
if (victim.status === "resolved") {
  assert(victim.overlay !== null);
  assert.equal(victim.overlay.preCalls.length, 2);
  assert.equal(
    (victim.exactPostState as { readonly kind?: unknown } | null)?.kind,
    "v2",
  );
}
const exact = await session.issueExact({
  edge,
  amountIn: 1_000_000n,
  executor: EXECUTOR,
  runtimeEvidence: Object.freeze([]),
});
assert(exact.amountOut > 0n);
assert.deepEqual(exact.source, CURRENT);
const execution = session.buildExecution({
  edge,
  exact,
  minAmountOut: exact.amountOut - 1n,
  executor: EXECUTOR,
});
assert.equal(execution.status, "resolved");

assert.throws(
  () => session.buildExecution({
    edge,
    exact: Object.freeze({ ...exact }) as typeof exact,
    minAmountOut: exact.amountOut - 1n,
    executor: EXECUTOR,
  }),
  /same session-issued route\/exact authority/,
);

const foreignSession = await root.createSession({
  source: CURRENT,
  runtime: strictRuntime,
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.throws(
  () => foreignSession.buildExecution({
    edge: foreignSession.edges.find((candidate) =>
      candidate.canonicalEdgeId === edge.canonicalEdgeId
    )!,
    exact,
    minAmountOut: exact.amountOut - 1n,
    executor: EXECUTOR,
  }),
  /same session-issued route\/exact authority/,
);

const startupHandle = publication.instances[0].routeHandles.find((handle) =>
  handle.routeKey === startupView.handleByCanonicalEdgeId.get(
    edge.canonicalEdgeId!,
  )?.routeKey
)!;
const stale = await executeFamilyExactQuote({
  family,
  route: startupHandle,
  amountIn: 1_000_000n,
  executor: EXECUTOR,
  runtimeEvidence: Object.freeze([]),
  source: CURRENT,
  generation: CURRENT.generation,
  runtime: strictRuntime,
});
assert.notEqual(stale.status, "resolved");

const unavailableSession = await root.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, {
    reserves: Object.freeze({
      reserve0: 0n,
      reserve1: pool.reserves.reserve1,
      blockTimestampLast: pool.reserves.blockTimestampLast,
    }),
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
assert.equal(
  unavailableSession.currentPricingForEdge(
    unavailableSession.edges.find((candidate) =>
      candidate.canonicalEdgeId === edge.canonicalEdgeId
    )!,
  )?.status,
  "behavior-proven-unavailable",
);

await assert.rejects(
  root.createSession({
    source: CURRENT,
    runtime: runtime(CURRENT, { failCurrentPricing: true }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  }),
  /strict current pricing incomplete/,
);

await assert.rejects(
  new StrictProductionRuntimeRoot({
    catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
    readySource: STARTUP,
    readyGraph: startupView.edges.slice(1),
    readyInstances: publication.instances,
    readyFundingAssets,
  }).createSession({
    source: CURRENT,
    runtime: strictRuntime,
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  }),
  /topology differs/,
);

console.log("strict production runtime session contract: PASS");
