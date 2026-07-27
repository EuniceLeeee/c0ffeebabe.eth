import assert from "node:assert/strict";
import {
  AdapterRuntimeCoordinator,
  FlashFundingSnapshot,
  type AdapterRuntimePrepareResult,
  type CurrentNExactExecutionContextResult,
  type PrepareAdapterRuntimeInput,
} from "../adapter-runtime-coordinator.js";
import type {
  BlockScanStatePrepareResult,
  BlockScanStateSnapshot,
} from "../blockscan-state-coordinator.js";
import {
  BlockScanRuntimeLoop,
  dexRuntimeAdmissionCompleteThrough,
  type BlockScanRuntimeLoopDependencies,
} from "../blockscan-runtime-loop.js";
import {
  CanonicalHeaderJournal,
  CanonicalHeaderOutsideRetentionError,
} from "../canonical-header-journal.js";
import {
  cloneLiveDiscoveryPublicationState,
  describeDexPublicationSlice,
  rebaseHotDexPublication,
  type DiscoveryCoverageAnchor,
  type LiveDiscoveryPublicationState,
} from "../live-discovery-publication.js";
import type {
  PoolEntry,
  TokenEdge,
} from "../planner/token-graph.js";
import { createProtocolDiscoveryEvidenceCache } from
  "../protocol-discovery-cache.js";
import { ProtocolDiscoveryMutationQueue } from
  "../protocol-discovery-coordinator.js";
import type { RuntimePoolRefreshDelta } from
  "../runtime-pool-refresh.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { buildStrategyViews } from "../strategy-views.js";
import {
  createVerifiedGraphView,
  exactSetHash,
  type VerifiedGraphView,
} from "../venues/blockscan-state-capability.js";

const HOT_BUDGET_MS = 25;
const STARTUP_BUDGET_MS = 500;
const HOT_FAMILY_BUDGET_MS = 10;
const PUBLICATION_RESERVE_MS = 5;
const EMPTY_HASH = exactSetHash([]);

interface PreparedDiscovery {
  readonly block: number;
  readonly baseDexFingerprint: string;
  readonly delta: RuntimePoolRefreshDelta;
}

await distantStartupCatchesUpInSameHead();
await stalePreparedSourceRestartsFromCurrentHead();
await activeBackfillSettlesBeforeHotCatchup();
await failedBackfillDoesNotBecomeUnboundedHotScan();
await steadyStateBehindRemainsFailClosed();
await steadyStateCompleteReadyCatchesCurrentHead();
await steadyStateIncompleteReadyRemainsFailClosed();
await incompleteRetriesAndHotBudgetResumes();
await startupStateGetsAnIndependentPhaseBudget();
await degradedSnapshotCompletesStartupWithoutScanning();
await latestHeadCoalescesDuringStartupWarm();
await protocolLagDoesNotBlockDexRuntime();
await familyProjectionLagDoesNotBlockOrdinaryDexRuntime();
blindModeStillRequiresExecutableDexGraph();
await observedPublicationDoesNotInvalidateHotDexCommit();
await shutdownInterruptsStartupBackfillWait();
await shutdownDrainsActivePassAndDropsPendingHead();
await nMinusOneTrackerStaysOutsideNormalRuntimePublication();
await nMinusOneWaitsForItsOnlyAdjacentProducer();
blindModeDoesNotEnterOrdinaryStartupWarm();

console.log(
  "[blockscan-runtime-startup-warm] current-head/retry/degraded/coalesce: " +
    "PASS (20/20)",
);

async function distantStartupCatchesUpInSameHead(): Promise<void> {
  const harness = createHarness(
    100,
    ["complete"],
    { laneReadyBlocksAfterSettlement: [140] },
  );
  await harness.run(140);
  assert.deepEqual(
    harness.runtimeBlocks,
    [140],
    "startup must strictly catch discovery up to the current head",
  );
  assert.deepEqual(harness.backfillBlocks, []);
  assert.equal(harness.loop.isStartupWarmPending(), false);
  assert.equal(harness.publishedPricing, 1);
}

async function stalePreparedSourceRestartsFromCurrentHead(): Promise<void> {
  const harness = createHarness(
    100,
    ["complete"],
    {
      initialLaneReadyBlock: 100,
      outsideRetainedReadyBlock: 100,
      laneReadyBlocksAfterSettlement: [139],
    },
  );
  await harness.run(140);
  assert.equal(
    harness.laneInvalidations,
    1,
    "a prepared source outside the retained journal must be discarded",
  );
  assert.deepEqual(
    harness.laneTakeBlocks,
    [139],
    "startup must consume only the replacement current-branch generation",
  );
  assert.deepEqual(harness.runtimeBlocks, [140]);
}

