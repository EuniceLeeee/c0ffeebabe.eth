import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { ethers } from "ethers";
import {
  buildFamilyRouteGraphView,
} from "../adapter-family-graph-runtime.js";
import {
  fluidDexFixtureRuntime,
  runUniv2Lifecycle,
  runFluidDexLifecycle,
  UNIV2_FIXTURE_FACTORY,
  UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";
import { createStrictCentralAdapterRuntime } from
  "../strict-central-adapter-runtime.js";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";
import { StrictProductionRuntimeRoot } from
  "../strict-production-runtime-session.js";
import { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import {
  StrictCurrentRuntimeCoordinator,
  type StrictPricingPublication,
  type StrictSessionRequest,
} from
  "../strict-current-runtime-coordinator.js";
import { assertAtomicBlockScanRuntime } from
  "../detector/blockscan-scanner-production.js";
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
import { scanBlockStateFromResolvedMids } from
  "../detector/blockscan-scanner-core.js";

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
    readonly reservesByTarget?: ReadonlyMap<string, Readonly<{
      readonly reserve0: bigint;
      readonly reserve1: bigint;
      readonly blockTimestampLast: number;
    }>>;
    readonly onCurrentPricingRead?: () => void;
    readonly onCurrentPricingReadStart?: (target: string) => void;
    readonly onCurrentPricingReadEnd?: (target: string) => void;
    readonly onFundingRead?: (data: string) => void | Promise<void>;
    readonly isCurrent?: () => boolean;
    readonly currentPricingDelayMs?: number | ((target: string) => number);
    readonly failCurrentPricing?: boolean;
    readonly failCurrentPricingTarget?: string;
    readonly failFunding?: boolean;
    readonly fundingBalance?: bigint;
    readonly producerCallBackend?: PinnedRethQuoteBackend;
    readonly producerCallCache?: Pick<PinnedRethQuoteBackend, "callCached">;
    readonly exactCallBackend?: PinnedRethQuoteBackend;
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
            const pricingDelayMs = typeof options.currentPricingDelayMs ===
                "function"
              ? options.currentPricingDelayMs(target)
              : options.currentPricingDelayMs ?? 0;
            if (pricingDelayMs > 0) {
              await new Promise((resolve) => setTimeout(
                resolve,
                pricingDelayMs,
              ));
            }
            options.onCurrentPricingRead?.();
            if (
              options.failCurrentPricing === true ||
              options.failCurrentPricingTarget === target
            ) {
              throw new Error("current pricing transport failed");
            }
            const targetReserves = options.reservesByTarget?.get(target) ?? reserves;
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult(
              "getReserves",
              [
                targetReserves.reserve0,
                targetReserves.reserve1,
                targetReserves.blockTimestampLast,
              ],
            );
          } finally {
            options.onCurrentPricingReadEnd?.(target);
          }
        }
        if (options.failFunding === true) {
          throw new Error("current Funding transport failed");
        }
        await options.onFundingRead?.(request.data);
        return ERC20_BALANCE.encodeFunctionResult(
          "balanceOf",
          [options.fundingBalance ?? 10n ** 24n],
        );
      },
      getCode: async () => "0x01",
      getStorage: async () => `0x${"00".repeat(32)}`,
    },
    executor: EXECUTOR,
    ...(options.producerCallBackend === undefined ? {} : { producerCallBackend: options.producerCallBackend }),
    ...(options.producerCallCache === undefined ? {} : { producerCallCache: options.producerCallCache }),
    ...(options.exactCallBackend === undefined ? {} : { exactCallBackend: options.exactCallBackend }),
    generationFence: Object.freeze({
      assertCurrent(generation: number, candidate: CanonicalSource) {
        if (
          options.isCurrent?.() === false ||
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
let currentGenerationActive = true;
const strictRuntime = runtime(CURRENT, {
  isCurrent: () => currentGenerationActive,
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

// A single physical Fluid DEX instance owns one pricing state per direction.
// The strict session must preserve those route-local state identities instead
// of rejecting the instance as internally contradictory.
const fluidPublication = await runFluidDexLifecycle(STARTUP);
const fluidFamily = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forFamily(
  fluidPublication.familyId,
);
const fluidView = buildFamilyRouteGraphView({
  routes: fluidPublication.instances.flatMap((instance) =>
    instance.routes.map((route, index) => ({
      family: fluidFamily,
      descriptor: instance.descriptor,
      route,
      handle: instance.routeHandles[index],
    }))
  ),
});
const fluidRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: fluidView.edges,
  readyInstances: fluidPublication.instances,
  readyFundingAssets: Object.freeze([]),
});
const fluidSession = await fluidRoot.createSession({
  source: CURRENT,
  runtime: fluidDexFixtureRuntime(),
  fundingAssets: Object.freeze([]),
});
const fluidStateKeys = new Set(
  fluidSession.edges.map((edge) => fluidSession.stateKeyForEdge(edge)),
);
assert.equal(fluidStateKeys.size, 2, "Fluid directions keep distinct state keys");
assert.ok(
  fluidSession.edges.every((edge) =>
    fluidSession.currentPricingForEdge(edge)?.status === "priced"
  ),
  "Fluid directions remain currently priced",
);

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

const zeroLiquiditySession = await root.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT, { fundingBalance: 0n }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
});
const zeroLiquidityProjection = zeroLiquiditySession.fundingProjection();
assert.ok(zeroLiquidityProjection.outcomes.length > 0);
assert.ok(zeroLiquidityProjection.outcomes.every((outcome) =>
  outcome.status === "verified" &&
  outcome.reasonCode === "funding-offer-derived"
));
assert.equal(
  zeroLiquidityProjection.sources.size,
  0,
  "verified zero-liquidity sources are resolved coverage, not planner offers",
);

const twoTokenReadyFundingAssets = Object.freeze(
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll()
    .filter((candidate) => candidate.plugin.manifest.domain === "funding")
    .flatMap((candidate) => [UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1]
      .map((asset) => Object.freeze({
        familyId: candidate.plugin.manifest.familyId,
        asset,
      }))),
);
const twoTokenFundingRoot = new StrictProductionRuntimeRoot({
  catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
  readySource: STARTUP,
  readyGraph: startupView.edges,
  readyInstances: publication.instances,
  readyFundingAssets: twoTokenReadyFundingAssets,
});
const twoTokenFundingProjection = (await twoTokenFundingRoot.createSession({
  source: CURRENT,
  runtime: runtime(CURRENT),
  fundingAssets: Object.freeze([
    UNIV2_FIXTURE_TOKEN0,
    UNIV2_FIXTURE_TOKEN1,
  ]),
})).fundingProjection();
assert.equal(
  twoTokenFundingProjection.outcomes.length,
  twoTokenReadyFundingAssets.length,
  "Funding outcomes partition every dynamically cataloged provider/token source",
);
assert.equal(twoTokenFundingProjection.sources.size, 2);

// Real central issuance/decoding and strict Funding authority; only the HTTP
// endpoint is synthetic. The exact session may reuse bytes, not Funding offers.
{
  type WireCall = {
    id: number;
    method: string;
    params: [{ to: string; data: string; from?: string }, { blockHash: string; requireCanonical: boolean }];
  };
  const wire: Array<{ lane: string; call: WireCall }> = [];
  const stubErrors: unknown[] = [];
  const balanceSelector = ERC20_BALANCE.getFunction("balanceOf")!.selector;
  const reservesSelector = UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireCall | WireCall[];
        const reply = (call: WireCall) => {
          wire.push({ lane: req.url!, call });
          assert.equal(call.method, "eth_call");
          assert.deepEqual(call.params[1], { blockHash: CURRENT.hash, requireCanonical: true });
          const selector = call.params[0].data.slice(0, 10);
          assert.ok(selector === balanceSelector || selector === reservesSelector, "unexpected local fixture call");
          if (req.url === "/failed") return {
            jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted", data: "0xdeadbeef" },
          };
          const result = selector === balanceSelector
            ? ERC20_BALANCE.encodeFunctionResult("balanceOf", [10n ** 24n])
            : UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [
              pool.reserves.reserve0, pool.reserves.reserve1, pool.reserves.blockTimestampLast,
            ]);
          return { jsonrpc: "2.0", id: call.id, result };
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)));
      } catch (error) {
        stubErrors.push(error);
        res.end(JSON.stringify({ error: "unexpected fixture request" }));
      }
    });
  });
  const backends: PinnedRethQuoteBackend[] = [];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const backend = (lane: string, transportLane: "producer-bulk" | "exact") => {
      const client = new PinnedRethQuoteBackend(`http://127.0.0.1:${address.port}/${lane}`, CURRENT.hash, {
        transportLane, deadlineAtMs: Date.now() + 5000, allowSingleCallFallback: false,
      });
      backends.push(client);
      return client;
    };
    const producer = backend("producer", "producer-bulk");
    const exactBackend = backend("exact", "exact");
    const failedCache = backend("failed", "producer-bulk");
    let directReads = 0;
    const unexpectedDirectRead = () => { directReads++; };
    const pricing = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "pricing", fundingAssets: [UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1],
      runtime: runtime(CURRENT, {
        producerCallBackend: producer,
        onFundingRead: unexpectedDirectRead, onCurrentPricingRead: unexpectedDirectRead,
      }),
    });
    await producer.drain();
    const pricingWireCount = wire.length;
    const fundingCalls = wire.filter(({ call }) => call.params[0].data.startsWith(balanceSelector));
    assert.equal(fundingCalls.length, 4, "pricing reads two providers for each of two assets");
    assert.equal(pricingWireCount, 5, "pricing also reads the pool reserves once");
    assert.equal(producer.stats().batchesSent, 2, "one pricing batch plus one shared Funding batch, not one per Family");
    assert.equal(producer.stats().maxBatchItemsSent, 4);
    assert.equal(pricing.fundingProjection().sources.size, 2);
    const refined = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "exact", fundingAssets: [UNIV2_FIXTURE_TOKEN0],
      control: { deadlineAtMs: Date.now() + 2000 },
      runtime: runtime(CURRENT, {
        producerCallCache: producer, exactCallBackend: exactBackend,
        onFundingRead: unexpectedDirectRead, onCurrentPricingRead: unexpectedDirectRead,
      }),
    });
    await producer.drain();
    assert.equal(wire.length, pricingWireCount, "second-phase Funding must issue zero physical RPC items");
    assert.equal(directReads, 0, "warm Funding unexpectedly fell back to the raw provider");
    assert.equal(producer.stats().memoHits, 2);
    assert.equal(producer.stats().lane, "producer-bulk");
    assert.equal(exactBackend.stats().totalCalls, 0, "Funding must not enter the exact backend");
    let baselineFundingReads = 0;
    const baseline = await twoTokenFundingRoot.createSession({
      source: CURRENT, kind: "exact", fundingAssets: [UNIV2_FIXTURE_TOKEN0],
      runtime: runtime(CURRENT, { onFundingRead() { baselineFundingReads++; } }),
    });
    assert.equal(baselineFundingReads, 2);
    const comparableFunding = (current: StrictProductionRuntimeSession) => {
      const projection = current.fundingProjection();
      return { ...projection, outcomes: projection.outcomes.map((outcome) => {
        if (!outcome.workReceipt) return outcome;
        // Only clock-dependent receipt timing differs; retain attempts and all
        // schedule/source/evidence/failure/offer fields in the comparison.
        const { timing, ...receipt } = outcome.workReceipt;
        return { ...outcome, workReceipt: { ...receipt, timing: { attempts: timing.attempts } } };
      }) };
    };
    const projection = refined.fundingProjection();
    assert.deepEqual(comparableFunding(refined), comparableFunding(baseline));
    for (const outcome of projection.outcomes) {
      assert.deepEqual(outcome.source, CURRENT);
      assert.equal(outcome.status, "verified");
      assert.notStrictEqual(outcome, pricing.fundingProjection().outcomes.find((old) => old.fundingId === outcome.fundingId));
    }
    const actions = refined.fundingActionIds(UNIV2_FIXTURE_TOKEN0, 1_000_000n);
    assert.deepEqual(actions, ["morpho-flash", "balancer-flash"]);
    assert.deepEqual(actions, baseline.fundingActionIds(UNIV2_FIXTURE_TOKEN0, 1_000_000n));
    for (const actionAdapterId of actions) {
      const input = { actionAdapterId, asset: UNIV2_FIXTURE_TOKEN0, amount: 1_000_000n, minProfit: 1n, children: [] };
      assert.deepEqual(refined.buildFundingRoot(input), baseline.buildFundingRoot(input));
    }
    const edge = refined.edges[0]!;
    const quote = await refined.issueExact({ edge, amountIn: 1_000_000n, executor: EXECUTOR, runtimeEvidence: [] });
    assert.ok(quote.amountOut > 0n);
    assert.deepEqual(quote.source, CURRENT);
    assert.equal(refined.buildExecution({ edge, exact: quote, minAmountOut: quote.amountOut - 1n, executor: EXECUTOR }).status, "resolved");
    await exactBackend.drain();
    assert.equal(wire.length, pricingWireCount + 1);
    assert.equal(wire.at(-1)!.lane, "/exact", "exact quote must use its own cold backend despite warm producer reserves");
    assert.equal(wire.at(-1)!.call.params[0].data, reservesSelector);
    assert.equal(directReads, 0);

    // A missing or failed cache entry must retain the old direct-provider path,
    // never enqueue/join producer transport. Fresh offers still decode normally.
    for (const priorFailure of [false, true]) {
      if (priorFailure) {
        const request = fundingCalls.find(({ call }) => call.params[0].to.toLowerCase() === UNIV2_FIXTURE_TOKEN0.toLowerCase())!.call.params[0];
        await assert.rejects(failedCache.call(request), /revert/i);
        await failedCache.drain();
      }
      const before: number = wire.length;
      let fallbackReads = 0;
      const fallback = await twoTokenFundingRoot.createSession({
        source: CURRENT, kind: "exact", fundingAssets: [UNIV2_FIXTURE_TOKEN0],
        runtime: runtime(CURRENT, { producerCallCache: failedCache, onFundingRead() { fallbackReads++; } }),
      });
      await failedCache.drain();
      assert.equal(fallbackReads, 2, "cache miss/failure must use the original direct provider");
      assert.equal(wire.length, before, "cache lookup changed the miss path to producer batching");
      assert.deepEqual(comparableFunding(fallback), comparableFunding(refined));
      assert.deepEqual(fallback.fundingActionIds(UNIV2_FIXTURE_TOKEN0), actions);
    }
    assert.deepEqual(stubErrors, []);
    console.log("strict Funding phase reuse: PASS (pricing 4 Funding + 1 reserve; exact Funding 0; exact quote 1 separate; miss/revert fallback 2 direct each)");
  } finally {
    const closed = await Promise.allSettled(backends.map((client) => client.closeAndDrain()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.ok(closed.every((result) => result.status === "fulfilled"));
    for (const client of backends) {
      const stats = client.stats();
      assert.deepEqual([stats.pendingItems, stats.liveItems, stats.inFlightBatches, stats.activeTransports], [0, 0, 0, 0]);
    }
  }
}

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
assert.equal(
  parallelSession.creationTiming.readyInstanceCount,
  parallelReadyInstances.length,
);
assert.equal(
  parallelSession.creationTiming.selectedInstanceCount,
  parallelReadyInstances.length,
);
assert.equal(
  parallelSession.creationTiming.refreshedInstanceCount,
  parallelReadyInstances.length,
);
assert.equal(parallelSession.creationTiming.failedInstanceCount, 0);
assert.equal(parallelSession.creationTiming.requestedFundingAssetCount, 1);
assert.ok(parallelSession.creationTiming.pricingMs >= 0);
assert.ok(parallelSession.creationTiming.fundingMs >= 0);
assert.ok(parallelSession.creationTiming.routeProjectionMs >= 0);
assert.ok(parallelSession.creationTiming.totalMs >= 0);
assert.ok(parallelSession.creationTiming.heapUsedBytes > 0);
assert.deepEqual(
  parallelSession.edges.map((candidate) => candidate.canonicalEdgeId),
  parallelStartupView.edges.map((candidate) => candidate.canonicalEdgeId),
  "concurrent refresh must preserve deterministic ready edge order",
);

let activeFailedRefreshReads = 0;
const firstParallelTarget = parallelReadyInstances[0]!.instanceKey.toLowerCase();
const secondParallelTarget = parallelReadyInstances[1]!.instanceKey.toLowerCase();
const carryNextSource: CanonicalSource = Object.freeze({
  number: CURRENT.number + 1,
  hash: `0x${"63".repeat(32)}`,
  generation: CURRENT.generation + 1,
});
const carryBaseGraph = createVerifiedGraphView({
  id: "strict-carry-base",
  generation: CURRENT.generation,
  sourceBlock: CURRENT.number,
  sourceBlockHash: CURRENT.hash,
  completenessWatermark: CURRENT.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-carry-test",
    sourceFingerprint: "strict-carry-test-v1",
    completeThroughBlock: CURRENT.number,
    completeThroughHash: CURRENT.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: parallelStartupView.edges,
});
const carryNextGraph = createVerifiedGraphView({
  id: "strict-carry-next",
  generation: carryNextSource.generation,
  sourceBlock: carryNextSource.number,
  sourceBlockHash: carryNextSource.hash,
  completenessWatermark: carryNextSource.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-carry-test",
    sourceFingerprint: "strict-carry-test-v1",
    completeThroughBlock: carryNextSource.number,
    completeThroughHash: carryNextSource.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: parallelStartupView.edges,
});
const producerPricingBackend = Object.freeze({
  call: async () => {
    throw new Error("producer pricing backend should be transport-only in this test");
  },
});
let sparseCarrySession: StrictProductionRuntimeSession | null = null;
const pricingHistoryPublications: StrictPricingPublication[] = [];
const carryBaseCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => {
    assert.equal(request.purpose, "coarse-pricing");
    assert.deepEqual(request.fundingAssets, [], "coarse pricing excludes Funding");
    assert.equal(
      request.pricingCallBackend,
      producerPricingBackend,
      "coarse coordinator forwards its generation-scoped pricing backend",
    );
    const created = parallelRoot.createSession({
      source: request.source,
      runtime: runtime(request.source, {
        reservesByTarget: new Map<string, Readonly<{
          reserve0: bigint;
          reserve1: bigint;
          blockTimestampLast: number;
        }>>([
          [firstParallelTarget, Object.freeze({ reserve0: 1_000_000_000n, reserve1: 3_000_000_000n, blockTimestampLast: 1 })],
          [secondParallelTarget, Object.freeze({ reserve0: 3_000_000_000n, reserve1: 1_000_000_000n, blockTimestampLast: 1 })],
        ]),
      }),
      fundingAssets: request.fundingAssets,
      kind: "pricing",
      ...(request.control === undefined ? {} : { control: request.control }),
      ...(request.exactCallBackend === undefined
        ? {}
        : { exactCallBackend: request.exactCallBackend }),
      ...(request.touchedPools === undefined
        ? {}
        : { touchedPools: request.touchedPools }),
      ...(request.pricingCallBackend === undefined
        ? {}
        : { pricingCallBackend: request.pricingCallBackend }),
      ...(request.requiredEdgeIds === undefined
        ? {}
        : { requiredEdgeIds: request.requiredEdgeIds }),
    });
    if (request.source.number === carryNextSource.number) {
      sparseCarrySession = await created;
      return sparseCarrySession;
    }
    return created;
  },
  () => {},
  (pricingPublication) => pricingHistoryPublications.push(pricingPublication),
);
const carryBase = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  pricingCallBackend: producerPricingBackend,
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(carryBase.status, "complete");
assert.equal(pricingHistoryPublications.length, 1);
assert.equal(pricingHistoryPublications[0]!.kind, "baseline");
assert.strictEqual(
  pricingHistoryPublications[0]!.snapshot,
  carryBase.snapshot,
  "the history baseline reuses the published full snapshot",
);
const bootstrapCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => {
    assert.equal(request.purpose, "coarse-pricing");
    assert.deepEqual(request.fundingAssets, [], "bootstrap excludes Funding");
    assert.equal(request.touchedPools, undefined, "bootstrap refreshes all instances");
    return parallelRoot.createSession({
      source: request.source,
      runtime: runtime(request.source),
      fundingAssets: request.fundingAssets,
      kind: "pricing",
      ...(request.control === undefined ? {} : { control: request.control }),
    });
  },
  () => {},
);
const bootstrap = await bootstrapCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  touchedPools: new Set([firstParallelTarget]),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(bootstrap.status, "complete");
assert.equal(bootstrap.snapshot.coverage.carriedEdgeKeys?.length, 0);
assert.equal(
  bootstrap.snapshot.coverage.refreshedEdgeKeys?.length,
  carryBaseGraph.scannerEdgeCount,
  "without a baseline, bootstrap refreshes the complete graph",
);
const edgeA = carryBaseGraph.edges.find((candidate) =>
  candidate.instanceKey?.toLowerCase() === firstParallelTarget
)!;
const edgeB = carryBaseGraph.edges.find((candidate) =>
  candidate.instanceKey?.toLowerCase() === secondParallelTarget
)!;
const touchedA = new Set([firstParallelTarget]);
const carried = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryNextGraph,
  pricingCallBackend: producerPricingBackend,
  touchedPools: touchedA,
  canonicalActivity: Object.freeze({
    source: carryNextSource,
    touchedStateKeys: touchedA,
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(carried.status, "complete");
const carriedPricing = carried.snapshot;
assert.equal(
  carriedPricing.pricingProvenanceByEdgeKey?.get(edgeA.canonicalEdgeId!),
  "refreshed",
);
assert.equal(
  carriedPricing.pricingProvenanceByEdgeKey?.get(edgeB.canonicalEdgeId!),
  "carried",
);
assert.equal(carriedPricing.coverage.carriedEdgeKeys?.length, 38);
assert.equal(carriedPricing.coverage.unresolvedEdgeKeys.length, 0);
assert.ok(carriedPricing.mids.has(edgeA.canonicalEdgeId!));
assert.ok(carriedPricing.mids.has(edgeB.canonicalEdgeId!));
const carryDelta = pricingHistoryPublications[1]!;
assert.equal(carryDelta.kind, "delta");
if (carryDelta.kind === "delta") {
  assert.equal(carryDelta.previousSourceBlock, carryBase.snapshot.sourceBlock);
  assert.deepEqual(carryDelta.removals, []);
  assert.equal(
    carryDelta.updates.length,
    carriedPricing.coverage.refreshedEdgeKeys?.length,
  );
  const touchedEdgeKeys = new Set<string>(carryNextGraph.edges
    .filter((candidate) =>
      candidate.instanceKey?.toLowerCase() === firstParallelTarget
    )
    .map((candidate) => String(candidate.canonicalEdgeId!)));
  assert.ok(carryDelta.updates.every(([edgeKey]) => touchedEdgeKeys.has(edgeKey)));
  assert.ok(
    !carryDelta.updates.some(([edgeKey]) => edgeKey === edgeB.canonicalEdgeId),
    "the carried clean edge is inherited by baseline reconstruction, not re-emitted",
  );
}

const carryThirdSource: CanonicalSource = Object.freeze({
  number: carryNextSource.number + 1,
  hash: `0x${"65".repeat(32)}`,
  generation: carryNextSource.generation + 1,
});
const carryThirdGraph = createVerifiedGraphView({
  id: "strict-carry-third",
  generation: carryThirdSource.generation,
  sourceBlock: carryThirdSource.number,
  sourceBlockHash: carryThirdSource.hash,
  completenessWatermark: carryThirdSource.number,
  perSourceCoverage: Object.freeze([Object.freeze({
    familyId: publication.familyId,
    sourceId: "strict-carry-test",
    sourceFingerprint: "strict-carry-test-v1",
    completeThroughBlock: carryThirdSource.number,
    completeThroughHash: carryThirdSource.hash,
  })]),
  familyIdForEdge: () => publication.familyId,
  edges: parallelStartupView.edges,
});
const carriedAgain = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryThirdGraph,
  pricingCallBackend: producerPricingBackend,
  touchedPools: touchedA,
  canonicalActivity: Object.freeze({
    source: carryThirdSource,
    touchedStateKeys: touchedA,
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(carriedAgain.status, "complete");
assert.strictEqual(
  carriedAgain.snapshot.coverageByEdgeKey,
  carriedPricing.coverageByEdgeKey,
  "unchanged coverage categories reuse the prior coverage map",
);
assert.strictEqual(
  carriedAgain.snapshot.pricingStateKeyByEdgeKey,
  carriedPricing.pricingStateKeyByEdgeKey,
  "unchanged topology reuses the prior state-key index",
);
assert.strictEqual(
  carriedAgain.snapshot.pricingFamilyIdByEdgeKey,
  carriedPricing.pricingFamilyIdByEdgeKey,
  "unchanged topology reuses the prior Family index",
);
assert.strictEqual(
  carriedAgain.snapshot.pricingProvenanceByEdgeKey,
  carriedPricing.pricingProvenanceByEdgeKey,
  "unchanged refreshed/carried classification reuses provenance",
);
assert.strictEqual(
  carriedAgain.snapshot.mids.get(edgeB.canonicalEdgeId!),
  carriedPricing.mids.get(edgeB.canonicalEdgeId!),
  "a clean carried mid is reused directly",
);
assert.notStrictEqual(
  carriedAgain.snapshot.mids,
  carriedPricing.mids,
  "the refreshed A entry still publishes a new delta map",
);

await carryBaseCoordinator.resetDynamicStateForReplay();
const fullRebuild = await carryBaseCoordinator.prepareCoarsePricing({
  graph: carryThirdGraph,
  pricingCallBackend: producerPricingBackend,
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(fullRebuild.status, "complete");
assert.equal(pricingHistoryPublications.at(-1)?.kind, "baseline");
assert.deepEqual(
  [...fullRebuild.snapshot.coverageByEdgeKey.entries()],
  [...carriedAgain.snapshot.coverageByEdgeKey.entries()],
  "delta publication preserves the full coverage result",
);
for (const candidate of [edgeA, edgeB]) {
  assert.equal(
    fullRebuild.snapshot.mids.get(candidate.canonicalEdgeId!)?.mid,
    carriedAgain.snapshot.mids.get(candidate.canonicalEdgeId!)?.mid,
    "delta publication preserves full-rebuild mid values",
  );
}

const unavailableCarryCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => parallelRoot.createSession({
    source: request.source,
    runtime: runtime(request.source, {
      ...(request.source.number === carryNextSource.number
        ? {
            reservesByTarget: new Map([
              [secondParallelTarget, Object.freeze({
                reserve0: 0n,
                reserve1: 1_000_000_000n,
                blockTimestampLast: 1,
              })],
            ]),
          }
        : {}),
    }),
    fundingAssets: request.fundingAssets,
    kind: "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
    ...(request.touchedPools === undefined
      ? {}
      : { touchedPools: request.touchedPools }),
    ...(request.pricingCallBackend === undefined
      ? {}
      : { pricingCallBackend: request.pricingCallBackend }),
  }),
  () => {},
);
const unavailableBase = await unavailableCarryCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(unavailableBase.status, "complete");
const unavailableNext = await unavailableCarryCoordinator.prepareCoarsePricing({
  graph: carryNextGraph,
  touchedPools: new Set([firstParallelTarget, secondParallelTarget]),
  canonicalActivity: Object.freeze({
    source: carryNextSource,
    touchedStateKeys: new Set([firstParallelTarget, secondParallelTarget]),
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(unavailableNext.status, "complete");
assert.equal(
  unavailableNext.snapshot.pricingProvenanceByEdgeKey?.get(
    edgeB.canonicalEdgeId!,
  ),
  "unavailable",
  "a clean behavior-proven unavailable edge remains terminal when carried",
);
assert.equal(
  unavailableNext.snapshot.coverageByEdgeKey.get(edgeB.canonicalEdgeId!)?.status,
  "rejected",
);
assert.ok(
  unavailableNext.snapshot.coverage.unavailableEdgeKeys.includes(
    edgeB.canonicalEdgeId!,
  ),
);
assert.equal(unavailableNext.snapshot.mids.has(edgeB.canonicalEdgeId!), false);
assert.notStrictEqual(
  unavailableNext.snapshot.coverageByEdgeKey,
  unavailableBase.snapshot.coverageByEdgeKey,
  "a newly unavailable edge updates the coverage delta",
);
assert.notStrictEqual(
  unavailableNext.snapshot.mids,
  unavailableBase.snapshot.mids,
  "a newly unavailable edge is deleted from the published mids",
);
const sparseSession = sparseCarrySession!;
assert.equal(
  sparseSession.creationTiming.skippedCleanInstanceCount,
  parallelReadyInstances.length - 1,
  "clean instances are not reissued in a sparse coarse session",
);
assert.equal(
  sparseSession.creationTiming.cleanAuthorityReissueCount,
  0,
);
assert.equal(
  sparseSession.creationTiming.projectedRouteCount,
  2,
  "coarse projection is limited to the touched instance routes",
);
assert.equal(
  sparseSession.creationTiming.selectedInstanceCount,
  1,
);
const enumerated = scanBlockStateFromResolvedMids({
  edges: [...carryNextGraph.edges],
  sourceBlock: carryNextSource.number,
  swapTouched: null,
  cfg: {
    maxHops: 2,
    minSpreadBps: 1,
    maxCandidates: 20,
    budgetMs: 1_000,
    pricedTokens: new Map([
      [UNIV2_FIXTURE_TOKEN0.toLowerCase(), { maxBorrow: 10n ** 18n }],
      [UNIV2_FIXTURE_TOKEN1.toLowerCase(), { maxBorrow: 10n ** 18n }],
    ]),
  },
  mids: carriedPricing.mids,
});
assert.ok(
  enumerated.opportunities.some((opportunity) =>
    opportunity.seedEdges.some((candidate) => candidate.instanceKey?.toLowerCase() === firstParallelTarget) &&
    opportunity.seedEdges.some((candidate) => candidate.instanceKey?.toLowerCase() === secondParallelTarget)
  ),
  "A→B→A remains enumerable from the dense coarse snapshot",
);
const requiredCarryEdges = new Set([edgeA.canonicalEdgeId!, edgeB.canonicalEdgeId!]);
const exactCarrySession = await parallelRoot.createSession({
  source: carryNextSource,
  runtime: runtime(carryNextSource, {
    reservesByTarget: new Map<string, Readonly<{
      reserve0: bigint;
      reserve1: bigint;
      blockTimestampLast: number;
    }>>([
      [firstParallelTarget, Object.freeze({ reserve0: 1_000_000_000n, reserve1: 3_000_000_000n, blockTimestampLast: 2 })],
      [secondParallelTarget, Object.freeze({ reserve0: 3_000_000_000n, reserve1: 1_000_000_000n, blockTimestampLast: 2 })],
    ]),
  }),
  fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  kind: "exact",
  requiredEdgeIds: requiredCarryEdges,
});
assert.ok(exactCarrySession.edges.some((candidate) => candidate.canonicalEdgeId === edgeA.canonicalEdgeId));
assert.ok(exactCarrySession.edges.some((candidate) => candidate.canonicalEdgeId === edgeB.canonicalEdgeId));
for (const candidate of [edgeA, edgeB]) {
  const exactCarry = await exactCarrySession.issueExact({
    edge: exactCarrySession.edges.find((item) => item.canonicalEdgeId === candidate.canonicalEdgeId)!,
    amountIn: 1_000_000n,
    executor: EXECUTOR,
    runtimeEvidence: Object.freeze([]),
  });
  assert.equal(exactCarry.status, "resolved");
}
await assert.rejects(
  parallelRoot.createSession({
    source: carryNextSource,
    runtime: runtime(carryNextSource),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    kind: "exact",
    requiredEdgeIds: new Set(["missing-canonical-edge"]),
  }),
  /missing required edge ids/,
  "exact must fail closed when the candidate closure is missing from the session",
);

const reorgCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => parallelRoot.createSession({
    source: request.source,
    runtime: runtime(request.source),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
    ...(request.exactCallBackend === undefined
      ? {}
      : { exactCallBackend: request.exactCallBackend }),
    ...(request.touchedPools === undefined
      ? {}
      : { touchedPools: request.touchedPools }),
    ...(request.pricingCallBackend === undefined
      ? {}
      : { pricingCallBackend: request.pricingCallBackend }),
    ...(request.requiredEdgeIds === undefined
      ? {}
      : { requiredEdgeIds: request.requiredEdgeIds }),
  }),
  () => {},
);
await reorgCoordinator.prepareCoarsePricing({
  graph: carryBaseGraph,
  deadlineAtMs: Date.now() + 10_000,
});
const reorg = await reorgCoordinator.prepareCoarsePricing({
  graph: carryNextGraph,
  touchedPools: touchedA,
  canonicalActivity: Object.freeze({
    source: Object.freeze({
      ...carryNextSource,
      hash: `0x${"64".repeat(32)}`,
    }),
    touchedStateKeys: touchedA,
    complete: true,
  }),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(reorg.status, "degraded");
assert.equal(
  reorg.snapshot.pricingProvenanceByEdgeKey?.get(edgeB.canonicalEdgeId!),
  "unresolved",
  "a reorg/mismatched canonical activity proof cannot authorize carry",
);
assert.equal(
  reorg.snapshot.mids.has(edgeB.canonicalEdgeId!),
  false,
  "an unresolved edge is deleted from the published mids",
);

const failedParallelSession = await parallelRoot.createSession({
    source: CURRENT,
    runtime: runtime(CURRENT, {
      currentPricingDelayMs: (target) =>
        target === firstParallelTarget ? 0 : 25,
      failCurrentPricingTarget: firstParallelTarget,
      onCurrentPricingReadStart() {
        activeFailedRefreshReads++;
      },
      onCurrentPricingReadEnd() {
        activeFailedRefreshReads--;
      },
    }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  });
assert.equal(
  activeFailedRefreshReads,
  0,
  "failed session must drain every sibling refresh before returning",
);
assert.equal(
  failedParallelSession.currentPricingForEdge(failedParallelSession.edges[0]!)?.status,
  "unresolved",
  "a failed dirty refresh remains explicitly unresolved",
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

// Both real Funding plugins must enter transport before either is released.
// This tests the removed dependency, not a machine-speed threshold.
for (const mode of ["success", "failed-provider", "stale", "aborted"] as const) {
  const releases: Array<() => void> = [];
  const heldByCall = new Map<string, Promise<void>>();
  let markAllStarted!: () => void;
  const allStarted = new Promise<void>((resolve) => { markAllStarted = resolve; });
  let active = 0;
  let current = true;
  let completed = false;
  let failedCall: string | undefined;
  const controller = new AbortController();
  const pendingSession = root.createSession({
    source: CURRENT,
    kind: "exact",
    fundingAssets: [UNIV2_FIXTURE_TOKEN0],
    control: { signal: controller.signal },
    runtime: runtime(CURRENT, {
      isCurrent: () => current,
      async onFundingRead(data) {
        let held = heldByCall.get(data);
        if (held === undefined) {
          if (heldByCall.size === 0) failedCall = data;
          held = new Promise<void>((resolve) => { releases.push(resolve); });
          heldByCall.set(data, held);
          if (heldByCall.size === readyFundingAssets.length) markAllStarted();
        }
        active++;
        try {
          await held;
          if (mode === "failed-provider" && data === failedCall) {
            throw new Error("one Funding provider failed");
          }
        } finally {
          active--;
        }
      },
    }),
  }).finally(() => { completed = true; });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      allStarted,
      new Promise<never>((_, reject) => {
        guard = setTimeout(() => reject(new Error("Funding families still serialize")), 1_000);
      }),
    ]);
    assert.equal(active, readyFundingAssets.length);
    assert.equal(completed, false);
    if (mode === "stale") current = false;
    if (mode === "aborted") controller.abort(new Error("test head changed"));
    // Complete the later catalog entry first; no partial session may escape.
    releases.at(-1)!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (mode !== "aborted") assert.equal(completed, false);
  } finally {
    if (guard !== undefined) clearTimeout(guard);
    releases.forEach((release) => release());
  }
  const funded = await pendingSession;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 0, "all sibling provider work must settle");
  const projection = funded.fundingProjection();
  assert.deepEqual(
    projection.outcomes.map((item) => item.fundingId),
    session.fundingProjection().outcomes.map((item) => item.fundingId),
    "completion order must not change catalog/asset publication order",
  );
  if (mode === "success") {
    assert.deepEqual(funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0), session.fundingActionIds(UNIV2_FIXTURE_TOKEN0));
    for (const actionAdapterId of funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0)) {
      const input = { actionAdapterId, asset: UNIV2_FIXTURE_TOKEN0, amount: 1_000_000n, minProfit: 1n, children: [] };
      assert.deepEqual(funded.buildFundingRoot(input), session.buildFundingRoot(input));
    }
  } else if (mode === "failed-provider") {
    assert.equal(funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0).length, 1);
    assert.equal(projection.outcomes.filter((item) => item.status === "verified").length, 1);
  } else {
    assert.deepEqual(funded.fundingActionIds(UNIV2_FIXTURE_TOKEN0), []);
    assert.ok(projection.outcomes.every((item) => item.status !== "verified"));
  }
}
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
  async (request: StrictSessionRequest) => {
    if (request.purpose === "source-n-runtime") {
      assert.deepEqual(request.fundingAssets, [UNIV2_FIXTURE_TOKEN0]);
    }
    return root.createSession({
      source: request.source,
      runtime: strictRuntime,
      fundingAssets: request.fundingAssets,
      kind: request.purpose === "exact-execution" ? "exact" : "pricing",
      ...(request.control === undefined ? {} : { control: request.control }),
    });
  },
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
assert.equal(currentRuntime.timing?.executionMs, 0, "no execution barrier means zero execution wait");
assert.equal(currentRuntime.snapshot.graph, currentGraph);
const currentFunding = currentRuntime.snapshot.funding;
assert.equal(
  currentFunding.coverage.expectedKeys.length,
  readyFundingAssets.length,
  "strict Funding coverage is keyed by every dynamic provider/asset source",
);
assert.equal(
  currentFunding.coverageByFundingId.size,
  currentFunding.coverage.expectedKeys.length,
);
assert.equal(
  currentFunding.freshnessByFundingId.size,
  currentFunding.coverage.resolvedKeys.length,
);
assert.ok(
  currentFunding.coverage.expectedKeys.every((fundingId) =>
    fundingId !== UNIV2_FIXTURE_TOKEN0.toLowerCase() &&
    currentFunding.coverageByFundingId.get(fundingId)?.status === "resolved" &&
    [...(currentFunding.freshnessByFundingId.get(fundingId)?.values() ?? [])]
      .every((proof) =>
        proof.kind === "strict-work" &&
        proof.source.number === CURRENT.number &&
        proof.source.hash === CURRENT.hash
      )
  ),
  "token lookup keys must not masquerade as Funding coverage/freshness keys",
);
assert.doesNotThrow(() => assertAtomicBlockScanRuntime(currentRuntime.snapshot));
assert.throws(
  () => assertAtomicBlockScanRuntime(Object.freeze({
    ...currentRuntime.snapshot,
    funding: Object.freeze({
      ...currentFunding,
      borrowable: currentFunding.borrowable.bind(currentFunding),
      source: currentFunding.source.bind(currentFunding),
      freshnessByFundingId: new Map(),
    }),
  })),
  /rejected funding coverage\/freshness/,
  "production boundary must reject a strict Funding snapshot without freshness",
);
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
await assert.rejects(
  currentCoordinator.prepareCurrentNExactExecutionContext({
    graph: currentGraph,
    fundingTokens: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
    deadlineAtMs: Date.now() + 10_000,
  }),
  /requires requiredEdgeIds/,
  "strict exact context must receive an explicit candidate edge closure",
);

const failingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => await root.createSession({
    source: request.source,
    runtime: runtime(request.source, { failCurrentPricing: true }),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
  }),
  () => {},
);
const failedCoarse = await failingCoordinator.prepareCoarsePricing({
    graph: currentGraph,
    deadlineAtMs: Date.now() + 10_000,
  });
assert.equal(failedCoarse.status, "degraded");
assert.ok(failingCoordinator.latestPricingSnapshot());
assert.equal(
  failedCoarse.snapshot.coverage.unresolvedEdgeKeys.length,
  currentGraph.scannerEdgeCount,
  "failed strict pricing is published as explicit unresolved coverage",
);
let failAfterPublication = false;
const retainingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => await root.createSession({
    source: request.source,
    runtime: runtime(request.source, {
      failCurrentPricing: failAfterPublication,
    }),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
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
const failedAfterPublication = await retainingCoordinator.prepareCoarsePricing({
    graph: currentGraph,
    deadlineAtMs: Date.now() + 10_000,
  });
assert.equal(failedAfterPublication.status, "degraded");
assert.notStrictEqual(
  retainingCoordinator.latestPricingSnapshot(),
  retainedPricing,
  "failed strict refresh is visible as an explicit degraded generation",
);
const failingFundingCoordinator = new StrictCurrentRuntimeCoordinator(
  async (request: StrictSessionRequest) => await root.createSession({
    source: request.source,
    runtime: runtime(request.source, { failFunding: true }),
    fundingAssets: request.fundingAssets,
    kind: request.purpose === "exact-execution" ? "exact" : "pricing",
    ...(request.control === undefined ? {} : { control: request.control }),
  }),
  () => {},
);
const unresolvedFunding = await failingFundingCoordinator.prepare({
  graph: currentGraph,
  fundingTokens: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  deadlineAtMs: Date.now() + 10_000,
});
assert.equal(unresolvedFunding.status, "degraded");
assert.equal(
  unresolvedFunding.snapshot.funding.coverage.unresolvedKeys.length,
  readyFundingAssets.length,
);
assert.equal(unresolvedFunding.snapshot.funding.sources.size, 0);
assert.equal(unresolvedFunding.snapshot.funding.freshnessByFundingId.size, 0);
assert.ok([...unresolvedFunding.snapshot.funding.coverageByFundingId.values()]
  .every((coverage) => coverage.status === "unresolved"));
assert.doesNotThrow(() =>
  assertAtomicBlockScanRuntime(unresolvedFunding.snapshot)
);
assert.equal(
  failingFundingCoordinator.latestPricingSnapshot(),
  unresolvedFunding.snapshot.pricing,
  "healthy pricing may publish while unresolved Funding remains fail-closed",
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

// A searched handle may be consumed again in its own current session without
// another quote, but retaining it must not retain authority after retirement.
const readsBeforeReuse = currentPricingReads;
assert.deepEqual(session.buildExecution({
  edge,
  exact,
  minAmountOut: exact.amountOut - 1n,
  executor: EXECUTOR,
}), execution);
assert.equal(currentPricingReads, readsBeforeReuse);
currentGenerationActive = false;
try {
  assert.throws(() => session.buildExecution({
    edge,
    exact,
    minAmountOut: exact.amountOut - 1n,
    executor: EXECUTOR,
  }), /generation fence rejected stale source/);
} finally {
  currentGenerationActive = true;
}

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

const failedSession = await root.createSession({
    source: CURRENT,
    runtime: runtime(CURRENT, { failCurrentPricing: true }),
    fundingAssets: Object.freeze([UNIV2_FIXTURE_TOKEN0]),
  });
assert.equal(
  failedSession.currentPricingForEdge(failedSession.edges[0]!)?.status,
  "unresolved",
);

assert.throws(
  () => new StrictProductionRuntimeRoot({
      catalog: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
      readySource: STARTUP,
      readyGraph: startupView.edges.slice(1),
      readyInstances: publication.instances,
      readyFundingAssets,
    }),
  /absent from Graph/,
  "the ready pricing index must reject a graph missing a pricing route",
);

console.log("strict production runtime session contract: PASS");
