import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  FlashFundingSnapshot,
  type AdapterRuntimePrepareResult,
  type CurrentNExactExecutionContextResult,
  type PrepareAdapterRuntimeInput,
} from "../adapter-runtime-coordinator.js";
import type {
  BlockScanLaggingTopologyRefreshMode,
  BlockScanStatePrepareResult,
  BlockScanStateSnapshot,
} from "../blockscan-state-coordinator.js";
import {
  assertExactContextMatchesGraph,
  blockScanCandidateFundingTokens,
  BlockScanRuntimeLoop,
  incompleteBlockScanFamilies,
  NMinusOneProducerGate,
  nMinusOneProducerCanServeLatestHead,
  summarizeBlockScanIssueCauses,
  type BlockScanAtomicExecutionInput,
  type BlockScanAtomicResult,
  type BlockScanEnumerationSolverTelemetrySink,
  type BlockScanPendingEvidenceTrigger,
  type BlockScanRuntimeLoopDependencies,
  type CurrentSourceRuntimeCoordinator,
} from "../blockscan-runtime-loop.js";
import {
  CanonicalHeaderJournal,
  CanonicalHeaderOutsideRetentionError,
} from "../canonical-header-journal.js";
import {
  cloneLiveDiscoveryPublicationState,
  computeDiscoveryGraphTopologyKey,
  describeDexPublicationSlice,
  describeLiveDiscoveryPublicationState,
  rebaseHotDexPublication,
  type DiscoveryCoverageAnchor,
  type LiveDiscoveryPublicationState,
} from "../live-discovery-publication.js";
import type {
  PoolEntry,
  TokenEdge,
} from "../planner/token-graph.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import type { RuntimeEvidence } from
  "../venues/adapter-family-plugin.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from
  "../runtime-evidence.js";
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
  blockScanEdgeKey,
  exactSetHash,
  type VerifiedGraphView,
} from "../venues/blockscan-state-capability.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
} from "../venues/route-leg-adapter.js";

const HOT_BUDGET_MS = 25;
const STARTUP_BUDGET_MS = 500;
const HOT_FAMILY_BUDGET_MS = 10;
const N_MINUS_ONE_FAMILY_SETTLE_BUDGET_MS = 10;
const PUBLICATION_RESERVE_MS = 5;
const EMPTY_HASH = exactSetHash([]);
const ROUTE_TOKEN_A = address(0xb001);
const ROUTE_TOKEN_B = address(0xb002);
const ROUTE_POOL_CHEAP = address(0xc001);
const ROUTE_POOL_RICH = address(0xc002);
const ROUTE_V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const PENDING_EVIDENCE_FAMILY: ExecutionFamilyId =
  "custom-swap:fixture-current-head";
const routePairInterface = new ethers.Interface([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function factory() view returns (address)",
]);

function resolvedPlan(netProfit: bigint): ResolvedPlan {
  return {
    root: {
      adapterId: "skip",
      target: ethers.ZeroAddress,
      tokenIn: ethers.ZeroAddress,
      tokenOut: ethers.ZeroAddress,
      amount: 0n,
      params: {},
      children: [],
    },
    netProfit,
    profitToken: ethers.ZeroAddress,
    flashAmount: 0n,
    templateName: "blockscan-runtime-startup-warm-fixture",
  };
}

await productionRuntimeRecordsNonzeroEnumerationAndSolver();
await incompleteRetriesAndHotBudgetResumes();
await startupStateGetsAnIndependentPhaseBudget();
await degradedSnapshotCompletesStartupWithoutScanning();
await latestHeadCoalescesDuringStartupWarm();
await sameHeadEvidenceTransactionsRemainFifoAndIsolated();
await exactRefineAndSolverShareOneBoundEvidenceContext();
await pendingEvidenceCooperativelyInterruptsOrdinaryPass();
await pendingEvidenceInterruptsNonCooperativeAtomicFinalSim();
await startupWarmRequeuesEvidenceWithinOriginalDeadline();
await startupWarmRecordsExpiredEvidenceInsteadOfSilentlyDropping();
await evidenceReorgKeepsFollowingEvidencePassCombined();
await unavailableDependenciesDrainEvidenceFifoWithoutLeakingKeys();
await sameHeightReorgForcesEvidenceBackToCombinedMode();
await newerEvidenceHeadCancelsBlockedEvidencePass();
await workerForkReceivesPassCancellationControl();
blindModeStillRequiresExecutableDexGraph();
await shutdownDrainsActivePassAndDropsPendingHead();
await nMinusOneTrackerStaysOutsideNormalRuntimePublication();
await nMinusOneRecoveryBacklogStaysOnHotBudget();
await nMinusOneWaitsForItsOnlyAdjacentProducer();
await nMinusOneProducerStartsAtArmTime();
nMinusOneExactJoinRejectsMixedAnchor();
nMinusOneFundingIsCandidateLocal();
blindModeDoesNotEnterOrdinaryStartupWarm();
familyFailureSummaryNamesOnlyNonCompleteFamilies();
failureCauseSummaryIsBoundedAndRedacted();

console.log(
    "[blockscan-runtime-startup-warm] strict frozen topology runtime: PASS",
);

function nMinusOneFundingIsCandidateLocal(): void {
  assert.deepEqual(
    blockScanCandidateFundingTokens([
      { flashToken: "0xB" },
      { flashToken: "0xa" },
      { flashToken: "0xb" },
    ]),
    ["0xa", "0xb"],
    "exact funding must be deduplicated from enumerated candidate flash tokens",
  );
}

function familyFailureSummaryNamesOnlyNonCompleteFamilies(): void {
  assert.deepEqual(
    incompleteBlockScanFamilies([
      {
        familyId: "univ2-standard",
        lane: "swap",
        wallMs: 12,
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "complete",
        issueCount: 0,
      },
      {
        familyId: "protocol:fixture",
        lane: "protocol",
        wallMs: 25,
        uniqueStateKeys: 1,
        reads: 1,
        batches: 1,
        status: "incomplete",
        issueCount: 1,
      },
    ]).map((family) => family.familyId),
    ["protocol:fixture"],
  );
}

function failureCauseSummaryIsBoundedAndRedacted(): void {
  const summary = summarizeBlockScanIssueCauses([
    {
      kind: "deadline",
      lane: "swap",
      familyId: "univ3-standard",
      sourceId: "mutation-range",
      stateKey: "state:1",
      message: "header read https://secret.example/v1 timed out",
    },
    {
      kind: "deadline",
      lane: "swap",
      familyId: "univ3-standard",
      sourceId: "mutation-range",
      stateKey: "state:2",
      message: "second deadline",
    },
    {
      kind: "backend",
      lane: "protocol",
      familyId: "protocol:fixture",
      message: "rpc wss://secret.example/ws failed",
    },
  ], {
    families: 1,
    samplesPerKind: 1,
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0]?.familyId, "univ3-standard");
  assert.equal(summary[0]?.issueCount, 2);
  assert.equal(summary[0]?.kinds[0]?.count, 2);
  assert.match(
    summary[0]?.kinds[0]?.samples[0]?.message ?? "",
    /<redacted-url>/,
  );
  assert.doesNotMatch(
    JSON.stringify(summary),
    /secret\.example/,
  );
}