async function activeBackfillSettlesBeforeHotCatchup(): Promise<void> {
  const holdLane = deferred<void>();
  const harness = createHarness(
    100,
    ["complete"],
    {
      laneReadyBlocksAfterSettlement: [130, 149],
      beforeLaneSettled: async () => {
        await holdLane.promise;
      },
    },
  );
  const run = harness.run(150);
  await waitFor(() => harness.laneSettledCalls === 1);
  assert.deepEqual(
    harness.runtimeBlocks,
    [],
    "startup must not race hot discovery against the active backfill lane",
  );
  holdLane.resolve();
  await run;
  assert.deepEqual(harness.runtimeBlocks, [150]);
  assert.deepEqual(
    harness.laneTakeBlocks,
    [130, 149],
    "bounded canonical chunks must publish in the same startup head",
  );
  assert.deepEqual(
    harness.discoveryPrepareBases,
    [149],
    "strict current-head catch-up must start from the consumed watermark",
  );
  assert.equal(harness.loop.isStartupWarmPending(), false);
}

async function failedBackfillDoesNotBecomeUnboundedHotScan(): Promise<void> {
  const harness = createHarness(100, ["complete"]);
  await harness.run(180);
  assert.deepEqual(harness.runtimeBlocks, []);
  assert.deepEqual(
    harness.discoveryPrepareBases,
    [],
    "a failed historical lane must not move the entire gap to hot RPC",
  );
  assert.deepEqual(harness.backfillBlocks, [180, 180]);
  assert.equal(harness.loop.isStartupWarmPending(), true);
}

async function steadyStateBehindRemainsFailClosed(): Promise<void> {
  const harness = createHarness(
    100,
    ["complete"],
    { startupWarmEnabled: false },
  );
  await harness.run(170);
  assert.deepEqual(harness.runtimeBlocks, []);
  assert.deepEqual(harness.discoveryPrepareBases, []);
  assert.deepEqual(harness.backfillBlocks, [170]);
}

async function steadyStateCompleteReadyCatchesCurrentHead(): Promise<void> {
  const harness = createHarness(
    100,
    ["complete"],
    {
      startupWarmEnabled: false,
      initialLaneReadyBlock: 165,
    },
  );
  await harness.run(170);
  assert.deepEqual(harness.laneTakeBlocks, [165]);
  assert.deepEqual(harness.discoveryPrepareBases, [165]);
  assert.deepEqual(harness.runtimeBlocks, [170]);
  assert.deepEqual(harness.backfillBlocks, []);
}

async function steadyStateIncompleteReadyRemainsFailClosed(): Promise<void> {
  const harness = createHarness(
    100,
    ["complete"],
    {
      startupWarmEnabled: false,
      initialLaneReadyBlock: 165,
      initialLanePublishedBlock: 160,
    },
  );
  await harness.run(170);
  assert.deepEqual(harness.laneTakeBlocks, [165]);
  assert.deepEqual(
    harness.discoveryPrepareBases,
    [],
    "a prepared generation incomplete at its own pinned source must not " +
      "enter strict hot catch-up",
  );
  assert.deepEqual(harness.runtimeBlocks, []);
  assert.deepEqual(harness.backfillBlocks, [170]);
}

async function incompleteRetriesAndHotBudgetResumes(): Promise<void> {
  const harness = createHarness(
    199,
    ["incomplete", "complete", "complete"],
    { stopAfterPrepareCall: 3 },
  );
  await harness.run(200);
  assert.equal(harness.loop.isStartupWarmPending(), true);
  assert.equal(harness.publishedPricing, 0);

  await harness.run(201);
  assert.equal(harness.loop.isStartupWarmPending(), false);
  assert.equal(harness.publishedPricing, 1);

  await harness.run(202);
  assert.deepEqual(harness.runtimeBlocks, [200, 201, 202]);
  assert(
    harness.deadlineRemainingMs[0]! > HOT_BUDGET_MS * 4 &&
      harness.deadlineRemainingMs[1]! > HOT_BUDGET_MS * 4,
    "incomplete startup retries retain the separate startup budget",
  );
  assert(
    harness.deadlineRemainingMs[2]! <= HOT_BUDGET_MS + 20,
    "the first head after a published startup snapshot uses the hot deadline",
  );
  for (const call of [0, 1]) {
    assert(
      harness.preparationSettleRemainingMs[call] !== null &&
        harness.pricingSettleRemainingMs[call] !== null,
      "startup warm must reserve time for publication",
    );
    assert(
      harness.deadlineRemainingMs[call]! -
          harness.preparationSettleRemainingMs[call]! >=
        PUBLICATION_RESERVE_MS - 2,
      "startup preparation must settle before the outer publication deadline",
    );
    assert(
      Math.abs(
        harness.pricingSettleRemainingMs[call]! -
          harness.preparationSettleRemainingMs[call]!,
      ) <= 2,
      "startup pricing may use the cold budget but not the publication reserve",
    );
  }
  assert(
    harness.pricingSettleRemainingMs[2] !== null &&
      harness.pricingSettleRemainingMs[2]! <
        harness.preparationSettleRemainingMs[2]!,
    "ordinary live must settle pricing families before all preparation",
  );
  assert(
    harness.deadlineRemainingMs[2]! -
        harness.preparationSettleRemainingMs[2]! >=
      PUBLICATION_RESERVE_MS - 2,
    "ordinary live must retain the publication reserve",
  );
}

