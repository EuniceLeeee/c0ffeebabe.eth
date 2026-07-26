import { AnvilStateBackend } from "../shared/state/state-backend.js";
import type { BlockScanOpportunity } from "./detector/detector.js";
import { detectProductionBlockScanOpportunities } from "./detector/blockscan-scanner-production.js";
import type { BlockScanCoreConfig } from "./detector/blockscan-scanner-core.js";
import { refineBlockScanCandidates } from "./detector/blockscan-candidate-refinement.js";
import { BlockScanFamilyStageBudget } from "./detector/blockscan-family-budget.js";
import { BlockScanPassTimeline } from "./blockscan-pass-timeline.js";
import { emitEvent } from "./events.js";
import type { CandidatePlan, TemplatePlanner } from "./planner/planner.js";
import type { TokenEdge } from "./planner/token-graph.js";
import type { ResolvedPlan } from "./solver/solver.js";
import type { AnvilSolver } from "./solver/solver.js";
import { BotVMSimulator } from "./simulator/botvm-simulator.js";
import { FLASH_SWAP_REPAY } from "./templates/path-template.js";
import {
  AdapterRuntimeCoordinator,
  type AdapterRuntimeSnapshot,
} from "./adapter-runtime-coordinator.js";
import type {
  BufferedBlockScanBackrunStatePublisher,
} from "./blockscan-backrun-state-bridge.js";
import {
  LatestHeadScheduler,
  type LatestHeadObservation,
} from "./latest-head-scheduler.js";
import {
  type DiscoveryBackfillControl,
  DiscoveryBackfillLane,
} from "./discovery-backfill-lane.js";
import { CanonicalHeaderJournal, type CanonicalHeader } from "./canonical-header-journal.js";
import {
  describeLiveDiscoveryPublicationState,
  type LiveDiscoveryPublicationState,
} from "./live-discovery-publication.js";
import { ProtocolDiscoveryMutationQueue } from "./protocol-discovery-coordinator.js";
import type { LandedPoolDiscoveryCoverage } from "./venues/landed-pool-discovery.js";
import type { VerifiedGraphView } from "./venues/blockscan-state-capability.js";
import {
  blindCompatibilityCanonicalEdgeId,
  blindCompatibilityRouteStep,
} from "./blind-production-compatibility.js";
import {
  BLIND_PRODUCTION_RAW_PREFIX,
  blindProductionAuditHash,
  blindProductionCalldataSha256,
  blindProductionCanonicalJson,
  type BlindProductionOpportunityEvidence,
  type BlindProductionPrepareControl,
  type BlindProductionSourceHeadControl,
  type BlindProductionStageEvidence,
  type BlindProductionStageName,
  type BlindProductionStageSealInput,
} from "./blind-production-audit.js";
import {
  blindProductionArtifactReceipt,
  createBlindProductionArtifact,
  type BlindProductionArtifact,
} from "./blind-production-artifacts.js";
import {
  appendBlindProductionStageEvidence,
  blindGraphArtifactPayload,
  completeBlindProductionStageEvidence,
  createBlindProductionSemanticEvidence,
  createBlindProductionPassRecord,
  type BlindProductionPricingCoverageSource,
  type PreparedBlindProductionArtifacts,
} from "./blind-production-runtime.js";
import { hashTokenGraph } from "./strategy-views.js";

const EMPTY_BLIND_PRICING_COVERAGE: BlindProductionPricingCoverageSource =
  Object.freeze({
    expectedStateKeys: Object.freeze([]),
    resolvedStateKeys: Object.freeze([]),
    expectedEdgeKeys: Object.freeze([]),
    resolvedEdgeKeys: Object.freeze([]),
  });

export interface BlockScanRejectBlacklistEntry {
  strikes: number;
  expiryBlock: number | null;
}

export interface BlockScanRejectBlacklistState {
  enabled: boolean;
  after: number;
  ttlBlocks: number;
  entries: Map<string, BlockScanRejectBlacklistEntry>;
}

export interface BlockScanAtomicResult {
  decision: string;
  submitted: boolean;
  /** False only when another quote-ranked amount should still be tried. */
  terminalForQuoteSet: boolean;
  finalSimStatus: "not-run" | "succeeded" | "failed";
  /** False when a timed-out final sim forced this Anvil worker to be reaped. */
  workerReusable: boolean;
  audit: Pick<BlindProductionOpportunityEvidence, "simulation" | "ev"> | null;
  timing: {
    finalSimMs: number;
    evMs: number;
    finalSimStartedAtMs: number | null;
    finalSimFinishedAtMs: number | null;
    evStartedAtMs: number | null;
    evFinishedAtMs: number | null;
  };
}

export interface BlockScanExecutionWorker {
  readonly state: AnvilStateBackend;
  readonly solver: AnvilSolver;
  readonly simulator: BotVMSimulator;
}

export interface BlockScanAtomicExecutionInput {
  readonly simulator: BotVMSimulator;
  readonly state: AnvilStateBackend;
  readonly opp: BlockScanOpportunity;
  readonly resolved: ResolvedPlan;
  readonly sourceBlock: number;
  readonly ring: string;
  readonly protoRing: boolean;
  readonly plans: number;
  readonly passDeadlineAtMs: number;
  readonly sourceBlockHash: string;
}

interface PlannedBlockScanSolve {
  opp: BlockScanOpportunity;
  ring: string;
  protoRing: boolean;
  plan: CandidatePlan;
  planCount: number;
}

