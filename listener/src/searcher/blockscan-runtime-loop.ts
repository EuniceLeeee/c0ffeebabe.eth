import {
  AnvilStateBackend,
  type StateBackend,
} from "../shared/state/state-backend.js";
import { PinnedRethQuoteBackend } from "./pinned-reth-quote-backend.js";
import {
  isPassScopedExactStateBackend,
  type PassScopedExactStateBackend,
} from "./pinned-reth-quote-backend.js";
import type {
  RethTransportScheduler,
  RethTransportLane,
  RethTransportLease,
} from "./reth-transport-scheduler.js";
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
import type { StrictProductionRuntimeSession } from
  "./strict-production-runtime-session.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  BotVMSimulator,
  type SimulationResult,
} from "./simulator/botvm-simulator.js";
import {
  createBlockScanWorkerFinalSimulationRunner,
  createBotVmFinalSimulationPlanIdentity,
  createFinalSimulationWorkRuntime,
  type FinalSimulationRunnerInput,
  type FinalSimulationWorkRuntime,
} from "./final-simulation-work-runtime.js";
import { FLASH_SWAP_REPAY } from "./templates/path-template.js";
import type {
  AdapterRuntimePrepareResult,
  AdapterRuntimeSnapshot,
  CurrentNExactExecutionContext,
  CurrentNExactExecutionContextResult,
  PrepareAdapterRuntimeInput,
  PrepareCurrentNExactExecutionContextInput,
} from "./adapter-runtime-coordinator.js";
import type {
  BlockScanLaggingTopologyRefreshMode,
  BlockScanFamilyTelemetry,
  BlockScanStateIssue,
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
  type CanonicalHeader,
} from "./canonical-header-journal.js";
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
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
} from "./venues/route-leg-adapter.js";
import {
  createBlockScanExecutionAvailability,
  validateBlockScanPendingEvidenceTrigger,
  type BlockScanExecutionPassMode,
  type BlockScanPendingEvidenceTrigger,
} from "./blockscan-pending-evidence.js";
import { awaitBlockScanDeadline } from "./blockscan-pass-deadline.js";
export type {
  BlockScanPendingEvidenceTrigger,
} from "./blockscan-pending-evidence.js";

const EMPTY_BLIND_PRICING_COVERAGE: BlindProductionPricingCoverageSource =
  Object.freeze({
    expectedStateKeys: Object.freeze([]),
    resolvedStateKeys: Object.freeze([]),
    expectedEdgeKeys: Object.freeze([]),
    resolvedEdgeKeys: Object.freeze([]),
  });

const MAX_PENDING_EVIDENCE_CONTEXTS_PER_HEAD = 32;

interface PendingEvidenceQueueItem {
  readonly key: string;
  readonly context: BlockScanPendingEvidenceTrigger;
}

type ScheduledExecutionRefresh =
  | {
      readonly kind: "evidence";
      readonly item: PendingEvidenceQueueItem;
    }
  | {
      readonly kind: "ordinary-retry";
    };

class PendingEvidencePriorityInterruption extends Error {
  constructor(readonly evidenceHead: number) {
    super(`pending evidence prioritized for head ${evidenceHead}`);
    this.name = "PendingEvidencePriorityInterruption";
  }
}

class BlockScanHeadSupersededInterruption extends Error {
  constructor(readonly newerHead: number) {
    super(`block-scan head superseded by ${newerHead}`);
    this.name = "BlockScanHeadSupersededInterruption";
  }
}

export function incompleteBlockScanFamilies(
  families: readonly BlockScanFamilyTelemetry[] | undefined,
): readonly BlockScanFamilyTelemetry[] {
  return Object.freeze(
    (families ?? []).filter((family) => family.status !== "complete"),
  );
}

function blockScanStateHasRecoveryBacklog(
  prepared: BlockScanStatePrepareResult,
): boolean {
  return (prepared.familyTelemetry ?? []).some(
    (family) => (family.recoveryRequiredStateKeys ?? 0) > 0,
  );
}

export interface BlockScanIssueCauseSummary {
  readonly familyId: string | null;
  readonly lane: string | null;
  readonly issueCount: number;
  readonly kinds: readonly {
    readonly kind: BlockScanStateIssue["kind"];
    readonly count: number;
    readonly samples: readonly {
      readonly sourceId: string | null;
      readonly stateKey: string | null;
      readonly edgeKey: string | null;
      readonly message: string;
    }[];
  }[];
}

/**
 * Bound and redact live failure evidence before it reaches stdout. A single
 * failed read batch can expand into thousands of state-key issues, so logging
 * raw issues would hide the scheduling cause and can expose an RPC URL.
 */
export function summarizeBlockScanIssueCauses(
  issues: readonly BlockScanStateIssue[],
  limits: {
    readonly families?: number;
    readonly kindsPerFamily?: number;
    readonly samplesPerKind?: number;
  } = {},
): readonly BlockScanIssueCauseSummary[] {
  const familyLimit = Math.max(1, limits.families ?? 24);
  const kindLimit = Math.max(1, limits.kindsPerFamily ?? 8);
  const sampleLimit = Math.max(1, limits.samplesPerKind ?? 2);
  const groups = new Map<string, {
    familyId: string | null;
    lane: string | null;
    issueCount: number;
    kinds: Map<BlockScanStateIssue["kind"], {
      count: number;
      samples: Array<{
        sourceId: string | null;
        stateKey: string | null;
        edgeKey: string | null;
        message: string;
      }>;
    }>;
  }>();
  for (const issue of issues) {
    const familyId = issue.familyId ?? null;
    const lane = issue.lane ?? null;
    const groupKey = `${familyId ?? "<global>"}\u0000${lane ?? "<none>"}`;
    let group = groups.get(groupKey);
    if (!group) {
      if (groups.size >= familyLimit) continue;
      group = {
        familyId,
        lane,
        issueCount: 0,
        kinds: new Map(),
      };
      groups.set(groupKey, group);
    }
    group.issueCount++;
    let kind = group.kinds.get(issue.kind);
    if (!kind) {
      if (group.kinds.size >= kindLimit) continue;
      kind = { count: 0, samples: [] };
      group.kinds.set(issue.kind, kind);
    }
    kind.count++;
    if (kind.samples.length < sampleLimit) {
      kind.samples.push({
        sourceId: boundedLogField(issue.sourceId),
        stateKey: boundedLogField(issue.stateKey),
        edgeKey: boundedLogField(issue.edgeKey),
        message: sanitizeBlockScanFailureMessage(issue.message),
      });
    }
  }
  return Object.freeze(
    [...groups.values()].map((group) =>
      Object.freeze({
        familyId: group.familyId,
        lane: group.lane,
        issueCount: group.issueCount,
        kinds: Object.freeze(
          [...group.kinds.entries()].map(([kind, summary]) =>
            Object.freeze({
              kind,
              count: summary.count,
              samples: Object.freeze(
                summary.samples.map((sample) => Object.freeze(sample)),
              ),
            })
          ),
        ),
      })
    ),
  );
}

/**
 * The coarse state producer for head N is registered the moment the graph
 * view is ready and starts immediately, so the N-1 state for the next head is
 * published as early as possible instead of waiting for this pass's
 * enumeration or exact pipeline. Exact work keeps transport priority through
 * the read-priority system (foreground reads preempt the producer's
 * background bulk reads; the producer's mutation proofs and the pass's exact
 * reads use separate transports), so starting production early does not delay
 * candidate processing. afterEnumeration is now only the exact-resource
 * admission decision; release() stays idempotent for the run-head finally
 * boundary so exception paths cannot leave an armed producer stranded.
 */
export class NMinusOneProducerGate {
  private deferred: (() => void) | null = null;

  arm(startNextProducer: () => void): void {
    if (this.deferred) {
      throw new Error("N-1 producer gate is already armed");
    }
    this.deferred = startNextProducer;
  }


  /** Start predecessor production immediately once the graph is ready. */
  start(): void {
    this.release();
  }

  afterEnumeration(candidateCount: number): boolean {
    return candidateCount > 0;
  }

  release(): void {
    const deferred = this.deferred;
    this.deferred = null;
    deferred?.();
  }
}

export function nMinusOneProducerCanServeLatestHead(
  sourceBlock: number,
  latestScheduledHead: number | null,
): boolean {
  return latestScheduledHead === null ||
    latestScheduledHead <= sourceBlock + 1;
}

export function blockScanCandidateFundingTokens(
  opportunities: readonly Pick<BlockScanOpportunity, "flashToken">[],
): readonly string[] {
  return Object.freeze(
    [...new Set(
      opportunities.map((opportunity) =>
        opportunity.flashToken.toLowerCase()
      ),
    )].sort(),
  );
}

function boundedLogField(value: string | undefined): string | null {
  return value ? value.replace(/\s+/g, " ").slice(0, 160) : null;
}