async function startupStateGetsAnIndependentPhaseBudget(): Promise<void> {
  const harness = createHarness(
    249,
    ["complete"],
    {
      beforeDiscoveryPrepare: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
      },
    },
  );
  await harness.run(250);
  assert(
    harness.deadlineRemainingMs[0]! > STARTUP_BUDGET_MS - 100,
    "startup state must receive a fresh bounded phase budget after slow discovery",
  );
  assert.equal(harness.loop.isStartupWarmPending(), false);
  assert.equal(harness.publishedPricing, 1);
}

async function degradedSnapshotCompletesStartupWithoutScanning(): Promise<void> {
  const harness = createHarness(299, ["degraded"]);
  await harness.run(300);
  assert.equal(harness.loop.isStartupWarmPending(), false);
  assert.equal(harness.publishedPricing, 1);
  assert.equal(harness.runtimeBlocks.length, 1);
  assert.equal(
    harness.plannerGraphCalls,
    0,
    "the one-time degraded startup snapshot must skip enumeration/planning",
  );
}

async function latestHeadCoalescesDuringStartupWarm(): Promise<void> {
  const holdFirst = deferred<void>();
  const harness = createHarness(
    399,
    ["complete", "complete"],
    {
      stopAfterPrepareCall: 2,
      beforePrepareResult: async (call) => {
        if (call === 1) await holdFirst.promise;
      },
    },
  );
  harness.loop.schedule(400);
  await waitFor(() => harness.runtimeBlocks.length === 1);

  // Simulate the independently prepared discovery lane reaching the latest
  // predecessor while state preparation for 400 is still active.
  harness.setPublication(401);
  harness.loop.schedule(401);
  harness.loop.schedule(402);
  holdFirst.resolve();
  await waitFor(() => harness.runtimeBlocks.length === 2);
  assert.deepEqual(
    harness.runtimeBlocks,
    [400, 402],
    "the scheduler must retain only the newest head during startup warm",
  );
}

async function protocolLagDoesNotBlockDexRuntime(): Promise<void> {
  const harness = createHarness(
    449,
    ["degraded"],
    { initialProtocolCompleteThrough: 448 },
  );
  await harness.run(450);
  assert.deepEqual(
    harness.runtimeBlocks,
    [450],
    "a protocol-family discovery lag must not suppress the DEX runtime pass",
  );
  assert.equal(
    harness.publishedPricing,
    1,
    "healthy DEX state must publish while the owning protocol family is degraded",
  );
}

async function familyProjectionLagDoesNotBlockOrdinaryDexRuntime(): Promise<void> {
  const harness = createHarness(
    599,
    ["complete"],
    {
      startupWarmEnabled: false,
      preserveHotGraphGap: true,
    },
  );
  await harness.run(600);
  assert.deepEqual(
    harness.runtimeBlocks,
    [600],
    "source-complete ordinary live must run healthy families while one projection retries",
  );
  assert.deepEqual(
    harness.backfillBlocks,
    [600],
    "an ordinary family projection gap must schedule immediate background healing",
  );
  assert.equal(
    harness.publication.dexGraphCoverage.sourceCompleteThrough,
    600,
  );
  assert.equal(
    harness.publication.dexGraphCoverage.graphCompleteThrough,
    599,
  );
}

function blindModeStillRequiresExecutableDexGraph(): void {
  const state: LiveDiscoveryPublicationState = {
    ...publicationAt(650),
    dexGraphCoverage: {
      sourceCompleteThrough: 650,
      graphCompleteThrough: 649,
    },
  };
  assert.equal(
    dexRuntimeAdmissionCompleteThrough(state, false),
    650,
    "ordinary live admission follows canonical source coverage",
  );
  assert.equal(
    dexRuntimeAdmissionCompleteThrough(state, true),
    649,
    "blind/audit admission remains pinned to executable graph coverage",
  );
}

async function observedPublicationDoesNotInvalidateHotDexCommit(): Promise<void> {
  const harness = createHarness(
    469,
    ["complete"],
    { publishObservedDuringDiscoveryPrepare: true },
  );
  await harness.run(470);
  assert.deepEqual(
    harness.runtimeBlocks,
    [470],
    "a protocol-only publication must not suppress the DEX runtime pass",
  );
  assert.equal(harness.publishedPricing, 1);
  assert.deepEqual(
    harness.backfillBlocks,
    [],
    "a successful hot rebase must not schedule stale-base backfill",
  );
  assert.equal(
    harness.publication.dexGraphCoverage.graphCompleteThrough,
    470,
  );
  assert.equal(
    harness.publication.protocolEvidenceCache.runtime.recentProcessedTxs.has(
      hash(0xbeef),
    ),
    true,
    "the hot DEX commit must preserve the concurrent protocol cache update",
  );
  assert(
    harness.publication.backrunGraph.some(
      (edge) =>
        edge.target.toLowerCase() === runtimeDexPool(470).address.toLowerCase(),
    ),
    "the runtime interleave must commit the prepared non-empty DEX delta",
  );
}