interface BlockScanDiscoveryDependencies<PreparedDiscovery> {
  readonly lane: DiscoveryBackfillLane<
    LiveDiscoveryPublicationState,
    PreparedDiscovery
  >;
  readonly journal: CanonicalHeaderJournal;
  readonly queue: ProtocolDiscoveryMutationQueue;
  observeHeader(blockNumber: number): Promise<CanonicalHeader>;
  capture(): LiveDiscoveryPublicationState;
  publish(state: LiveDiscoveryPublicationState): void;
  finishPublished(): void;
  scheduleBackfill(blockNumber: number): void | Promise<void>;
  prepare(
    base: LiveDiscoveryPublicationState,
    input: {
      readonly source: { readonly number: number; readonly hash: string };
      readonly through: number;
      readonly control?: DiscoveryBackfillControl;
    },
  ): Promise<PreparedDiscovery>;
  validate(
    base: LiveDiscoveryPublicationState,
    prepared: PreparedDiscovery,
  ): LiveDiscoveryPublicationState;
  finish(prepared: PreparedDiscovery): void;
}

interface BlockScanBlindDependencies {
  readonly enabled: boolean;
  activeSource(): BlindProductionSourceHeadControl | null;
  preparedBase(): BlindProductionPrepareControl | null;
  preparedArtifacts(): PreparedBlindProductionArtifacts | null;
  dynamicResetNonce(): string | null;
}

export interface BlockScanRuntimeLoopDependencies<PreparedDiscovery> {
  readonly enabled: boolean;
  readonly blockScanConfig: BlockScanCoreConfig | undefined;
  readonly executionWorkers: readonly BlockScanExecutionWorker[];
  readonly runtimeAbort: AbortController;
  readonly sharedPlanner: Pick<TemplatePlanner, "setFlashLiquidity">;
  readonly backrunStatePublisher: Pick<
    BufferedBlockScanBackrunStatePublisher,
    "publish"
  >;
  readonly discovery: BlockScanDiscoveryDependencies<PreparedDiscovery>;
  readonly blind: BlockScanBlindDependencies;
  readonly largeGraphEdgeThreshold: number;
  readonly largeGraphPassBudgetMs: number;
  readonly passBudgetMs: number;
  /** Explicitly enabled only by the ordinary live runtime. */
  readonly startupWarmEnabled: boolean;
  /** One-time ordinary-live budget for the first current-head runtime snapshot. */
  readonly startupWarmBudgetMs: number;
  readonly refineCandidates: number;
  readonly solveReserveMs: number;
  readonly midConcurrency: number;
  isShuttingDown(): boolean;
  blockScanGraph(): readonly TokenEdge[] | undefined;
  blockScanPlanner(): TemplatePlanner | undefined;
  adapterRuntimeCoordinator(): AdapterRuntimeCoordinator | undefined;
  flashTokens(): readonly string[];
  buildGraphView(input: {
    readonly id: string;
    readonly generation: number;
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly edges: readonly TokenEdge[];
    readonly landedCoverage: readonly LandedPoolDiscoveryCoverage[];
  }): VerifiedGraphView;
  readBlockHash(
    provider: AnvilStateBackend["provider"],
    blockNumber: number,
  ): Promise<string>;
  formatRouteKey(opportunity: Pick<BlockScanOpportunity, "seedEdges">): string;
  formatRing(
    opportunity: Pick<BlockScanOpportunity, "seedEdges" | "affectedTokens">,
  ): string;
  isRouteBlacklisted(routeKey: string, currentBlock: number): boolean;
  submitAtomic(input: BlockScanAtomicExecutionInput): Promise<BlockScanAtomicResult>;
}

/**
 * Owns the one-at-a-time current-head block-scan pass. Main constructs the
 * dependencies and keeps discovery/blind state ownership; this loop owns only
 * scheduling, worker orchestration and the unchanged stage sequence.
 */
export class BlockScanRuntimeLoop<PreparedDiscovery> {
  private generation = 0;
  private startupWarmPending: boolean;
  private readonly scheduler: LatestHeadScheduler;