async function productionRuntimeRecordsNonzeroEnumerationAndSolver(): Promise<void> {
  const harness = createHarness(
    100,
    ["complete"],
    {
      startupWarmEnabled: false,
      initialLaneReadyBlock: 165,
      routePipeline: true,
    },
  );
  await harness.run(170);
  assert.equal(harness.solverInvocations, 1);
  assert.equal(harness.routeTelemetryRecords.length, 1);
  const record = harness.routeTelemetryRecords[0]!;
  assert.equal(record.sourceBlock, 170);
  assert.equal(record.enumerationCount, 1);
  assert.equal(record.solverCalls, 1);
  assert.equal(record.finished, true);
  assert.equal(record.pricingMode, "source_n");
  assert.deepEqual(
    record.enumerationRoutes,
    record.solverRoutes,
    "the naturally enumerated production route must be recorded immediately " +
      "before the same route enters solver.solve",
  );
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
  assert.deepEqual(
    harness.pricingLaggingTopologyModes,
    ["startup-bootstrap", "startup-bootstrap", "proof-scoped"],
    "startup retries may bootstrap once; steady-state pricing must be proof-scoped",
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
  await waitFor(() =>
    harness.routeTelemetryRecords.length === 2 &&
    harness.routeTelemetryRecords.every((record) => record.finished)
  );
  assert.deepEqual(
    harness.runtimeBlocks,
    [400, 402],
    "the scheduler must retain only the newest head during startup warm",
  );
  assert.equal(
    harness.routeTelemetryRecords[0]?.passOutcome,
    "startup_warm",
    "a newer head must not abort the active startup warm",
  );
  assert.equal(
    harness.publishedPricing,
    1,
    "the protected startup warm must publish before the latest pending head runs",
  );
  assert.equal(
    harness.loop.isStartupWarmPending(),
    false,
    "the protected startup warm must release the one-time startup barrier",
  );
}

async function sameHeadEvidenceTransactionsRemainFifoAndIsolated(): Promise<void> {
  const sourceBlock = 610;
  const harness = createHarness(
    sourceBlock - 1,
    ["complete", "complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
    },
  );
  const first = pendingEvidenceTrigger(sourceBlock, 0x6101);
  const second = pendingEvidenceTrigger(sourceBlock, 0x6102);

  assert.equal(harness.loop.schedulePendingEvidence(first), true);
  assert.equal(harness.loop.schedulePendingEvidence(second), true);
  await waitFor(() => harness.solverExecutionEvidence.length === 2);

  assert.deepEqual(
    harness.solverExecutionEvidence.map((items) =>
      items.map((item) => ({
        familyId: item.familyId,
        txHash: item.txHash,
      }))
    ),
    [
      [{
        familyId: PENDING_EVIDENCE_FAMILY,
        txHash: first.txHash,
      }],
      [{
        familyId: PENDING_EVIDENCE_FAMILY,
        txHash: second.txHash,
      }],
    ],
    "same-head evidence must remain FIFO and each solver invocation must see " +
      "exactly one immutable transaction context",
  );
  await harness.loop.shutdown();
}

async function exactRefineAndSolverShareOneBoundEvidenceContext(): Promise<void> {
  const sourceBlock = 615;
  const edgeAdapterId = "fixture-current-head-swap";
  const harness = createHarness(
    sourceBlock - 1,
    ["complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      routeEdgeAdapterId: edgeAdapterId,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
    },
  );
  try {
    const trigger = pendingEvidenceTrigger(
      sourceBlock,
      0x6151,
      PENDING_EVIDENCE_FAMILY,
    );
    const expectedEvidence = trigger.evidence[0]!;

    assert.equal(harness.loop.schedulePendingEvidence(trigger), true);
    await waitFor(() => harness.solverExecutionEvidence.length === 1);

    assert(
      harness.exactQuoteRuntimeEvidence.length > 0,
      "the combined pass must issue at least one strict exact quote",
    );
    const solverEvidence = harness.solverExecutionEvidence[0]?.[0];
    assert(solverEvidence, "solver must receive strict runtime evidence");
    for (const observed of harness.exactQuoteRuntimeEvidence) {
      assert.strictEqual(
        observed[0],
        solverEvidence,
        "every exact quote hop must receive the immutable tx/head-bound " +
          "strict evidence object later consumed by solver",
      );
    }
    const recomputedEvidenceHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "bytes32", "uint256", "bytes32", "bytes32"],
        [
          expectedEvidence.familyId,
          trigger.txHash,
          trigger.head.number,
          trigger.head.hash,
          expectedEvidence.payloadHash,
        ],
      ),
    );
    assert.deepEqual(
      {
        familyId: solverEvidence.familyId,
        kind: solverEvidence.kind,
        txHash: solverEvidence.txHash,
        source: solverEvidence.source,
        evidenceHash: solverEvidence.evidenceHash,
        sealedPayloadRef: solverEvidence.sealedPayloadRef,
      },
      {
        familyId: expectedEvidence.familyId,
        kind: PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND,
        txHash: trigger.txHash,
        source: {
          number: trigger.head.number,
          hash: trigger.head.hash,
          generation: 1,
        },
        evidenceHash: recomputedEvidenceHash,
        sealedPayloadRef: expectedEvidence.canonicalPayload,
      },
      "strict runtime evidence must remain bound to the triggering tx/head/payload",
    );
  } finally {
    await harness.loop.shutdown();
  }
}

async function pendingEvidenceCooperativelyInterruptsOrdinaryPass(): Promise<void> {
  const sourceBlock = 620;
  const ordinaryEntered = deferred<void>();
  const ordinaryInterrupted = deferred<void>();
  const harness = createHarness(
    sourceBlock - 1,
    ["complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      beforePrepareResult: async (call, input) => {
        if (call !== 1) return;
        ordinaryEntered.resolve();
        const signal = input.signal;
        assert(signal, "ordinary runtime preparation must receive pass-local cancellation");
        await new Promise<void>((_resolve, reject) => {
          const interrupted = () => {
            ordinaryInterrupted.resolve();
            reject(signal.reason);
          };
          if (signal.aborted) interrupted();
          else signal.addEventListener("abort", interrupted, { once: true });
        });
      },
    },
  );
  harness.loop.schedule(sourceBlock);
  await ordinaryEntered.promise;

  const trigger = pendingEvidenceTrigger(sourceBlock, 0x6201);
  assert.equal(harness.loop.schedulePendingEvidence(trigger), true);
  await ordinaryInterrupted.promise;
  await waitFor(() => harness.solverExecutionEvidence.length === 1);

  assert.equal(
    harness.routeTelemetryRecords[0]?.passReason,
    "pending_evidence_priority",
    "the interrupted ordinary pass must close with a structured priority reason",
  );
  assert.deepEqual(
    harness.solverExecutionEvidence[0]?.map((item) => item.txHash),
    [trigger.txHash],
    "the prioritized combined pass must carry the triggering evidence to solver",
  );
  await harness.loop.shutdown();
}