async function shutdownInterruptsStartupBackfillWait(): Promise<void> {
  const holdLane = deferred<void>();
  const harness = createHarness(
    100,
    [],
    {
      beforeLaneSettled: async () => {
        await holdLane.promise;
      },
    },
  );
  harness.loop.schedule(520);
  await waitFor(() => harness.laneSettledCalls === 1);
  await harness.loop.shutdown();
  assert.deepEqual(harness.runtimeBlocks, []);
  assert.equal(harness.loop.isStartupWarmPending(), true);
  assert.equal(harness.runtimeAborted, true);
  holdLane.resolve();
}

async function shutdownDrainsActivePassAndDropsPendingHead(): Promise<void> {
  const holdActive = deferred<void>();
  const harness = createHarness(
    549,
    ["complete"],
    {
      beforePrepareResult: async () => {
        await holdActive.promise;
      },
    },
  );
  harness.loop.schedule(550);
  await waitFor(() => harness.runtimeBlocks.length === 1);
  harness.loop.schedule(551);

  let settled = false;
  const shutdown = harness.loop.shutdown().then(() => {
    settled = true;
  });
  await waitFor(() => harness.runtimeAborted);
  assert.equal(harness.workerStops, 1);
  assert.equal(
    settled,
    false,
    "runtime shutdown must drain the active head before persistence may flush",
  );

  holdActive.resolve();
  await shutdown;
  harness.loop.schedule(552);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    harness.runtimeBlocks,
    [550],
    "pending and post-shutdown heads must not enter discovery/runtime prepare",
  );
}

async function nMinusOneTrackerStaysOutsideNormalRuntimePublication(): Promise<void> {
  const harness = createHarness(699, ["complete"], {
    nMinusOneFallbackEnabled: true,
  });
  await harness.run(700);
  assert.equal(harness.publishedPricing, 1);
  await harness.run(701);
  await waitFor(() => harness.coarsePricingBlocks.includes(701));
  await harness.run(702);
  assert.deepEqual(
    harness.runtimeBlocks,
    [700],
    "fallback heads must not invoke or publish a mixed-source normal runtime",
  );
  assert.deepEqual(harness.coarsePricingBlocks, [701, 702]);
  assert.deepEqual(harness.exactContextBlocks, [701, 702]);
  assert.ok(
    harness.coarsePricingDeadlineRemainingMs.every(
      (remainingMs) => remainingMs > 19_000 && remainingMs <= 20_000,
    ),
    "each queued predecessor must receive a fresh independent 20s budget",
  );
  assert.ok(
    harness.coarsePricingFamilyDeadlineRemainingMs.every(
      (remainingMs, index) =>
        Math.abs(
          remainingMs - harness.coarsePricingDeadlineRemainingMs[index]!,
        ) <= 1,
    ),
    "the degraded background producer must not inherit the 5s hot-family cutoff",
  );
  assert.equal(harness.publishedPricing, 1);
}

