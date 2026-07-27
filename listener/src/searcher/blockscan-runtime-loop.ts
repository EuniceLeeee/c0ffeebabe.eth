import { AnvilStateBackend } from "../shared/state/state-backend.js";
import type { BlockScanOpportunity } from "./detector/detector.js";
import { detectProductionBlockScanOpportunities } from "./detector/blockscan-scanner-production.js";
import type {
  BlockScanCoreConfig,
  BlockScanOutcome,
} from "./detector/blockscan-scanner-core.js";
import { refineBlockScanCandidates } from "./detector/blockscan-candidate-refinement.js";
import {
  enumerateNMinusOneCoarseCandidates,
  promoteNMinusOneExactCandidates,
  type NMinusOneCoarseCandidate,
} from "./detector/blockscan-nminus1-fallback.js";
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
  BlockScanStatePrepareResult,
  BlockScanStateSnapshot,
} from "./blockscan-state-coordinator.js";
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
import {
  CanonicalHeaderJournal,
  CanonicalHeaderOutsideRetentionError,
  type CanonicalHeader,
} from "./canonical-header-journal.js";
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

export function dexRuntimeAdmissionCompleteThrough(
  state: LiveDiscoveryPublicationState,
  blindEnabled: boolean,
): number {
  return blindEnabled
    ? state.dexGraphCoverage.graphCompleteThrough
    : state.dexGraphCoverage.sourceCompleteThrough;
}

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
  /**
   * Pure current-head rebase. A null result means the DEX slice itself changed
   * or route arbitration must be rerun by the combined background lane.
   */
  validateHot(
    current: LiveDiscoveryPublicationState,
    prepared: PreparedDiscovery,
  ): LiveDiscoveryPublicationState | null;
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
  /**
   * Explicit degraded availability mode. It never changes the normal
   * production scanner boundary and remains disabled for blind replay.
   */
  readonly nMinusOneFallbackEnabled?: boolean;
  /**
   * Independent wall-clock allowance for the background predecessor pricing
   * producer. This does not extend the current-head scanner pass deadline.
   */
  readonly nMinusOneStateBudgetMs?: number;
  /**
   * Ordinary-live per-family pricing cutoff. This is deliberately shorter
   * than the generation deadline so one slow family degrades locally instead
   * of letting the outer deadline erase every healthy sibling.
   */
  readonly hotPricingFamilyBudgetMs?: number;
  /**
   * Time reserved for canonical CAS/publication after pricing, funding and
   * execution preparation have all settled.
   */
  readonly runtimePublicationReserveMs?: number;
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
  private coarsePricingActive: Promise<void> | null = null;
  private coarsePricingActiveSourceBlock: number | null = null;
  private readonly completedCoarsePricingByBlock =
    new Map<number, BlockScanStateSnapshot>();
  private pendingCoarsePricing: {
    readonly coordinator: AdapterRuntimeCoordinator;
    readonly graph: VerifiedGraphView;
  } | null = null;

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

  private enqueueCoarsePricing(input: {
    readonly coordinator: AdapterRuntimeCoordinator;
    readonly graph: VerifiedGraphView;
  }): void {
    if (this.coarsePricingActive) {
      if (
        !this.pendingCoarsePricing ||
        input.graph.sourceBlock >= this.pendingCoarsePricing.graph.sourceBlock
      ) {
        this.pendingCoarsePricing = input;
      }
      return;
    }
    this.startCoarsePricing(input);
  }

  private startCoarsePricing(input: {
    readonly coordinator: AdapterRuntimeCoordinator;
    readonly graph: VerifiedGraphView;
  }): void {
    const startedAtMs = Date.now();
    const stateBudgetMs = Math.max(
      1,
      this.deps.nMinusOneStateBudgetMs ?? 20_000,
    );
    const deadlineAtMs = startedAtMs + stateBudgetMs;
    let result: BlockScanStatePrepareResult | null = null;
    const task = input.coordinator.prepareCoarsePricing({
      graph: input.graph,
      deadlineAtMs,
      familySettleDeadlineAtMs: deadlineAtMs,
      signal: this.deps.runtimeAbort.signal,
    }).then((prepared) => {
      result = prepared;
      if (prepared.status !== "incomplete") {
        this.completedCoarsePricingByBlock.set(
          prepared.snapshot.sourceBlock,
          prepared.snapshot,
        );
        for (const sourceBlock of this.completedCoarsePricingByBlock.keys()) {
          if (sourceBlock < prepared.snapshot.sourceBlock - 2) {
            this.completedCoarsePricingByBlock.delete(sourceBlock);
          }
        }
      }
      console.log(
        `[searcher/blockscan-nminus1-state] ${JSON.stringify({
          sourceBlock: prepared.sourceBlock,
          generation: prepared.generation,
          status: prepared.status,
          priced: prepared.coverage.resolvedEdgeKeys.length,
          expected: prepared.coverage.expectedEdgeKeys.length,
          issueCount: prepared.issues.length,
          wallMs: Math.max(0, Date.now() - startedAtMs),
          budgetMs: stateBudgetMs,
        })}`,
      );
    }).catch((error) => {
      console.log(
        `[searcher/blockscan-nminus1-state] ${JSON.stringify({
          sourceBlock: input.graph.sourceBlock,
          generation: input.graph.generation,
          status: "failed",
          error: blockScanErrorMessage(error),
          wallMs: Math.max(0, Date.now() - startedAtMs),
          budgetMs: stateBudgetMs,
        })}`,
      );
    }).finally(() => {
      if (this.coarsePricingActive !== task) return;
      this.coarsePricingActive = null;
      this.coarsePricingActiveSourceBlock = null;
      const pending = this.pendingCoarsePricing;
      this.pendingCoarsePricing = null;
      if (
        pending &&
        !this.deps.runtimeAbort.signal.aborted &&
        pending.graph.sourceBlock >
          (result?.sourceBlock ?? input.graph.sourceBlock)
      ) {
        this.startCoarsePricing(pending);
      }
    });
    this.coarsePricingActive = task;
    this.coarsePricingActiveSourceBlock = input.graph.sourceBlock;
  }

  private completedCoarsePricing(
    coordinator: AdapterRuntimeCoordinator,
    sourceBlock: number,
  ): BlockScanStateSnapshot | null {
    const tracked = this.completedCoarsePricingByBlock.get(sourceBlock);
    if (tracked) return tracked;
    const coordinatorLatest = coordinator.latestPricingSnapshot();
    return coordinatorLatest?.sourceBlock === sourceBlock
      ? coordinatorLatest
      : null;
  }

  private async waitForAdjacentCoarsePricing(
    coordinator: AdapterRuntimeCoordinator,
    sourceBlock: number,
    deadlineAtMs: number,
  ): Promise<BlockScanStateSnapshot | null> {
    const completed = this.completedCoarsePricing(coordinator, sourceBlock);
    if (completed) return completed;
    const active = this.coarsePricingActive;
    if (
      !active ||
      this.coarsePricingActiveSourceBlock !== sourceBlock
    ) {
      return null;
    }
    const finished = await waitForTaskUntil(
      active,
      deadlineAtMs,
      this.deps.runtimeAbort.signal,
    );
    return finished
      ? this.completedCoarsePricing(coordinator, sourceBlock)
      : null;
  }

  stopExecutionWorkers(): void {
    if (!this.deps.runtimeAbort.signal.aborted) {
      this.deps.runtimeAbort.abort(new Error("searcher shutdown"));
    }
    this.pendingCoarsePricing = null;
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
    if (this.coarsePricingActive) {
      await this.coarsePricingActive;
    }
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
    let pricingMode: "source_n" | "n_minus_one_coarse_current_n_exact" =
      "source_n";
    let coarseSourceBlock: number | null = null;
    let coarseSourceBlockHash: string | null = null;
    let exactSourceBlockHash: string | null = null;
    let fullCoverage = true;
    let degradedRecallReasons: readonly string[] = Object.freeze([]);
    let scannedPairs = 0;
    let candidates = 0;
    let plannedCount = 0;
    let quotePositive = 0;
    let bestNet: bigint | null = null;
    const atomicResults: BlockScanAtomicResult[] = [];
    const workerResetTimings: Array<{
      readonly worker: number;
      readonly wallMs: number;
      readonly status: "complete" | "failed";
    }> = [];
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
        pricing_mode: pricingMode,
        coarse_source_block: coarseSourceBlock,
        coarse_source_block_hash: coarseSourceBlockHash,
        exact_source_block_hash: exactSourceBlockHash,
        full_coverage: fullCoverage,
        degraded_recall_reasons: degradedRecallReasons,
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
      // The mutation queue performs only descriptor/hash checks, a pure DEX
      // delta fold and one synchronous publication; no provider/trace/probe
      // I/O runs inside it.
      const sourceHeader = await discovery.observeHeader(blockNumber);
      const consumePreparedBackfill = async (): Promise<number | null> => {
        const ready = discovery.lane.readyDescriptor();
        if (!ready) return null;
        if (ready.source.number > sourceHeader.number) {
          // The latest-head scheduler already has (or will receive) the newer
          // head. Preserve this generation for that pass; do not extend the
          // current head's canonical journal into its future.
          return null;
        }
        let preparedHeader: CanonicalHeader;
        try {
          preparedHeader = await discovery.observeHeader(
            ready.source.number,
          );
        } catch (error) {
          if (!(error instanceof CanonicalHeaderOutsideRetentionError)) {
            throw error;
          }
          discovery.lane.invalidate(
            `prepared source ${ready.source.number} fell outside ` +
              `retained canonical journal at ` +
              `${error.retainedHeadNumber}`,
          );
          return null;
        }
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
          return ready.source.number;
        }
        return null;
      };
      const consumedPreparedSource = await consumePreparedBackfill();

      let base = discovery.capture();
      const dexAdmissionCompleteThrough = (
        state: LiveDiscoveryPublicationState,
      ): number =>
        dexRuntimeAdmissionCompleteThrough(
          state,
          this.deps.blind.enabled,
        );
      const requiredPredecessor = Math.max(0, blockNumber - 1);
      if (
        dexAdmissionCompleteThrough(base) < requiredPredecessor
      ) {
        if (startupWarmAttempt) {
          // Startup has a separate bounded budget. Let the already-running
          // historical lane finish and consume its canonical result
          // immediately. If its bounded chunk predates N-1, keep advancing
          // through the same background-concurrency lane. The hot transition
          // below therefore remains a current-head transition, never an
          // unbounded historical scan. Publication still happens only through
          // the mutation queue; timeout/shutdown remains fail-closed.
          await waitForBackfillSettlement(
            discovery.lane.settled(),
            passDeadlineAtMs,
            this.deps.runtimeAbort.signal,
          );
          await consumePreparedBackfill();
          base = discovery.capture();
          while (
            dexAdmissionCompleteThrough(base) < requiredPredecessor &&
            Date.now() < passDeadlineAtMs
          ) {
            const previousCompleteThrough =
              dexAdmissionCompleteThrough(base);
            await waitForBackfillSettlement(
              Promise.resolve(
                discovery.scheduleBackfill(blockNumber),
              ).then(() => undefined),
              passDeadlineAtMs,
              this.deps.runtimeAbort.signal,
            );
            await waitForBackfillSettlement(
              discovery.lane.settled(),
              passDeadlineAtMs,
              this.deps.runtimeAbort.signal,
            );
            const consumed = await consumePreparedBackfill();
            base = discovery.capture();
            if (
              consumed === null ||
              dexAdmissionCompleteThrough(base) <= previousCompleteThrough
            ) {
              break;
            }
          }
        }
        const predecessorStillBehind =
          dexAdmissionCompleteThrough(base) < requiredPredecessor;
        const canStrictlyCatchCurrentHead =
          !startupWarmAttempt &&
          consumedPreparedSource !== null &&
          dexAdmissionCompleteThrough(base) >= consumedPreparedSource;
        // A complete prepared generation can only be behind because heads
        // advanced while it was running. The existing hot transition may
        // strictly scan that elapsed suffix within the ordinary pass budget.
        // An incomplete/failed historical generation never enters this path.
        if (
          Date.now() >= passDeadlineAtMs ||
          (predecessorStillBehind && !canStrictlyCatchCurrentHead)
        ) {
          outcome = "degraded";
          const admissionThrough = dexAdmissionCompleteThrough(base);
          skippedReason =
            admissionThrough < requiredPredecessor
              ? `discovery_backfill_behind:` +
                `${admissionThrough}<` +
                `${requiredPredecessor}`
              : "startup_discovery_deadline";
          finishStage("state", "failed");
          void discovery.scheduleBackfill(blockNumber);
          return;
        }
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
      const canonicalAfter = await discovery.observeHeader(blockNumber);
      const nextDiscovery = await discovery.queue.enqueue(
        "dex-refresh",
        async () => {
          if (canonicalAfter.hash !== sourceHeader.hash) {
            return null;
          }
          const current = discovery.capture();
          const rebased = discovery.validateHot(
            current,
            preparedDiscovery,
          );
          if (rebased === null) return null;
          discovery.publish(rebased);
          return rebased;
        },
      );
      if (nextDiscovery === null) {
        outcome = "degraded";
        skippedReason = "discovery_hot_rebase_conflict";
        finishStage("state", "failed");
        void discovery.scheduleBackfill(blockNumber);
        return;
      }
      discovery.finish(preparedDiscovery);
      const nextDescriptor =
        describeLiveDiscoveryPublicationState(nextDiscovery);
      const nextAdmissionThrough = dexAdmissionCompleteThrough(nextDiscovery);
      if (nextAdmissionThrough < blockNumber) {
        outcome = "degraded";
        skippedReason =
          `discovery_current_incomplete:` +
          `${nextAdmissionThrough}<${blockNumber}`;
        finishStage("state", "failed");
        void discovery.scheduleBackfill(blockNumber);
        return;
      }
      if (
        nextDiscovery.dexGraphCoverage.graphCompleteThrough < blockNumber
      ) {
        // The source range is canonical and complete, but one or more family
        // projections remain retryable. Keep healing in the background while
        // GraphView excludes only those owning families from this live pass.
        void discovery.scheduleBackfill(blockNumber);
      }
      const discoveryPass = {
        dexComplete: nextAdmissionThrough >= blockNumber,
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
      /*
       * Startup discovery and the first current-N state snapshot are two
       * independently bounded phases. A distant canonical catch-up may spend
       * most of the discovery budget without making the 20k+ edge state read
       * any less necessary. Reusing that depleted deadline makes every cold
       * attempt abort before publication, so no incremental predecessor can
       * ever exist. Hot passes retain the single end-to-end deadline.
       */
      const runtimeDeadlineAtMs = startupWarmAttempt
        ? Math.max(
            passDeadlineAtMs,
            Date.now() + Math.max(1, this.deps.startupWarmBudgetMs),
          )
        : passDeadlineAtMs;
      const preparationSettleDeadlineAtMs =
        runtimeDeadlineAtMs -
        Math.max(1, this.deps.runtimePublicationReserveMs ?? 1_500);
      const pricingFamilySettleDeadlineAtMs = startupWarmAttempt
        ? preparationSettleDeadlineAtMs
        : Math.min(
            preparationSettleDeadlineAtMs,
            Date.now() +
              Math.max(1, this.deps.hotPricingFamilyBudgetMs ?? 5_000),
          );
      const prepareExecution = async (
        input: {
          readonly sourceBlock: number;
          readonly sourceBlockHash: string;
          readonly signal: AbortSignal;
        },
      ): Promise<void> => {
        const { sourceBlock, sourceBlockHash, signal } = input;
        const settled = await Promise.allSettled(
          blockScanExecutionWorkers.map(async (worker, workerIndex) => {
            const resetStartedAtMs = Date.now();
            let status: "complete" | "failed" = "failed";
            try {
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
              status = "complete";
            } finally {
              workerResetTimings.push(Object.freeze({
                worker: workerIndex,
                wallMs: Math.max(0, Date.now() - resetStartedAtMs),
                status,
              }));
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
      };
      const useNMinusOneFallback =
        this.deps.nMinusOneFallbackEnabled === true &&
        !startupWarmAttempt &&
        !this.deps.blind.enabled;
      let coarse: BlockScanOutcome;
      let fallbackEnvelopes: readonly NMinusOneCoarseCandidate[] | null = null;
      if (!useNMinusOneFallback) {
        const runtime = await adapterRuntimeCoordinator.prepare({
          graph: graphView,
          fundingTokens: [...new Set([
            ...this.deps.flashTokens(),
            ...graphEdges.flatMap((edge) => [edge.tokenIn, edge.tokenOut]),
          ])],
          deadlineAtMs: runtimeDeadlineAtMs,
          preparationSettleDeadlineAtMs,
          pricingFamilySettleDeadlineAtMs,
          signal: this.deps.runtimeAbort.signal,
          prepareExecution,
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
            runtime: runtime.timing,
            workerResets: [...workerResetTimings].sort(
              (a, b) => a.worker - b.worker,
            ),
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
        exactSourceBlockHash = snapshot.sourceBlockHash;
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
        const productionCoarse = detectProductionBlockScanOpportunities({
          runtime: snapshot,
          swapTouched: null,
          cfg: {
            ...blockScanCfg,
            maxCandidates: this.deps.refineCandidates,
            pinnedOutsideBudget: true,
          },
        });
        coarse = productionCoarse;
        auditSelectionMode = productionCoarse.selectionMode;
        auditForcedSelectionCount = productionCoarse.forcedSelectionCount;
      } else {
        this.enqueueCoarsePricing({
          coordinator: adapterRuntimeCoordinator,
          graph: graphView,
        });
        const predecessorPricing = await this.waitForAdjacentCoarsePricing(
          adapterRuntimeCoordinator,
          blockNumber - 1,
          passDeadlineAtMs - Math.max(1, this.deps.solveReserveMs),
        );
        if (
          !predecessorPricing ||
          predecessorPricing.sourceBlock + 1 !== blockNumber
        ) {
          finishStage("state", "failed");
          timing.stateMs = stageBoundaries.state.stage_ms;
          outcome = "degraded";
          skippedReason = "no_adjacent_precompleted_coarse";
          fullCoverage = false;
          degradedRecallReasons = Object.freeze([
            "current_n_mutation_anchors_unavailable",
            "off_event_dependencies_uncovered",
          ]);
          console.log(
            `[searcher/blockscan-nminus1] ${JSON.stringify({
              block: blockNumber,
              status: "ineligible",
              reason: skippedReason,
              latestCoarseBlock: predecessorPricing?.sourceBlock ?? null,
            })}`,
          );
          return;
        }
        const predecessorHeader = await discovery.observeHeader(
          blockNumber - 1,
        );
        const exactContext = await
          adapterRuntimeCoordinator.prepareCurrentNExactExecutionContext({
            graph: graphView,
            fundingTokens: this.deps.flashTokens(),
            deadlineAtMs: runtimeDeadlineAtMs,
            preparationSettleDeadlineAtMs,
            signal: this.deps.runtimeAbort.signal,
            prepareExecution,
          });
        finishStage(
          "state",
          exactContext.status === "incomplete" ? "failed" : "ran",
        );
        timing.stateMs = stageBoundaries.state.stage_ms;
        if (exactContext.status === "incomplete") {
          outcome = Date.now() >= passDeadlineAtMs
            ? "budget_exceeded"
            : "stale_state";
          skippedReason = exactContext.issues[0]?.message ??
            "current-N exact execution context incomplete";
          console.log(
            `[searcher/blockscan-nminus1] ${JSON.stringify({
              block: blockNumber,
              status: "exact-context-incomplete",
              reason: skippedReason,
              timing: exactContext.timing,
              funding: exactContext.fundingCoverage,
            })}`,
          );
          return;
        }
        runtimeSourceBlock = exactContext.context.sourceBlock;
        exactSourceBlockHash = exactContext.context.sourceBlockHash;
        blockScanPlanner.setFlashLiquidity(exactContext.context.funding);
        pricingMode = "n_minus_one_coarse_current_n_exact";
        coarseSourceBlock = predecessorPricing.sourceBlock;
        coarseSourceBlockHash = predecessorPricing.sourceBlockHash;
        fullCoverage = false;
        degradedRecallReasons = Object.freeze([
          "current_n_mutation_anchors_unavailable",
          "off_event_dependencies_uncovered",
        ]);
        beginStage("enumeration");
        const fallbackCoarse = enumerateNMinusOneCoarseCandidates({
          coarsePricing: predecessorPricing,
          canonicalPredecessorHash: predecessorHeader.hash,
          exactGraph: exactContext.context.graph,
          cfg: {
            ...blockScanCfg,
            maxCandidates: this.deps.refineCandidates,
            pinnedOutsideBudget: true,
          },
        });
        fallbackEnvelopes = fallbackCoarse.candidates;
        coarse = Object.freeze({
          ...fallbackCoarse.scan,
          opportunities: fallbackCoarse.candidates.map(
            (candidate) => candidate.exactProbeOpportunity,
          ),
        });
        console.log(
          `[searcher/blockscan-nminus1] ${JSON.stringify({
            block: blockNumber,
            status: "coarse-enumerated",
            pricingMode: fallbackCoarse.pricingMode,
            coarseSourceBlock: fallbackCoarse.coarseSourceBlock,
            coarseSourceBlockHash: fallbackCoarse.coarseSourceBlockHash,
            exactSourceBlock: fallbackCoarse.requiredExactSourceBlock,
            exactSourceBlockHash: fallbackCoarse.requiredExactSourceBlockHash,
            candidates: fallbackCoarse.candidates.length,
            rejectedRouteCount: fallbackCoarse.rejectedRouteCount,
            recallMode: fallbackCoarse.recallMode,
            fullCoverage: fallbackCoarse.fullCoverage,
            degradedRecallReasons: fallbackCoarse.degradedRecallReasons,
            exactContextTiming: exactContext.timing,
          })}`,
        );
      }
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
      const exactOpportunities = fallbackEnvelopes
        ? promoteNMinusOneExactCandidates(
            fallbackEnvelopes,
            refinement.opportunities,
          )
        : refinement.opportunities;

      beginStage("planner_solver");
      const planned: PlannedBlockScanSolve[] = [];
      const plannerFamilyBudget = new BlockScanFamilyStageBudget();
      const plannerQueue = plannerFamilyBudget.order(
        exactOpportunities,
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

async function waitForBackfillSettlement(
  settlement: Promise<void>,
  deadlineAtMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason ?? new Error("searcher shutdown");
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error("startup discovery backfill wait deadline exceeded");
  }
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = (): void => {
      finish(signal.reason ?? new Error("searcher shutdown"));
    };
    const timer = setTimeout(() => {
      finish(new Error("startup discovery backfill wait deadline exceeded"));
    }, remainingMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void settlement.then(
      () => finish(),
      (error) => finish(error),
    );
  });
}

async function waitForTaskUntil(
  task: Promise<void>,
  deadlineAtMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    throw signal.reason ?? new Error("searcher shutdown");
  }
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) return false;
  return await new Promise<boolean>((resolve, reject) => {
    let finished = false;
    const finish = (value?: boolean, error?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(value ?? false);
    };
    const onAbort = (): void => {
      finish(undefined, signal.reason ?? new Error("searcher shutdown"));
    };
    const timer = setTimeout(() => finish(false), remainingMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void task.then(
      () => finish(true),
      (error) => finish(undefined, error),
    );
  });
}