async function pendingEvidenceInterruptsNonCooperativeAtomicFinalSim(): Promise<void> {
  const sourceBlock = 625;
  const ordinaryAtomicEntered = deferred<void>();
  const ordinaryAtomicAborted = deferred<void>();
  const evidenceAtomicEntered = deferred<void>();
  let atomicCalls = 0;
  let activeAtomicCalls = 0;
  let maxActiveAtomicCalls = 0;
  let ordinaryWorkerReleased = false;
  let evidencePassMode: string | null = null;
  let ordinaryCompletedAtEvidenceAtomic: boolean | null = null;
  let harness!: ReturnType<typeof createHarness>;

  harness = createHarness(
    sourceBlock - 1,
    ["complete", "complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      pendingEvidenceRouteEdgeAdapterId: null,
      solverNetProfit: 1n,
      submitAtomic: async (input) => {
        atomicCalls++;
        activeAtomicCalls++;
        maxActiveAtomicCalls = Math.max(
          maxActiveAtomicCalls,
          activeAtomicCalls,
        );
        if (atomicCalls === 1) {
          ordinaryAtomicEntered.resolve();
          return await new Promise<BlockScanAtomicResult>(
            (_resolve, reject) => {
              let settled = false;
              const abort = () => {
                if (settled) return;
                settled = true;
                activeAtomicCalls--;
                ordinaryWorkerReleased = true;
                ordinaryAtomicAborted.resolve();
                reject(input.signal.reason);
              };
              if (input.signal.aborted) abort();
              else input.signal.addEventListener("abort", abort, { once: true });
            },
          );
        }

        assert.equal(
          ordinaryWorkerReleased,
          true,
          "the ordinary atomic worker must settle before evidence execution starts",
        );
        evidencePassMode = harness.activePassMode;
        ordinaryCompletedAtEvidenceAtomic =
          harness.ordinaryCompleted(sourceBlock);
        evidenceAtomicEntered.resolve();
        activeAtomicCalls--;
        return successfulAtomicResult();
      },
    },
  );
  harness.loop.schedule(sourceBlock);
  await ordinaryAtomicEntered.promise;

  const trigger = pendingEvidenceTrigger(sourceBlock, 0x6251);
  assert.equal(harness.loop.schedulePendingEvidence(trigger), true);
  await ordinaryAtomicAborted.promise;
  await evidenceAtomicEntered.promise;
  await waitFor(() => harness.solverExecutionEvidence.length === 2);

  assert.equal(
    harness.routeTelemetryRecords[0]?.passReason,
    "pending_evidence_priority",
    "an ordinary pass blocked in atomic execution must close as prioritized",
  );
  assert.equal(
    evidencePassMode,
    "combined",
    "aborting ordinary final sim must leave the evidence pass combined",
  );
  assert.equal(
    ordinaryCompletedAtEvidenceAtomic,
    false,
    "an aborted ordinary final sim must not mark the head complete",
  );
  assert.equal(
    maxActiveAtomicCalls,
    1,
    "the same worker must never remain owned by both atomic passes",
  );
  assert.deepEqual(
    harness.solverExecutionEvidence.map((items) =>
      items.map((item) => item.txHash)
    ),
    [[], [trigger.txHash]],
    "the released worker must start a fresh evidence-bound solver pass",
  );
  await harness.loop.shutdown();
}

async function startupWarmRequeuesEvidenceWithinOriginalDeadline(): Promise<void> {
  const sourceBlock = 630;
  const harness = createHarness(
    sourceBlock - 1,
    ["complete", "complete"],
    {
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      passBudgetMs: 2_000,
    },
  );
  const trigger = pendingEvidenceTrigger(sourceBlock, 0x6301);

  assert.equal(harness.loop.schedulePendingEvidence(trigger), true);
  await waitFor(() => harness.solverExecutionEvidence.length === 1);

  assert.equal(harness.loop.isStartupWarmPending(), false);
  assert.deepEqual(
    harness.solverExecutionEvidence[0]?.map((item) => item.txHash),
    [trigger.txHash],
    "startup warm must requeue the same immutable evidence context",
  );
  assert.deepEqual(
    harness.notStartedRecords,
    [],
    "an in-deadline startup requeue must not be reported as dropped",
  );
  await harness.loop.shutdown();
}

async function startupWarmRecordsExpiredEvidenceInsteadOfSilentlyDropping(): Promise<void> {
  const sourceBlock = 640;
  const harness = createHarness(
    sourceBlock - 1,
    ["complete"],
    {
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      passBudgetMs: 10,
      beforePrepareResult: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
      },
    },
  );
  const trigger = pendingEvidenceTrigger(sourceBlock, 0x6401);

  assert.equal(harness.loop.schedulePendingEvidence(trigger), true);
  await waitFor(() =>
    harness.notStartedRecords.some((record) =>
      record.passReason === "pending_evidence_deadline_before_schedule"
    )
  );

  assert.equal(
    harness.solverExecutionEvidence.length,
    0,
    "expired startup evidence must never reach solver",
  );
  assert.deepEqual(
    harness.notStartedRecords.at(-1),
    {
      sourceBlock,
      sourceBlockHash: hash(sourceBlock),
      passReason: "pending_evidence_deadline_before_schedule",
    },
    "deadline expiry after startup warm must be a structured, hash-bound drop",
  );
  await harness.loop.shutdown();
}

async function evidenceReorgKeepsFollowingEvidencePassCombined(): Promise<void> {
  const sourceBlock = 650;
  let observeHeaderCalls = 0;
  let secondPassMode: string | null = null;
  let ordinaryCompletedAtSecondPrepare: boolean | null = null;
  let harness!: ReturnType<typeof createHarness>;
  harness = createHarness(
    sourceBlock - 1,
    ["complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      observeHeader: (blockNumber) => {
        observeHeaderCalls++;
        return {
          number: blockNumber,
          hash: observeHeaderCalls === 1
            ? hash(blockNumber + 1_000)
            : hash(blockNumber),
        };
      },
      beforePrepareResult: async () => {
        secondPassMode = harness.activePassMode;
        ordinaryCompletedAtSecondPrepare =
          harness.ordinaryCompleted(sourceBlock);
      },
    },
  );
  const reorged = pendingEvidenceTrigger(sourceBlock, 0x6501);
  const canonical = pendingEvidenceTrigger(sourceBlock, 0x6502);

  assert.equal(harness.loop.schedulePendingEvidence(reorged), true);
  assert.equal(harness.loop.schedulePendingEvidence(canonical), true);
  await waitFor(() => harness.solverExecutionEvidence.length === 1);

  assert.equal(
    harness.routeTelemetryRecords[0]?.passReason,
    "pending_evidence_head_reorged",
  );
  assert.equal(
    ordinaryCompletedAtSecondPrepare,
    false,
    "a reorged combined pass must not mark ordinary enumeration complete",
  );
  assert.equal(
    secondPassMode,
    "combined",
    "the next same-head evidence transaction must still run a combined pass",
  );
  assert.deepEqual(
    harness.solverExecutionEvidence[0]?.map((item) => item.txHash),
    [canonical.txHash],
    "reorged evidence must not leak into the following canonical context",
  );
  await harness.loop.shutdown();
}