async function nMinusOneWaitsForItsOnlyAdjacentProducer(): Promise<void> {
  const hold701 = deferred<void>();
  const harness = createHarness(699, ["complete"], {
    nMinusOneFallbackEnabled: true,
    beforeCoarsePricingResult: async (sourceBlock) => {
      if (sourceBlock === 701) await hold701.promise;
    },
  });
  await harness.run(700);
  await harness.run(701);
  let head702Finished = false;
  const head702 = harness.run(702).then(() => {
    head702Finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    head702Finished,
    false,
    "N+1 must wait within its pass budget for the active N producer",
  );
  hold701.resolve();
  await head702;
  assert(
    harness.exactContextBlocks.includes(702),
    "the only adjacent completed predecessor must reach exact-N context",
  );
}

function blindModeDoesNotEnterOrdinaryStartupWarm(): void {
  const harness = createHarness(499, [], { blindEnabled: true });
  assert.equal(
    harness.loop.isStartupWarmPending(),
    false,
    "the trusted blind runner owns its explicit N-1 preparation lifecycle",
  );
}

function createHarness(
  initialCompleteThrough: number,
  statuses: Array<"complete" | "degraded" | "incomplete">,
  options: {
    readonly stopAfterPrepareCall?: number;
    readonly beforePrepareResult?: (call: number) => Promise<void>;
    readonly blindEnabled?: boolean;
    readonly initialProtocolCompleteThrough?: number;
    readonly publishObservedDuringDiscoveryPrepare?: boolean;
    readonly beforeLaneSettled?: () => Promise<void>;
    readonly laneReadyBlocksAfterSettlement?: number[];
    readonly startupWarmEnabled?: boolean;
    readonly initialLaneReadyBlock?: number;
    readonly outsideRetainedReadyBlock?: number;
    readonly initialLanePublishedBlock?: number;
    readonly beforeDiscoveryPrepare?: () => Promise<void>;
    readonly preserveHotGraphGap?: boolean;
    readonly nMinusOneFallbackEnabled?: boolean;
    readonly beforeCoarsePricingResult?: (
      sourceBlock: number,
    ) => Promise<void>;
  } = {},
) {
  let publication = publicationAt(
    initialCompleteThrough,
    0,
    options.initialProtocolCompleteThrough,
  );
  let shuttingDown = false;
  let prepareCalls = 0;
  let publishedPricing = 0;
  let plannerGraphCalls = 0;
  const runtimeBlocks: number[] = [];
  const deadlineRemainingMs: number[] = [];
  const pricingSettleRemainingMs: Array<number | null> = [];
  const preparationSettleRemainingMs: Array<number | null> = [];
  const backfillBlocks: number[] = [];
  const queue = new ProtocolDiscoveryMutationQueue();
  const journal = new CanonicalHeaderJournal();
  const runtimeAbort = new AbortController();
  let workerStops = 0;
  let laneSettledCalls = 0;
  let laneInvalidations = 0;
  let laneReadyBlock: number | null =
    options.initialLaneReadyBlock ?? null;
  const laneReadyBlocksAfterSettlement = [
    ...(options.laneReadyBlocksAfterSettlement ?? []),
  ];
  const laneTakeBlocks: number[] = [];
  const discoveryPrepareBases: number[] = [];
  const coarsePricingBlocks: number[] = [];
  const coarsePricingDeadlineRemainingMs: number[] = [];
  const coarsePricingFamilyDeadlineRemainingMs: number[] = [];
  const exactContextBlocks: number[] = [];
  let latestPricing: BlockScanStateSnapshot | null = null;

  const runtimeCoordinator = {
    async prepare(
      input: PrepareAdapterRuntimeInput,
    ): Promise<AdapterRuntimePrepareResult> {
      const call = ++prepareCalls;
      runtimeBlocks.push(input.graph.sourceBlock);
      deadlineRemainingMs.push(input.deadlineAtMs - Date.now());
      preparationSettleRemainingMs.push(
        input.preparationSettleDeadlineAtMs === undefined
          ? null
          : input.preparationSettleDeadlineAtMs - Date.now(),
      );
      pricingSettleRemainingMs.push(
        input.pricingFamilySettleDeadlineAtMs === undefined
          ? null
          : input.pricingFamilySettleDeadlineAtMs - Date.now(),
      );
      await options.beforePrepareResult?.(call);
      await input.prepareExecution?.({
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        deadlineAtMs:
          input.preparationSettleDeadlineAtMs ?? input.deadlineAtMs,
        signal: input.signal ?? new AbortController().signal,
      });
      if (options.stopAfterPrepareCall === call) shuttingDown = true;
      const result = runtimeResult(
        statuses.shift() ?? "complete",
        input.graph,
      );
      if (result.status !== "incomplete") {
        latestPricing = result.snapshot.pricing;
      }
      return result;
    },
    latestPricingSnapshot(): BlockScanStateSnapshot | null {
      return latestPricing;
    },
    async prepareCoarsePricing(input: {
      readonly graph: VerifiedGraphView;
      readonly deadlineAtMs: number;
      readonly familySettleDeadlineAtMs?: number;
    }): Promise<BlockScanStatePrepareResult> {
      coarsePricingBlocks.push(input.graph.sourceBlock);
      coarsePricingDeadlineRemainingMs.push(input.deadlineAtMs - Date.now());
      coarsePricingFamilyDeadlineRemainingMs.push(
        (input.familySettleDeadlineAtMs ?? input.deadlineAtMs) - Date.now(),
      );
      await options.beforeCoarsePricingResult?.(input.graph.sourceBlock);
      const prepared = runtimeResult("complete", input.graph);
      if (prepared.status === "incomplete") throw new Error("fixture bug");
      latestPricing = prepared.snapshot.pricing;
      return prepared.pricing;
    },
    async prepareCurrentNExactExecutionContext(input: {
      readonly graph: VerifiedGraphView;
      readonly prepareExecution?: PrepareAdapterRuntimeInput["prepareExecution"];
      readonly deadlineAtMs: number;
      readonly signal?: AbortSignal;
    }): Promise<CurrentNExactExecutionContextResult> {
      exactContextBlocks.push(input.graph.sourceBlock);
      await input.prepareExecution?.({
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        deadlineAtMs: input.deadlineAtMs,
        signal: input.signal ?? new AbortController().signal,
      });
      const fundingCoverage = {
        expectedKeys: [],
        resolvedKeys: [],
        unresolvedKeys: [],
        expectedHash: EMPTY_HASH,
        resolvedHash: EMPTY_HASH,
        unresolvedHash: EMPTY_HASH,
      };
      const funding = new FlashFundingSnapshot(
        input.graph.generation,
        input.graph.sourceBlock,
        input.graph.sourceBlockHash,
        fundingCoverage,
        new Map(),
        new Map(),
        new Map(),
      );
      return {
        status: "complete",
        context: {
          generation: input.graph.generation,
          sourceBlock: input.graph.sourceBlock,
          sourceBlockHash: input.graph.sourceBlockHash,
          graph: input.graph,
          funding,
        },
        fundingCoverage,
        issues: [],
        timing: {
          startedAtMs: Date.now(),
          finishedAtMs: Date.now(),
          wallMs: 0,
          fundingMs: 0,
          executionMs: 0,
          finalCanonicalCasMs: 0,
        },
      };
    },
  } as unknown as AdapterRuntimeCoordinator;

  const blockScanPlanner = {
    setFlashLiquidity() {},
    setGraph() {
      plannerGraphCalls++;
    },
  };
  const workerState = {
    provider: {},
    async forkAt() {},
    stop() {
      workerStops++;
    },
    async stopAndWait() {},
  };
  const deps: BlockScanRuntimeLoopDependencies<PreparedDiscovery> = {
    enabled: true,
    blockScanConfig: {
      maxHops: 3,
      minSpreadBps: 0,
      maxCandidates: 1,
      budgetMs: 1,
      pricedTokens: new Map(),
    },
    executionWorkers: ([{
      state: workerState,
      solver: {},
      simulator: {},
    }] as unknown) as BlockScanRuntimeLoopDependencies<
      PreparedDiscovery
    >["executionWorkers"],
    runtimeAbort,
    sharedPlanner: { setFlashLiquidity() {} },
    backrunStatePublisher: {
      publish() {
        publishedPricing++;
        return {};
      },
    },
    discovery: {
      lane: {
        readyDescriptor: () =>
          laneReadyBlock === null
            ? null
            : {
                jobId: 1,
                planId: `fixture:${laneReadyBlock}`,
                source: {
                  number: laneReadyBlock,
                  hash: hash(laneReadyBlock),
                },
              },
        settled: async () => {
          laneSettledCalls++;
          await options.beforeLaneSettled?.();
          laneReadyBlock =
            laneReadyBlocksAfterSettlement.shift() ?? null;
        },
        takeForHotHead: () => {
          assert.notEqual(laneReadyBlock, null);
          const sourceBlock = laneReadyBlock!;
          const publishedBlock =
            options.initialLanePublishedBlock ?? sourceBlock;
          laneReadyBlock = null;
          laneTakeBlocks.push(sourceBlock);
          return {
            status: "ready_degraded",
            state: publicationAt(
              publishedBlock,
              publication.revision + 1,
            ),
            planId: `fixture:${sourceBlock}`,
            jobId: 1,
            graphCompleteThrough: publishedBlock,
            reason: "coverage_behind",
          };
        },
        invalidate: () => {
          laneInvalidations++;
          laneReadyBlock = null;
        },
      },
      journal,
      queue,
      observeHeader: async (blockNumber: number) => {
        if (blockNumber === options.outsideRetainedReadyBlock) {
          throw new CanonicalHeaderOutsideRetentionError(
            blockNumber,
            blockNumber + 2_048,
          );
        }
        return header(blockNumber);
      },
      capture: () => cloneLiveDiscoveryPublicationState(publication),
      publish: (next: LiveDiscoveryPublicationState) => {
        publication = cloneLiveDiscoveryPublicationState(next);
      },
      finishPublished() {},
      scheduleBackfill: async (blockNumber: number) => {
        backfillBlocks.push(blockNumber);
      },
      prepare: async (
        base: LiveDiscoveryPublicationState,
        input: { readonly through: number },
      ) => {
        await options.beforeDiscoveryPrepare?.();
        discoveryPrepareBases.push(
          base.dexGraphCoverage.graphCompleteThrough,
        );
        const pool = runtimeDexPool(input.through);
        const delta: RuntimePoolRefreshDelta = {
          attemptedPools: [pool],
          successfulBuilds: [{
            pool,
            edges: runtimeDexEdges(pool),
          }],
          failedPools: [],
        };
        const prepared: PreparedDiscovery = {
          block: input.through,
          baseDexFingerprint: describeDexPublicationSlice(base),
          delta,
        };
        if (options.publishObservedDuringDiscoveryPrepare) {
          await queue.enqueue("observed", async () => {
            const observed = cloneLiveDiscoveryPublicationState(publication);
            observed.protocolEvidenceCache.runtime.recentProcessedTxs.set(
              hash(0xbeef),
              input.through,
            );
            publication = {
              ...observed,
              revision: observed.revision + 1,
            };
          });
        }
        return prepared;
      },
      validateHot: (
        current: LiveDiscoveryPublicationState,
        prepared: PreparedDiscovery,
      ) =>
        rebaseHotDexPublication({
          current,
          patch: {
            baseDexFingerprint: prepared.baseDexFingerprint,
            chainId: "1",
            delta: prepared.delta,
            retryableDexGraphPools: current.retryableDexGraphPools,
            retryableDexIdentityPools: current.retryableDexIdentityPools,
            // Ordinary live may publish a source-complete generation while one
            // family projection remains retryable. Blind mode must still reject
            // the same fixture before runtime preparation.
            dexGraphCoverage: {
              sourceCompleteThrough: prepared.block,
              graphCompleteThrough: options.preserveHotGraphGap
                ? current.dexGraphCoverage.graphCompleteThrough
                : prepared.block,
            },
            dexSourceAnchor: anchor(prepared.block),
            dexGraphAnchor: options.preserveHotGraphGap
              ? current.dexGraphAnchor
              : anchor(prepared.block),
            landedCoverage: current.landedCoverage,
          },
          buildStrategyViews: runtimeStrategyViews,
        }),
      finish() {},
    } as unknown as BlockScanRuntimeLoopDependencies<
      PreparedDiscovery
    >["discovery"],
    blind: {
      enabled: options.blindEnabled ?? false,
      activeSource: () => null,
      preparedBase: () => null,
      preparedArtifacts: () => null,
      dynamicResetNonce: () => null,
    },
    largeGraphEdgeThreshold: 20_000,
    largeGraphPassBudgetMs: 30_000,
    passBudgetMs: HOT_BUDGET_MS,
    startupWarmEnabled:
      (options.startupWarmEnabled ?? true) &&
      !(options.blindEnabled ?? false),
    startupWarmBudgetMs: STARTUP_BUDGET_MS,
    nMinusOneFallbackEnabled: options.nMinusOneFallbackEnabled,
    hotPricingFamilyBudgetMs: HOT_FAMILY_BUDGET_MS,
    runtimePublicationReserveMs: PUBLICATION_RESERVE_MS,
    refineCandidates: 1,
    solveReserveMs: 0,
    midConcurrency: 1,
    isShuttingDown: () => shuttingDown,
    blockScanGraph: () => [],
    blockScanPlanner: () =>
      blockScanPlanner as unknown as BlockScanRuntimeLoopDependencies<
        PreparedDiscovery
      >["blockScanPlanner"] extends () => infer T ? T : never,
    adapterRuntimeCoordinator: () => runtimeCoordinator,
    flashTokens: () => [],
    buildGraphView: (input) => graphAt(
      input.generation,
      input.sourceBlock,
      input.sourceBlockHash,
    ),
    readBlockHash: async (_provider, blockNumber) => hash(blockNumber),
    formatRouteKey: () => "fixture-route",
    formatRing: () => "fixture-ring",
    isRouteBlacklisted: () => false,
    submitAtomic: async () => {
      throw new Error("startup warm unexpectedly reached final simulation");
    },
  };
  const loop = new BlockScanRuntimeLoop(deps);

  return {
    loop,
    runtimeBlocks,
    deadlineRemainingMs,
    preparationSettleRemainingMs,
    pricingSettleRemainingMs,
    backfillBlocks,
    get publishedPricing() {
      return publishedPricing;
    },
    get plannerGraphCalls() {
      return plannerGraphCalls;
    },
    get runtimeAborted() {
      return runtimeAbort.signal.aborted;
    },
    get workerStops() {
      return workerStops;
    },
    get laneSettledCalls() {
      return laneSettledCalls;
    },
    get laneInvalidations() {
      return laneInvalidations;
    },
    laneTakeBlocks,
    discoveryPrepareBases,
    coarsePricingBlocks,
    coarsePricingDeadlineRemainingMs,
    coarsePricingFamilyDeadlineRemainingMs,
    exactContextBlocks,
    get publication() {
      return cloneLiveDiscoveryPublicationState(publication);
    },
    setPublication(block: number) {
      publication = publicationAt(block, publication.revision + 1);
    },
    run(block: number) {
      return loop.runHead(block, {
        sourceHeadSeenAtMs: Date.now(),
        sourceHeadSeenAtMonotonicMs: performance.now(),
      });
    },
  };
}

function runtimeResult(
  status: "complete" | "degraded" | "incomplete",
  graph: VerifiedGraphView,
): AdapterRuntimePrepareResult {
  const coverage = {
    expectedStateKeys: [],
    resolvedStateKeys: [],
    unresolvedStateKeys: [],
    expectedReadKeys: [],
    resolvedReadKeys: [],
    unresolvedReadKeys: [],
    expectedEdgeKeys: [],
    resolvedEdgeKeys: [],
    unavailableEdgeKeys: [],
    unresolvedEdgeKeys: [],
    expectedStateKeyHash: EMPTY_HASH,
    resolvedStateKeyHash: EMPTY_HASH,
    unresolvedStateKeyHash: EMPTY_HASH,
    expectedReadKeyHash: EMPTY_HASH,
    resolvedReadKeyHash: EMPTY_HASH,
    unresolvedReadKeyHash: EMPTY_HASH,
    expectedEdgeKeyHash: EMPTY_HASH,
    resolvedEdgeKeyHash: EMPTY_HASH,
    unavailableEdgeKeyHash: EMPTY_HASH,
    unresolvedEdgeKeyHash: EMPTY_HASH,
  };
  const pricingBase = {
    generation: graph.generation,
    sourceBlock: graph.sourceBlock,
    sourceBlockHash: graph.sourceBlockHash,
    coverage,
    issues: status === "incomplete"
      ? [{ kind: "deadline" as const, message: "fixture incomplete" }]
      : [],
    laneTelemetry: [],
    familyTelemetry: [],
  };
  const fundingCoverage = {
    expectedKeys: [],
    resolvedKeys: [],
    unresolvedKeys: [],
    expectedHash: EMPTY_HASH,
    resolvedHash: EMPTY_HASH,
    unresolvedHash: EMPTY_HASH,
  };
  if (status === "incomplete") {
    return {
      status,
      pricing: { ...pricingBase, status },
      fundingCoverage,
      issues: pricingBase.issues,
    };
  }
  const pricing = {
    ...pricingBase,
    status,
    snapshot: {
      generation: graph.generation,
      sourceBlock: graph.sourceBlock,
      sourceBlockHash: graph.sourceBlockHash,
      graph,
      mids: new Map(),
      coverageByReadKey: new Map(),
      coverageByEdgeKey: new Map(),
      freshnessByReadKey: new Map(),
      stateByStateKey: new Map(),
      resolvedFamilyIds: [],
      incompleteFamilyIds: status === "degraded" ? ["fixture-family"] : [],
      coverage,
      laneTelemetry: [],
      familyTelemetry: [],
    },
  };
  const funding = new FlashFundingSnapshot(
    graph.generation,
    graph.sourceBlock,
    graph.sourceBlockHash,
    fundingCoverage,
    new Map(),
    new Map(),
    new Map(),
  );
  return {
    status,
    snapshot: {
      completeness: status,
      generation: graph.generation,
      sourceBlock: graph.sourceBlock,
      sourceBlockHash: graph.sourceBlockHash,
      graph,
      pricing: pricing.snapshot,
      funding,
    },
    pricing,
    fundingCoverage,
    issues: [],
  };
}

function graphAt(
  generation: number,
  block: number,
  blockHash: string,
): VerifiedGraphView {
  return createVerifiedGraphView({
    id: `startup-warm:${generation}`,
    generation,
    sourceBlock: block,
    sourceBlockHash: blockHash,
    completenessWatermark: block,
    perSourceCoverage: [{
      familyId: "fixture-family",
      sourceId: "fixture-source",
      sourceFingerprint: "fixture:v1",
      completeThroughBlock: block,
      completeThroughHash: blockHash,
    }],
    edges: [],
  });
}

function publicationAt(
  block: number,
  revision = 0,
  protocolCompleteThrough?: number,
): LiveDiscoveryPublicationState {
  const evidence = createProtocolDiscoveryEvidenceCache(1);
  return {
    revision,
    strategyViews: {
      backrun: [],
      blockscan: [],
      versions: {
        strategy_view_version: "fixture:v1",
        backrun_view_hash: "fixture:backrun",
        blockscan_view_hash: "fixture:blockscan",
        pool_universe_generated_at: "2026-07-25T00:00:00.000Z",
        overrides_hash: "fixture:overrides",
      },
    },
    backrunGraph: [],
    blockscanGraph: [],
    tokenIndex: new Map(),
    poolAddressMap: new Map(),
    flashTokens: [],
    knownPoolKeys: new Set(),
    knownPoolAddresses: new Set(),
    protocolOwnership: { version: 0, admissions: new Map() },
    protocolEvidenceCache: evidence,
    retryableDexGraphPools: new Map(),
    retryableDexIdentityPools: new Map(),
    dexGraphCoverage: {
      sourceCompleteThrough: block,
      graphCompleteThrough: block,
    },
    dexSourceAnchor: anchor(block),
    dexGraphAnchor: anchor(block),
    landedCoverage: [],
    protocolFamilySourceCoverage: protocolCompleteThrough === undefined
      ? new Map()
      : new Map([[
          "fixture-protocol\u001fobserved-interaction",
          anchor(protocolCompleteThrough),
        ]]),
    protocolObservedCursor: {
      completeThroughBlock: -1,
      completeThroughHash: null,
    },
  };
}

function runtimeDexPool(block: number): PoolEntry {
  return {
    address: address(0x8000 + block),
    adapter: "univ2",
    token0: address(0x9000 + block),
    token1: address(0xa000 + block),
  };
}

function runtimeDexEdges(pool: PoolEntry): TokenEdge[] {
  return [
    runtimeDexEdge(pool, pool.token0!, pool.token1!),
    runtimeDexEdge(pool, pool.token1!, pool.token0!),
  ];
}

function runtimeDexEdge(
  pool: PoolEntry,
  tokenIn: string,
  tokenOut: string,
): TokenEdge {
  return {
    adapterId: "univ2-swap",
    target: pool.address,
    tokenIn,
    tokenOut,
    poolToken0: pool.token0,
    poolToken1: pool.token1,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  };
}

function runtimeStrategyViews(pools: PoolEntry[]) {
  return buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 10_000,
    poolUniverseGeneratedAt: "2026-07-26T00:00:00.000Z",
  });
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function anchor(block: number): DiscoveryCoverageAnchor {
  return {
    completeThroughBlock: block,
    completeThroughHash: hash(block),
  };
}

function header(block: number) {
  return {
    number: block,
    hash: hash(block),
    parentHash: hash(Math.max(0, block - 1)),
  };
}

function hash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
