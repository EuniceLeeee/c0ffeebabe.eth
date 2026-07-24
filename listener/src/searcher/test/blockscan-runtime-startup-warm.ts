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
  type DiscoveryCoverageAnchor,
  type LiveDiscoveryPublicationState,
} from "../live-discovery-publication.js";
import { createProtocolDiscoveryEvidenceCache } from
  "../protocol-discovery-cache.js";
import { ProtocolDiscoveryMutationQueue } from
  "../protocol-discovery-coordinator.js";
import {
  createVerifiedGraphView,
  exactSetHash,
  type VerifiedGraphView,
} from "../venues/blockscan-state-capability.js";

const HOT_BUDGET_MS = 25;
const STARTUP_BUDGET_MS = 500;
const EMPTY_HASH = exactSetHash([]);

await distantStartupWaitsForCurrentDiscovery();
await incompleteRetriesAndHotBudgetResumes();
await degradedSnapshotCompletesStartupWithoutScanning();
await latestHeadCoalescesDuringStartupWarm();
blindModeDoesNotEnterOrdinaryStartupWarm();

console.log(
  "[blockscan-runtime-startup-warm] current-head/retry/degraded/coalesce: " +
    "PASS (5/5)",
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
  } = {},
) {
  let publication = publicationAt(initialCompleteThrough);
  let shuttingDown = false;
  let prepareCalls = 0;
  let publishedPricing = 0;
  let plannerGraphCalls = 0;
  const runtimeBlocks: number[] = [];
  const deadlineRemainingMs: number[] = [];
  const backfillBlocks: number[] = [];
  const queue = new ProtocolDiscoveryMutationQueue();
  const journal = new CanonicalHeaderJournal();

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
    stop() {},
    async stopAndWait() {},
  };
  const deps: BlockScanRuntimeLoopDependencies<{ readonly block: number }> = {
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
      { readonly block: number }
    >["executionWorkers"],
    runtimeAbort: new AbortController(),
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
        _base: LiveDiscoveryPublicationState,
        input: { readonly through: number },
      ) => ({ block: input.through }),
      validate: (
        base: LiveDiscoveryPublicationState,
        prepared: { readonly block: number },
      ) =>
        publicationAt(prepared.block, base.revision + 1),
      finish() {},
    } as unknown as BlockScanRuntimeLoopDependencies<
      { readonly block: number }
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
        { readonly block: number }
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
    protocolFamilySourceCoverage: new Map(),
    protocolObservedCursor: {
      completeThroughBlock: -1,
      completeThroughHash: null,
    },
  };
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