async function unavailableDependenciesDrainEvidenceFifoWithoutLeakingKeys(): Promise<void> {
  const sourceBlock = 655;
  const harness = createHarness(
    sourceBlock - 1,
    ["complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      runtimeDependenciesAvailable: false,
    },
  );
  const first = pendingEvidenceTrigger(sourceBlock, 0x6551);
  const second = pendingEvidenceTrigger(sourceBlock, 0x6552);

  assert.equal(harness.loop.schedulePendingEvidence(first), true);
  assert.equal(harness.loop.schedulePendingEvidence(second), true);
  await waitFor(() =>
    harness.routeTelemetryRecords.filter((record) =>
      record.finished &&
      record.passReason === "runtime_dependencies_unavailable"
    ).length === 2
  );
  assert.deepEqual(
    harness.routeTelemetryRecords.map((record) => record.passReason),
    [
      "runtime_dependencies_unavailable",
      "runtime_dependencies_unavailable",
    ],
    "dependency-unavailable evidence must drain one FIFO context at a time",
  );

  harness.setRuntimeDependenciesAvailable(true);
  assert.equal(
    harness.loop.schedulePendingEvidence(first),
    true,
    "a dropped evidence key must be reusable after structured dispatch cleanup",
  );
  await waitFor(() => harness.solverExecutionEvidence.length === 1);
  assert.deepEqual(
    harness.solverExecutionEvidence[0]?.map((item) => item.txHash),
    [first.txHash],
    "the third dispatch must not be blocked by a leaked key from the first",
  );
  await harness.loop.shutdown();
}

async function sameHeightReorgForcesEvidenceBackToCombinedMode(): Promise<void> {
  const sourceBlock = 660;
  const oldHash = hash(sourceBlock + 10_000);
  const newHash = hash(sourceBlock + 20_000);
  let canonicalHash = oldHash;
  let evidencePassMode: string | null = null;
  let prepareCalls = 0;
  let harness!: ReturnType<typeof createHarness>;
  harness = createHarness(
    sourceBlock - 1,
    ["complete", "complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      observeHeader: (blockNumber) => ({
        number: blockNumber,
        hash: canonicalHash,
      }),
      readBlockHash: () => canonicalHash,
      beforePrepareResult: async () => {
        prepareCalls++;
        if (prepareCalls === 2) {
          evidencePassMode = harness.activePassMode;
        }
      },
    },
  );

  await harness.run(sourceBlock);
  assert.equal(
    harness.ordinaryCompletedHash(sourceBlock),
    oldHash,
    "ordinary completion must retain the canonical hash, not just the height",
  );

  canonicalHash = newHash;
  const evidence = pendingEvidenceTrigger(
    sourceBlock,
    0x6601,
    PENDING_EVIDENCE_FAMILY,
    newHash,
  );
  assert.equal(harness.loop.schedulePendingEvidence(evidence), true);
  await waitFor(() => harness.solverExecutionEvidence.length === 1);

  assert.equal(
    evidencePassMode,
    "combined",
    "same-height evidence on a new canonical hash must rerun ordinary enumeration",
  );
  assert.equal(
    harness.ordinaryCompletedHash(sourceBlock),
    newHash,
    "the completed ordinary marker must advance to the replacement hash",
  );
  assert.deepEqual(
    harness.solverExecutionEvidence.at(-1)?.map((item) => item.txHash),
    [evidence.txHash],
  );
  await harness.loop.shutdown();
}

