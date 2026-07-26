import assert from "node:assert/strict";
import {
  AdapterRuntimeCoordinator,
  FlashFundingSnapshot,
  type AdapterRuntimePrepareResult,
  type PrepareAdapterRuntimeInput,
} from "../adapter-runtime-coordinator.js";
import {
  BlockScanRuntimeLoop,
  type BlockScanRuntimeLoopDependencies,
} from "../blockscan-runtime-loop.js";
import { CanonicalHeaderJournal } from "../canonical-header-journal.js";
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
const EMPTY_HASH = exactSetHash([]);

interface PreparedDiscovery {
  readonly block: number;
  readonly baseDexFingerprint: string;
  readonly delta: RuntimePoolRefreshDelta;
}

await distantStartupWaitsForCurrentDiscovery();
await incompleteRetriesAndHotBudgetResumes();
await degradedSnapshotCompletesStartupWithoutScanning();
await latestHeadCoalescesDuringStartupWarm();
await protocolLagDoesNotBlockDexRuntime();
await observedPublicationDoesNotInvalidateHotDexCommit();
await shutdownDrainsActivePassAndDropsPendingHead();
blindModeDoesNotEnterOrdinaryStartupWarm();

console.log(
  "[blockscan-runtime-startup-warm] current-head/retry/degraded/coalesce: " +
    "PASS (8/8)",
);

async function distantStartupWaitsForCurrentDiscovery(): Promise<void> {
  const harness = createHarness(100, ["complete"]);
  await harness.run(140);
  assert.deepEqual(
    harness.runtimeBlocks,
    [],
    "D+40 must not prepare runtime state before discovery reaches N-1",
  );
  assert.deepEqual(harness.backfillBlocks, [140]);
  assert.equal(harness.loop.isStartupWarmPending(), true);

  harness.setPublication(139);
  await harness.run(140);
  assert.deepEqual(harness.runtimeBlocks, [140]);
  assert.equal(harness.loop.isStartupWarmPending(), false);
  assert.equal(harness.publishedPricing, 1);
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
  const backfillBlocks: number[] = [];
  const queue = new ProtocolDiscoveryMutationQueue();
  const journal = new CanonicalHeaderJournal();
  const runtimeAbort = new AbortController();
  let workerStops = 0;

  const runtimeCoordinator = {
    async prepare(
      input: PrepareAdapterRuntimeInput,
    ): Promise<AdapterRuntimePrepareResult> {
      const call = ++prepareCalls;
      runtimeBlocks.push(input.graph.sourceBlock);
      deadlineRemainingMs.push(input.deadlineAtMs - Date.now());
      await options.beforePrepareResult?.(call);
      await input.prepareExecution?.({
        generation: input.graph.generation,
        sourceBlock: input.graph.sourceBlock,
        sourceBlockHash: input.graph.sourceBlockHash,
        deadlineAtMs: input.deadlineAtMs,
        signal: input.signal ?? new AbortController().signal,
      });
      if (options.stopAfterPrepareCall === call) shuttingDown = true;
      return runtimeResult(
        statuses.shift() ?? "complete",
        input.graph,
      );
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
        readyDescriptor: () => null,
      },
      journal,
      queue,
      observeHeader: async (blockNumber: number) => header(blockNumber),
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
            dexGraphCoverage: {
              sourceCompleteThrough: prepared.block,
              graphCompleteThrough: prepared.block,
            },
            dexSourceAnchor: anchor(prepared.block),
            dexGraphAnchor: anchor(prepared.block),
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
    startupWarmEnabled: !(options.blindEnabled ?? false),
    startupWarmBudgetMs: STARTUP_BUDGET_MS,
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