function sanitizeBlockScanFailureMessage(message: string): string {
  return message
    .replace(/(?:https?|wss?):\/\/[^\s"'`]+/gi, "<redacted-url>")
    .replace(/\s+/g, " ")
    .slice(0, 240);
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
  readonly finalSimulationRuntime: FinalSimulationWorkRuntime<
    ResolvedPlan,
    SimulationResult
  >;
  readonly sourceGeneration: number;
  readonly opp: BlockScanOpportunity;
  readonly resolved: ResolvedPlan;
  readonly sourceBlock: number;
  readonly ring: string;
  readonly protoRing: boolean;
  readonly plans: number;
  readonly passDeadlineAtMs: number;
  readonly sourceBlockHash: string;
  readonly signal: AbortSignal;
}

interface PlannedBlockScanSolve {
  opp: BlockScanOpportunity;
  ring: string;
  protoRing: boolean;
  plan: CandidatePlan;
  planCount: number;
}

export interface BlockScanFrozenTopologyDependencies {
  /** Canonical current-head observation; never scans or publishes topology. */
  observeHeader(blockNumber: number): Promise<CanonicalHeader>;
  /** Hash/root of the startup-ready Graph/catalog generation. */
  readonly topologyKey: string;
}

export function bindFrozenTopologyToHeader(
  topology: BlockScanFrozenTopologyDependencies,
  header: CanonicalHeader,
): {
  readonly dexComplete: true;
  readonly protocolComplete: true;
  readonly sourceBlockHash: string;
} {
  if (topology.topologyKey.trim() === "") {
    throw new Error("frozen topology key is empty");
  }
  return Object.freeze({
    dexComplete: true,
    protocolComplete: true,
    sourceBlockHash: header.hash,
  });
}

interface BlockScanBlindDependencies {
  readonly enabled: boolean;
  activeSource(): BlindProductionSourceHeadControl | null;
  preparedBase(): BlindProductionPrepareControl | null;
  preparedArtifacts(): PreparedBlindProductionArtifacts | null;
  dynamicResetNonce(): string | null;
}

export interface BlockScanEnumerationSolverPass {
  recordEnumeration(opportunities: readonly BlockScanOpportunity[]): void;
  recordSolver(opportunity: BlockScanOpportunity): void;
  finish(input: {
    readonly sourceBlockHash: string | null;
    readonly pricingMode:
      | "source_n"
      | "n_minus_one_coarse_current_n_exact"
      | null;
    readonly passOutcome: string;
    readonly passReason: string | null;
  }): void;
}

export interface BlockScanEnumerationSolverTelemetrySink {
  beginPass(sourceBlock: number): BlockScanEnumerationSolverPass | null;
  recordNotStarted(input: {
    readonly sourceBlock: number;
    readonly sourceBlockHash: string | null;
    readonly pricingMode: null;
    readonly passOutcome: "not_started";
    readonly passReason: string;
  }): void;
}

export interface ExactQuoteStateFactoryInput {
  readonly sourceBlockHash: string;
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly transportScheduler?: Pick<RethTransportScheduler, "run">;
}

export interface BlockScanRuntimeLoopDependencies {
  readonly enabled: boolean;
  readonly blockScanConfig: BlockScanCoreConfig | undefined;
  readonly executionWorkers: readonly BlockScanExecutionWorker[];
  /** Dedicated S5 resources; never used by exact refinement or solver work. */
  readonly finalSimulationWorkers: readonly BlockScanExecutionWorker[];
  readonly rpcUrl: string;
  /** Sole current-source Family/exact/execution/Funding authority. */
  readonly strictSession?: (
    source: CanonicalSource,
  ) => Promise<StrictProductionRuntimeSession>;
  /**
   * Override the exact-probe quote backend. Production uses the source-hash
   * pinned reth micro-batch backend; harnesses inject a deterministic fake.
   */
  readonly exactQuoteStateFactory?: (
    input: ExactQuoteStateFactoryInput,
  ) => StateBackend;
  readonly rethTransportScheduler?: Pick<
    RethTransportScheduler,
    "run"
  >;
  readonly runtimeAbort: AbortController;
  readonly sharedPlanner: Pick<TemplatePlanner, "setFlashLiquidity">;
  readonly backrunStatePublisher: Pick<
    BufferedBlockScanBackrunStatePublisher,
    "publish"
  >;
  /** Sole topology authority, frozen from readyGeneration before producer creation. */
  readonly frozenTopology: BlockScanFrozenTopologyDependencies;
  readonly blind: BlockScanBlindDependencies;
  /**
   * Hard wall-clock budget for one exact-refine stage. Exact probes are
   * optional work; a long probe tail in pass N can delay pass N+1 beyond the
   * head cadence even after enumeration has completed successfully.
   */
  readonly exactRefineHardBudgetMs?: number;
  /**
   * When the background N-1 producer is behind the newest scheduled head,
   * exact probes yield the shared reth transport for up to this many
   * milliseconds per batch. Heavy candidate blocks (900+ probes) can occupy
   * reth for 15-20s and push the producer's N-1 publication past the next
   * head cadence; this gate gives the producer the transport it needs to
   * close the gap while keeping exact work bounded.
   */
  readonly exactProducerLagYieldMs?: number;
  /**
   * Total wall-clock budget for exact probe yielding to the producer within
   * one pass. The per-batch yield gives the producer a short reth window;
   * this bounds how much of the pass budget exact may donate overall so a
   * persistently lagging producer cannot starve exact forever.
   */
  readonly exactProducerLagYieldBudgetMs?: number;
  readonly routeTelemetry?: BlockScanEnumerationSolverTelemetrySink;
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
   * Family-local work window inside the N-1 producer. The remaining state
   * budget is reserved for abort drain, partial aggregation and canonical CAS.
   */
  readonly nMinusOneFamilySettleBudgetMs?: number;
  /**
   * Maximum age of the already-published discovery graph used by the N-1
   * consumer. Pricing and exact execution remain source-pinned; this bound
   * affects recall only and keeps current-head discovery I/O out of the
   * latency-critical consume path.
   */
  readonly nMinusOneMaxGraphLagBlocks?: number;
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
  /** BotVM execution contract supplied to generic route quote contexts. */
  readonly executorAddress: string;
  /**
   * Registry-derived execution requirement. Null means the edge is executable
   * in an ordinary periodic pass.
   */
  currentHeadEvidenceFamilyForEdge(
    edgeAdapterId: string,
  ): ExecutionFamilyId | null;
  currentHeadEvidenceScopeKeyForEdge(edge: TokenEdge): string | null;
  currentHeadEvidenceScopeKeys(
    evidence: PendingExecutionEvidence,
  ): readonly string[];
  isCurrentHeadEvidenceFamily(familyId: ExecutionFamilyId): boolean;
  isShuttingDown(): boolean;
  blockScanGraph(): readonly TokenEdge[] | undefined;
  blockScanPlanner(): TemplatePlanner | undefined;
  currentRuntimeCoordinator(): CurrentSourceRuntimeCoordinator | undefined;
  flashTokens(): readonly string[];
  buildGraphView(input: {
    readonly id: string;
    readonly generation: number;
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
    readonly edges: readonly TokenEdge[];
    readonly landedCoverage: readonly LandedPoolDiscoveryCoverage[];
    readonly topologyKey: string;
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

export interface CurrentSourceRuntimeCoordinator {
  latestPricingSnapshot(): BlockScanStateSnapshot | null;
  prepareCoarsePricing(input: {
    readonly graph: VerifiedGraphView;
    readonly deadlineAtMs: number;
    readonly familySettleDeadlineAtMs?: number;
    readonly laggingTopologyRefreshMode?:
      BlockScanLaggingTopologyRefreshMode;
    readonly signal?: AbortSignal;
  }): Promise<BlockScanStatePrepareResult>;
  resetDynamicStateForReplay(): Promise<void>;
  prepare(
    input: PrepareAdapterRuntimeInput,
  ): Promise<AdapterRuntimePrepareResult>;
  prepareCurrentNExactExecutionContext(
    input: PrepareCurrentNExactExecutionContextInput,
  ): Promise<CurrentNExactExecutionContextResult>;
}

/**
 * Owns the one-at-a-time current-head block-scan pass. Main supplies one
 * startup-ready frozen topology plus blind/runtime dependencies; this loop
 * owns scheduling, worker orchestration and the unchanged stage sequence.
 */
export class BlockScanRuntimeLoop {
  private generation = 0;
  private producerCriticalActive = false;
  private startupWarmPending: boolean;
  private readonly scheduler: LatestHeadScheduler;
  private coarsePricingActive: Promise<void> | null = null;
  private coarsePricingActiveSourceBlock: number | null = null;
  private readonly completedCoarsePricingByBlock =
    new Map<number, BlockScanStateSnapshot>();
  private pendingCoarsePricing: {
    readonly coordinator: CurrentSourceRuntimeCoordinator;
    readonly graph: VerifiedGraphView;
  } | null = null;
  private latestScheduledHead: number | null = null;
  private evidenceRevision = 0;
  private readonly scheduledExecutionRefreshes = new Map<
    string,
    ScheduledExecutionRefresh
  >();
  private readonly pendingEvidenceByHead = new Map<
    number,
    PendingEvidenceQueueItem[]
  >();
  private readonly pendingEvidenceKeys = new Set<string>();
  private readonly evidenceDispatchScheduledHeads = new Set<number>();
  private readonly completedOrdinaryHeads = new Map<number, string>();
  /** Last pass stage for scheduler error diagnosis. */
  private passStageLabel = "start";
  private activePass: {
    readonly blockNumber: number;
    readonly mode: BlockScanExecutionPassMode;
    readonly startupWarm: boolean;
    readonly controller: AbortController;
  } | null = null;

  constructor(
    private readonly deps: BlockScanRuntimeLoopDependencies,
  ) {
    if ("discovery" in deps) {
      throw new Error("block-scan rejects mutable discovery authority");
    }
    this.startupWarmPending =
      deps.startupWarmEnabled && !deps.blind.enabled;
    this.scheduler = new LatestHeadScheduler(
      this.runHead,
      (blockNumber, error) => {
        console.log(
          `[searcher/blockscan-family] block=${blockNumber} error=` +
            `${error instanceof Error ? error.message : String(error)} ` +
            `stage=${this.passStageLabel} ` +
            `stack=${error instanceof Error ? error.stack : "n/a"} ` +
            `cause=${error instanceof Error && error.cause instanceof Error
              ? `${error.cause.message}@${error.cause.stack ?? "n/a"}`
              : "none"}`,
        );
      },
      (head) => {
        if (head.revision !== undefined) {
          const key = executionRefreshKey(
            head.blockNumber,
            head.revision,
          );
          const refresh = this.scheduledExecutionRefreshes.get(key);
          this.scheduledExecutionRefreshes.delete(key);
          if (refresh?.kind === "evidence") {
            this.pendingEvidenceKeys.delete(refresh.item.key);
            this.evidenceDispatchScheduledHeads.delete(head.blockNumber);
          }
        }
        this.deps.routeTelemetry?.recordNotStarted({
          sourceBlock: head.blockNumber,
          sourceBlockHash: null,
          pricingMode: null,
          passOutcome: "not_started",
          passReason: head.reason,
        });
      },
    );
  }

  private observeTopologyHeader(blockNumber: number): Promise<CanonicalHeader> {
    return this.deps.frozenTopology.observeHeader(blockNumber);
  }

  private topologyKey(): string {
    return this.deps.frozenTopology.topologyKey;
  }

  private landedCoverage(): readonly LandedPoolDiscoveryCoverage[] {
    return Object.freeze([]);
  }

  schedule(
    blockNumber: number,
    observation?: LatestHeadObservation,
  ): void {
    this.advanceLatestHead(blockNumber);
    this.scheduler.schedule(blockNumber, observation);
    this.maybeStartProducerAtObservation(blockNumber);
  }

  /**
   * Start the background N-1 producer as soon as a new head is observed,
   * before the pass runs its discovery gate. Under sustained exact-storm
   * load the pass for head N can start 20-60s late; arming the producer
   * only inside the pass delayed N-1 publication past the next head and
   * produced stale_state/ineligible passes even when every producer
   * generation itself was fast. The producer re-observes canonical headers
   * per generation, so the provisional hash here is only a placeholder.
   */
  private maybeStartProducerAtObservation(blockNumber: number): void {
    if (this.startupWarmPending || this.deps.blind.enabled) return;
    if (this.deps.nMinusOneFallbackEnabled !== true) return;
    const coordinator = this.deps.currentRuntimeCoordinator();
    const graph = this.deps.blockScanGraph();
    if (!coordinator || !graph) return;
    const producerView = this.producerGraphView({
      edges: Object.freeze([...graph]),
      topologyKey: this.topologyKey(),
      landedCoverage: this.landedCoverage(),
      generation: this.nextGeneration(),
      sourceBlock: blockNumber,
      sourceBlockHash: "",
    });
    if (this.coarsePricingActiveSourceBlock === blockNumber) return;
    if (this.pendingCoarsePricing?.graph.sourceBlock === blockNumber) return;
    if (
      !nMinusOneProducerCanServeLatestHead(
        blockNumber,
        this.latestScheduledHead,
      )
    ) {
      return;
    }
    this.enqueueCoarsePricing({
      coordinator,
      graph: producerView,
    });
  }

  /**
   * Bind the immutable ready topology to this producer source. The strict
   * GraphView coordinator rejects any changed edge object or topology key;
   * there is no adoption cache that could hide an unauthorized mutation.
   */
  private producerGraphView(input: {
    readonly edges: readonly TokenEdge[];
    readonly topologyKey: string;
    readonly landedCoverage: readonly LandedPoolDiscoveryCoverage[];
    readonly generation: number;
    readonly sourceBlock: number;
    readonly sourceBlockHash: string;
  }): VerifiedGraphView {
    return this.deps.buildGraphView({
      id: `blockscan:${input.topologyKey}`,
      generation: input.generation,
      sourceBlock: input.sourceBlock,
      sourceBlockHash: input.sourceBlockHash,
      edges: input.edges,
      landedCoverage: input.landedCoverage,
      topologyKey: input.topologyKey,
    });
  }

  private advanceLatestHead(blockNumber: number): void {
    if (
      this.latestScheduledHead === null ||
      blockNumber > this.latestScheduledHead
    ) {
      this.latestScheduledHead = blockNumber;
      this.pruneEvidenceContexts(blockNumber);
      const active = this.activePass;
      // The one-time periodic startup warm must publish once. The scheduler
      // already coalesces newer heads; steady-state/evidence passes stay abortable.
      if (
        active !== null &&
        active.blockNumber < blockNumber &&
        !(active.mode === "periodic" && active.startupWarm) &&
        !active.controller.signal.aborted
      ) {
        active.controller.abort(
          new BlockScanHeadSupersededInterruption(blockNumber),
        );
      }
    }
  }

  schedulePendingEvidence(
    trigger: BlockScanPendingEvidenceTrigger,
  ): boolean {
    return this.enqueuePendingEvidence(trigger, false);
  }

  private enqueuePendingEvidence(
    trigger: BlockScanPendingEvidenceTrigger,
    resumeInterruptedContext: boolean,
  ): boolean {
    validateBlockScanPendingEvidenceTrigger(trigger);
    const evidence = Object.freeze(trigger.evidence.filter((item) =>
      this.deps.isCurrentHeadEvidenceFamily(item.familyId)
    ));
    if (evidence.length === 0) return false;
    if (
      this.latestScheduledHead !== null &&
      trigger.head.number < this.latestScheduledHead
    ) {
      return false;
    }
    if (
      this.latestScheduledHead === null ||
      trigger.head.number > this.latestScheduledHead
    ) {
      this.advanceLatestHead(trigger.head.number);
    }
    const context = Object.freeze({ ...trigger, evidence });
    if (Date.now() >= this.pendingEvidenceDeadlineAtMs(context)) {
      this.recordPendingEvidenceNotStarted(
        context,
        "pending_evidence_deadline_before_schedule",
      );
      return false;
    }
    const item = Object.freeze({
      key: pendingEvidenceContextKey(context),
      context,
    });
    if (this.pendingEvidenceKeys.has(item.key)) return false;
    const pendingForHead = this.pendingEvidenceCount(
      trigger.head.number,
    );
    if (pendingForHead >= MAX_PENDING_EVIDENCE_CONTEXTS_PER_HEAD) {
      this.recordPendingEvidenceNotStarted(
        context,
        "pending_evidence_queue_full",
      );
      return false;
    }
    this.pendingEvidenceKeys.add(item.key);
    const queue = this.pendingEvidenceByHead.get(trigger.head.number);
    if (queue) {
      if (resumeInterruptedContext) queue.unshift(item);
      else queue.push(item);
    }
    else this.pendingEvidenceByHead.set(trigger.head.number, [item]);
    this.dispatchNextPendingEvidence(trigger.head.number);
    const active = this.activePass;
    if (
      active?.mode === "periodic" &&
      active.blockNumber <= trigger.head.number &&
      !active.controller.signal.aborted
    ) {
      active.controller.abort(
        new PendingEvidencePriorityInterruption(trigger.head.number),
      );
    }
    return true;
  }

  private dispatchNextPendingEvidence(blockNumber: number): void {
    if (this.evidenceDispatchScheduledHeads.has(blockNumber)) return;
    const queue = this.pendingEvidenceByHead.get(blockNumber);
    const item = queue?.shift();
    if (!item) {
      this.pendingEvidenceByHead.delete(blockNumber);
      return;
    }
    if (queue!.length === 0) this.pendingEvidenceByHead.delete(blockNumber);
    const revision = ++this.evidenceRevision;
    const key = executionRefreshKey(blockNumber, revision);
    this.scheduledExecutionRefreshes.set(
      key,
      Object.freeze({ kind: "evidence", item }),
    );
    this.evidenceDispatchScheduledHeads.add(blockNumber);
    const admitted = this.scheduler.scheduleRevision(
      blockNumber,
      revision,
      {
        sourceHeadSeenAtMs: item.context.observedAtMs,
        sourceHeadSeenAtMonotonicMs:
          item.context.observedAtMonotonicMs,
      },
    );
    if (!admitted) {
      this.scheduledExecutionRefreshes.delete(key);
      this.evidenceDispatchScheduledHeads.delete(blockNumber);
      this.pendingEvidenceKeys.delete(item.key);
      this.recordPendingEvidenceNotStarted(
        item.context,
        "pending_evidence_scheduler_rejected",
      );
    }
  }

  private scheduleOrdinaryRetry(
    blockNumber: number,
    observation: LatestHeadObservation,
  ): void {
    const revision = ++this.evidenceRevision;
    const key = executionRefreshKey(blockNumber, revision);
    this.scheduledExecutionRefreshes.set(
      key,
      Object.freeze({ kind: "ordinary-retry" }),
    );
    if (!this.scheduler.scheduleRevision(blockNumber, revision, observation)) {
      this.scheduledExecutionRefreshes.delete(key);
    }
  }

  private pendingEvidenceCount(blockNumber: number): number {
    let count = this.pendingEvidenceByHead.get(blockNumber)?.length ?? 0;
    for (const refresh of this.scheduledExecutionRefreshes.values()) {
      if (
        refresh.kind === "evidence" &&
        refresh.item.context.head.number === blockNumber
      ) {
        count++;
      }
    }
    if (
      this.activePass?.mode !== "periodic" &&
      this.activePass?.blockNumber === blockNumber
    ) {
      count++;
    }
    return count;
  }

  private pendingEvidenceDeadlineAtMs(
    trigger: BlockScanPendingEvidenceTrigger,
  ): number {
    const graphSize = this.deps.blockScanGraph()?.length ?? 0;
    const budgetMs = graphSize >= this.deps.largeGraphEdgeThreshold
      ? this.deps.largeGraphPassBudgetMs
      : this.deps.passBudgetMs;
    return trigger.observedAtMs + Math.max(1, budgetMs);
  }

  private recordPendingEvidenceNotStarted(
    trigger: BlockScanPendingEvidenceTrigger,
    reason: string,
  ): void {
    this.deps.routeTelemetry?.recordNotStarted({
      sourceBlock: trigger.head.number,
      sourceBlockHash: trigger.head.hash,
      pricingMode: null,
      passOutcome: "not_started",
      passReason: reason,
    });
    console.log(
      `[searcher/blockscan-pending-evidence] ${JSON.stringify({
        block: trigger.head.number,
        tx: trigger.txHash.toLowerCase(),
        status: "not_started",
        reason,
      })}`,
    );
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
    readonly coordinator: CurrentSourceRuntimeCoordinator;
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
    readonly coordinator: CurrentSourceRuntimeCoordinator;
    readonly graph: VerifiedGraphView;
  }): void {
    const startedAtMs = Date.now();
    const ordinaryStateBudgetMs = Math.max(
      1,
      this.deps.nMinusOneStateBudgetMs ?? 20_000,
    );
    /*
     * Startup warm owns the long bootstrap budget in the foreground pass.
     * A periodic recovery backlog stays inside this hot budget and is drained
     * by the coordinator's bounded family-local current-N reads.
     */
    const stateBudgetMs = ordinaryStateBudgetMs;
    const publicationReserveMs = Math.min(
      stateBudgetMs,
      Math.max(1, this.deps.runtimePublicationReserveMs ?? 1_500),
    );
    const familySettleBudgetMs = Math.min(
      stateBudgetMs,
      Math.max(
        1,
        this.deps.nMinusOneFamilySettleBudgetMs ??
          Math.min(12_000, stateBudgetMs),
      ),
    );
    const deadlineAtMs = startedAtMs + stateBudgetMs;
    const familySettleDeadlineAtMs = Math.min(
      startedAtMs + familySettleBudgetMs,
      Math.max(
        startedAtMs,
        deadlineAtMs - publicationReserveMs,
      ),
    );
    let result: BlockScanStatePrepareResult | null = null;
    /*
     * The coarse producer must NOT hold the shared reth foreground lease for
     * its whole generation. Live evidence (generations 506-523, b406d13)
     * showed the producer running back-to-back for ~12s each, so the
     * exclusive lease starved the DEX discovery backfill: every 8-block chunk
     * exceeded its 120s budget and failed, the per-source coverage watermark
     * fell ~500 blocks behind, the graph became incomplete, mutation ranges
     * became ineligible, proof-scoped recovery was capped at 16 keys per
     * family, and every coarse state published priced=0/35682.
     *
     * The producer's critical work keeps priority through the backend's own
     * transport: mutation proofs run stateTransportPriority foreground plus
     * the shared critical tail, and bulk family reads are background on a
     * dedicated transport. Only the outer exclusive lease is dropped, so the
     * retry-safe discovery backfill can finally make progress and the graph
     * can complete, which is what makes mutation proofs eligible again.
     */
    /*
     * Sequential catch-up chain: the producer fills every missing predecessor
     * from the last published coarse source up to the armed head, one
     * canonical block at a time. Each generation is a 1-block activity range,
     * so it stays fast, and a strict N-1 consumer always finds the exactly
     * adjacent state once the chain reaches it (the old producer jumped
     * straight to the newest head and skipped the intermediate blocks, so
     * coalesced heads permanently lacked their predecessor state).
     */
    const task = (async () => {
      const targetBlock = input.graph.sourceBlock;
      let nextBlock = input.coordinator.latestPricingSnapshot() === null
        ? targetBlock
        : input.coordinator.latestPricingSnapshot()!.sourceBlock + 1;
      let catchupIndex = 0;
      for (;;) {
        if (this.deps.runtimeAbort.signal.aborted) break;
        if (nextBlock > targetBlock) break;
        // Each chain generation receives a fresh independent budget; the
        // absolute per-arm deadline above would shrink to zero for later
        // blocks in a catch-up gap and abort every family instantly.
        const generationStartedAtMs = Date.now();
        const generationDeadlineAtMs =
          generationStartedAtMs + stateBudgetMs;
        const generationFamilySettleDeadlineAtMs = Math.min(
          generationStartedAtMs + familySettleBudgetMs,
          Math.max(
            generationStartedAtMs,
            generationDeadlineAtMs - publicationReserveMs,
          ),
        );
        /*
         * No per-arm generation cap: the producer must keep filling the chain
         * to the newest armed head. Breaking early left the single-flight
         * producer idle while every strict N-1 pass waited on it, and the
         * pass-gate restart only fired after a pass deadline expired -> a
         * self-sustaining 10-22s stale cascade. finally() still hands off to
         * the newest pending head without an idle gap.
         */
        /*
         * The producer-critical gate must cover the canonical header read as
         * well as state preparation. Otherwise exact/discovery traffic can
         * enter while observeHeader is queued and make the N-1 publication
         * miss the next head even though the state work itself is healthy.
         */
        this.producerCriticalActive = true;
        const clearProducerCriticalOnAbort = (): void => {
          this.producerCriticalActive = false;
        };
        this.deps.runtimeAbort.signal.addEventListener(
          "abort",
          clearProducerCriticalOnAbort,
          { once: true },
        );
        let header;
        const observeHeaderStartedAtMs = Date.now();
        try {
          header = await this.observeTopologyHeader(nextBlock);
        } catch {
          this.producerCriticalActive = false;
          break;
        } finally {
          this.deps.runtimeAbort.signal.removeEventListener(
            "abort",
            clearProducerCriticalOnAbort,
          );
        }
        const observeHeaderMs = Math.max(
          0,
          Date.now() - observeHeaderStartedAtMs,
        );
        if (this.deps.runtimeAbort.signal.aborted) {
          this.producerCriticalActive = false;
          break;
        }
        const generation = this.nextGeneration();
        const anchoredGraph: VerifiedGraphView = Object.freeze({
          ...input.graph,
          id: `blockscan-coarse-${nextBlock}-${generation}`,
          generation,
          sourceBlock: nextBlock,
          sourceBlockHash: header.hash,
        });
        let prepared: BlockScanStatePrepareResult;
        let bootstrapEscalated = false;
        try {
        prepared = await input.coordinator.prepareCoarsePricing({
          graph: anchoredGraph,
          deadlineAtMs: generationDeadlineAtMs,
          /*
           * Family-local deadlines must settle before the generation
           * deadline; the outer abort wins the same instant as a slow family.
           */
          familySettleDeadlineAtMs: generationFamilySettleDeadlineAtMs,
          laggingTopologyRefreshMode: "proof-scoped",
          signal: this.deps.runtimeAbort.signal,
        });
        if (prepared.status === "incomplete") {
          /*
           * A topology change (e.g. the overnight universe reindex) invalidates
           * every family's compiled static schema. The hot 80s budget cannot
           * finish the full recompile + bootstrap direct read, so the chain
           * retries the same block forever with 0 resolved keys. Escalate once
           * to the startup-warm budget and bootstrap mode, which commits the
           * rebuilt schema and lets the hot chain resume from this block.
           */
          const bootstrapBudgetMs = Math.max(
            stateBudgetMs,
            this.deps.startupWarmBudgetMs ?? 300_000,
          );
          const bootstrapDeadlineAtMs = Date.now() + bootstrapBudgetMs;
          const bootstrapFamilySettleDeadlineAtMs = Math.min(
            bootstrapDeadlineAtMs,
            Math.max(
              Date.now(),
              bootstrapDeadlineAtMs - publicationReserveMs,
            ),
          );
          console.log(
            `[searcher/blockscan-nminus1-state] ${JSON.stringify({
              sourceBlock: nextBlock,
              generation,
              status: "bootstrap-escalated",
              budgetMs: bootstrapBudgetMs,
              wallMs: Math.max(0, Date.now() - generationStartedAtMs),
              armWallMs: Math.max(0, Date.now() - startedAtMs),
            })}`,
          );
          prepared = await input.coordinator.prepareCoarsePricing({
            graph: anchoredGraph,
            deadlineAtMs: bootstrapDeadlineAtMs,
            familySettleDeadlineAtMs: bootstrapFamilySettleDeadlineAtMs,
            laggingTopologyRefreshMode: "startup-bootstrap",
            signal: this.deps.runtimeAbort.signal,
          });
          bootstrapEscalated = true;
        }
        result = prepared;
        } finally {
          this.producerCriticalActive = false;
        }
        const recoveryPending = blockScanStateHasRecoveryBacklog(
          prepared,
        );
        console.log(
          `[searcher/blockscan-nminus1-state] ${JSON.stringify({
            sourceBlock: prepared.sourceBlock,
            generation: prepared.generation,
            status: prepared.status,
            priced: prepared.coverage.resolvedEdgeKeys.length,
            expected: prepared.coverage.expectedEdgeKeys.length,
            issueCount: prepared.issues.length,
            // Both per-generation and arm-cumulative walls are reported:
            // generationWallMs measures one producer generation end to end
            // (observeHeader -> prepareCoarsePricing -> publication), while
            // armWallMs is the whole catch-up arm and only for scheduling
            // diagnosis. Incomplete generations are logged too so a slow
            // failed generation cannot hide from performance analysis.
            generationWallMs: Math.max(
              0,
              Date.now() - generationStartedAtMs,
            ),
            observeHeaderMs,
            armWallMs: Math.max(0, Date.now() - startedAtMs),
            catchupIndex,
            targetBlock,
            budgetMs: stateBudgetMs,
            familySettleBudgetMs,
            publicationReserveMs,
            recoveryBootstrap: false,
            ...(bootstrapEscalated
              ? { bootstrapEscalated: true as const }
              : {}),
            recoveryPending,
            families: prepared.familyTelemetry ?? [],
            lanes: prepared.laneTelemetry,
            causes: summarizeBlockScanIssueCauses(prepared.issues),
          })}`,
        );
        catchupIndex++;
        if (prepared.status !== "incomplete") {
          this.completedCoarsePricingByBlock.set(
            prepared.snapshot.sourceBlock,
            prepared.snapshot,
          );
          for (const sourceBlock of
            this.completedCoarsePricingByBlock.keys()) {
            if (sourceBlock < prepared.snapshot.sourceBlock - 2) {
              this.completedCoarsePricingByBlock.delete(sourceBlock);
            }
          }
        } else {
          // The chain cannot advance past an unpublished block; the next arm
          // retries from the same point.
          break;
        }
        const published = input.coordinator.latestPricingSnapshot();
        nextBlock = published === null
          ? nextBlock + 1
          : published.sourceBlock + 1;
      }
    })();
    task.catch((error) => {
      console.log(
        `[searcher/blockscan-nminus1-state] ${JSON.stringify({
          sourceBlock: input.graph.sourceBlock,
          generation: input.graph.generation,
          status: "failed",
          error: blockScanErrorMessage(error),
          wallMs: Math.max(0, Date.now() - startedAtMs),
          budgetMs: stateBudgetMs,
          recoveryBootstrap: false,
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
    coordinator: CurrentSourceRuntimeCoordinator,
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
    coordinator: CurrentSourceRuntimeCoordinator,
    expectedSourceBlock: number,
    deadlineAtMs: number,
    signal: AbortSignal,
  ): Promise<BlockScanStateSnapshot | null> {
    /*
     * Strict N-1: a pass may only join the exactly adjacent coarse state.
     * Any older published state would silently drop routes that never got
     * enumerated (exact current-N refinement cannot resurrect them), so the
     * fallback to arbitrary preceding states is intentionally removed. The
     * producer fills the chain sequentially (published+1 -> armed head), so
     * walk the producer queue: wait for whatever is active, re-check, and
     * continue with the next pending producer until the exactly adjacent
     * state is published or the deadline expires.
     */
    for (;;) {
      if (this.deps.runtimeAbort.signal.aborted || signal.aborted) {
        throw signal.reason ??
          this.deps.runtimeAbort.signal.reason ??
          new Error("searcher shutdown");
      }
      const completed = this.completedCoarsePricing(
        coordinator,
        expectedSourceBlock,
      );
      if (completed) return completed;
      const active = this.coarsePricingActive;
      if (!active) return null;
      const finished = await waitForTaskUntil(
        active,
        deadlineAtMs,
        signal,
      );
      if (!finished || this.deps.runtimeAbort.signal.aborted) return null;
      // The settled producer's finally starts the next pending producer,
      // which continues the chain from published+1; loop until the needed
      // predecessor is published or the deadline expires.
    }
  }

  stopExecutionWorkers(): void {
    if (!this.deps.runtimeAbort.signal.aborted) {
      this.deps.runtimeAbort.abort(new Error("searcher shutdown"));
    }
    this.pendingCoarsePricing = null;
    this.pendingEvidenceByHead.clear();
    this.pendingEvidenceKeys.clear();
    this.scheduledExecutionRefreshes.clear();
    this.evidenceDispatchScheduledHeads.clear();
    for (const worker of [
      ...this.deps.executionWorkers,
      ...this.deps.finalSimulationWorkers,
    ]) {
      worker.state.stop();
    }
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
    const revision = sourceHead.revision ?? 0;
    const refresh = revision === 0
      ? null
      : this.scheduledExecutionRefreshes.get(
        executionRefreshKey(blockNumber, revision),
      ) ?? null;
    if (revision > 0) {
      this.scheduledExecutionRefreshes.delete(
        executionRefreshKey(blockNumber, revision),
      );
      if (!refresh) return;
    }
    const activeEvidenceItem = refresh?.kind === "evidence"
      ? refresh.item
      : null;
    const executionContext = activeEvidenceItem?.context ?? null;
    const completedOrdinaryHash =
      this.completedOrdinaryHeads.get(blockNumber);
    const ordinaryAlreadyCompleted =
      completedOrdinaryHash !== undefined &&
      (
        executionContext === null ||
        completedOrdinaryHash.toLowerCase() ===
          executionContext.head.hash.toLowerCase()
      );
    const passMode = executionContext === null
      ? "periodic"
      : ordinaryAlreadyCompleted
        ? "evidence-only"
        : "combined";
    const executionEvidence = executionContext?.evidence ?? Object.freeze([]);
    let requeueExecutionContext = false;
    let retryOrdinaryAfterEvidenceReorg = false;
    const { edgeEligible, routeEligible } =
      createBlockScanExecutionAvailability({
        mode: passMode,
        evidence: executionEvidence,
        familyForEdge: (edgeAdapterId) =>
          this.deps.currentHeadEvidenceFamilyForEdge(edgeAdapterId),
        edgeScopeKey: (edge) =>
          this.deps.currentHeadEvidenceScopeKeyForEdge(edge),
        evidenceScopeKeys: (evidence) =>
          this.deps.currentHeadEvidenceScopeKeys(evidence),
      });
    let routeTelemetryPass: BlockScanEnumerationSolverPass | null = null;
    try {
      routeTelemetryPass =
        this.deps.routeTelemetry?.beginPass(blockNumber) ?? null;
    } catch {
      // Route evidence is fail-open and cannot suppress a production pass.
    }
    const recordEnumeration = (
      opportunities: readonly BlockScanOpportunity[],
    ): void => {
      try {
        routeTelemetryPass?.recordEnumeration(opportunities);
      } catch {
        // Route evidence is fail-open and cannot alter enumeration.
      }
    };
    const recordSolver = (opportunity: BlockScanOpportunity): void => {
      try {
        routeTelemetryPass?.recordSolver(opportunity);
      } catch {
        // Route evidence is fail-open and cannot alter solver admission.
      }
    };
    const blockScanGraph = this.deps.blockScanGraph();
    const blockScanCfg = this.deps.blockScanConfig;
    const blockScanPlanner = this.deps.blockScanPlanner();
    const currentRuntimeCoordinator = this.deps.currentRuntimeCoordinator();
    const blockScanExecutionWorkers = this.deps.executionWorkers;
    const blockScanFinalSimulationWorkers = this.deps.finalSimulationWorkers;
    console.log(
      `[searcher/blockscan-debug] runHead enter block=${blockNumber} ` +
        `enabled=${this.deps.enabled} graph=${blockScanGraph?.length ?? "none"} ` +
        `cfg=${blockScanCfg ? "yes" : "no"} planner=${blockScanPlanner ? "yes" : "no"} ` +
        `coord=${currentRuntimeCoordinator ? "yes" : "no"} ` +
        `workers=${blockScanExecutionWorkers.length} ` +
        `finalSimWorkers=${blockScanFinalSimulationWorkers.length} ` +
        `shutdown=${this.deps.isShuttingDown()}`,
    );
    if (
      this.deps.isShuttingDown() ||
      !this.deps.enabled ||
      !blockScanGraph ||
      !blockScanCfg ||
      !blockScanPlanner ||
      !currentRuntimeCoordinator ||
      blockScanExecutionWorkers.length === 0 ||
      blockScanFinalSimulationWorkers.length === 0
    ) {
      try {
        routeTelemetryPass?.finish({
          sourceBlockHash: null,
          pricingMode: null,
          passOutcome: "disabled",
          passReason: this.deps.isShuttingDown()
            ? "shutdown"
            : "runtime_dependencies_unavailable",
        });
      } catch {
        // Route evidence is fail-open and cannot suppress a production pass.
      }
      if (activeEvidenceItem) {
        this.pendingEvidenceKeys.delete(activeEvidenceItem.key);
        this.evidenceDispatchScheduledHeads.delete(blockNumber);
        console.log(
          `[searcher/blockscan-pending-evidence] ${JSON.stringify({
            block: executionContext!.head.number,
            tx: executionContext!.txHash.toLowerCase(),
            status: "not_started",
            reason: this.deps.isShuttingDown()
              ? "shutdown"
              : "runtime_dependencies_unavailable",
          })}`,
        );
        if (!this.deps.isShuttingDown()) {
          this.dispatchNextPendingEvidence(blockNumber);
        }
      }
      return;
    }
    const startupWarmAttempt =
      this.startupWarmPending && !this.deps.blind.enabled;
    const passController = new AbortController();
    const detachRuntimeAbort = linkAbortController(
      this.deps.runtimeAbort.signal,
      passController,
    );
    const passSignal = passController.signal;
    this.activePass = Object.freeze({
      blockNumber,
      mode: passMode,
      startupWarm: startupWarmAttempt && passMode === "periodic",
      controller: passController,
    });

    // Strict latency begins when the production block listener observed the
    // head, not when this single-worker scheduler eventually began running.
    // Pending time therefore remains visible and consumes the same pass
    // deadline instead of becoming an unreported source of fake speed.
    const passStarted = sourceHead.sourceHeadSeenAtMonotonicMs;
    const passStartedAtMs = sourceHead.sourceHeadSeenAtMs;
    const passWorkerStartedAtMs = Date.now();
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
    const useNMinusOneFallback =
      this.deps.nMinusOneFallbackEnabled === true &&
      !startupWarmAttempt &&
      !this.deps.blind.enabled;
    const nMinusOneMaxGraphLagBlocks = Math.max(
      1,
      Math.floor(this.deps.nMinusOneMaxGraphLagBlocks ?? 10),
    );
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
    let exactSourceGeneration: number | null = null;
    let observedSourceBlockHash: string | null = null;
    let fullCoverage = true;
    let degradedRecallReasons: readonly string[] = Object.freeze([]);
    let scannedPairs = 0;
    let candidates = 0;
    let plannedCount = 0;
    let quotePositive = 0;
    let bestNet: bigint | null = null;
    let enumerationFinished = false;
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
        pass_mode: passMode,
        execution_evidence_tx:
          executionContext?.txHash.toLowerCase() ?? null,
        evidence_ready_at_ms:
          executionContext?.evidenceReadyAtMs ?? null,
        evidence_observation_ms: executionContext
          ? Math.max(
              0,
              executionContext.evidenceReadyAtMs -
                executionContext.observedAtMs,
            )
          : null,
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
        exact_transport_drain_ms: exactTransportDrainMs,
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
      try {
        routeTelemetryPass?.finish({
          sourceBlockHash: observedSourceBlockHash,
          pricingMode,
          passOutcome: outcome,
          passReason: skippedReason ?? null,
        });
      } catch {
        // Route evidence is fail-open and cannot alter the pass decision.
      }
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

    const nMinusOneProducerGate = new NMinusOneProducerGate();
    const observeCanonicalHeader = (
      canonicalBlock: number,
      stage: string,
    ): Promise<CanonicalHeader> =>
      awaitBlockScanDeadline(
        this.observeTopologyHeader(canonicalBlock),
        passDeadlineAtMs,
        stage,
        undefined,
        passSignal,
      );
    beginStage("state", {
      atMs: passStartedAtMs,
      atPerf: passStarted,
    });
    let exactQuoteState: StateBackend | null = null;
    let exactTransportDrainMs = 0;
    try {
      // The startup-ready topology is immutable for the lifetime of this
      // producer. Only the current canonical header and state are observed
      // here; discovery, backfill and topology publication do not exist in
      // this loop.
      const sourceHeader = await observeCanonicalHeader(
        blockNumber,
        "source canonical header",
      );
      this.passStageLabel = "state:header";
      observedSourceBlockHash = sourceHeader.hash;
      if (
        executionContext &&
        sourceHeader.hash.toLowerCase() !==
          executionContext.head.hash.toLowerCase()
      ) {
        outcome = "stale_state";
        skippedReason = "pending_evidence_head_reorged";
        retryOrdinaryAfterEvidenceReorg = !ordinaryAlreadyCompleted;
        finishStage("state", "failed");
        return;
      }
      // readyGeneration is the only topology authority for this process.
      // Current-head work observes the canonical header and binds the exact
      // immutable edge set to pricing/exact; it cannot scan, backfill,
      // advance a topology cursor, or publish a Graph generation.
      const frozen = bindFrozenTopologyToHeader(
        this.deps.frozenTopology,
        sourceHeader,
      );
      const discoveryPass = Object.freeze({
        ...frozen,
        landedCoverage: Object.freeze([]),
      });
      const sourceBlockHash = discoveryPass.sourceBlockHash;
      const currentGraph = this.deps.blockScanGraph();
      if (!currentGraph) {
        throw new Error("block-scan strict ready graph disappeared");
      }
      const graphEdges = Object.freeze([...currentGraph]);
      const generation = this.nextGeneration();
      const graphView = this.deps.buildGraphView({
        id: `blockscan:${this.topologyKey()}`,
        generation,
        sourceBlock: blockNumber,
        sourceBlockHash,
        edges: graphEdges,
        landedCoverage: discoveryPass.landedCoverage,
        topologyKey: this.topologyKey(),
      });
      if (useNMinusOneFallback) {
        // Register current-N production before any predecessor wait or
        // enumeration. The producer starts only after this pass's N-1 wait
        // resolves (below), so arming this head can never evict the pending
        // predecessor producer this pass is about to wait on. A newer head
        // may cancel this pass at either boundary; the outer finally release
        // stays idempotent and starts the producer on failure paths too.
        nMinusOneProducerGate.arm(() => {
          if (
            !nMinusOneProducerCanServeLatestHead(
              graphView.sourceBlock,
              this.latestScheduledHead,
            )
          ) {
            console.log(
              `[searcher/blockscan-nminus1-producer] ${JSON.stringify({
                sourceBlock: graphView.sourceBlock,
                latestScheduledHead: this.latestScheduledHead,
                status: "skipped_obsolete",
              })}`,
            );
            return;
          }
          if (
            this.coarsePricingActiveSourceBlock === graphView.sourceBlock ||
            this.pendingCoarsePricing?.graph.sourceBlock ===
              graphView.sourceBlock
          ) {
            // Observation-time scheduling already started (or queued) this
            // head's producer; do not enqueue a redundant duplicate.
            return;
          }
          this.enqueueCoarsePricing({
            coordinator: currentRuntimeCoordinator,
            graph: this.producerGraphView({
              edges: graphEdges,
              topologyKey: this.topologyKey(),
              landedCoverage: discoveryPass.landedCoverage,
              generation,
              sourceBlock: blockNumber,
              sourceBlockHash,
            }),
          });
        });
      }
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
      const allExecutionWorkers = Object.freeze([
        ...blockScanExecutionWorkers,
        ...blockScanFinalSimulationWorkers,
      ]);
      const forkExecutionWorker = async (
        worker: BlockScanExecutionWorker,
        workerIndex: number,
        input: {
          readonly sourceBlock: number;
          readonly sourceBlockHash: string;
          readonly deadlineAtMs: number;
          readonly signal: AbortSignal;
        },
      ): Promise<void> => {
        const resetStartedAtMs = Date.now();
        let status: "complete" | "failed" = "failed";
        try {
          if (this.deps.isShuttingDown() || input.signal.aborted) {
            throw input.signal.reason;
          }
          await worker.state.forkAt(input.sourceBlock, {
            deadlineAtMs: input.deadlineAtMs,
            signal: input.signal,
          });
          if (this.deps.isShuttingDown() || input.signal.aborted) {
            throw input.signal.reason;
          }
          const forkHash = await awaitBlockScanDeadline(
            this.deps.readBlockHash(
              worker.state.provider,
              input.sourceBlock,
            ),
            input.deadlineAtMs,
            "execution worker fork hash",
            () => worker.state.stop(),
            input.signal,
          );
          if (this.deps.isShuttingDown() || input.signal.aborted) {
            throw input.signal.reason;
          }
          if (forkHash !== input.sourceBlockHash) {
            throw new Error(
              `worker fork hash mismatch ${forkHash} != ${input.sourceBlockHash}`,
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
      };
      const prepareExecution = async (
        input: {
          readonly sourceBlock: number;
          readonly sourceBlockHash: string;
          readonly signal: AbortSignal;
        },
      ): Promise<void> => {
        const settled = await Promise.allSettled(
          allExecutionWorkers.map((worker, workerIndex) =>
            forkExecutionWorker(worker, workerIndex, {
              sourceBlock: input.sourceBlock,
              sourceBlockHash: input.sourceBlockHash,
              deadlineAtMs: preparationSettleDeadlineAtMs,
              signal: input.signal,
            }),
          ),
        );
        const { signal } = input;
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
            allExecutionWorkers.map((worker) =>
              worker.state.stopAndWait()
            ),
          );
          throw failure?.reason ??
            signal.reason ??
            new Error("block-scan runtime shutting down");
        }
      };
      let coarse: BlockScanOutcome;
      let fallbackEnvelopes: readonly NMinusOneCoarseCandidate[] | null = null;
      let exactRefineStarted = false;
      let exactFundingTokens: readonly string[] = [];
      if (!useNMinusOneFallback) {
        this.passStageLabel = "state:prepare";
        const runtime = await currentRuntimeCoordinator.prepare({
          graph: graphView,
          fundingTokens: [...new Set([
            ...this.deps.flashTokens(),
            ...graphEdges.flatMap((edge) => [edge.tokenIn, edge.tokenOut]),
          ])],
          deadlineAtMs: runtimeDeadlineAtMs,
          preparationSettleDeadlineAtMs,
          pricingFamilySettleDeadlineAtMs,
          pricingLaggingTopologyRefreshMode: startupWarmAttempt
            ? "startup-bootstrap"
            : "proof-scoped",
          cacheMode: startupWarmAttempt ? "warm" : "hot",
          signal: passSignal,
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
        const familyFailures = incompleteBlockScanFamilies(
          runtime.pricing.familyTelemetry,
        );
        const pricingIssueSet = new Set(runtime.pricing.issues);
        const downstreamIssues = runtime.issues.filter(
          (issue) => !pricingIssueSet.has(issue),
        );
        if (familyFailures.length > 0) {
          console.warn(
            `[searcher/blockscan-family-local-failures] ${JSON.stringify({
              block: blockNumber,
              sourceBlock: runtime.pricing.sourceBlock,
              failed: familyFailures.length,
              total: runtime.pricing.familyTelemetry?.length ?? 0,
              families: familyFailures.map((family) => ({
                familyId: family.familyId,
                lane: family.lane,
                status: family.status,
                wallMs: family.wallMs,
                issueCount: family.issueCount,
                fullFallbackReason: family.fullFallbackReason,
                fullFallbackDetail: family.fullFallbackDetail,
                recoveryRequiredStateKeys:
                  family.recoveryRequiredStateKeys,
              })),
              causes: summarizeBlockScanIssueCauses(runtime.pricing.issues),
            })}`,
          );
        }
        if (downstreamIssues.length > 0) {
          console.warn(
            `[searcher/blockscan-runtime-failure-causes] ${JSON.stringify({
              block: blockNumber,
              sourceBlock: runtime.pricing.sourceBlock,
              causes: summarizeBlockScanIssueCauses(downstreamIssues),
            })}`,
          );
        }
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
          if (executionContext) requeueExecutionContext = true;
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
        exactSourceGeneration = snapshot.generation;
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
          /*
           * Emit the same state record as the N-1 producer so the KPI join
           * can bind subsequent passes to the warm's coarse snapshot (the
           * relaxed N-delta join uses the latest preceding published state,
           * which is often this warm publication).
           */
          console.log(
            `[searcher/blockscan-nminus1-state] ${JSON.stringify({
              sourceBlock: snapshot.sourceBlock,
              sourceBlockHash: snapshot.sourceBlockHash,
              generation: snapshot.generation,
              status: runtime.status,
              priced: runtime.pricing.coverage.resolvedEdgeKeys.length,
              expected: runtime.pricing.coverage.expectedEdgeKeys.length,
              issueCount: runtime.issues.length,
              wallMs: Math.max(0, Date.now() - passWorkerStartedAtMs),
              warm: true,
            })}`,
          );
          console.log(
            `[searcher/blockscan-startup-warm] ${JSON.stringify({
              sourceBlock: snapshot.sourceBlock,
              generation: snapshot.generation,
              status: runtime.status,
              wallMs: Math.max(0, Date.now() - passWorkerStartedAtMs),
              issueCount: runtime.issues.length,
            })}`,
          );
          if (executionContext) requeueExecutionContext = true;
          return;
        }

        this.passStageLabel = "enumeration";
        beginStage("enumeration");
        const productionCoarse = detectProductionBlockScanOpportunities({
          runtime: snapshot,
          swapTouched: null,
          cfg: {
            ...blockScanCfg,
            maxCandidates: this.deps.refineCandidates,
            pinnedOutsideBudget: true,
          },
          routeEligible,
          edgeEligible,
        });
        coarse = productionCoarse;
        recordEnumeration(coarse.opportunities);
        auditSelectionMode = productionCoarse.selectionMode;
        auditForcedSelectionCount = productionCoarse.forcedSelectionCount;
        console.log(
          `[searcher/blockscan-enumeration] ${JSON.stringify({
            block: blockNumber,
            outcome: productionCoarse.outcome,
            enumeratedCount:
              productionCoarse.selection.enumeratedCount,
            admittedCount: productionCoarse.selection.admittedCount,
            selectedCount: productionCoarse.selection.selectedCount,
            admissionSpreadBps:
              blockScanCfg.exactAdmissionSpreadBps ??
              blockScanCfg.minSpreadBps,
            minCapitalFraction:
              blockScanCfg.minCapitalFraction ?? 0,
            capitalRejected:
              productionCoarse.debug?.capitalRejected ?? 0,
            scannedPairs: productionCoarse.scannedPairs,
          })}`,
        );
      } else {
        this.passStageLabel = "state:wait-adjacent";
        const expectedCoarseBlock = blockNumber - 1;
        const predecessorPricing = await this.waitForAdjacentCoarsePricing(
          currentRuntimeCoordinator,
          expectedCoarseBlock,
          passDeadlineAtMs - Math.max(1, this.deps.solveReserveMs),
          passSignal,
        );
        if (
          !predecessorPricing ||
          predecessorPricing.sourceBlock !== expectedCoarseBlock
        ) {
          finishStage("state", "failed");
          timing.stateMs = stageBoundaries.state.stage_ms;
          outcome = "degraded";
          skippedReason = "no_adjacent_precompleted_coarse";
          fullCoverage = false;
          degradedRecallReasons = Object.freeze([
            ...degradedRecallReasons,
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
        const predecessorHeader = await observeCanonicalHeader(
          expectedCoarseBlock,
          "predecessor canonical header",
        );
        /*
         * The N-1 state this pass needs is guaranteed (or abandoned). Start
         * current-N production now so the N+1 head finds it ready, and a
         * candidate-bearing exact pipeline no longer delays predecessor
         * production (the exact join started below keeps transport priority
         * through the read-priority system).
         */
        nMinusOneProducerGate.start();
        finishStage("state", "ran");
        timing.stateMs = stageBoundaries.state.stage_ms;
        pricingMode = "n_minus_one_coarse_current_n_exact";
        coarseSourceBlock = predecessorPricing.sourceBlock;
        coarseSourceBlockHash = predecessorPricing.sourceBlockHash;
        runtimeSourceBlock = predecessorPricing.sourceBlock;
        exactSourceBlockHash = graphView.sourceBlockHash;
        fullCoverage = false;
        degradedRecallReasons = Object.freeze([
          ...degradedRecallReasons,
          "current_n_mutation_anchors_unavailable",
          "off_event_dependencies_uncovered",
        ]);
        beginStage("enumeration");
        const fallbackCoarse = enumerateNMinusOneCoarseCandidates({
          coarsePricing: predecessorPricing,
          canonicalPredecessorHash: predecessorHeader.hash,
          exactGraph: graphView,
          cfg: {
            ...blockScanCfg,
            maxCandidates: this.deps.refineCandidates,
            pinnedOutsideBudget: true,
          },
          routeEligible,
          edgeEligible,
        });
        fallbackEnvelopes = fallbackCoarse.candidates;
        coarse = Object.freeze({
          ...fallbackCoarse.scan,
          opportunities: fallbackCoarse.candidates.map(
            (candidate) => candidate.exactProbeOpportunity,
          ),
        });
        recordEnumeration(coarse.opportunities);
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
            scanOutcome: fallbackCoarse.scan.outcome,
            admissionSpreadBps:
              blockScanCfg.exactAdmissionSpreadBps ??
              blockScanCfg.minSpreadBps,
            minCapitalFraction:
              blockScanCfg.minCapitalFraction ?? 0,
            capitalRejected:
              fallbackCoarse.scan.debug?.capitalRejected ?? 0,
            naturallyEnumeratedRoutes:
              fallbackCoarse.scan.selection.enumeratedCount,
            admittedRoutes:
              fallbackCoarse.scan.selection.admittedCount,
            selectedRoutes: fallbackCoarse.scan.selection.selectedCount,
            scanBudgetMs: blockScanCfg.budgetMs,
            scanTimingMs: fallbackCoarse.scanTimingMs,
            atomicValidationTimingMs:
              fallbackCoarse.atomicValidationTimingMs,
            wrapperTimingMs: fallbackCoarse.wrapperTimingMs,
            recallMode: fallbackCoarse.recallMode,
            fullCoverage: fallbackCoarse.fullCoverage,
            degradedRecallReasons: fallbackCoarse.degradedRecallReasons,
            graphCompleteThrough: blockNumber,
            graphLagBlocks: 0,
            stateReadyHeadAgeMs: Math.max(
              0,
              Date.now() - passStartedAtMs,
            ),
            exactContextTiming: null,
          })}`,
        );
        finishStage("enumeration");
        enumerationFinished = true;
        timing.enumerationMs = stageBoundaries.enumeration.stage_ms;
        scannedPairs = coarse.scannedPairs;
        candidates = coarse.opportunities.length;
        if (
          candidates > 0 &&
          Date.now() >=
            passDeadlineAtMs - Math.max(1, this.deps.solveReserveMs)
        ) {
          outcome = "budget_exceeded";
          skippedReason = "nminus1_exact_reserve_exhausted";
          console.log(
            `[searcher/blockscan-nminus1] ${JSON.stringify({
              block: blockNumber,
              status: "exact-deferred-stale-head",
              reason: skippedReason,
              candidates,
              headAgeMs: Math.max(0, Date.now() - passStartedAtMs),
              exactReserveMs: Math.max(1, this.deps.solveReserveMs),
            })}`,
          );
          return;
        }
        const requiresExact = nMinusOneProducerGate.afterEnumeration(
          coarse.opportunities.length,
        );
        if (!requiresExact) {
          // Zero candidates cannot consume funding or execution state.
          return;
        }
        exactFundingTokens = blockScanCandidateFundingTokens(
          coarse.opportunities,
        );
        /*
         * Exact probes are current-N view reads against reth; they do not
         * need the Anvil execution context. Keep the Anvil re-fork (the
         * dominant 10-13s fixed cost) out of the pre-probe critical path and
         * prepare funding/CAS only after refinement, right before the solver
         * actually admits a route.
         */
        runtimeSourceBlock = graphView.sourceBlock;
        exactSourceBlockHash = graphView.sourceBlockHash;
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
      if (!enumerationFinished) {
        finishStage("enumeration");
        enumerationFinished = true;
        timing.enumerationMs = stageBoundaries.enumeration.stage_ms;
      }
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
      const refineDeadline = resolveExactRefineDeadline({
        nowMs: Date.now(),
        passDeadlineAtMs,
        refinementReserveMs,
        ...(this.deps.exactRefineHardBudgetMs === undefined
          ? {}
          : { hardBudgetMs: this.deps.exactRefineHardBudgetMs }),
      });
      if (!exactRefineStarted) beginStage("exact_refine");
      /*
       * Exact probes read current-N view state only. Batch them directly to
       * local reth (source-hash pinned) instead of serializing every quote
       * through one Anvil fork; Anvil stays reserved for solver/final-sim.
       */
      if (exactSourceBlockHash === null) {
        throw new Error("exact quote source hash is unavailable");
      }
      if (runtimeSourceBlock === null) {
        throw new Error("strict exact source block is unavailable");
      }
      if (this.deps.strictSession === undefined) {
        throw new Error("block-scan requires a strict current-source session");
      }
      // Reuse the N-1 producer's session for this exact source. The strict
      // session cache is keyed number:hash:generation and the producer built
      // its session under latestPricingSnapshot's generation; a per-pass
      // generation missed the cache and re-ran the full 1706-instance
      // createSession inside exact_refine (~13s per pass, one leaked session
      // per block). The producer's published snapshot is the exact
      // predecessor this pass enumerated against, so bind its source/hash/
      // generation verbatim.
      const producerSnapshot = currentRuntimeCoordinator.latestPricingSnapshot();
      const exactSource = producerSnapshot !== null &&
          producerSnapshot.sourceBlock === runtimeSourceBlock &&
          producerSnapshot.sourceBlockHash?.toLowerCase() ===
            exactSourceBlockHash?.toLowerCase()
        ? Object.freeze({
            number: producerSnapshot.sourceBlock,
            hash: producerSnapshot.sourceBlockHash,
            generation: producerSnapshot.generation,
          })
        : Object.freeze({
            number: runtimeSourceBlock,
            hash: exactSourceBlockHash,
            generation: exactSourceGeneration ?? generation,
          });
      console.log(
        "[exact-source] producer=" +
          (producerSnapshot === null
            ? "none"
            : producerSnapshot.sourceBlock + ":" + producerSnapshot.generation) +
          " runtime=" + runtimeSourceBlock +
          " hash=" + (exactSourceBlockHash ?? "null").slice(0, 10) +
          " -> source=" + exactSource.number + ":" +
          exactSource.generation,
      );
      const strictSession = await this.deps.strictSession(exactSource);
      const runtimeEvidence = strictSession
        .runtimeEvidenceFromPendingExecution(executionEvidence);
      let exactYieldedMs = 0;
      const producerLagBlocks = (): number => {
        const snapshot = currentRuntimeCoordinator.latestPricingSnapshot();
        const producerSource = snapshot?.sourceBlock ?? -1;
        const newestHead = this.latestScheduledHead ?? blockNumber;
        return Math.max(0, newestHead - producerSource);
      };
      /*
       * Producer-lag gate for the exact probe transport. Heavy candidate
       * blocks issue 900+ probes in 15-20s; while the background N-1 producer
       * is behind the newest scheduled head, each exact batch yields the
       * shared reth transport for a bounded window so the producer can
       * publish the missing predecessor instead of waiting behind exact.
       */
      const exactTransportScheduler: Pick<
        RethTransportScheduler,
        "run"
      > | undefined = this.deps.rethTransportScheduler
        ? Object.freeze({
            run: async <T>(
              lane: RethTransportLane,
              signal: AbortSignal,
              work: (lease: RethTransportLease) => Promise<T>,
            ): Promise<T> => {
              const scheduler = this.deps.rethTransportScheduler!;
              if (lane !== "exact") {
                return scheduler.run(lane, signal, work);
              }
              const maxBatchYieldMs = Math.max(
                0,
                this.deps.exactProducerLagYieldMs ?? 5_000,
              );
              const maxPassYieldMs = Math.max(
                0,
                this.deps.exactProducerLagYieldBudgetMs ?? 10_000,
              );
              const batchYieldUntilAtMs = Date.now() + maxBatchYieldMs;
              while (Date.now() < batchYieldUntilAtMs) {
                if (signal.aborted || passSignal.aborted) break;
                if (
                  !exactProducerYieldShouldWait({
                    producerCriticalActive: this.producerCriticalActive,
                    producerLagBlocks: producerLagBlocks(),
                  })
                ) {
                  break;
                }
                if (exactYieldedMs >= maxPassYieldMs) break;
                await new Promise<void>((resolve) =>
                  setTimeout(resolve, 100)
                );
                exactYieldedMs += 100;
              }
              if (!signal.aborted && !passSignal.aborted) {
                assertExactProbeProducerAvailable({
                  producerCriticalActive: this.producerCriticalActive,
                  producerLagBlocks: producerLagBlocks(),
                });
              }
              return scheduler.run(lane, signal, work);
            },
          })
        : undefined;
      const exactFactoryInput: ExactQuoteStateFactoryInput = {
        sourceBlockHash: exactSourceBlockHash,
        signal: passSignal,
        deadlineAtMs: passDeadlineAtMs,
        transportScheduler: exactTransportScheduler,
      };
      exactQuoteState = this.deps.exactQuoteStateFactory
        ? this.deps.exactQuoteStateFactory(exactFactoryInput)
        : new PinnedRethQuoteBackend(
            this.deps.rpcUrl,
            exactSourceBlockHash,
            {
              signal: passSignal,
              deadlineAtMs: passDeadlineAtMs,
              maxBatchSize: 32,
              maxConcurrentBatches: 8,
              maxConcurrentBatchesProvider: () =>
                this.producerCriticalActive || producerLagBlocks() >= 2
                  ? 2
                  : 8,
              transportScheduler: exactTransportScheduler,
            },
          );
      if (exactQuoteState === null) {
        throw new Error("exact quote state not initialized");
      }
      const exactQuoteStateRef: StateBackend = exactQuoteState;
      const refinement = await refineBlockScanCandidates(
        exactQuoteStateRef,
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
        {
          executor: this.deps.executorAddress,
          strictSession,
          runtimeEvidence,
          signal: passSignal,
          admissionSpreadBps:
            blockScanCfg.exactAdmissionSpreadBps ??
            blockScanCfg.minSpreadBps,
          minCapitalFraction:
            blockScanCfg.minCapitalFraction ?? 0,
        },
      );
      if (refinement.shadow) {
        console.log(
          `[searcher/blockscan-refine-shadow] ${JSON.stringify({
            block: blockNumber,
            exactNotAdmitted: refinement.shadow.notAdmitted.total,
            ...refinement.shadow,
          })}`,
        );
      }
      if (exactQuoteState instanceof PinnedRethQuoteBackend) {
        console.log(
          `[searcher/blockscan-exact-quote-stats] ${JSON.stringify({
            block: blockNumber,
            ...exactQuoteState.stats(),
          })}`,
        );
      }
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
      if (useNMinusOneFallback && exactOpportunities.length > 0) {
        if (passSignal.aborted) throw passSignal.reason;
        /*
         * Deferred exact context: probes have already finished. Now prepare
         * funding + canonical CAS for the surviving routes only; Anvil worker
         * forks remain lazy until the solver actually starts on a worker.
         */
        const exactContext: CurrentNExactExecutionContextResult =
          await currentRuntimeCoordinator
            .prepareCurrentNExactExecutionContext({
              graph: graphView,
              fundingTokens: exactFundingTokens,
              deadlineAtMs: runtimeDeadlineAtMs,
              preparationSettleDeadlineAtMs,
              signal: passSignal,
            });
        if (exactContext.status === "incomplete") {
          finishStage("planner_solver", "failed");
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
              requestedFundingTokens: exactFundingTokens.length,
              funding: exactContext.fundingCoverage,
              causes: summarizeBlockScanIssueCauses(exactContext.issues),
            })}`,
          );
          return;
        }
        assertExactContextMatchesGraph(exactContext.context, graphView);
        runtimeSourceBlock = exactContext.context.sourceBlock;
        exactSourceBlockHash = exactContext.context.sourceBlockHash;
        blockScanPlanner.setFlashLiquidity(exactContext.context.funding);
        console.log(
          `[searcher/blockscan-nminus1-exact-join] ${JSON.stringify({
            block: blockNumber,
            sourceBlock: exactContext.context.sourceBlock,
            sourceBlockHash: exactContext.context.sourceBlockHash,
            graphId: exactContext.context.graph.id,
            status: exactContext.status,
            timing: exactContext.timing,
            requestedFundingTokens: exactFundingTokens.length,
            funding: exactContext.fundingCoverage,
          })}`,
        );
      }
      const planned: PlannedBlockScanSolve[] = [];
      const plannerFamilyBudget = new BlockScanFamilyStageBudget();
      const plannerQueue = plannerFamilyBudget.order(
        exactOpportunities,
        (opp) => opp.seedEdges,
      );
      for (const opp of plannerQueue) {
        if (planned.length >= blockScanCfg.maxCandidates) break;
        if (plannerFamilyBudget.blocks(opp.seedEdges)) continue;
        if (passSignal.aborted || Date.now() >= passDeadlineAtMs) {
          if (passSignal.aborted) throw passSignal.reason;
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
      const finalSimulationPlanCommitments = new WeakMap<ResolvedPlan, string>();
      const finalSimulationPlanIdentity = createBotVmFinalSimulationPlanIdentity({
        executor: this.deps.executorAddress,
        expectedSha256: (plan) => {
          const commitment = finalSimulationPlanCommitments.get(plan);
          if (commitment === undefined) {
            throw new Error("resolved plan has no sealed Step 4 execution commitment");
          }
          return commitment;
        },
      });
      const exactQuoted: Array<{
        index: number;
        candidateIndex: number;
        item: PlannedBlockScanSolve;
        resolved: ResolvedPlan;
      }> = [];
      const forkedStates = new Set<AnvilStateBackend>();
      const ensureExecutionWorkerForked = async (
        worker: BlockScanExecutionWorker,
      ): Promise<void> => {
        const state = worker.state;
        if (forkedStates.has(state)) return;
        if (runtimeSourceBlock === null || exactSourceBlockHash === null) {
          throw new Error(
            "execution worker fork missing exact source pin",
          );
        }
        forkedStates.add(state);
        await forkExecutionWorker(
          worker,
          allExecutionWorkers.indexOf(worker),
          {
            sourceBlock: runtimeSourceBlock,
            sourceBlockHash: exactSourceBlockHash,
            deadlineAtMs: passDeadlineAtMs,
            signal: passSignal,
          },
        );
      };
      const workerLoop = async (
        worker: BlockScanExecutionWorker,
      ): Promise<void> => {
        for (;;) {
          const queued = solverQueue[cursor++];
          if (
            !queued ||
            Date.now() >= passDeadlineAtMs ||
            passSignal.aborted ||
            this.deps.isShuttingDown()
          ) return;
          const { item, index } = queued;
          if (solverFamilyBudget.blocks(item.opp.seedEdges)) continue;
          try {
            let deferredCandidates: readonly ResolvedPlan[] = [];
            recordSolver(item.opp);
            const solved = await worker.solver.solve(
              item.plan,
              // Phase-1 quotes are current-N view reads; run them through the
              // same pinned reth batch backend as refinement so Anvil is only
              // forked right before final simulation.
              exactQuoteStateRef,
              worker.simulator,
              {
                deadlineMs: Math.max(1, passDeadlineAtMs - Date.now()),
                deadlineAtMs: passDeadlineAtMs,
                deferPhase2Sim: true,
                finalSimTopN: 3,
                gssMaxTries: 8,
                quoteProfitFloorBps: 0n,
                quoteSafetyBps: 10000n,
                strictSession,
                runtimeEvidence,
                signal: passSignal,
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
              const planBytes = finalSimulationPlanIdentity.bytesHex(candidate);
              finalSimulationPlanCommitments.set(
                candidate,
                blindProductionCalldataSha256(planBytes),
              );
              exactQuoted.push({
                index,
                candidateIndex,
                item,
                resolved: candidate,
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
      if (passSignal.aborted) throw passSignal.reason;
      finishStage("planner_solver");
      timing.plannerSolverMs = stageBoundaries.planner_solver.stage_ms;
      sealAuditBoundary("planner_solver_done", "planner_solver");

      exactQuoted.sort((a, b) =>
        a.index - b.index || a.candidateIndex - b.candidateIndex
      );
      if (
        runtimeSourceBlock !== blockNumber ||
        exactSourceBlockHash !== sourceBlockHash
      ) {
        throw new Error(
          "final simulation source differs from the exact current-N anchor",
        );
      }
      const blockScanWorkerRunner =
        createBlockScanWorkerFinalSimulationRunner<BlockScanExecutionWorker>();
      const finalSimulationRuntime = createFinalSimulationWorkRuntime({
        reservedResources: blockScanFinalSimulationWorkers.map(
          (worker, index) => Object.freeze({
            id: `blockscan-final-sim-${index}`,
            value: worker,
          }),
        ),
        runner: Object.freeze({
          async simulate(input: FinalSimulationRunnerInput<
            BlockScanExecutionWorker,
            ResolvedPlan
          >) {
            if (useNMinusOneFallback) {
              await ensureExecutionWorkerForked(input.resource);
            }
            return blockScanWorkerRunner.simulate(input);
          },
          terminate(input: Parameters<NonNullable<
            typeof blockScanWorkerRunner.terminate
          >>[0]) {
            blockScanWorkerRunner.terminate?.(input);
          },
        }),
        generationFence: {
          assertCurrent: (candidateGeneration, candidateSource) => {
            if (
              candidateGeneration !== generation ||
              candidateSource.generation !== generation ||
              candidateSource.number !== blockNumber ||
              candidateSource.hash.toLowerCase() !== sourceBlockHash ||
              passSignal.aborted ||
              this.deps.isShuttingDown()
            ) {
              throw passSignal.reason ??
                new Error("block-scan final simulation generation is stale");
            }
          },
        },
        planIdentity: finalSimulationPlanIdentity,
        timeoutMs: Math.max(1, passDeadlineAtMs - Date.now()),
        deadlineAtMsForIntent: () => passDeadlineAtMs,
        maxQueued: 0,
        signalForIntent: () => passSignal,
      });
      const finalSimFamilyBudget = new BlockScanFamilyStageBudget();
      const finalSimQueue = finalSimFamilyBudget.order(
        exactQuoted,
        (quoted) => quoted.item.opp.seedEdges,
      );
      const terminalQuoteSets = new Set<number>();
      try {
        for (const quoted of finalSimQueue) {
          if (terminalQuoteSets.has(quoted.index)) continue;
          if (finalSimFamilyBudget.blocks(quoted.item.opp.seedEdges)) continue;
          if (
            Date.now() >= passDeadlineAtMs ||
            passSignal.aborted ||
            this.deps.isShuttingDown()
          ) {
            if (passSignal.aborted) throw passSignal.reason;
            outcome = this.deps.isShuttingDown()
              ? "disabled"
              : "budget_exceeded";
            skippedReason = this.deps.isShuttingDown()
              ? "shutdown"
              : "final_sim_deadline";
            break;
          }
          const atomic = await this.deps.submitAtomic({
            finalSimulationRuntime,
            sourceGeneration: generation,
            opp: quoted.item.opp,
            resolved: quoted.resolved,
            sourceBlock: blockNumber,
            ring: quoted.item.ring,
            protoRing: quoted.item.protoRing,
            plans: quoted.item.planCount,
            passDeadlineAtMs,
            sourceBlockHash,
            signal: passSignal,
          });
          atomicResults.push(atomic);
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
      } finally {
        finalSimulationRuntime.close(
          new Error(`block-scan final simulation generation ${generation} ended`),
        );
      }
      if (Date.now() >= passDeadlineAtMs && atomicResults.length === 0) {
        outcome = "budget_exceeded";
        skippedReason ??= "solve_deadline";
      }
    } catch (error) {
      if (
        passSignal.aborted &&
        passSignal.reason instanceof PendingEvidencePriorityInterruption
      ) {
        outcome = "skipped_busy";
        skippedReason = "pending_evidence_priority";
        return;
      }
      if (
        passSignal.aborted &&
        passSignal.reason instanceof BlockScanHeadSupersededInterruption
      ) {
        outcome = "stale_state";
        skippedReason = "source_head_superseded";
        return;
      }
      outcome = Date.now() >= passDeadlineAtMs
        ? "budget_exceeded"
        : "stale_state";
      skippedReason = `runtime_error:${blockScanErrorMessage(error)}`;
      throw error;
    } finally {
      try {
        if (isPassScopedExactStateBackend(exactQuoteState)) {
          exactTransportDrainMs = await exactQuoteState.closeAndDrain(
            passSignal.reason ??
              new Error(`block-scan pass ${blockNumber} completed`),
          );
        }
        if (exactQuoteState instanceof PinnedRethQuoteBackend) {
          console.log(
            `[searcher/blockscan-exact-quote-stats-final] ${JSON.stringify({
              block: blockNumber,
              ...exactQuoteState.stats(),
            })}`,
          );
        }
        /*
         * Active stage ends only after drain, so stage/total_ms never show
         * "Promise returned but old RPC still running" fake speed.
         */
        const activeStage = passTimeline.activeStage();
        if (activeStage) finishStage(activeStage, "failed");
        completeAuditStages();
        recordPass();
      } finally {
        if (
          passMode !== "evidence-only" &&
          enumerationFinished &&
          observedSourceBlockHash !== null &&
          !passSignal.aborted &&
          outcome !== "stale_state" &&
          outcome !== "disabled" &&
          outcome !== "skipped_busy" &&
          outcome !== "budget_exceeded"
        ) {
          this.completedOrdinaryHeads.set(
            blockNumber,
            observedSourceBlockHash,
          );
          for (const completed of this.completedOrdinaryHeads.keys()) {
            if (completed < blockNumber - 1) {
              this.completedOrdinaryHeads.delete(completed);
            }
          }
        }
        if (this.activePass?.controller === passController) {
          this.activePass = null;
        }
        detachRuntimeAbort();
        if (activeEvidenceItem) {
          this.pendingEvidenceKeys.delete(activeEvidenceItem.key);
          this.evidenceDispatchScheduledHeads.delete(blockNumber);
        }
        nMinusOneProducerGate.release();
        if (
          requeueExecutionContext &&
          executionContext &&
          !this.deps.isShuttingDown()
        ) {
          this.enqueuePendingEvidence(executionContext, true);
        } else if (
          retryOrdinaryAfterEvidenceReorg &&
          !this.deps.isShuttingDown() &&
          !this.evidenceDispatchScheduledHeads.has(blockNumber) &&
          (this.pendingEvidenceByHead.get(blockNumber)?.length ?? 0) === 0
        ) {
          this.scheduleOrdinaryRetry(blockNumber, sourceHead);
        }
        if (
          activeEvidenceItem &&
          !this.deps.isShuttingDown() &&
          (
            !retryOrdinaryAfterEvidenceReorg ||
            (this.pendingEvidenceByHead.get(blockNumber)?.length ?? 0) > 0
          )
        ) {
          this.dispatchNextPendingEvidence(blockNumber);
        }
      }
    }
  };

  private pruneEvidenceContexts(minimumHead: number): void {
    for (const [head, queue] of this.pendingEvidenceByHead) {
      if (head >= minimumHead) continue;
      this.pendingEvidenceByHead.delete(head);
      for (const item of queue) {
        this.pendingEvidenceKeys.delete(item.key);
        this.recordPendingEvidenceNotStarted(
          item.context,
          "pending_evidence_head_superseded",
        );
      }
    }
    for (const [key, refresh] of this.scheduledExecutionRefreshes) {
      if (
        refresh.kind !== "evidence" ||
        refresh.item.context.head.number >= minimumHead
      ) {
        continue;
      }
      this.scheduledExecutionRefreshes.delete(key);
      this.pendingEvidenceKeys.delete(refresh.item.key);
      this.evidenceDispatchScheduledHeads.delete(
        refresh.item.context.head.number,
      );
      this.recordPendingEvidenceNotStarted(
        refresh.item.context,
        "pending_evidence_head_superseded",
      );
    }
  }
}

function executionRefreshKey(blockNumber: number, revision: number): string {
  return `${blockNumber}:${revision}`;
}

function pendingEvidenceContextKey(
  context: BlockScanPendingEvidenceTrigger,
): string {
  return [
    context.head.number,
    context.head.hash.toLowerCase(),
    context.txHash.toLowerCase(),
    ...context.evidence
      .map((item) => item.evidenceHash.toLowerCase())
      .sort(),
  ].join(":");
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
  return sanitizeBlockScanFailureMessage(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 200);
}

export function assertExactContextMatchesGraph(
  context: CurrentNExactExecutionContext,
  graph: VerifiedGraphView,
): void {
  const numberFields = [
    ["generation", context.generation, graph.generation],
    ["source block", context.sourceBlock, graph.sourceBlock],
  ] as const;
  for (const [label, actual, expected] of numberFields) {
    if (actual !== expected) {
      throw new Error(
        `N-1 exact join rejected mixed ${label}: ${actual} != ${expected}`,
      );
    }
  }
  const stringFields = [
    ["source block hash", context.sourceBlockHash, graph.sourceBlockHash],
    ["graph id", context.graph.id, graph.id],
    ["edge hash", context.graph.orderedEdgeHash, graph.orderedEdgeHash],
    ["metadata hash", context.graph.metadataHash, graph.metadataHash],
    ["ownership hash", context.graph.ownershipHash, graph.ownershipHash],
  ] as const;
  for (const [label, actual, expected] of stringFields) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `N-1 exact join rejected mixed ${label}: ${actual} != ${expected}`,
      );
    }
  }
}

function linkAbortController(
  source: AbortSignal,
  target: AbortController,
): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
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

/**
 * Exact-probe producer-yield predicate. The N pass's exact_refine batches and
 * the background N-1 producer's canonical-activity read both hit reth; when
 * they overlap, the producer generation stretches to 12-18s, its sequential
 * publication chain delays the next passes' state stage past the head cadence,
 * and enumeration_not_ran follows. Exact yields while the producer generation
 * is in progress (event-driven, not only when the producer is >=2 blocks
 * behind) so the coarse chain keeps its 2-5s cadence.
 */
export function exactProducerYieldShouldWait(input: {
  readonly producerCriticalActive: boolean;
  readonly producerLagBlocks: number;
}): boolean {
  return input.producerCriticalActive || input.producerLagBlocks >= 2;
}

export class ExactProbeProducerBusyError extends Error {
  readonly code = "exact_probe_producer_busy" as const;

  constructor() {
    super("exact probe skipped: blockscan producer critical");
    this.name = "ExactProbeProducerBusyError";
  }
}

/** Fail closed instead of issuing another exact batch after its yield cap. */
export function assertExactProbeProducerAvailable(input: {
  readonly producerCriticalActive: boolean;
  readonly producerLagBlocks: number;
}): void {
  if (exactProducerYieldShouldWait(input)) {
    throw new ExactProbeProducerBusyError();
  }
}

/** Resolve the exact-stage deadline without extending the outer pass budget. */
export function resolveExactRefineDeadline(input: {
  readonly nowMs: number;
  readonly passDeadlineAtMs: number;
  readonly refinementReserveMs: number;
  readonly hardBudgetMs?: number;
}): number {
  const hardBudgetMs = Math.max(1_000, input.hardBudgetMs ?? 4_000);
  return Math.min(
    Math.max(
      input.nowMs,
      input.passDeadlineAtMs - input.refinementReserveMs,
    ),
    input.nowMs + hardBudgetMs,
  );
}