async function newerEvidenceHeadCancelsBlockedEvidencePass(): Promise<void> {
  const oldHead = 670;
  const entered = deferred<void>();
  const interrupted = deferred<void>();
  const harness = createHarness(
    oldHead - 1,
    ["complete", "complete"],
    {
      startupWarmEnabled: false,
      routePipeline: true,
      pendingEvidenceFamilyId: PENDING_EVIDENCE_FAMILY,
      beforePrepareResult: async (call, input) => {
        if (call !== 1) return;
        entered.resolve();
        const signal = input.signal;
        assert(signal, "the old evidence pass must receive a cancellation signal");
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            interrupted.resolve();
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    },
  );
  const oldEvidence = pendingEvidenceTrigger(oldHead, 0x6701);
  const newEvidence = pendingEvidenceTrigger(oldHead + 1, 0x6711);

  assert.equal(harness.loop.schedulePendingEvidence(oldEvidence), true);
  await entered.promise;
  assert.equal(
    harness.loop.schedulePendingEvidence(newEvidence),
    true,
    "the evidence API itself must admit the advancing head",
  );
  await interrupted.promise;
  await waitFor(() => harness.solverExecutionEvidence.length === 1);

  assert.equal(
    harness.routeTelemetryRecords[0]?.passReason,
    "source_head_superseded",
    "advancing evidence must cooperatively cancel the blocked older pass",
  );
  assert.deepEqual(
    harness.solverExecutionEvidence[0]?.map((item) => item.txHash),
    [newEvidence.txHash],
    "only the newest evidence head may reach solver",
  );
  await harness.loop.shutdown();
}

async function workerForkReceivesPassCancellationControl(): Promise<void> {
  const sourceBlock = 680;
  let expectedSignal: AbortSignal | undefined;
  let expectedDeadlineAtMs: number | undefined;
  const harness = createHarness(
    sourceBlock - 1,
    ["complete"],
    {
      startupWarmEnabled: false,
      beforePrepareResult: async (_call, input) => {
        expectedSignal = input.signal;
        expectedDeadlineAtMs = input.preparationSettleDeadlineAtMs;
      },
    },
  );

  await harness.run(sourceBlock);
  assert.equal(harness.forkAtControls.length, 1);
  assert.strictEqual(
    harness.forkAtControls[0]?.signal,
    expectedSignal,
    "worker reset must receive the exact pass-local cancellation signal",
  );
  assert.equal(
    harness.forkAtControls[0]?.deadlineAtMs,
    expectedDeadlineAtMs,
    "worker reset must receive the pass preparation deadline",
  );
  assert(
    typeof expectedDeadlineAtMs === "number" &&
      Number.isFinite(expectedDeadlineAtMs),
    "worker reset deadline must be finite",
  );
  await harness.loop.shutdown();
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
    state.dexGraphCoverage.sourceCompleteThrough,
    650,
    "ordinary live admission follows canonical source coverage",
  );
  assert.equal(
    state.dexGraphCoverage.graphCompleteThrough,
    649,
    "blind/audit admission remains pinned to executable graph coverage",
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

async function nMinusOneTrackerStaysOutsideNormalRuntimePublication(): Promise<void> {
  const harness = createHarness(699, ["complete"], {
    nMinusOneFallbackEnabled: true,
  });
  await harness.run(700);
  assert.equal(harness.publishedPricing, 1);
  const startupDiscoveryPrepareCount =
    harness.discoveryPrepareBases.length;
  await harness.run(701);
  await waitFor(() => harness.coarsePricingBlocks.includes(701));
  await harness.run(702);
  await waitFor(() => harness.coarsePricingBlocks.includes(702));
  assert.deepEqual(
    harness.runtimeBlocks,
    [700],
    "fallback heads must not invoke or publish a mixed-source normal runtime",
  );
  assert.deepEqual(harness.coarsePricingBlocks, [701, 702]);
  assert.deepEqual(
    harness.exactContextBlocks,
    [],
    "zero-candidate heads must not acquire unused funding/execution state",
  );
  assert.equal(
    harness.discoveryPrepareBases.length,
    startupDiscoveryPrepareCount,
    "N-1 consumers must not run synchronous current-head discovery",
  );
  assert.ok(
    harness.coarsePricingDeadlineRemainingMs.every(
      (remainingMs) => remainingMs > 19_000 && remainingMs <= 20_000,
    ),
    "each queued predecessor must receive a fresh independent 20s budget",
  );
  assert.ok(
    harness.coarsePricingFamilyDeadlineRemainingMs.every(
      (remainingMs) =>
        remainingMs > 0 &&
        remainingMs <= N_MINUS_ONE_FAMILY_SETTLE_BUDGET_MS,
    ),
    "the background producer must cap family work before partial publication",
  );
  assert.ok(
    harness.coarsePricingDeadlineRemainingMs.every(
      (remainingMs, index) =>
        remainingMs -
          harness.coarsePricingFamilyDeadlineRemainingMs[index]! >
        PUBLICATION_RESERVE_MS,
    ),
    "the background producer must leave a real abort-drain and CAS window",
  );
  assert.equal(harness.publishedPricing, 1);
  assert.deepEqual(
    harness.routeTelemetryRecords
      .filter((record) => record.sourceBlock >= 701)
      .map((record) => ({
        sourceBlock: record.sourceBlock,
        enumerationCalls: record.enumerationCalls,
        enumerationCount: record.enumerationCount,
        solverCalls: record.solverCalls,
        finished: record.finished,
        pricingMode: record.pricingMode,
      })),
    [
      {
        sourceBlock: 701,
        enumerationCalls: 1,
        enumerationCount: 0,
        solverCalls: 0,
        finished: true,
        pricingMode: "n_minus_one_coarse_current_n_exact",
      },
      {
        sourceBlock: 702,
        enumerationCalls: 1,
        enumerationCount: 0,
        solverCalls: 0,
        finished: true,
        pricingMode: "n_minus_one_coarse_current_n_exact",
      },
    ],
    "N-1 fallback must publish one Enumeration boundary per consumed head",
  );
}

async function nMinusOneRecoveryBacklogStaysOnHotBudget(): Promise<void> {
  const harness = createHarness(699, ["complete"], {
    nMinusOneFallbackEnabled: true,
    startupWarmBudgetMs: 40_000,
    coarsePricingRecoveryRequiredStateKeys: [2, 0, 0],
  });
  await harness.run(700);
  await harness.run(701);
  await waitFor(() => harness.coarsePricingBlocks.length === 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await harness.run(702);
  await waitFor(() => harness.coarsePricingBlocks.length === 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await harness.run(703);
  await waitFor(() => harness.coarsePricingBlocks.length === 3);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.coarsePricingBlocks, [701, 702, 703]);
  assert.deepEqual(
    harness.coarsePricingLaggingTopologyModes,
    ["proof-scoped", "proof-scoped", "proof-scoped"],
    "a recovery backlog must stay family-local instead of upgrading the next generation",
  );
  assert(
    harness.coarsePricingDeadlineRemainingMs.every(
      (remainingMs) => remainingMs > 19_000 && remainingMs <= 20_000,
    ),
    "periodic recovery must retain the ordinary N-1 state budget",
  );
  assert(
    harness.coarsePricingFamilyDeadlineRemainingMs.every(
      (remainingMs) =>
        remainingMs > 0 &&
        remainingMs <= N_MINUS_ONE_FAMILY_SETTLE_BUDGET_MS,
    ),
    "periodic recovery must retain the ordinary family settle budget",
  );
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
    harness.coarsePricingBlocks.includes(702),
    "the only adjacent completed predecessor must enumerate before N is produced",
  );
  assert.deepEqual(
    harness.exactContextBlocks,
    [],
    "waiting for an adjacent producer must not force an exact join without candidates",
  );
}

async function nMinusOneProducerStartsAtArmTime(): Promise<void> {
  const activity: string[] = [];
  const candidateGate = new NMinusOneProducerGate();
  candidateGate.arm(() => activity.push("producer:start"));
  candidateGate.start();
  assert.equal(
    candidateGate.afterEnumeration(1),
    true,
    "candidate heads must still enter the exact join",
  );
  assert.deepEqual(
    activity.slice(0, 1),
    ["producer:start"],
    "the producer must start as soon as the graph is armed, not after exact work",
  );
  activity.push("exact:start");
  activity.push("pipeline:settled");
  candidateGate.release();
  assert.equal(
    activity.filter((entry) => entry === "producer:start").length,
    1,
    "a finally-bound release after start must not double-start the producer",
  );

  activity.length = 0;
  const emptyGate = new NMinusOneProducerGate();
  emptyGate.arm(() => activity.push("producer:start"));
  emptyGate.start();
  assert.deepEqual(
    activity,
    ["producer:start"],
    "zero-candidate heads start the producer at arm time too",
  );
  assert.equal(
    emptyGate.afterEnumeration(0),
    false,
    "zero-candidate heads must skip exact resources",
  );

  activity.length = 0;
  const failedGate = new NMinusOneProducerGate();
  failedGate.arm(() => activity.push("producer:start"));
  failedGate.start();
  activity.push("pipeline:error");
  assert.equal(
    failedGate.afterEnumeration(1),
    true,
  );
  failedGate.release();
  assert.deepEqual(
    activity,
    ["producer:start", "pipeline:error"],
    "an exception in the exact pipeline must not strand an already-started producer",
  );

  activity.length = 0;
  const preEnumerationAbortGate = new NMinusOneProducerGate();
  preEnumerationAbortGate.arm(() => activity.push("producer:start"));
  preEnumerationAbortGate.start();
  activity.push("pass:superseded-before-enumeration");
  preEnumerationAbortGate.release();
  preEnumerationAbortGate.release();
  assert.deepEqual(
    activity,
    ["producer:start", "pass:superseded-before-enumeration"],
    "a pass cancelled before enumeration must still start its armed producer exactly once",
  );

  assert.equal(
    nMinusOneProducerCanServeLatestHead(700, 700),
    true,
    "the current source producer remains useful before a newer head arrives",
  );
  assert.equal(
    nMinusOneProducerCanServeLatestHead(700, 701),
    true,
    "source N must remain available to serve head N+1",
  );
  assert.equal(
    nMinusOneProducerCanServeLatestHead(700, 702),
    false,
    "source N is obsolete once the latest scheduled head has advanced to N+2",
  );
}

function nMinusOneExactJoinRejectsMixedAnchor(): void {
  const graph = graphAt(7, 900, hash(900));
  const runtime = runtimeResult("complete", graph);
  if (runtime.status === "incomplete") throw new Error("fixture bug");
  const context = {
    generation: graph.generation,
    sourceBlock: graph.sourceBlock,
    sourceBlockHash: graph.sourceBlockHash,
    graph,
    funding: runtime.snapshot.funding,
  };
  assert.doesNotThrow(() => assertExactContextMatchesGraph(context, graph));
  assert.throws(
    () =>
      assertExactContextMatchesGraph(
        { ...context, sourceBlockHash: hash(899) },
        graph,
      ),
    /mixed source block hash/,
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
    readonly beforePrepareResult?: (
      call: number,
      input: PrepareAdapterRuntimeInput,
    ) => Promise<void>;
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
    readonly coarsePricingRecoveryRequiredStateKeys?: readonly number[];
    readonly startupWarmBudgetMs?: number;
    readonly routePipeline?: boolean;
    readonly routeEdgeAdapterId?: string;
    readonly pendingEvidenceFamilyId?: ExecutionFamilyId;
    readonly pendingEvidenceRouteEdgeAdapterId?: string | null;
    readonly solverNetProfit?: bigint;
    readonly submitAtomic?: (
      input: BlockScanAtomicExecutionInput,
    ) => Promise<BlockScanAtomicResult>;
    readonly passBudgetMs?: number;
    readonly runtimeDependenciesAvailable?: boolean;
    readonly observeHeader?: (
      blockNumber: number,
    ) =>
      | { readonly number: number; readonly hash: string }
      | Promise<{ readonly number: number; readonly hash: string }>;
    readonly readBlockHash?: (blockNumber: number) => string;
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
  const pricingLaggingTopologyModes: Array<
    PrepareAdapterRuntimeInput["pricingLaggingTopologyRefreshMode"]
  > = [];
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
  const coarsePricingLaggingTopologyModes:
    BlockScanLaggingTopologyRefreshMode[] = [];
  let coarsePricingCalls = 0;
  const exactContextBlocks: number[] = [];
  const pipelineEdges = options.routePipeline
    ? routePipelineEdges(options.routeEdgeAdapterId)
    : [];
  let solverInvocations = 0;
  const solverExecutionEvidence: Array<readonly RuntimeEvidence[]> = [];
  const exactQuoteRuntimeEvidence: Array<readonly RuntimeEvidence[]> = [];
  const notStartedRecords: Array<{
    readonly sourceBlock: number;
    readonly sourceBlockHash: string | null;
    readonly passReason: string;
  }> = [];
  const routeTelemetryRecords: Array<{
    sourceBlock: number;
    enumerationCalls: number;
    enumerationCount: number;
    solverCalls: number;
    enumerationRoutes: string[];
    solverRoutes: string[];
    finished: boolean;
    pricingMode:
      | "source_n"
      | "n_minus_one_coarse_current_n_exact"
      | null;
    passOutcome: string | null;
    passReason: string | null;
  }> = [];
  let latestPricing: BlockScanStateSnapshot | null = null;
  let producerYieldActive: (() => boolean) | null = null;
  let runtimeDependenciesAvailable =
    options.runtimeDependenciesAvailable ?? true;
  const forkAtControls: Array<{
    readonly signal?: AbortSignal;
    readonly deadlineAtMs?: number;
  }> = [];

  const routeTelemetry: BlockScanEnumerationSolverTelemetrySink = {
    beginPass(sourceBlock) {
      const record: typeof routeTelemetryRecords[number] = {
        sourceBlock,
        enumerationCalls: 0,
        enumerationCount: 0,
        solverCalls: 0,
        enumerationRoutes: [],
        solverRoutes: [],
        finished: false,
        pricingMode: null as
          | "source_n"
          | "n_minus_one_coarse_current_n_exact"
          | null,
        passOutcome: null,
        passReason: null,
      };
      routeTelemetryRecords.push(record);
      return {
        recordEnumeration(opportunities) {
          record.enumerationCalls++;
          record.enumerationCount += opportunities.length;
          record.enumerationRoutes.push(
            ...opportunities.map(telemetryRouteKey),
          );
        },
        recordSolver(opportunity) {
          record.solverCalls++;
          record.solverRoutes.push(telemetryRouteKey(opportunity));
        },
        finish(input) {
          record.finished = true;
          record.pricingMode = input.pricingMode;
          record.passOutcome = input.passOutcome;
          record.passReason = input.passReason;
        },
      };
    },
    recordNotStarted(input) {
      notStartedRecords.push({
        sourceBlock: input.sourceBlock,
        sourceBlockHash: input.sourceBlockHash,
        passReason: input.passReason,
      });
    },
  };

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
      pricingLaggingTopologyModes.push(
        input.pricingLaggingTopologyRefreshMode,
      );
      await options.beforePrepareResult?.(call, input);
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
        options.routePipeline === true,
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
      readonly laggingTopologyRefreshMode?:
        BlockScanLaggingTopologyRefreshMode;
    }): Promise<BlockScanStatePrepareResult> {
      const coarsePricingCall = coarsePricingCalls++;
      coarsePricingBlocks.push(input.graph.sourceBlock);
      coarsePricingLaggingTopologyModes.push(
        input.laggingTopologyRefreshMode ?? "proof-scoped",
      );
      coarsePricingDeadlineRemainingMs.push(input.deadlineAtMs - Date.now());
      coarsePricingFamilyDeadlineRemainingMs.push(
        (input.familySettleDeadlineAtMs ?? input.deadlineAtMs) - Date.now(),
      );
      await options.beforeCoarsePricingResult?.(input.graph.sourceBlock);
      const prepared = runtimeResult(
        "complete",
        input.graph,
        options.routePipeline === true,
      );
      if (prepared.status === "incomplete") throw new Error("fixture bug");
      latestPricing = prepared.snapshot.pricing;
      const recoveryRequiredStateKeys =
        options.coarsePricingRecoveryRequiredStateKeys?.[
          coarsePricingCall
        ] ?? 0;
      return Object.freeze({
        ...prepared.pricing,
        familyTelemetry: Object.freeze([Object.freeze({
          familyId: "univ2-standard",
          lane: "swap" as const,
          wallMs: 1,
          uniqueStateKeys: 2,
          reads: 0,
          batches: 0,
          status: recoveryRequiredStateKeys > 0
            ? "degraded" as const
            : "complete" as const,
          issueCount: recoveryRequiredStateKeys > 0 ? 1 : 0,
          recoveryRequiredStateKeys,
        })]),
      });
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
  } as unknown as CurrentSourceRuntimeCoordinator;

  const blockScanPlanner = {
    setFlashLiquidity() {},
    setGraph() {
      plannerGraphCalls++;
    },
    async planBlockScanFromSeedEdges() {
      return options.routePipeline ? [{}] : [];
    },
  };
  const workerState = {
    provider: {},
    async forkAt(
      _blockNumber: number,
      control?: {
        readonly signal?: AbortSignal;
        readonly deadlineAtMs?: number;
      },
    ) {
      forkAtControls.push(Object.freeze({ ...control }));
    },
    async call(req: { readonly to: string; readonly data: string }) {
      if (!options.routePipeline) {
        throw new Error("empty startup harness unexpectedly quoted a route");
      }
      const selector = req.data.slice(0, 10);
      if (selector === routePairInterface.getFunction("token0")!.selector) {
        return routePairInterface.encodeFunctionResult(
          "token0",
          [ROUTE_TOKEN_A],
        );
      }
      if (selector === routePairInterface.getFunction("factory")!.selector) {
        return routePairInterface.encodeFunctionResult(
          "factory",
          [ROUTE_V2_FACTORY],
        );
      }
      if (selector === routePairInterface.getFunction("getReserves")!.selector) {
        const rich = req.to.toLowerCase() === ROUTE_POOL_CHEAP;
        return routePairInterface.encodeFunctionResult(
          "getReserves",
          rich
            ? [1_000_000_000_000_000_000n, 2_000_000_000_000_000_000n, 0]
            : [2_000_000_000_000_000_000n, 2_000_000_000_000_000_000n, 0],
        );
      }
      throw new Error(`unexpected route fixture selector ${selector}`);
    },
    stop() {
      workerStops++;
    },
    async stopAndWait() {},
  };
  const workerSolver = {
    async solve(
      _plan: unknown,
      _state: unknown,
      _simulator: unknown,
      solveOptions?: {
        readonly runtimeEvidence?: readonly RuntimeEvidence[];
      },
    ) {
      solverInvocations++;
      solverExecutionEvidence.push(Object.freeze([
        ...(solveOptions?.runtimeEvidence ?? []),
      ]));
      return resolvedPlan(options.solverNetProfit ?? 0n);
    },
  };
  const deps: BlockScanRuntimeLoopDependencies = {
    enabled: true,
    blockScanConfig: {
      maxHops: 3,
      minSpreadBps: 0,
      maxCandidates: 1,
      budgetMs: options.routePipeline ? 1_000 : 1,
      pricedTokens: options.routePipeline
        ? new Map([[ROUTE_TOKEN_A, {
            maxBorrow: 1_000_000_000_000_000_000n,
          }]])
        : new Map(),
    },
    executionWorkers: ([{
      state: workerState,
      solver: workerSolver,
      simulator: {},
    }] as unknown) as BlockScanRuntimeLoopDependencies["executionWorkers"],
    finalSimulationWorkers: ([{
      state: {
        provider: {},
        async forkAt() {},
        stop() {},
        async stopAndWait() {},
      },
      solver: workerSolver,
      simulator: {},
    }] as unknown) as BlockScanRuntimeLoopDependencies["finalSimulationWorkers"],
    rpcUrl: "http://127.0.0.1:8545",
    strictSession: async (source) =>
      strictRouteSession(
        source,
        pipelineEdges,
        (runtimeEvidence) => exactQuoteRuntimeEvidence.push(runtimeEvidence),
      ),
    exactQuoteStateFactory: () => workerState as never,
    runtimeAbort,
    executorAddress: "0x0000000000000000000000000000000000000001",
    sharedPlanner: { setFlashLiquidity() {} },
    backrunStatePublisher: {
      publish() {
        publishedPricing++;
        return {};
      },
    },
    frozenTopology: {
      topologyKey: "strict-ready:fixture",
      observeHeader: async (blockNumber: number) => {
        const observed = await options.observeHeader?.(blockNumber) ??
          header(blockNumber);
        return Object.freeze({
          ...observed,
          parentHash: "parentHash" in observed
            ? String(observed.parentHash)
            : hash(Math.max(0, blockNumber - 1)),
        });
      },
    },
    blind: {
      enabled: options.blindEnabled ?? false,
      activeSource: () => null,
      preparedBase: () => null,
      preparedArtifacts: () => null,
      dynamicResetNonce: () => null,
    },
    routeTelemetry,
    largeGraphEdgeThreshold: 20_000,
    largeGraphPassBudgetMs: 30_000,
    passBudgetMs: options.passBudgetMs ??
      (options.routePipeline ? 2_000 : HOT_BUDGET_MS),
    startupWarmEnabled:
      (options.startupWarmEnabled ?? true) &&
      !(options.blindEnabled ?? false),
    startupWarmBudgetMs:
      options.startupWarmBudgetMs ?? STARTUP_BUDGET_MS,
    nMinusOneFallbackEnabled: options.nMinusOneFallbackEnabled,
    nMinusOneFamilySettleBudgetMs:
      N_MINUS_ONE_FAMILY_SETTLE_BUDGET_MS,
    hotPricingFamilyBudgetMs: HOT_FAMILY_BUDGET_MS,
    runtimePublicationReserveMs: PUBLICATION_RESERVE_MS,
    refineCandidates: 1,
    solveReserveMs: 0,
    midConcurrency: 1,
    currentHeadEvidenceFamilyForEdge: (edgeAdapterId) => {
      const evidenceRouteEdgeAdapterId =
        options.pendingEvidenceRouteEdgeAdapterId === undefined
          ? options.routeEdgeAdapterId ?? "univ2-swap"
          : options.pendingEvidenceRouteEdgeAdapterId;
      return options.pendingEvidenceFamilyId &&
          evidenceRouteEdgeAdapterId !== null &&
          edgeAdapterId === evidenceRouteEdgeAdapterId
        ? options.pendingEvidenceFamilyId
        : null;
    },
    currentHeadEvidenceScopeKeyForEdge: (edge) => {
      const evidenceRouteEdgeAdapterId =
        options.pendingEvidenceRouteEdgeAdapterId === undefined
          ? options.routeEdgeAdapterId ?? "univ2-swap"
          : options.pendingEvidenceRouteEdgeAdapterId;
      return options.pendingEvidenceFamilyId &&
          evidenceRouteEdgeAdapterId !== null &&
          edge.adapterId === evidenceRouteEdgeAdapterId
        ? "fixture-family-scope"
        : null;
    },
    currentHeadEvidenceScopeKeys: (evidence) =>
      evidence.familyId === options.pendingEvidenceFamilyId
        ? Object.freeze(["fixture-family-scope"])
        : Object.freeze([]),
    isCurrentHeadEvidenceFamily: (familyId) =>
      familyId === options.pendingEvidenceFamilyId,
    isShuttingDown: () => shuttingDown,
    blockScanGraph: () =>
      runtimeDependenciesAvailable ? pipelineEdges : undefined,
    blockScanPlanner: () =>
      blockScanPlanner as unknown as BlockScanRuntimeLoopDependencies["blockScanPlanner"] extends () => infer T ? T : never,
    currentRuntimeCoordinator: () => runtimeCoordinator,
    flashTokens: () => [],
    buildGraphView: (input) => graphAt(
      input.generation,
      input.sourceBlock,
      input.sourceBlockHash,
      pipelineEdges,
    ),
    readBlockHash: async (_provider, blockNumber) =>
      options.readBlockHash?.(blockNumber) ?? hash(blockNumber),
    formatRouteKey: () => "fixture-route",
    formatRing: () => "fixture-ring",
    isRouteBlacklisted: () => false,
    submitAtomic: options.submitAtomic ??
      (async () => {
        throw new Error("startup warm unexpectedly reached final simulation");
      }),
  };
  const loop = new BlockScanRuntimeLoop(deps);

  return {
    loop,
    runtimeBlocks,
    deadlineRemainingMs,
    preparationSettleRemainingMs,
    pricingSettleRemainingMs,
    pricingLaggingTopologyModes,
    backfillBlocks,
    get publishedPricing() {
      return publishedPricing;
    },
    producerYieldActive() {
      return false;
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
    coarsePricingLaggingTopologyModes,
    exactContextBlocks,
    get solverInvocations() {
      return solverInvocations;
    },
    solverExecutionEvidence,
    exactQuoteRuntimeEvidence,
    forkAtControls,
    notStartedRecords,
    routeTelemetryRecords,
    get activePassMode(): string | null {
      return (
        loop as unknown as {
          readonly activePass: { readonly mode: string } | null;
        }
      ).activePass?.mode ?? null;
    },
    ordinaryCompletedHash(blockNumber: number): string | undefined {
      return (
        loop as unknown as {
          readonly completedOrdinaryHeads: ReadonlyMap<number, string>;
        }
      ).completedOrdinaryHeads.get(blockNumber);
    },
    ordinaryCompleted(blockNumber: number): boolean {
      return this.ordinaryCompletedHash(blockNumber) !== undefined;
    },
    get publication() {
      return cloneLiveDiscoveryPublicationState(publication);
    },
    setPublication(block: number) {
      publication = publicationAt(block, publication.revision + 1);
    },
    setRuntimeDependenciesAvailable(available: boolean) {
      runtimeDependenciesAvailable = available;
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
  routePipeline = false,
): AdapterRuntimePrepareResult {
  const edgeKeys = routePipeline
    ? graph.edges.map(blockScanEdgeKey)
    : [];
  const edgeHash = exactSetHash(edgeKeys);
  const coverage = {
    expectedStateKeys: [],
    resolvedStateKeys: [],
    unresolvedStateKeys: [],
    expectedReadKeys: [],
    resolvedReadKeys: [],
    unresolvedReadKeys: [],
    expectedEdgeKeys: edgeKeys,
    resolvedEdgeKeys: edgeKeys,
    unavailableEdgeKeys: [],
    unresolvedEdgeKeys: [],
    expectedStateKeyHash: EMPTY_HASH,
    resolvedStateKeyHash: EMPTY_HASH,
    unresolvedStateKeyHash: EMPTY_HASH,
    expectedReadKeyHash: EMPTY_HASH,
    resolvedReadKeyHash: EMPTY_HASH,
    unresolvedReadKeyHash: EMPTY_HASH,
    expectedEdgeKeyHash: edgeHash,
    resolvedEdgeKeyHash: edgeHash,
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
      mids: routePipelineMids(graph.edges),
      coverageByReadKey: new Map(),
      coverageByEdgeKey: new Map(
        edgeKeys.map((edgeKey) => [edgeKey, { status: "resolved" as const }]),
      ),
      freshnessByReadKey: new Map(),
      stateByStateKey: new Map(),
      resolvedFamilyIds: routePipeline ? ["univ2-swap"] : [],
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
  edges: readonly TokenEdge[] = [],
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
    edges,
  });
}

function routePipelineEdges(
  edgeAdapterId = "univ2-swap",
): TokenEdge[] {
  return [ROUTE_POOL_CHEAP, ROUTE_POOL_RICH].flatMap((target) => [
    {
      adapterId: edgeAdapterId,
      target,
      tokenIn: ROUTE_TOKEN_A,
      tokenOut: ROUTE_TOKEN_B,
      poolToken0: ROUTE_TOKEN_A,
      poolToken1: ROUTE_TOKEN_B,
      v2FeeBps: 30n,
      slotKind: "swap" as const,
      ...deriveEdgeTaxonomy("swap"),
    },
    {
      adapterId: edgeAdapterId,
      target,
      tokenIn: ROUTE_TOKEN_B,
      tokenOut: ROUTE_TOKEN_A,
      poolToken0: ROUTE_TOKEN_A,
      poolToken1: ROUTE_TOKEN_B,
      v2FeeBps: 30n,
      slotKind: "swap" as const,
      ...deriveEdgeTaxonomy("swap"),
    },
  ]);
}

function routePipelineMids(
  edges: readonly TokenEdge[],
): Map<string, RouteVenueMid> {
  return new Map(edges.map((edge) => {
    const cheap = edge.target.toLowerCase() === ROUTE_POOL_CHEAP;
    const forward =
      edge.tokenIn.toLowerCase() === ROUTE_TOKEN_A;
    const mid = cheap
      ? (forward ? 2 : 0.5)
      : 1;
    return [blockScanEdgeKey(edge), {
      kind: "v2",
      pool: edge.target.toLowerCase(),
      edges: [edge],
      mid,
      feeBps: 30,
      reserveA: 1_000_000_000_000_000_000n,
      reserveB: 2_000_000_000_000_000_000n,
      depthProxy: 1e18,
    }];
  }));
}

/**
 * Minimal issuer-shaped fixture for the route pipeline. Exact results are
 * minted by the same source-bound session passed through refinement and the
 * solver; the harness deliberately provides no registry or legacy quote
 * fallback.
 */
function strictRouteSession(
  source: StrictProductionRuntimeSession["source"],
  edges: readonly TokenEdge[],
  onIssueExact: (runtimeEvidence: readonly RuntimeEvidence[]) => void,
): StrictProductionRuntimeSession {
  const ownedEdges = new Set(edges.map(strictFixtureEdgeIdentity));
  return Object.freeze({
    source: Object.freeze({ ...source }),
    edges: Object.freeze([...edges]),
    runtimeEvidenceFromPendingExecution(
      evidence: readonly PendingExecutionEvidence[],
    ): readonly RuntimeEvidence[] {
      return Object.freeze(evidence.map((item) => {
        assert.equal(item.headBlockNumber, source.number);
        assert.equal(item.headHash.toLowerCase(), source.hash.toLowerCase());
        return Object.freeze({
          evidenceId: `pending:${item.txHash.toLowerCase()}`,
          familyId: item.familyId as RuntimeEvidence["familyId"],
          kind: PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND,
          scope: "transaction" as const,
          source,
          txHash: item.txHash.toLowerCase(),
          evidenceHash: item.evidenceHash.toLowerCase(),
          sealedPayloadRef: item.canonicalPayload,
        });
      }));
    },
    async issueExact(
      input: Parameters<StrictProductionRuntimeSession["issueExact"]>[0],
    ) {
      assert.equal(
        ownedEdges.has(strictFixtureEdgeIdentity(input.edge)),
        true,
        "strict fixture must issue exact authority only for its own Graph edge",
      );
      onIssueExact(input.runtimeEvidence);
      const cheap = input.edge.target.toLowerCase() === ROUTE_POOL_CHEAP;
      const forward = input.edge.tokenIn.toLowerCase() === ROUTE_TOKEN_A;
      const amountOut = cheap
        ? (forward ? input.amountIn * 2n : input.amountIn / 2n)
        : input.amountIn;
      return Object.freeze({ amountOut });
    },
  }) as unknown as StrictProductionRuntimeSession;
}

function strictFixtureEdgeIdentity(edge: TokenEdge): string {
  return [
    edge.adapterId,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.slotKind,
  ].join("\u001f");
}

function telemetryRouteKey(opportunity: {
  readonly seedEdges: readonly TokenEdge[];
}): string {
  return opportunity.seedEdges.map(blockScanEdgeKey).join(">");
}

function pendingEvidenceTrigger(
  sourceBlock: number,
  txSeed: number,
  familyId: ExecutionFamilyId = PENDING_EVIDENCE_FAMILY,
  headHash: string = hash(sourceBlock),
): BlockScanPendingEvidenceTrigger {
  const txHash = hash(txSeed);
  const sourceHash = headHash;
  const canonicalPayload = ethers.toBeHex(txSeed, 32);
  const payloadHash = ethers.keccak256(canonicalPayload);
  const evidenceHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "bytes32", "uint256", "bytes32", "bytes32"],
      [
        familyId,
        txHash,
        sourceBlock,
        sourceHash,
        payloadHash,
      ],
    ),
  );
  const observedAtMs = Date.now();
  const observedAtMonotonicMs = performance.now();
  const evidence: PendingExecutionEvidence = Object.freeze({
    familyId,
    txHash,
    headBlockNumber: sourceBlock,
    headHash: sourceHash,
    canonicalPayload,
    payloadHash,
    evidenceHash,
  });
  return Object.freeze({
    txHash,
    head: Object.freeze({
      number: sourceBlock,
      hash: sourceHash,
    }),
    observedAtMs,
    observedAtMonotonicMs,
    evidenceReadyAtMs: observedAtMs,
    evidenceReadyAtMonotonicMs: observedAtMonotonicMs,
    evidence: Object.freeze([evidence]),
  });
}

function successfulAtomicResult(): BlockScanAtomicResult {
  return {
    decision: "fixture_complete",
    submitted: false,
    terminalForQuoteSet: true,
    finalSimStatus: "succeeded",
    audit: null,
    timing: {
      finalSimMs: 0,
      evMs: 0,
      finalSimStartedAtMs: null,
      finalSimFinishedAtMs: null,
      evStartedAtMs: null,
      evFinishedAtMs: null,
    },
  };
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
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

function anchor(block: number): DiscoveryCoverageAnchor {
  return {
    completeThroughBlock: block,
    completeThroughHash: hash(block),
  };
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