  constructor(
    private readonly deps: BlockScanRuntimeLoopDependencies<PreparedDiscovery>,
  ) {
    this.startupWarmPending =
      deps.startupWarmEnabled && !deps.blind.enabled;
    this.scheduler = new LatestHeadScheduler(
      this.runHead,
      (blockNumber, error) => {
        console.log(
          `[searcher/blockscan-family] block=${blockNumber} error=` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  schedule(
    blockNumber: number,
    observation?: LatestHeadObservation,
  ): void {
    this.scheduler.schedule(blockNumber, observation);
  }

  nextGeneration(): number {
    return ++this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  isStartupWarmPending(): boolean {
    return this.startupWarmPending;
  }

  stopExecutionWorkers(): void {
    if (!this.deps.runtimeAbort.signal.aborted) {
      this.deps.runtimeAbort.abort(new Error("searcher shutdown"));
    }
    for (const worker of this.deps.executionWorkers) worker.state.stop();
  }

  async shutdown(): Promise<void> {
    // scheduler.shutdown() synchronously closes admission and drops the pending
    // head before yielding on the active pass. Abort its I/O, then drain it so
    // the caller can flush persistence only after publication has quiesced.
    const drained = this.scheduler.shutdown();
    let stopError: unknown;
    try {
      this.stopExecutionWorkers();
    } catch (error) {
      stopError = error;
    }
    await drained;
    if (stopError !== undefined) throw stopError;
  }

  readonly runHead = async (
    blockNumber: number,
    sourceHead: LatestHeadObservation,
  ): Promise<void> => {
    const blockScanGraph = this.deps.blockScanGraph();
    const blockScanCfg = this.deps.blockScanConfig;
    const blockScanPlanner = this.deps.blockScanPlanner();
    const adapterRuntimeCoordinator = this.deps.adapterRuntimeCoordinator();
    const blockScanExecutionWorkers = this.deps.executionWorkers;
    if (
      this.deps.isShuttingDown() ||
      !this.deps.enabled ||
      !blockScanGraph ||
      !blockScanCfg ||
      !blockScanPlanner ||
      !adapterRuntimeCoordinator ||
      blockScanExecutionWorkers.length === 0
    ) return;

    // Strict latency begins when the production block listener observed the
    // head, not when this single-worker scheduler eventually began running.
    // Pending time therefore remains visible and consumes the same pass
    // deadline instead of becoming an unreported source of fake speed.
    const passStarted = sourceHead.sourceHeadSeenAtMonotonicMs;
    const passStartedAtMs = sourceHead.sourceHeadSeenAtMs;
    const passWorkerStartedAtMs = Date.now();
    const startupWarmAttempt =
      this.startupWarmPending && !this.deps.blind.enabled;
    const passTimeline = new BlockScanPassTimeline(passStartedAtMs);
    const timing = passTimeline.timing;
    const stageBoundaries = passTimeline.boundaries;
    const beginStage = passTimeline.begin.bind(passTimeline);
    const finishStage = passTimeline.finish.bind(passTimeline);
    const mergeAtomicStage = passTimeline.mergeAtomic.bind(passTimeline);
    const hotPassDeadlineAtMs = passStartedAtMs + (
      blockScanGraph.length >= this.deps.largeGraphEdgeThreshold
        ? this.deps.largeGraphPassBudgetMs
        : this.deps.passBudgetMs
    );
    const passDeadlineAtMs = startupWarmAttempt
      ? Math.max(
          hotPassDeadlineAtMs,
          passWorkerStartedAtMs + Math.max(1, this.deps.startupWarmBudgetMs),
        )
      : hotPassDeadlineAtMs;
    let outcome:
      | "ran"
      | "startup_warm"
      | "degraded"
      | "skipped_busy"
      | "stale_state"
      | "budget_exceeded"
      | "disabled"
      | "breaker_open" = "ran";
    let skippedReason: string | undefined;
    let runtimeSourceBlock: number | null = null;
    let scannedPairs = 0;
    let candidates = 0;
    let plannedCount = 0;
    let quotePositive = 0;
    let bestNet: bigint | null = null;
    const atomicResults: BlockScanAtomicResult[] = [];
    let auditRuntime: AdapterRuntimeSnapshot | null = null;
    let auditGraphView: VerifiedGraphView | null = null;
    let auditPricingCoverage: BlindProductionPricingCoverageSource | null =
      null;
    let auditSourceDeltaArtifact:
      BlindProductionArtifact<"source-delta"> | null = null;
    let auditSelectionMode: "production" = "production";
    let auditForcedSelectionCount = 0;
    let auditStages: readonly BlindProductionStageEvidence[] = [];
    let auditStableSemanticEvidence:
      BlindProductionStageSealInput | null = null;
    const auditOpportunities = this.deps.blind.enabled
      ? new Map<string, BlindProductionOpportunityEvidence>()
      : null;
    const currentAuditSemanticEvidence =
      (): BlindProductionStageSealInput | null => {
        if (!auditGraphView || !auditPricingCoverage || !auditOpportunities) {
          return null;
        }
        return createBlindProductionSemanticEvidence({
          graph: auditGraphView,
          pricingCoverage: auditPricingCoverage,
          opportunities: [...auditOpportunities.values()],
        });
      };
    const sealAuditBoundary = (
      name: BlindProductionStageName,
      physical:
        | "state"
        | "enumeration"
        | "exact_refine"
        | "planner_solver"
        | "final_sim"
        | "ev",
    ): void => {
      if (!this.deps.blind.enabled) return;
      const semanticEvidence = currentAuditSemanticEvidence() ??
        auditStableSemanticEvidence;
      if (!semanticEvidence) return;
      auditStages = appendBlindProductionStageEvidence({
        stages: auditStages,
        name,
        boundary: stageBoundaries[physical],
        semanticEvidence,
      });
      auditStableSemanticEvidence = semanticEvidence;
    };
    const completeAuditStages = (): void => {
      if (!this.deps.blind.enabled) return;
      const stageDefinitions = [
        ["state_ready", "state"],
        ["enumeration_done", "enumeration"],
        ["exact_refine_done", "exact_refine"],
        ["planner_solver_done", "planner_solver"],
        ["final_sim_done", "final_sim"],
        ["ev_decision", "ev"],
      ] as const;
      while (auditStages.length < stageDefinitions.length) {
        const [name, physical] = stageDefinitions[auditStages.length]!;
        if (stageBoundaries[physical].status === "not-run") break;
        sealAuditBoundary(name, physical);
      }
      if (auditStages.length === stageDefinitions.length) return;
      const semanticEvidence = auditStableSemanticEvidence ??
        currentAuditSemanticEvidence();
      if (!semanticEvidence) return;
      auditStages = completeBlindProductionStageEvidence({
        stages: auditStages,
        completionCumulativeMs: Math.max(
          0,
          Date.now() - passStartedAtMs,
        ),
        semanticEvidence,
      });
      auditStableSemanticEvidence = semanticEvidence;
    };

    const recordPass = (): void => {
      const totalMs = Math.max(0, performance.now() - passStarted);
      const passDecision = atomicResults.at(-1)?.decision ??
        skippedReason ??
        (quotePositive > 0
          ? "positive_quote_without_atomic_decision"
          : "no_positive_quote");
      const structuredFields = {
        startup_warm: startupWarmAttempt,
        source_head_seen_at_ms: passStartedAtMs,
        scheduler_queue_ms: Math.max(
          0,
          passWorkerStartedAtMs - passStartedAtMs,
        ),
        stage_timing_ms: {
          state: stageBoundaries.state.stage_ms,
          enumeration: stageBoundaries.enumeration.stage_ms,
          exact_refine: stageBoundaries.exact_refine.stage_ms,
          planner_solver: stageBoundaries.planner_solver.stage_ms,
          final_sim: stageBoundaries.final_sim.stage_ms,
          ev: stageBoundaries.ev.stage_ms,
        },
        stages: stageBoundaries,
        decision: passDecision,
        atomic_decisions: atomicResults.map((result) => ({
          decision: result.decision,
          submitted: result.submitted,
        })),
        total_ms: totalMs,
      };
      emitEvent({
        type: "block_scan_result",
        source_block: blockNumber,
        state_block: runtimeSourceBlock,
        outcome,
        scanned_pairs: scannedPairs,
        swap_touched_pools: 0,
        candidates,
        scan_ms: Math.round(stageBoundaries.enumeration.stage_ms),
        skipped_reason: skippedReason,
        ...structuredFields,
      });
      console.log(
        `[searcher/blockscan-family] ${JSON.stringify({
          type: "block_scan_timing",
          source_block: blockNumber,
          outcome,
          candidates,
          planned: plannedCount,
          quote_positive: quotePositive,
          best_net: bestNet?.toString() ?? null,
          ...structuredFields,
        })}`,
      );
      const blindSource = this.deps.blind.activeSource();
      const blindBase = this.deps.blind.preparedBase();
      if (
        this.deps.blind.enabled &&
        blindSource &&
        blindBase &&
        blindSource.attemptNonce === blindBase.attemptNonce
      ) {
        const preparedBlindArtifacts = this.deps.blind.preparedArtifacts();
        if (!preparedBlindArtifacts || !auditSourceDeltaArtifact) {
          throw new Error(
            "blind production pass is missing actual frozen artifacts",
          );
        }
        const record = createBlindProductionPassRecord({
          source: blindSource,
          base: blindBase,
          preparedArtifacts: preparedBlindArtifacts,
          sourceDeltaArtifact: auditSourceDeltaArtifact,
          runtime: auditRuntime,
          generationFallback: this.generation,
          dynamicResetNonce: this.deps.blind.dynamicResetNonce(),
          selectionMode: auditSelectionMode,
          forcedSelectionCount: auditForcedSelectionCount,
          stages: auditStages,
        });
        process.stdout.write(
          `${BLIND_PRODUCTION_RAW_PREFIX}` +
            `${blindProductionCanonicalJson(record)}\n`,
        );
      }
    };

    beginStage("state", {
      atMs: passStartedAtMs,
      atPerf: passStarted,
    });
    try {
      const discovery = this.deps.discovery;
      // Historical discovery is prepared in a dedicated cancellable lane.
      // The mutation queue only performs descriptor/hash CAS and one
      // synchronous publication; no provider/trace/probe I/O runs inside it.
      const sourceHeader = await discovery.observeHeader(blockNumber);
      const ready = discovery.lane.readyDescriptor();
      if (ready) {
        const preparedHeader = await discovery.observeHeader(
          ready.source.number,
        );
        const proof = discovery.journal.proof(preparedHeader.number);
        const taken = await discovery.queue.enqueue(
          "dex-refresh",
          async () => {
            const result = discovery.lane.takeForHotHead({
              targetSource: {
                number: sourceHeader.number,
                hash: sourceHeader.hash,
              },
              currentState: discovery.capture(),
              canonicalPreparedSource: proof === null
                ? null
                : {
                    revision: proof.revision,
                    source: proof.source,
                  },
              currentCanonicalRevision: discovery.journal.revision,
            });
            if (result.status !== "degraded") {
              discovery.publish(result.state);
            }
            return result;
          },
        );
        if (taken.status !== "degraded") {
          discovery.finishPublished();
        }
      }

      const base = discovery.capture();
      const requiredPredecessor = Math.max(0, blockNumber - 1);
      if (
        base.dexGraphCoverage.graphCompleteThrough < requiredPredecessor
      ) {
        outcome = "degraded";
        skippedReason =
          `discovery_backfill_behind:` +
          `${base.dexGraphCoverage.graphCompleteThrough}<${requiredPredecessor}`;
        finishStage("state", "failed");
        void discovery.scheduleBackfill(blockNumber);
        return;
      }

      const hotControl: DiscoveryBackfillControl = {
        signal: this.deps.runtimeAbort.signal,
        deadlineAtMs: passDeadlineAtMs,
        run: (work) => work(this.deps.runtimeAbort.signal),
      };
      const preparedDiscovery = await discovery.prepare(base, {
        source: {
          number: sourceHeader.number,
          hash: sourceHeader.hash,
        },
        through: blockNumber,
        control: hotControl,
      });
      const nextDiscovery = discovery.validate(base, preparedDiscovery);
      const canonicalAfter = await discovery.observeHeader(blockNumber);
      const committed = await discovery.queue.enqueue(
        "dex-refresh",
        async () => {
          const current = discovery.capture();
          const expected = describeLiveDiscoveryPublicationState(base);
          const actual = describeLiveDiscoveryPublicationState(current);
          if (
            expected.revision !== actual.revision ||
            expected.baseFingerprint !== actual.baseFingerprint ||
            expected.coverageFingerprint !== actual.coverageFingerprint ||
            canonicalAfter.hash !== sourceHeader.hash
          ) {
            return false;
          }
          discovery.publish(nextDiscovery);
          return true;
        },
      );
      if (!committed) {
        outcome = "degraded";
        skippedReason = "discovery_publication_stale_base";
        finishStage("state", "failed");
        void discovery.scheduleBackfill(blockNumber);
        return;
      }
      discovery.finish(preparedDiscovery);
      const nextDescriptor =
        describeLiveDiscoveryPublicationState(nextDiscovery);
      if (
        nextDiscovery.dexGraphCoverage.graphCompleteThrough < blockNumber
      ) {
        outcome = "degraded";
        skippedReason =
          `discovery_current_incomplete:` +
          `${nextDiscovery.dexGraphCoverage.graphCompleteThrough}<${blockNumber}`;
        finishStage("state", "failed");
        void discovery.scheduleBackfill(blockNumber);
        return;
      }
      const discoveryPass = {
        dexComplete:
          nextDiscovery.dexGraphCoverage.graphCompleteThrough >= blockNumber,
        protocolComplete:
          nextDescriptor.graphCompleteThrough >= blockNumber,
        sourceBlockHash: sourceHeader.hash,
        landedCoverage: nextDiscovery.landedCoverage,
      };
      const sourceBlockHash = discoveryPass.sourceBlockHash;
      const currentGraph = this.deps.blockScanGraph();
      if (!currentGraph) {
        throw new Error("block-scan graph disappeared during discovery");
      }
      const graphEdges = Object.freeze([...currentGraph]);
      const generation = this.nextGeneration();
      const graphView = this.deps.buildGraphView({
        id: `blockscan:${hashTokenGraph([...graphEdges])}`,
        generation,
        sourceBlock: blockNumber,
        sourceBlockHash,
        edges: graphEdges,
        landedCoverage: discoveryPass.landedCoverage,
      });
      if (this.deps.blind.enabled) {
        auditGraphView = graphView;
        auditPricingCoverage = EMPTY_BLIND_PRICING_COVERAGE;
      }
      if (this.deps.blind.enabled) {
        const prepared = this.deps.blind.preparedArtifacts();
        if (!prepared) {
          throw new Error(
            "blind source head has no prepared base graph artifact",
          );
        }
        const sourceOrderedEdgeIds = graphView.edges.map(
          blindCompatibilityCanonicalEdgeId,
        );
        const baseSet = new Set(prepared.baseOrderedEdgeIds);
        const sourceSet = new Set(sourceOrderedEdgeIds);
        auditSourceDeltaArtifact = createBlindProductionArtifact(
          "source-delta",
          {
            ...blindGraphArtifactPayload(graphView, prepared.baseAnchor),
            baseGraphViewSha256:
              blindProductionArtifactReceipt(prepared.baseGraph).sha256,
            addedEdgeCount:
              sourceOrderedEdgeIds.filter((edge) => !baseSet.has(edge)).length,
            addedEdgeHash: blindProductionAuditHash(
              sourceOrderedEdgeIds.filter((edge) => !baseSet.has(edge)).sort(),
            ),
            removedEdgeCount:
              prepared.baseOrderedEdgeIds.filter((edge) =>
                !sourceSet.has(edge)
              ).length,
            removedEdgeHash: blindProductionAuditHash(
              prepared.baseOrderedEdgeIds.filter((edge) =>
                !sourceSet.has(edge)
              ).sort(),
            ),
          },
        );
      }
      const runtime = await adapterRuntimeCoordinator.prepare({
        graph: graphView,
        fundingTokens: [...new Set([
          ...this.deps.flashTokens(),
          ...graphEdges.flatMap((edge) => [edge.tokenIn, edge.tokenOut]),
        ])],
        deadlineAtMs: passDeadlineAtMs,
        signal: this.deps.runtimeAbort.signal,
        prepareExecution: async ({ sourceBlock, sourceBlockHash, signal }) => {
          const settled = await Promise.allSettled(
            blockScanExecutionWorkers.map(async (worker) => {
              if (this.deps.isShuttingDown() || signal.aborted) {
                throw signal.reason;
              }
              await worker.state.forkAt(sourceBlock);
              if (this.deps.isShuttingDown() || signal.aborted) {
                throw signal.reason;
              }
              const forkHash = await this.deps.readBlockHash(
                worker.state.provider,
                sourceBlock,
              );
              if (this.deps.isShuttingDown() || signal.aborted) {
                throw signal.reason;
              }
              if (forkHash !== sourceBlockHash) {
                throw new Error(
                  `worker fork hash mismatch ${forkHash} != ${sourceBlockHash}`,
                );
              }
            }),
          );
          const failure = settled.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          if (
            failure ||
            this.deps.isShuttingDown() ||
            signal.aborted
          ) {
            // Promise cancellation does not stop an in-flight anvil_reset.
            // Settle every worker first, then reap every process before this
            // generation releases the coordinator's reuse barrier.
            await Promise.all(
              blockScanExecutionWorkers.map((worker) =>
                worker.state.stopAndWait()
              ),
            );
            throw failure?.reason ??
              signal.reason ??
              new Error("block-scan runtime shutting down");
          }
        },
      });
      finishStage(
        "state",
        runtime.status === "incomplete" ? "failed" : "ran",
      );
      timing.stateMs = stageBoundaries.state.stage_ms;
      if (this.deps.blind.enabled) {
        auditPricingCoverage = runtime.pricing.coverage;
        sealAuditBoundary("state_ready", "state");
      }
      console.log(
        `[searcher/blockscan-family-telemetry] ${JSON.stringify({
          block: blockNumber,
          sourceBlock: runtime.pricing.sourceBlock,
          generation: runtime.pricing.generation,
          status: runtime.pricing.status,
          issueCount: runtime.pricing.issues.length,
          families: runtime.pricing.familyTelemetry ?? [],
          lanes: runtime.pricing.laneTelemetry,
        })}`,
      );
      if (runtime.status === "incomplete") {
        outcome = Date.now() >= passDeadlineAtMs
          ? "budget_exceeded"
          : "stale_state";
        skippedReason = runtime.issues[0]?.message ??
          `funding unresolved=${runtime.fundingCoverage.unresolvedKeys.length}`;
        console.log(
          `[searcher/blockscan-family] block=${blockNumber} state_incomplete ` +
            `priced=${runtime.pricing.coverage.resolvedEdgeKeys.length}/` +
            `${runtime.pricing.coverage.expectedEdgeKeys.length} ` +
            `funding=${runtime.fundingCoverage.resolvedKeys.length}/` +
            `${runtime.fundingCoverage.expectedKeys.length} ` +
            `reason=${skippedReason}`,
        );
        return;
      }
      if (runtime.status === "degraded") {
        outcome = "degraded";
        console.warn(
          `[searcher/blockscan-family] block=${blockNumber} degraded ` +
            `families=${runtime.snapshot.pricing.incompleteFamilyIds.join(",") || "unknown"} ` +
            `priced=${runtime.pricing.coverage.resolvedEdgeKeys.length}/` +
            `${runtime.pricing.coverage.expectedEdgeKeys.length}`,
        );
      }
      if (this.deps.isShuttingDown()) {
        outcome = "disabled";
        skippedReason = "shutdown";
        return;
      }

      const snapshot = runtime.snapshot;
      this.deps.backrunStatePublisher.publish(snapshot.pricing);
      if (this.deps.blind.enabled) auditRuntime = snapshot;
      runtimeSourceBlock = snapshot.sourceBlock;
      blockScanPlanner.setFlashLiquidity(snapshot.funding);
      this.deps.sharedPlanner.setFlashLiquidity(snapshot.funding);
      if (startupWarmAttempt) {
        // A current-head complete/degraded publication is a valid incremental
        // predecessor for the healthy state keys. Do not enumerate this
        // one-time, non-steady-state head; the latest-head scheduler retains
        // any newer head that arrived while preparation was running.
        this.startupWarmPending = false;
        outcome = "startup_warm";
        skippedReason = `startup_warm_${runtime.status}`;
        console.log(
          `[searcher/blockscan-startup-warm] ${JSON.stringify({
            sourceBlock: snapshot.sourceBlock,
            generation: snapshot.generation,
            status: runtime.status,
            wallMs: Math.max(0, Date.now() - passWorkerStartedAtMs),
            issueCount: runtime.issues.length,
          })}`,
        );
        return;
      }

      beginStage("enumeration");
      const coarse = detectProductionBlockScanOpportunities({
        runtime: snapshot,
        swapTouched: null,
        cfg: {
          ...blockScanCfg,
          maxCandidates: this.deps.refineCandidates,
          pinnedOutsideBudget: true,
        },
      });
      auditSelectionMode = coarse.selectionMode;
      auditForcedSelectionCount = coarse.forcedSelectionCount;
      if (auditOpportunities) {
        for (let index = 0; index < coarse.opportunities.length; index++) {
          const opportunity = coarse.opportunities[index]!;
          auditOpportunities.set(
            blindOpportunityEvidenceKey(opportunity),
            blindOpportunityEvidence(opportunity, index + 1),
          );
        }
      }
      finishStage("enumeration");
      timing.enumerationMs = stageBoundaries.enumeration.stage_ms;
      sealAuditBoundary("enumeration_done", "enumeration");
      scannedPairs = coarse.scannedPairs;
      candidates = coarse.opportunities.length;
      if (Date.now() >= passDeadlineAtMs) {
        outcome = "budget_exceeded";
        skippedReason = "scanner_deadline";
        return;
      }

      const refinementReserveMs = Math.min(
        Math.max(0, this.deps.solveReserveMs),
        Math.max(1, Math.floor((passDeadlineAtMs - Date.now()) / 3)),
      );
      const refineDeadline = Math.max(
        Date.now(),
        passDeadlineAtMs - refinementReserveMs,
      );
      beginStage("exact_refine");
      const refinement = await refineBlockScanCandidates(
        blockScanExecutionWorkers[0].state,
        coarse.opportunities,
        blockScanCfg.maxCandidates,
        refineDeadline,
        blockScanCfg.pricedTokens,
        this.deps.blind.enabled
          ? (diagnostic) => {
              const opportunity = coarse.opportunities[diagnostic.index];
              if (!opportunity) return;
              const key = blindOpportunityEvidenceKey(opportunity);
              const evidence = auditOpportunities?.get(key);
              if (!evidence) return;
              auditOpportunities!.set(key, {
                ...evidence,
                refined: diagnostic.status === "positive",
                ev: diagnostic.status === "positive"
                  ? evidence.ev
                  : {
                      executionStatus: "not_run",
                      decision: "reject",
                      reason: `exact_refine_${diagnostic.status}`,
                    },
              });
            }
          : undefined,
        this.deps.midConcurrency,
      );
      finishStage(
        "exact_refine",
        refinement.deadlineHit ? "failed" : "ran",
      );
      timing.exactRefineMs = stageBoundaries.exact_refine.stage_ms;
      sealAuditBoundary("exact_refine_done", "exact_refine");
      candidates = refinement.opportunities.length;
      if (refinement.deadlineHit || Date.now() >= passDeadlineAtMs) {
        outcome = "budget_exceeded";
        skippedReason = refinement.deadlineHit
          ? "exact_refinement_deadline"
          : "post_refinement_deadline";
        return;
      }

      beginStage("planner_solver");
      const planned: PlannedBlockScanSolve[] = [];
      const plannerFamilyBudget = new BlockScanFamilyStageBudget();
      const plannerQueue = plannerFamilyBudget.order(
        refinement.opportunities,
        (opp) => opp.seedEdges,
      );
      for (const opp of plannerQueue) {
        if (planned.length >= blockScanCfg.maxCandidates) break;
        if (plannerFamilyBudget.blocks(opp.seedEdges)) continue;
        if (Date.now() >= passDeadlineAtMs) {
          outcome = "budget_exceeded";
          skippedReason = "planner_deadline";
          break;
        }
        const routeKey = this.deps.formatRouteKey(opp);
        if (this.deps.isRouteBlacklisted(routeKey, blockNumber)) continue;
        const ring = this.deps.formatRing(opp);
        const protoRing = opp.seedEdges.some(
          (edge) => edge.slotKind === "protocol",
        );
        try {
          blockScanPlanner.setGraph(opp.seedEdges);
          const plans = await blockScanPlanner.planBlockScanFromSeedEdges(
            opp,
            [FLASH_SWAP_REPAY],
          );
          plannerFamilyBudget.recordSuccess(opp.seedEdges);
          if (plans[0]) {
            planned.push({
              opp,
              ring,
              protoRing,
              plan: plans[0],
              planCount: plans.length,
            });
            const evidence = auditOpportunities?.get(
              blindOpportunityEvidenceKey(opp),
            );
            if (evidence) {
              auditOpportunities!.set(blindOpportunityEvidenceKey(opp), {
                ...evidence,
                planCount: plans.length,
              });
            }
          } else {
            const evidence = auditOpportunities?.get(
              blindOpportunityEvidenceKey(opp),
            );
            if (evidence) {
              auditOpportunities!.set(blindOpportunityEvidenceKey(opp), {
                ...evidence,
                ev: {
                  executionStatus: "not_run",
                  decision: "reject",
                  reason: "no_plans",
                },
              });
            }
          }
        } catch (error) {
          plannerFamilyBudget.recordFailure(opp.seedEdges, error);
          const evidence = auditOpportunities?.get(
            blindOpportunityEvidenceKey(opp),
          );
          if (evidence) {
            auditOpportunities!.set(blindOpportunityEvidenceKey(opp), {
              ...evidence,
              ev: {
                executionStatus: "not_run",
                decision: "reject",
                reason: `planner_error:${blockScanErrorMessage(error)}`,
              },
            });
          }
          console.log(
            `[searcher/blockscan-family] block=${blockNumber} planner_failed ` +
              `ring=${ring} error=${blockScanErrorMessage(error)}`,
          );
        }
      }
      plannedCount = planned.length;

      const solverFamilyBudget = new BlockScanFamilyStageBudget();
      const solverQueue = solverFamilyBudget.order(
        planned.map((item, index) => ({ item, index })),
        ({ item }) => item.opp.seedEdges,
      );
      let cursor = 0;
      const exactQuoted: Array<{
        index: number;
        candidateIndex: number;
        item: PlannedBlockScanSolve;
        resolved: ResolvedPlan;
        simulator: BotVMSimulator;
        state: AnvilStateBackend;
      }> = [];
      const workerLoop = async (
        worker: BlockScanExecutionWorker,
      ): Promise<void> => {
        for (;;) {
          const queued = solverQueue[cursor++];
          if (
            !queued ||
            Date.now() >= passDeadlineAtMs ||
            this.deps.isShuttingDown()
          ) return;
          const { item, index } = queued;
          if (solverFamilyBudget.blocks(item.opp.seedEdges)) continue;
          try {
            let deferredCandidates: readonly ResolvedPlan[] = [];
            const solved = await worker.solver.solve(
              item.plan,
              worker.state,
              worker.simulator,
              {
                deadlineMs: Math.max(1, passDeadlineAtMs - Date.now()),
                deadlineAtMs: passDeadlineAtMs,
                deferPhase2Sim: true,
                finalSimTopN: 3,
                gssMaxTries: 8,
                quoteProfitFloorBps: 0n,
                quoteSafetyBps: 10000n,
                onDeferredCandidates: (resolved) => {
                  deferredCandidates = resolved;
                },
              },
            );
            solverFamilyBudget.recordSuccess(item.opp.seedEdges);
            const resolvedCandidates = deferredCandidates.length > 0
              ? deferredCandidates
              : [solved];
            let positiveCandidate = false;
            for (
              let candidateIndex = 0;
              candidateIndex < resolvedCandidates.length;
              candidateIndex++
            ) {
              const candidate = resolvedCandidates[candidateIndex];
              if (bestNet === null || candidate.netProfit > bestNet) {
                bestNet = candidate.netProfit;
              }
              if (candidate.netProfit <= 0n) continue;
              positiveCandidate = true;
              quotePositive++;
              exactQuoted.push({
                index,
                candidateIndex,
                item,
                resolved: candidate,
                simulator: worker.simulator,
                state: worker.state,
              });
            }
            if (!positiveCandidate) {
              const evidence = auditOpportunities?.get(
                blindOpportunityEvidenceKey(item.opp),
              );
              if (evidence) {
                auditOpportunities!.set(
                  blindOpportunityEvidenceKey(item.opp),
                  {
                    ...evidence,
                    ev: {
                      executionStatus: "not_run",
                      decision: "reject",
                      reason: "non_positive_solved_quote",
                    },
                  },
                );
              }
            }
          } catch (error) {
            solverFamilyBudget.recordFailure(item.opp.seedEdges, error);
            const evidence = auditOpportunities?.get(
              blindOpportunityEvidenceKey(item.opp),
            );
            if (evidence) {
              auditOpportunities!.set(blindOpportunityEvidenceKey(item.opp), {
                ...evidence,
                ev: {
                  executionStatus: "not_run",
                  decision: "reject",
                  reason: `solver_error:${blockScanErrorMessage(error)}`,
                },
              });
            }
            console.log(
              `[searcher/blockscan-family] block=${blockNumber} solve_failed ` +
                `ring=${item.ring} error=${blockScanErrorMessage(error)}`,
            );
          }
        }
      };
      await Promise.all(blockScanExecutionWorkers.map(workerLoop));
      finishStage("planner_solver");
      timing.plannerSolverMs = stageBoundaries.planner_solver.stage_ms;
      sealAuditBoundary("planner_solver_done", "planner_solver");

      exactQuoted.sort((a, b) =>
        a.index - b.index || a.candidateIndex - b.candidateIndex
      );
      const finalSimFamilyBudget = new BlockScanFamilyStageBudget();
      const finalSimQueue = finalSimFamilyBudget.order(
        exactQuoted,
        (quoted) => quoted.item.opp.seedEdges,
      );
      const terminalQuoteSets = new Set<number>();
      const unavailableFinalSimStates = new Set<AnvilStateBackend>();
      for (const quoted of finalSimQueue) {
        if (terminalQuoteSets.has(quoted.index)) continue;
        if (finalSimFamilyBudget.blocks(quoted.item.opp.seedEdges)) continue;
        if (unavailableFinalSimStates.has(quoted.state)) continue;
        if (
          Date.now() >= passDeadlineAtMs ||
          this.deps.isShuttingDown()
        ) {
          outcome = this.deps.isShuttingDown()
            ? "disabled"
            : "budget_exceeded";
          skippedReason = this.deps.isShuttingDown()
            ? "shutdown"
            : "final_sim_deadline";
          break;
        }
        const atomic = await this.deps.submitAtomic({
          simulator: quoted.simulator,
          state: quoted.state,
          opp: quoted.item.opp,
          resolved: quoted.resolved,
          sourceBlock: blockNumber,
          ring: quoted.item.ring,
          protoRing: quoted.item.protoRing,
          plans: quoted.item.planCount,
          passDeadlineAtMs,
          sourceBlockHash,
        });
        atomicResults.push(atomic);
        if (!atomic.workerReusable) {
          unavailableFinalSimStates.add(quoted.state);
        }
        const auditEvidence = auditOpportunities?.get(
          blindOpportunityEvidenceKey(quoted.item.opp),
        );
        if (auditEvidence && atomic.audit) {
          auditOpportunities!.set(
            blindOpportunityEvidenceKey(quoted.item.opp),
            {
              ...auditEvidence,
              simulation: atomic.audit.simulation,
              ev: atomic.audit.ev,
            },
          );
        }
        if (atomic.finalSimStatus === "succeeded") {
          finalSimFamilyBudget.recordSuccess(quoted.item.opp.seedEdges);
        } else if (atomic.finalSimStatus === "failed") {
          // A whole-route simulator rejection has no typed leg owner.
          finalSimFamilyBudget.recordFailure(quoted.item.opp.seedEdges);
        }
        if (atomic.terminalForQuoteSet) terminalQuoteSets.add(quoted.index);
        mergeAtomicStage(
          "final_sim",
          atomic.timing.finalSimStartedAtMs,
          atomic.timing.finalSimFinishedAtMs,
          atomic.timing.finalSimMs,
        );
        mergeAtomicStage(
          "ev",
          atomic.timing.evStartedAtMs,
          atomic.timing.evFinishedAtMs,
          atomic.timing.evMs,
        );
      }
      if (Date.now() >= passDeadlineAtMs && atomicResults.length === 0) {
        outcome = "budget_exceeded";
        skippedReason ??= "solve_deadline";
      }
    } catch (error) {
      outcome = Date.now() >= passDeadlineAtMs
        ? "budget_exceeded"
        : "stale_state";
      skippedReason = `runtime_error:${blockScanErrorMessage(error)}`;
      throw error;
    } finally {
      const activeStage = passTimeline.activeStage();
      if (activeStage) finishStage(activeStage, "failed");
      completeAuditStages();
      recordPass();
    }
  };
}

function blindOpportunityEvidence(
  opportunity: BlockScanOpportunity,
  rank: number,
): BlindProductionOpportunityEvidence {
  return {
    rank,
    route: blindOpportunityRoute(opportunity),
    refined: false,
    planCount: 0,
    simulation: {
      executed: false,
      success: false,
      profitRaw: "0",
      gasUsed: "0",
      calldataSha256: blindProductionCalldataSha256("0x"),
      standingPosition: opportunity.leavesStandingPosition,
    },
    ev: {
      executionStatus: "not_run",
      decision: "reject",
      reason: "not_evaluated",
    },
  };
}

function blindOpportunityEvidenceKey(
  opportunity: Pick<BlockScanOpportunity, "seedEdges">,
): string {
  return blindProductionAuditHash(blindOpportunityRoute(opportunity));
}

function blindOpportunityRoute(
  opportunity: Pick<BlockScanOpportunity, "seedEdges">,
): BlindProductionOpportunityEvidence["route"] {
  return opportunity.seedEdges.map(blindCompatibilityRouteStep);
}

function blockScanErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 200);
}
