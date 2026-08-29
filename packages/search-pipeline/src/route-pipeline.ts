import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertPlainObject,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type {
  GraphRouteHandle,
  IssuedRouteHandle,
  PersistedGraphEdgeV1,
  RuntimeGraphEdgeV1,
} from "../../graph/src/index.ts";
import type { ProductionSixStepEmissionCapabilityV1 } from "../../evidence-emitter/src/index.ts";
import {
  enumerateClosedLoopPlanningProblem,
  readIssuedPlanningEnumerationV1,
  type IssuedPlanningEnumerationV1,
  type PlannedRouteCandidateV1,
  type PlannedRouteLegV1,
  type PlanningEnumerationV1,
} from "../../planner/src/index.ts";
import {
  assertIssuedStrategyPlanningProblem,
  type StrategyPlanningProblemV1,
} from "../../strategy-composition/src/index.ts";
import {
  readIssuedResolvedRouteExecutionProgramEvidenceV1,
  readIssuedResolvedRouteSixStepArtifactCapabilitiesV1,
  readIssuedResolvedRouteSixStepTraceV1,
  runResolvedRoutePipeline,
  validateRouteCapability,
  validateSearchObjective,
  validateSourceView,
  type CoarseBoundedUnrankedV1,
  type CoarseRankableV1,
  type CurrentSourceSessionV1,
  type ExecutionProgramSixStepEvidenceV1,
  type RouteCapabilityV1,
  type RouteSelectionV1,
  type ResolvedRoutePipelineInputV1,
  type ResolvedRouteSixStepTraceV1,
  type SearchObjectiveV1,
  type SearchGraphLeaseV1,
  type ResolvedRoutePipelinePortsV1,
  type ProductionSixStepArtifactCapabilitiesV1,
  type SearchSchedulerResourceJoinCapabilityV1,
  type SearchSchedulerResourceJoinV1,
  type StageTerminalFailureV1,
  type SourceViewV1,
  type UnsignedDryRunReceiptV1,
} from "./index.ts";
import { readSearchSchedulerResourceJoin } from "./internal/scheduler-resource-join.ts";
import { routeCoarseAttemptEvidenceReaderV1 } from "./internal/coarse-attempt-evidence-state.ts";
import {
  admitCoarseRoutesV1,
  qualifiedCoarseProjectionReceiptRootV1,
  readIssuedCoarseRouteBindingV1,
  readIssuedCoarseRouteAssessmentV1,
  type CoarseAdmissionEntryV1,
  type CoarseAdmissionObjectiveV1,
  type CoarseRouteBindingV1,
  type CoarseRouteAssessmentV1,
  type IssuedCoarseRouteBindingV1,
  type IssuedCoarseRouteAssessmentV1,
  type QualifiedCoarseProjectionReceiptV1,
} from "../../coarse-economics/src/index.ts";
import {
  issueCoarseEnumerationBindingV1,
  issueCoarseRouteBindingV1,
} from "../../coarse-economics/src/internal/search-owner.ts";

/** Route ownership is resolved once for the complete multi-edge candidate. */
export interface RouteResolutionPortV1 {
  readonly resolve: (input: {
    readonly candidate: PlannedRouteCandidateV1;
    readonly selections: readonly RouteSelectionV1[];
  }) => Promise<RouteCapabilityV1> | RouteCapabilityV1;
}

export interface RouteAdmissionPolicyV1 {
  /** Maximum number of rankable routes admitted to exact evaluation. */
  readonly topK: number;
  /** Maximum number of bounded-unranked routes admitted to exact evaluation. */
  readonly boundedUnrankedBudget: number;
}

export interface RouteCoarseAssessmentPortV1 {
  readonly assess: (input: {
    readonly binding: IssuedCoarseRouteBindingV1;
    /** Exact current-source session capability; the owner performs its own
     * before/after fences and the source DTO is never used as authority. */
    readonly currentSource: CurrentSourceSessionV1;
    /** Canonical profile body consumed by the Family owner. The issued
     * binding independently fixes the exact objectiveRef. */
    readonly objective: SearchObjectiveV1;
    readonly deadlineAtMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<IssuedCoarseRouteAssessmentV1 | null> | IssuedCoarseRouteAssessmentV1 | null;
  /** Optional for generic contract fixtures.  Production composition supplies
   * this owner-issued reader; absence is retained as an incomplete audit, not
   * interpreted as an empty or successful coarse result. */
  readonly attemptEvidenceAuthority?: RouteCoarseAttemptEvidenceAuthorityV1;
}

export interface RouteCoarseAttemptEvidenceV1 {
  readonly routeBinding: CoarseRouteBindingV1;
  /** Only pairs actually read through both release-qualified owners. A
   * stopped amount chain leaves later denominator legs missing. */
  readonly attempts: readonly RouteCoarseLegAttemptEvidenceV1[];
}

export interface RouteCoarseLegAttemptEvidenceV1 {
  readonly receipt: QualifiedCoarseProjectionReceiptV1;
  /** Complete canonical owner observation. The independent observer must
   * exact-decode it; the search pipeline never reconstructs a Family artifact. */
  readonly familyObservation: CanonicalJson;
}

export type RouteCoarseAttemptEvidenceAuthorityV1 = object;

function readOwnerIssuedCoarseAttemptEvidenceV1(
  authority: RouteCoarseAttemptEvidenceAuthorityV1,
  binding: IssuedCoarseRouteBindingV1,
): RouteCoarseAttemptEvidenceV1 {
  if (authority === null || typeof authority !== "object") {
    throw new TypeError("coarse attempt evidence authority is required");
  }
  const reader = routeCoarseAttemptEvidenceReaderV1(authority);
  if (reader === undefined) throw new TypeError("coarse attempt evidence authority was not owner-issued");
  return reader(binding);
}

export interface RoutePipelineInputV1 {
  readonly lease: SearchGraphLeaseV1;
  /** Issued by the generated Strategy composition for this exact Graph/trigger. */
  readonly planningProblem: StrategyPlanningProblemV1;
  /** Active generated Strategy composition root supplied by its owner. */
  readonly strategyCompositionRoot: Hash;
  readonly objective: SearchObjectiveV1;
  readonly currentSource: CurrentSourceSessionV1;
  readonly correlationId: Hash;
  readonly deadlineAtMs: number;
  readonly callerId: string;
  readonly admission: RouteAdmissionPolicyV1;
  readonly signal?: AbortSignal;
}

export interface RoutePipelinePortsV1<Projection, Plan, Exact, Simulation> {
  readonly route: RouteResolutionPortV1;
  readonly coarse: RouteCoarseAssessmentPortV1;
  readonly planner: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>["planner"];
  readonly exact: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>["exact"];
  readonly executionProgram: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>["executionProgram"];
  readonly finalSimulation: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>["finalSimulation"];
  readonly economicSafety: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>["economicSafety"];
  readonly unsignedDryRun: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>["unsignedDryRun"];
  readonly sixStepArtifacts: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>["sixStepArtifacts"];
}

export type RouteDispositionV1 = "selected" | "pruned" | "notProbed" | "failed";

export type RouteTerminalKindV1 =
  | "not-run"
  | "policyRejected"
  | "passed"
  | "retryable"
  | "invalidProgram"
  | "chainProvenRejected";

export interface RoutePolicyRejectionReceiptV1 {
  readonly kind: "aloha.route-policy-rejection-v1";
  readonly policyKind: "rankable-top-k" | "bounded-unranked-budget";
  readonly admissionPolicyHash: Hash;
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly candidateId: Hash;
  readonly candidateOrderKey: Hash;
  readonly routeHash: Hash;
  readonly receiptHash: Hash;
}

export interface RoutePostSuccessPolicyTerminalReceiptV1 {
  readonly kind: "aloha.route-post-success-policy-terminal-v1";
  readonly policyKind: "post-success-first-eligible";
  readonly admissionPolicyHash: Hash;
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly winnerCandidateId: Hash;
  readonly winnerTerminalLineageHash: Hash;
  readonly candidateId: Hash;
  readonly routeHash: Hash;
  readonly decisionMonotonicNs: string;
  readonly receiptHash: Hash;
}

export type RoutePolicyTerminalReceiptV1 = RoutePolicyRejectionReceiptV1 | RoutePostSuccessPolicyTerminalReceiptV1;

export interface RouteAccountingEntryV1 {
  readonly candidateId: Hash;
  readonly legs: readonly PlannedRouteLegV1[];
  readonly disposition: RouteDispositionV1;
  /** Generic terminal class for the enumerated candidate.  `selected` means
   * admitted to the exact tail even when that tail later rejects or fails. */
  readonly terminalKind: RouteTerminalKindV1;
  readonly routeHash: Hash | null;
  readonly reasonCode: string | null;
  readonly evidenceHash: Hash | null;
  readonly policyTerminal: RoutePolicyTerminalReceiptV1 | null;
}

export interface RouteAccountingV1 {
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly admissionPolicyHash: Hash;
  readonly enumerationTruncated: boolean;
  readonly observedUniqueCountLowerBound: string;
  readonly total: number;
  readonly selected: number;
  readonly pruned: number;
  readonly notProbed: number;
  readonly failed: number;
  readonly entries: readonly RouteAccountingEntryV1[];
  readonly root: Hash;
}

export interface RouteCandidateTerminalTimingFactsV1 {
  readonly kind: "aloha.route-candidate-terminal-timing-facts-v1";
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly admissionPolicyHash: Hash;
  readonly candidateId: Hash;
  readonly disposition: RouteDispositionV1;
  readonly terminalKind: RouteTerminalKindV1;
  readonly routeHash: Hash | null;
  readonly reasonCode: string | null;
  readonly evidenceHash: Hash | null;
  readonly policyTerminal: RoutePolicyTerminalReceiptV1 | null;
  readonly terminalLineageHash: Hash | null;
  readonly sixStepEvidenceRoot: Hash | null;
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly timingUs: string;
  readonly timingRoot: Hash;
}

export type RouteSetTerminalOutcomeV1 =
  | "complete-no-candidate"
  | "complete-candidates-terminal"
  | "retryable"
  | "invalidProgram";

export interface RouteSetTerminalReceiptV1 {
  readonly kind: "aloha.route-set-terminal-v1";
  readonly outcome: RouteSetTerminalOutcomeV1;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly cutoff: ResolvedRoutePipelineInputV1["lease"]["binding"]["cutoff"];
  readonly graphRoot: Hash;
  readonly objectiveRef: Hash;
  readonly source: SourceViewV1;
  readonly accounting: RouteAccountingV1;
  readonly accountingRoot: Hash;
  readonly signer: null;
  readonly transactionHash: null;
  readonly lineageHash: Hash;
}

export interface SearchTerminalCapabilityV1 {
  readonly __searchTerminalCapabilityV1?: never;
}

export interface RouteCoarseTimingFactsV1 {
  readonly kind: "aloha.route-coarse-timing-facts-v1";
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: SourceViewV1;
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly admissionPolicyHash: Hash;
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly durationUs: string;
  readonly timingRoot: Hash;
}

export type IssuedSearchTerminalV1 =
  | Readonly<{
    readonly kind: "unsigned-dry-run";
    readonly receipt: UnsignedDryRunReceiptV1;
    readonly accounting: RouteAccountingV1;
  }>
  | Readonly<{
    readonly kind: "route-set-terminal";
    readonly receipt: RouteSetTerminalReceiptV1;
  }>;

export type RoutePipelineOutcomeV1<Simulation> =
  | {
    readonly kind: "unsigned-dry-run";
    readonly receipt: UnsignedDryRunReceiptV1;
    readonly accounting: RouteAccountingV1;
    readonly terminalCapability: SearchTerminalCapabilityV1;
    readonly schedulerResourceJoin: SearchSchedulerResourceJoinCapabilityV1 | null;
  }
  | {
    readonly kind: "route-set-terminal";
    readonly receipt: RouteSetTerminalReceiptV1;
    readonly terminalCapability: SearchTerminalCapabilityV1;
    readonly schedulerResourceJoin: null;
  }
  | StageTerminalFailureV1;

export interface SearchSixStepGraphLegV1 {
  readonly edgeId: Hash;
  readonly owningFamilyId: string;
  readonly owningFamilyDefinitionHash: Hash;
  readonly owningInstanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly staticProjectionHash: Hash;
  readonly projectionHash: Hash;
}

/**
 * Exact Stage 3-6 production trace retained by the successful terminal.
 * Stage 1/2 are intentionally not reconstructed here; the later evidence
 * owner must join these publication hashes to the checkpoint-owned ready
 * closure for the same readyRecordHash.
 */
export interface SearchTerminalSixStepTraceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.search-terminal-six-step-trace-v1";
  readonly strategyCompositionRoot: Hash;
  readonly planningProblem: CanonicalJson;
  readonly planningProblemHash: Hash;
  readonly routeCandidate: CanonicalJson;
  readonly selectedGraphLegs: readonly SearchSixStepGraphLegV1[];
  readonly admission: Readonly<{
    readonly topK: string;
    readonly boundedUnrankedBudget: string;
    readonly admissionPolicyHash: Hash;
    readonly enumerationRoot: Hash;
    readonly accountingRoot: Hash;
  }>;
  readonly resolved: ResolvedRouteSixStepTraceV1;
  readonly traceRoot: Hash;
}

/** One opaque, process-local observation of the exact planning invocation.
 * It is issued together with the search terminal; observers cannot select a
 * subset of attempts or combine terminals by passing arrays. */
export type NativeFullFamilyAuditCapabilityV1 = object;

export interface NativeFullFamilyAuditBindingV1 {
  readonly correlationId: Hash;
  readonly sourceSessionId: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly readyCutoff: RoutePipelineInputV1["lease"]["binding"]["cutoff"];
  readonly graphRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly actualCurrentSource: SourceViewV1;
  readonly planningProblemHash: Hash;
  readonly plannerEnumerationRoot: Hash;
  readonly bindingRoot: Hash;
}

export interface NativeFullFamilyCoarseLegFactV1 {
  readonly searchAuditBindingRoot: Hash;
  readonly candidateId: Hash;
  readonly routeHash: Hash;
  readonly routeBindingHash: Hash;
  readonly legIndex: string;
  readonly edgeId: Hash;
  readonly owningFamilyId: string;
  readonly owningFamilyDefinitionHash: Hash;
  readonly owningInstanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly projectionHash: Hash;
  readonly receipt: QualifiedCoarseProjectionReceiptV1 | null;
  readonly familyObservation: CanonicalJson | null;
  readonly factRoot: Hash;
}

export interface NativeFullFamilyCoarseRouteFactV1 {
  readonly searchAuditBindingRoot: Hash;
  readonly candidateId: Hash;
  readonly routeHash: Hash;
  readonly routeBindingHash: Hash;
  readonly assessment: CoarseRouteAssessmentV1 | null;
  readonly legs: readonly NativeFullFamilyCoarseLegFactV1[];
  readonly routeFactRoot: Hash;
}

/** Exact Graph edge denominator owned by the active lease. Route attempts may
 * observe only a subset; the missing set stays explicit and cannot be
 * confused with a complete full-Graph coarse sweep. */
export interface NativeFullFamilyProjectedEdgeFactV1 {
  readonly searchAuditBindingRoot: Hash;
  readonly edge: PersistedGraphEdgeV1;
  readonly edgeId: Hash;
  readonly owningFamilyId: string;
  readonly owningFamilyDefinitionHash: Hash;
  readonly owningInstanceKey: string;
  readonly instancePublicationHash: Hash;
  readonly projectionHash: Hash;
  readonly factRoot: Hash;
}

export interface NativeFullFamilyActionLineageFactV1 {
  readonly searchAuditBindingRoot: Hash;
  readonly candidateId: Hash;
  readonly routeHash: Hash;
  readonly orderedEdgeIds: readonly Hash[];
  readonly executionProgramOwnerEvidence: ExecutionProgramSixStepEvidenceV1;
  readonly factRoot: Hash;
}

export interface NativeFullFamilyAuditV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.native-full-family-audit-v1";
  readonly binding: NativeFullFamilyAuditBindingV1;
  readonly expectedCandidateCount: string;
  readonly expectedLegCount: string;
  readonly observedReceiptCount: string;
  readonly missingLegKeys: readonly Hash[];
  readonly expectedProjectedEdgeCount: string;
  readonly observedProjectedEdgeCount: string;
  readonly missingProjectedEdgeIds: readonly Hash[];
  readonly expectedActionLineageCount: string;
  readonly observedActionLineageCount: string;
  readonly missingActionCandidateIds: readonly Hash[];
  readonly denominatorRoot: Hash;
  readonly observedReceiptRoot: Hash;
  readonly missingLegRoot: Hash;
  readonly projectedEdgeDenominatorRoot: Hash;
  readonly missingProjectedEdgeRoot: Hash;
  readonly actionDenominatorRoot: Hash;
  readonly actionObservedRoot: Hash;
  readonly coarseRoutes: readonly NativeFullFamilyCoarseRouteFactV1[];
  readonly projectedEdges: readonly NativeFullFamilyProjectedEdgeFactV1[];
  readonly actionLineage: readonly NativeFullFamilyActionLineageFactV1[];
  readonly auditRoot: Hash;
}

type PreparedRoute<Projection> = {
  readonly candidate: PlannedRouteCandidateV1;
  readonly startedMonotonicNs: bigint;
  readonly route: RouteCapabilityV1;
  readonly selections: readonly RouteSelectionV1[];
  readonly assessmentCapability: IssuedCoarseRouteAssessmentV1 | null;
  readonly coarse: CoarseRankableV1<Projection> | CoarseBoundedUnrankedV1;
  readonly lane: "rankable" | "bounded-unranked";
};

type PreparedAssessmentRoute = {
  readonly candidate: PlannedRouteCandidateV1;
  readonly startedMonotonicNs: bigint;
  readonly route: RouteCapabilityV1;
  readonly selections: readonly RouteSelectionV1[];
  readonly bindingCapability: IssuedCoarseRouteBindingV1;
  readonly assessmentCapability: IssuedCoarseRouteAssessmentV1 | null;
  readonly attemptEvidence: RouteCoarseAttemptEvidenceV1 | null;
};

type MutableAccounting = {
  readonly candidate: PlannedRouteCandidateV1;
  readonly startedMonotonicNs: bigint;
  finishedMonotonicNs: bigint | null;
  disposition: RouteDispositionV1;
  terminalKind: RouteTerminalKindV1;
  routeHash: Hash | null;
  reasonCode: string | null;
  evidenceHash: Hash | null;
  policyTerminal: RoutePolicyTerminalReceiptV1 | null;
};

class RouteContextUnavailableError extends Error {}

interface IssuedSearchTerminalStateV1 {
  readonly terminal: IssuedSearchTerminalV1;
  readonly plannerEnumeration: IssuedPlanningEnumerationV1;
  readonly schedulerResourceJoin: SearchSchedulerResourceJoinCapabilityV1 | null;
  readonly sixStepTrace: SearchTerminalSixStepTraceV1 | null;
  readonly sixStepArtifacts: ProductionSixStepArtifactCapabilitiesV1 | null;
  readonly coarseTiming: RouteCoarseTimingFactsV1;
  readonly candidateTerminalTimings: readonly RouteCandidateTerminalTimingFactsV1[];
  readonly nativeFullFamilyAudit: NativeFullFamilyAuditCapabilityV1;
}

const issuedSearchTerminals = new WeakMap<object, IssuedSearchTerminalStateV1>();
const issuedNativeFullFamilyAudits = new WeakMap<object, NativeFullFamilyAuditV1>();

function issueNativeFullFamilyAudit(value: Omit<NativeFullFamilyAuditV1, "auditRoot">): NativeFullFamilyAuditCapabilityV1 {
  const audit = deepFreeze({
    ...value,
    auditRoot: hashDomain("aloha/native-full-family-audit/v1", value as unknown as CanonicalJson),
  });
  const capability = Object.freeze(Object.create(null)) as NativeFullFamilyAuditCapabilityV1;
  issuedNativeFullFamilyAudits.set(capability, audit);
  return capability;
}

function issueSearchTerminalCapability(
  value: IssuedSearchTerminalV1,
  plannerEnumeration: IssuedPlanningEnumerationV1,
  schedulerResourceJoin: SearchSchedulerResourceJoinCapabilityV1 | null,
  sixStepTrace: SearchTerminalSixStepTraceV1 | null,
  sixStepArtifacts: ProductionSixStepArtifactCapabilitiesV1 | null,
  coarseTiming: RouteCoarseTimingFactsV1,
  candidateTerminalTimings: readonly RouteCandidateTerminalTimingFactsV1[],
  nativeFullFamilyAudit: NativeFullFamilyAuditCapabilityV1,
): SearchTerminalCapabilityV1 {
  if (value.kind === "unsigned-dry-run") {
    if (sixStepTrace === null) throw new TypeError("search terminal six-step trace is missing");
    if (sixStepArtifacts === null
      || sixStepArtifacts.stage1.length === 0
      || sixStepArtifacts.stage1.length !== sixStepArtifacts.stage2.length) {
      throw new TypeError("search terminal production Six-Step artifacts are missing");
    }
    assertSearchTerminalSixStepTrace(sixStepTrace, value.receipt);
  } else if (sixStepTrace !== null || sixStepArtifacts !== null) {
    throw new TypeError("non-success search terminal cannot carry a six-step trace");
  }
  const binding = value.receipt;
  const accounting = value.kind === "unsigned-dry-run" ? value.accounting : value.receipt.accounting;
  const enumeration = readIssuedPlanningEnumerationV1(plannerEnumeration);
  const enumeratedById = new Map(enumeration.candidates.map(candidate => [candidate.candidateId, candidate] as const));
  if (enumeration.planningProblemHash !== accounting.planningProblemHash
    || enumeration.enumerationRoot !== accounting.enumerationRoot
    || enumeration.graphRoot !== binding.graphRoot
    || enumeration.truncated !== accounting.enumerationTruncated
    || enumeration.observedUniqueCountLowerBound !== accounting.observedUniqueCountLowerBound
    || enumeration.candidates.length !== accounting.total
    || enumeration.candidates.length !== accounting.entries.length
    || enumeratedById.size !== enumeration.candidates.length) {
    throw new TypeError("search terminal planner enumeration denominator mismatch");
  }
  for (const entry of accounting.entries) {
    const candidate = enumeratedById.get(entry.candidateId);
    if (candidate === undefined
      || encodeCanonicalJson(candidate.legs) !== encodeCanonicalJson(entry.legs)) {
      throw new TypeError("search terminal planner enumeration candidate mismatch");
    }
  }
  if (coarseTiming.correlationId !== binding.correlationId
    || coarseTiming.generationId !== binding.generationId
    || coarseTiming.graphRoot !== binding.graphRoot
    || coarseTiming.source.chainId !== binding.source.chainId
    || coarseTiming.source.number !== binding.source.number
    || coarseTiming.source.hash !== binding.source.hash
    || coarseTiming.source.stateRoot !== binding.source.stateRoot
    || coarseTiming.planningProblemHash !== accounting.planningProblemHash
    || coarseTiming.enumerationRoot !== accounting.enumerationRoot
    || coarseTiming.admissionPolicyHash !== accounting.admissionPolicyHash) {
    throw new TypeError("search terminal coarse timing binding mismatch");
  }
  if (candidateTerminalTimings.length !== accounting.entries.length) {
    throw new TypeError("search terminal candidate timing denominator mismatch");
  }
  for (const [index, entry] of accounting.entries.entries()) {
    const timing = candidateTerminalTimings[index];
    if (timing === undefined
      || timing.candidateId !== entry.candidateId
      || timing.correlationId !== binding.correlationId
      || timing.generationId !== binding.generationId
      || timing.graphRoot !== binding.graphRoot
      || timing.planningProblemHash !== accounting.planningProblemHash
      || timing.enumerationRoot !== accounting.enumerationRoot
      || timing.admissionPolicyHash !== accounting.admissionPolicyHash
      || timing.disposition !== entry.disposition
      || timing.terminalKind !== entry.terminalKind
      || timing.routeHash !== entry.routeHash
      || timing.reasonCode !== entry.reasonCode
      || timing.policyTerminal?.receiptHash !== entry.policyTerminal?.receiptHash) {
      throw new TypeError("search terminal candidate timing accounting mismatch");
    }
    if (entry.terminalKind === "passed") {
      if (sixStepTrace === null
        || timing.evidenceHash !== binding.lineageHash
        || timing.terminalLineageHash !== binding.lineageHash
        || timing.sixStepEvidenceRoot !== sixStepTrace.traceRoot) {
        throw new TypeError("search terminal passed candidate timing lineage mismatch");
      }
    } else if (timing.evidenceHash !== entry.evidenceHash
      || timing.terminalLineageHash !== null
      || timing.sixStepEvidenceRoot !== null) {
      throw new TypeError("search terminal non-passed candidate timing evidence mismatch");
    }
  }
  if (!issuedNativeFullFamilyAudits.has(nativeFullFamilyAudit)) {
    throw new TypeError("native full-family audit capability was not issued");
  }
  const capability = Object.freeze(Object.create(null)) as SearchTerminalCapabilityV1;
  issuedSearchTerminals.set(capability, Object.freeze({ terminal: deepFreeze(value), plannerEnumeration, schedulerResourceJoin, sixStepTrace, sixStepArtifacts, coarseTiming, candidateTerminalTimings, nativeFullFamilyAudit }));
  return capability;
}

function sealRouteCoarseTimingFacts(input: {
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly source: SourceViewV1;
  readonly planningProblemHash: Hash;
  readonly enumerationRoot: Hash;
  readonly admissionPolicyHash: Hash;
  readonly startedMonotonicNs: bigint;
  readonly finishedMonotonicNs: bigint;
}): RouteCoarseTimingFactsV1 {
  if (input.finishedMonotonicNs < input.startedMonotonicNs) throw new TypeError("route coarse monotonic clock regressed");
  const payload = deepFreeze({
    kind: "aloha.route-coarse-timing-facts-v1" as const,
    correlationId: input.correlationId,
    generationId: input.generationId,
    graphRoot: input.graphRoot,
    source: input.source,
    planningProblemHash: input.planningProblemHash,
    enumerationRoot: input.enumerationRoot,
    admissionPolicyHash: input.admissionPolicyHash,
    startedMonotonicNs: input.startedMonotonicNs.toString(),
    finishedMonotonicNs: input.finishedMonotonicNs.toString(),
    durationUs: ((input.finishedMonotonicNs - input.startedMonotonicNs) / 1_000n).toString(),
  });
  return deepFreeze({ ...payload, timingRoot: hashDomain("aloha/route-coarse-timing-facts/v1", payload) });
}

function canonicalSnapshot(value: unknown, path: string): CanonicalJson {
  try {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function searchTerminalSixStepTracePayload(
  value: Omit<SearchTerminalSixStepTraceV1, "traceRoot">,
): CanonicalJson {
  return value as unknown as CanonicalJson;
}

function sealSearchTerminalSixStepTrace(
  value: Omit<SearchTerminalSixStepTraceV1, "traceRoot">,
): SearchTerminalSixStepTraceV1 {
  return deepFreeze({
    ...value,
    traceRoot: hashDomain("aloha/search-terminal-six-step-trace/v1", searchTerminalSixStepTracePayload(value)),
  });
}

function assertSearchTerminalSixStepTrace(
  trace: SearchTerminalSixStepTraceV1,
  receipt: UnsignedDryRunReceiptV1,
): void {
  const { traceRoot: _traceRoot, ...payload } = trace;
  if (trace.traceRoot !== hashDomain("aloha/search-terminal-six-step-trace/v1", searchTerminalSixStepTracePayload(payload))) {
    throw new TypeError("search terminal six-step trace root mismatch");
  }
  if (trace.resolved.routeCandidateId !== receipt.candidateId
    || trace.resolved.correlationId !== receipt.correlationId
    || trace.resolved.source.hash !== receipt.source.hash
    || trace.resolved.traceRoot.length === 0
    || encodeCanonicalJson(trace.resolved.unsignedDryRun) !== encodeCanonicalJson(receipt)) {
    throw new TypeError("search terminal six-step trace receipt mismatch");
  }
}

/**
 * Read-only narrow consumer boundary.  There is intentionally no public DTO
 * issuer: only `runSearchPipeline` can place a capability in this WeakMap.
 */
export function readIssuedSearchTerminalCapabilityV1(value: unknown): IssuedSearchTerminalV1 {
  if (value === null || typeof value !== "object") throw new TypeError("search terminal capability is required");
  assertExactKeys(value, [], "searchTerminalCapability");
  const state = issuedSearchTerminals.get(value);
  if (state === undefined) throw new TypeError("search terminal capability was not issued");
  return state.terminal;
}

export function readIssuedSearchTerminalCoarseTimingV1(
  terminalCapability: SearchTerminalCapabilityV1,
): RouteCoarseTimingFactsV1 {
  if (terminalCapability === null || typeof terminalCapability !== "object") {
    throw new TypeError("search terminal capability is required");
  }
  assertExactKeys(terminalCapability, [], "searchTerminalCapability");
  const state = issuedSearchTerminals.get(terminalCapability);
  if (state === undefined) throw new TypeError("search terminal capability was not issued");
  return state.coarseTiming;
}

export function readIssuedSearchTerminalCandidateTimingsV1(
  terminalCapability: SearchTerminalCapabilityV1,
): readonly RouteCandidateTerminalTimingFactsV1[] {
  if (terminalCapability === null || typeof terminalCapability !== "object") {
    throw new TypeError("search terminal capability is required");
  }
  assertExactKeys(terminalCapability, [], "searchTerminalCapability");
  const state = issuedSearchTerminals.get(terminalCapability);
  if (state === undefined) throw new TypeError("search terminal capability was not issued");
  return state.candidateTerminalTimings;
}

/** Planner-owned full route denominator retained by the exact terminal.  The
 * returned value is re-read through the planner WeakMap; a terminal/accounting
 * DTO cannot manufacture or replace it. */
export function readIssuedSearchTerminalPlannerEnumerationV1(
  terminalCapability: SearchTerminalCapabilityV1,
): PlanningEnumerationV1 {
  if (terminalCapability === null || typeof terminalCapability !== "object") {
    throw new TypeError("search terminal capability is required");
  }
  assertExactKeys(terminalCapability, [], "searchTerminalCapability");
  const state = issuedSearchTerminals.get(terminalCapability);
  if (state === undefined) throw new TypeError("search terminal capability was not issued");
  const enumeration = readIssuedPlanningEnumerationV1(state.plannerEnumeration);
  const accounting = state.terminal.kind === "unsigned-dry-run"
    ? state.terminal.accounting
    : state.terminal.receipt.accounting;
  if (enumeration.enumerationRoot !== accounting.enumerationRoot
    || enumeration.planningProblemHash !== accounting.planningProblemHash
    || enumeration.candidates.length !== accounting.entries.length) {
    throw new TypeError("search terminal planner enumeration no longer binds its accounting");
  }
  return enumeration;
}

/** Recover the single invocation-closed audit capability retained by this
 * terminal.  There is no API accepting caller-selected terminal/attempt sets. */
export function readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1(
  terminalCapability: SearchTerminalCapabilityV1,
): NativeFullFamilyAuditCapabilityV1 {
  if (terminalCapability === null || typeof terminalCapability !== "object") {
    throw new TypeError("search terminal capability is required");
  }
  assertExactKeys(terminalCapability, [], "searchTerminalCapability");
  const state = issuedSearchTerminals.get(terminalCapability);
  if (state === undefined) throw new TypeError("search terminal capability was not issued");
  return state.nativeFullFamilyAudit;
}

export function readIssuedNativeFullFamilyAuditV1(
  capability: NativeFullFamilyAuditCapabilityV1,
): NativeFullFamilyAuditV1 {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("native full-family audit capability is required");
  }
  assertExactKeys(capability, [], "nativeFullFamilyAuditCapability");
  const audit = issuedNativeFullFamilyAudits.get(capability);
  if (audit === undefined) throw new TypeError("native full-family audit capability was not issued");
  const { auditRoot: _auditRoot, ...payload } = audit;
  if (audit.auditRoot !== hashDomain("aloha/native-full-family-audit/v1", payload as unknown as CanonicalJson)) {
    throw new TypeError("native full-family audit identity mismatch");
  }
  return audit;
}

/**
 * Six-step evidence narrow reader. A JSON clone, a structurally equivalent
 * receipt, or a terminal issued for a non-success outcome has no trace.
 */
export function readIssuedSearchTerminalSixStepTraceV1(
  terminalCapability: SearchTerminalCapabilityV1,
): SearchTerminalSixStepTraceV1 {
  if (terminalCapability === null || typeof terminalCapability !== "object") {
    throw new TypeError("search terminal capability is required");
  }
  assertExactKeys(terminalCapability, [], "searchTerminalCapability");
  const state = issuedSearchTerminals.get(terminalCapability);
  if (state === undefined || state.terminal.kind !== "unsigned-dry-run" || state.sixStepTrace === null) {
    throw new TypeError("search terminal six-step trace was not issued");
  }
  assertSearchTerminalSixStepTrace(state.sixStepTrace, state.terminal.receipt);
  return state.sixStepTrace;
}

export function readIssuedSearchTerminalSixStepArtifactCapabilitiesV1(
  terminalCapability: SearchTerminalCapabilityV1,
): ProductionSixStepArtifactCapabilitiesV1 {
  if (terminalCapability === null || typeof terminalCapability !== "object") throw new TypeError("search terminal capability is required");
  assertExactKeys(terminalCapability, [], "searchTerminalCapability");
  const state = issuedSearchTerminals.get(terminalCapability);
  if (state === undefined) throw new TypeError("search terminal capability was not issued");
  if (state.sixStepArtifacts === null) throw new TypeError("search terminal production Six-Step artifacts were not issued");
  return state.sixStepArtifacts;
}

/**
 * Production-evidence narrow reader. The exact terminal capability retains
 * its owner-issued join internally; callers cannot provide or substitute a
 * second capability. Route-set and policy/rejection terminals have no join.
 */
export function readIssuedSearchTerminalSchedulerResourceJoinV1(
  terminalCapability: SearchTerminalCapabilityV1,
): SearchSchedulerResourceJoinV1 | null {
  if (terminalCapability === null || typeof terminalCapability !== "object") {
    throw new TypeError("search terminal capability is required");
  }
  const state = issuedSearchTerminals.get(terminalCapability);
  if (state === undefined) throw new TypeError("search terminal capability was not issued");
  if (state.terminal.kind !== "unsigned-dry-run" || state.schedulerResourceJoin === null) {
    return null;
  }
  const join = readSearchSchedulerResourceJoin(state.schedulerResourceJoin);
  if (join.correlationId !== state.terminal.receipt.correlationId
    || join.generationId !== state.terminal.receipt.generationId
    || join.source.chainId !== state.terminal.receipt.source.chainId
    || join.source.number !== state.terminal.receipt.source.number
    || join.source.hash !== state.terminal.receipt.source.hash
    || join.source.stateRoot !== state.terminal.receipt.source.stateRoot
    || join.programHash !== state.terminal.receipt.programHash
    || join.finalSimulationReceiptHash !== state.terminal.receipt.finalSimulationReceiptHash
    || join.unsignedDryRunCandidateId !== state.terminal.receipt.candidateId
    || join.unsignedDryRunLineageHash !== state.terminal.receipt.lineageHash) {
    throw new TypeError("scheduler resource join no longer binds its search terminal");
  }
  return join;
}

function isStageFailure(value: unknown): value is StageTerminalFailureV1 {
  return value !== null
    && typeof value === "object"
    && "kind" in value
    && ["retryable", "invalidProgram", "chainProvenRejected"].includes((value as { kind?: unknown }).kind as string);
}

function sameSource(left: SourceViewV1, right: SourceViewV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function findEdge(lease: SearchGraphLeaseV1, edgeId: Hash): RuntimeGraphEdgeV1 {
  const edge = lease.edges.find(value => value.edgeId === edgeId);
  if (!edge) throw new TypeError("route-candidate-edge-not-in-lease");
  return edge;
}

function validateCandidate(
  candidate: PlannedRouteCandidateV1,
  problem: StrategyPlanningProblemV1,
  lease: SearchGraphLeaseV1,
): void {
  assertExactKeys(candidate, ["candidateId", "planningProblemHash", "legs", "loopIntent", "orderKey"], "routeCandidate");
  assertHash(candidate.candidateId, "routeCandidate.candidateId");
  assertHash(candidate.orderKey, "routeCandidate.orderKey");
  if (candidate.planningProblemHash !== problem.problemHash) throw new TypeError("route candidate planning problem mismatch");
  if (!Array.isArray(candidate.legs) || candidate.legs.length < 2) throw new TypeError("route candidate has too few legs");
  const edgeIds = candidate.legs.map((leg, index) => {
    assertExactKeys(leg, ["edgeId", "transitionRef", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef"], `routeCandidate.legs[${index}]`);
    const edgeId = assertHash(leg.edgeId, `routeCandidate.legs[${index}].edgeId`);
    const edge = findEdge(lease, edgeId);
    const transitionRef = assertHash(leg.transitionRef, `routeCandidate.legs[${index}].transitionRef`);
    const inputAssetRef = assertHash(leg.inputAssetRef, `routeCandidate.legs[${index}].inputAssetRef`);
    const inputPortRef = assertHash(leg.inputPortRef, `routeCandidate.legs[${index}].inputPortRef`);
    const outputAssetRef = assertHash(leg.outputAssetRef, `routeCandidate.legs[${index}].outputAssetRef`);
    const outputPortRef = assertHash(leg.outputPortRef, `routeCandidate.legs[${index}].outputPortRef`);
    if (edge.opaqueTransitionRef !== transitionRef) throw new TypeError("route candidate transition is not on Graph edge");
    if (!edge.inputAssetPorts.some(port => port.assetRef === inputAssetRef && port.portRef === inputPortRef)) throw new TypeError("route candidate input port is not on Graph edge");
    if (!edge.outputAssetPorts.some(port => port.assetRef === outputAssetRef && port.portRef === outputPortRef)) throw new TypeError("route candidate output port is not on Graph edge");
    const next = candidate.legs[(index + 1) % candidate.legs.length]!;
    if (outputAssetRef !== next.inputAssetRef) throw new TypeError("route candidate asset continuity mismatch");
    return edgeId;
  });
  if (new Set(edgeIds).size !== edgeIds.length) throw new TypeError("route candidate contains duplicate edges");
  const candidatePayload = {
    planningProblemHash: problem.problemHash,
    objectiveRef: problem.objectiveRef,
    entryAssetRef: problem.entryAssetRef,
    returnAssetRef: problem.returnAssetRef,
    legs: candidate.legs,
  };
  if (candidate.candidateId !== hashDomain("aloha/planner-route-candidate/v1", candidatePayload)) throw new TypeError("route candidate hash mismatch");
  if (candidate.orderKey !== hashDomain("aloha/planner-route-order/v1", candidatePayload)) throw new TypeError("route candidate order key mismatch");
  assertExactKeys(candidate.loopIntent, ["kind", "entryAssetRef", "returnAssetRef", "objectiveRef", "constraintSchemaRefs", "legs"], "routeCandidate.loopIntent");
  if (candidate.loopIntent.kind !== "closed-loop"
    || candidate.loopIntent.entryAssetRef !== candidate.legs[0]!.inputAssetRef
    || candidate.loopIntent.returnAssetRef !== candidate.legs[0]!.inputAssetRef
    || candidate.loopIntent.objectiveRef !== problem.objectiveRef
    || candidate.loopIntent.legs.length !== candidate.legs.length
    || hashDomain("aloha/planner-constraint-set/v1", candidate.loopIntent.constraintSchemaRefs) !== hashDomain("aloha/planner-constraint-set/v1", problem.constraintSchemaRefs)) {
    throw new TypeError("route candidate loop intent mismatch");
  }
  for (const [index, intentLeg] of candidate.loopIntent.legs.entries()) {
    const leg = candidate.legs[index]!;
    assertExactKeys(intentLeg, ["fromAssetRef", "toAssetRef", "selectionRef", "requiredCapabilityPredicates"], `routeCandidate.loopIntent.legs[${index}]`);
    if (intentLeg.fromAssetRef !== leg.inputAssetRef
      || intentLeg.toAssetRef !== leg.outputAssetRef
      || intentLeg.selectionRef !== hashDomain("aloha/planner-route-selection/v1", leg)
      || hashDomain("aloha/planner-capability-set/v1", intentLeg.requiredCapabilityPredicates) !== hashDomain("aloha/planner-capability-set/v1", problem.requiredCapabilityPredicates)) {
      throw new TypeError("route candidate loop leg mismatch");
    }
  }
}

function routeSelection(edge: RuntimeGraphEdgeV1, leg: PlannedRouteLegV1, issuedHandle: IssuedRouteHandle): RouteSelectionV1 {
  const inputAssetPort = edge.inputAssetPorts.find(port => port.assetRef === leg.inputAssetRef && port.portRef === leg.inputPortRef);
  const outputAssetPort = edge.outputAssetPorts.find(port => port.assetRef === leg.outputAssetRef && port.portRef === leg.outputPortRef);
  if (inputAssetPort === undefined || outputAssetPort === undefined) throw new TypeError("route-candidate-port-not-in-lease");
  return deepFreeze({
    edgeId: assertHash(edge.edgeId, "route.edgeId"),
    inputAssetPort,
    outputAssetPort,
    opaqueTransitionRef: assertHash(edge.opaqueTransitionRef, "route.opaqueTransitionRef"),
    constraintRefs: Object.freeze([...edge.constraintRefs]),
    ownerDefinitionRef: assertHash(edge.owningFamilyDefinitionHash, "route.ownerDefinitionRef"),
    graphRouteHandle: edge.routeHandle,
    issuedHandle,
  });
}

async function prepareRoute(
  ports: RoutePipelinePortsV1<unknown, unknown, unknown, unknown>,
  input: RoutePipelineInputV1,
  candidate: PlannedRouteCandidateV1,
): Promise<{ readonly route: RouteCapabilityV1; readonly selections: readonly RouteSelectionV1[] }> {
  const selections: RouteSelectionV1[] = [];
  for (const leg of candidate.legs) {
    const edge = findEdge(input.lease, leg.edgeId);
    const issuedHandle = await input.lease.resolveRouteHandle(edge.edgeId, edge.routeHandle);
    selections.push(routeSelection(edge, leg, issuedHandle));
  }
  const route = await ports.route.resolve({ candidate, selections: Object.freeze(selections) });
  validateRouteCapability(route, candidate.legs.map(leg => leg.edgeId), selections.map(selection => selection.issuedHandle));
  return { route, selections: Object.freeze(selections) };
}

function failureFacts(value: StageTerminalFailureV1): { readonly reasonCode: string; readonly evidenceHash: Hash | null } {
  return {
    reasonCode: `${value.stage}:${value.code}`,
    evidenceHash: value.kind === "chainProvenRejected" ? value.evidenceHash : null,
  };
}

function admissionPolicyHash(policy: RouteAdmissionPolicyV1): Hash {
  return hashDomain("aloha/route-admission-policy/v1", {
    topK: policy.topK,
    boundedUnrankedBudget: policy.boundedUnrankedBudget,
  });
}

function admissionPolicyTerminalReceipt(
  policy: RouteAdmissionPolicyV1,
  enumeration: PlanningEnumerationV1,
  candidate: PlannedRouteCandidateV1,
  routeHash: Hash,
  lane: "rankable" | "bounded-unranked",
): RoutePolicyRejectionReceiptV1 {
  const body = {
    kind: "aloha.route-policy-rejection-v1" as const,
    policyKind: lane === "rankable" ? "rankable-top-k" as const : "bounded-unranked-budget" as const,
    admissionPolicyHash: admissionPolicyHash(policy),
    planningProblemHash: enumeration.planningProblemHash,
    enumerationRoot: enumeration.enumerationRoot,
    candidateId: candidate.candidateId,
    candidateOrderKey: candidate.orderKey,
    routeHash,
  };
  return deepFreeze({ ...body, receiptHash: hashDomain("aloha/route-policy-rejection-receipt/v1", body) });
}

function postSuccessPolicyTerminalReceipt(input: {
  readonly policy: RouteAdmissionPolicyV1;
  readonly enumeration: PlanningEnumerationV1;
  readonly winnerCandidateId: Hash;
  readonly winnerTerminalLineageHash: Hash;
  readonly candidateId: Hash;
  readonly routeHash: Hash;
  readonly decisionMonotonicNs: bigint;
}): RoutePostSuccessPolicyTerminalReceiptV1 {
  const body = deepFreeze({
    kind: "aloha.route-post-success-policy-terminal-v1" as const,
    policyKind: "post-success-first-eligible" as const,
    admissionPolicyHash: admissionPolicyHash(input.policy),
    planningProblemHash: input.enumeration.planningProblemHash,
    enumerationRoot: input.enumeration.enumerationRoot,
    winnerCandidateId: input.winnerCandidateId,
    winnerTerminalLineageHash: input.winnerTerminalLineageHash,
    candidateId: input.candidateId,
    routeHash: input.routeHash,
    decisionMonotonicNs: input.decisionMonotonicNs.toString(),
  });
  return deepFreeze({
    ...body,
    receiptHash: hashDomain("aloha/route-post-success-policy-terminal-receipt/v1", body),
  });
}

function makeAccounting(
  records: readonly MutableAccounting[],
  enumeration: PlanningEnumerationV1,
  policy: RouteAdmissionPolicyV1,
): RouteAccountingV1 {
  const entries = records.map(record => Object.freeze({
    candidateId: record.candidate.candidateId,
    legs: Object.freeze(record.candidate.legs.map(leg => Object.freeze({ ...leg }))),
    disposition: record.disposition,
    terminalKind: record.terminalKind,
    routeHash: record.routeHash,
    reasonCode: record.reasonCode,
    evidenceHash: record.evidenceHash,
    policyTerminal: record.policyTerminal,
  })).sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0);
  const total = entries.length;
  const selected = entries.filter(value => value.disposition === "selected").length;
  const pruned = entries.filter(value => value.disposition === "pruned").length;
  const notProbed = entries.filter(value => value.disposition === "notProbed").length;
  const failed = entries.filter(value => value.disposition === "failed").length;
  if (selected + pruned + notProbed + failed !== total) throw new TypeError("route-accounting-denominator-mismatch");
  const planningProblemHash = enumeration.planningProblemHash;
  const enumerationRoot = enumeration.enumerationRoot;
  const policyHash = admissionPolicyHash(policy);
  const enumerationTruncated = enumeration.truncated;
  const observedUniqueCountLowerBound = enumeration.observedUniqueCountLowerBound;
  const root = hashDomain("aloha/route-accounting/v1", { planningProblemHash, enumerationRoot, admissionPolicyHash: policyHash, enumerationTruncated, observedUniqueCountLowerBound, total, selected, pruned, notProbed, failed, entries });
  return deepFreeze({ planningProblemHash, enumerationRoot, admissionPolicyHash: policyHash, enumerationTruncated, observedUniqueCountLowerBound, total, selected, pruned, notProbed, failed, entries, root });
}

function sealRouteCandidateTerminalTimings(
  records: readonly MutableAccounting[],
  accounting: RouteAccountingV1,
  input: RoutePipelineInputV1,
  terminalLineageHash: Hash,
  sixStepTrace: SearchTerminalSixStepTraceV1 | null,
): readonly RouteCandidateTerminalTimingFactsV1[] {
  const recordsByCandidate = new Map(records.map(record => [record.candidate.candidateId, record] as const));
  const passed = accounting.entries.filter(entry => entry.terminalKind === "passed");
  if ((sixStepTrace === null && passed.length !== 0) || (sixStepTrace !== null && passed.length !== 1)) {
    throw new TypeError("candidate timing passed evidence mismatch");
  }
  return Object.freeze(accounting.entries.map(entry => {
    const record = recordsByCandidate.get(entry.candidateId);
    if (record === undefined || record.finishedMonotonicNs === null) {
      throw new TypeError("candidate timing terminal boundary is missing");
    }
    if (record.finishedMonotonicNs < record.startedMonotonicNs) {
      throw new TypeError("candidate timing monotonic clock regressed");
    }
    const payload = deepFreeze({
      kind: "aloha.route-candidate-terminal-timing-facts-v1" as const,
      correlationId: input.correlationId,
      generationId: input.lease.binding.generationId,
      graphRoot: input.lease.binding.graphRoot,
      planningProblemHash: accounting.planningProblemHash,
      enumerationRoot: accounting.enumerationRoot,
      admissionPolicyHash: accounting.admissionPolicyHash,
      candidateId: entry.candidateId,
      disposition: entry.disposition,
      terminalKind: entry.terminalKind,
      routeHash: entry.routeHash,
      reasonCode: entry.reasonCode,
      evidenceHash: entry.terminalKind === "passed" ? terminalLineageHash : entry.evidenceHash,
      policyTerminal: entry.policyTerminal,
      terminalLineageHash: entry.terminalKind === "passed" ? terminalLineageHash : null,
      sixStepEvidenceRoot: entry.terminalKind === "passed" ? sixStepTrace!.traceRoot : null,
      startedMonotonicNs: record.startedMonotonicNs.toString(),
      finishedMonotonicNs: record.finishedMonotonicNs.toString(),
      timingUs: ((record.finishedMonotonicNs - record.startedMonotonicNs) / 1_000n).toString(),
    });
    return deepFreeze({
      ...payload,
      timingRoot: hashDomain("aloha/route-candidate-terminal-timing-facts/v1", payload),
    });
  }));
}

function sealRouteSetTerminalReceipt(
  input: RoutePipelineInputV1,
  source: SourceViewV1,
  accounting: RouteAccountingV1,
): RouteSetTerminalReceiptV1 {
  const terminalKinds = accounting.entries.map(entry => entry.terminalKind);
  const outcome: RouteSetTerminalOutcomeV1 = terminalKinds.includes("invalidProgram")
    ? "invalidProgram"
    : accounting.enumerationTruncated
        || terminalKinds.includes("retryable")
        || terminalKinds.includes("not-run")
        || terminalKinds.includes("policyRejected")
      ? "retryable"
      : accounting.total === 0
        ? "complete-no-candidate"
        : "complete-candidates-terminal";
  const body = {
    kind: "aloha.route-set-terminal-v1" as const,
    outcome,
    correlationId: assertHash(input.correlationId, "correlationId"),
    generationId: input.lease.binding.generationId,
    readyRecordHash: input.lease.binding.readyRecordHash,
    cutoff: input.lease.binding.cutoff,
    graphRoot: input.lease.binding.graphRoot,
    objectiveRef: assertHash(input.objective.objectiveRef, "objective.objectiveRef"),
    source,
    accounting,
    accountingRoot: accounting.root,
    signer: null,
    transactionHash: null,
  };
  return deepFreeze({ ...body, lineageHash: hashDomain("aloha/route-set-terminal-lineage/v1", body) });
}

function coarseObjective(value: SearchObjectiveV1): CoarseAdmissionObjectiveV1 {
  assertPlainObject(value.payload, "objective.payload");
  assertExactKeys(value.payload, ["numeraireAssetRef", "minNetGain", "maxGas", "maxValueAtRisk"], "objective.payload");
  const payload = value.payload as Record<string, unknown>;
  assertDecimalString(payload.maxGas, "objective.payload.maxGas");
  assertDecimalString(payload.maxValueAtRisk, "objective.payload.maxValueAtRisk");
  return deepFreeze({
    objectiveRef: value.objectiveRef,
    numeraireAssetRef: assertHash(payload.numeraireAssetRef, "objective.payload.numeraireAssetRef"),
    minNetGain: assertDecimalString(payload.minNetGain, "objective.payload.minNetGain"),
    maxGas: assertDecimalString(payload.maxGas, "objective.payload.maxGas"),
    maxValueAtRisk: assertDecimalString(payload.maxValueAtRisk, "objective.payload.maxValueAtRisk"),
  });
}

function dependencySetRef(route: RouteCapabilityV1): Hash {
  return hashDomain("aloha/coarse-route-dependency-set/v1", route.legs.map(leg => ({
    edgeId: leg.edgeId,
    ownerRef: leg.ownerRef,
  })));
}

function issueRouteCoarseBinding(
  input: RoutePipelineInputV1,
  candidate: PlannedRouteCandidateV1,
  route: RouteCapabilityV1,
  selections: readonly RouteSelectionV1[],
  sourceView: SourceViewV1,
): IssuedCoarseRouteBindingV1 {
  if (selections.length !== candidate.legs.length) throw new TypeError("coarse-route-selection-denominator-mismatch");
  const ownerRefs = Object.freeze([...new Set(route.legs.map(leg => assertHash(leg.ownerRef, "route.leg.ownerRef")))].sort());
  return issueCoarseRouteBindingV1({
    candidateId: candidate.candidateId,
    orderKey: candidate.orderKey,
    planningProblemHash: candidate.planningProblemHash,
    routeHash: route.routeHash,
    routeBindingHash: route.routeBindingHash,
    dependencySetRef: dependencySetRef(route),
    ownerRefs,
    generationId: input.lease.binding.generationId,
    graphRoot: input.lease.binding.graphRoot,
    source: {
      chainId: sourceView.chainId,
      number: sourceView.number,
      hash: assertHash(sourceView.hash, "coarse.source.hash"),
      stateRoot: assertHash(sourceView.stateRoot, "coarse.source.stateRoot"),
    },
    objectiveRef: input.objective.objectiveRef,
    releaseProvenanceHash: input.lease.binding.releaseProvenanceHash,
    legs: Object.freeze(candidate.legs.map((leg, index) => Object.freeze({
      edgeId: leg.edgeId,
      transitionRef: assertHash(selections[index]!.opaqueTransitionRef, `coarse.route.legs[${index}].transitionRef`),
      inputAssetRef: leg.inputAssetRef,
      inputPortRef: leg.inputPortRef,
      outputAssetRef: leg.outputAssetRef,
      outputPortRef: leg.outputPortRef,
    }))),
  });
}

function admittedCoarse<Projection>(
  prepared: PreparedAssessmentRoute,
  entry: ReturnType<typeof admitCoarseRoutesV1>["entries"][number],
  sourceView: SourceViewV1,
): PreparedRoute<Projection> {
  if (entry.disposition !== "ranked-selected" && entry.disposition !== "bounded-unranked-selected") {
    throw new TypeError("coarse admission entry was not selected");
  }
  if (entry.disposition === "ranked-selected") {
    const assessment = readIssuedCoarseRouteAssessmentV1(prepared.assessmentCapability);
    if (assessment.status !== "rankable" || assessment.assessmentId !== entry.assessmentId || assessment.projectionRoot !== entry.projectionRoot) {
      throw new TypeError("ranked coarse assessment changed after admission");
    }
    const coarse: CoarseRankableV1<Projection> = deepFreeze({
      kind: "rankable",
      routeHash: prepared.route.routeHash,
      source: sourceView,
      projection: assessment as Projection,
      projectionHash: assessment.assessmentId,
      rankKey: hashDomain("aloha/coarse-admitted-rank/v1", { assessmentId: assessment.assessmentId, rankScore: assessment.rankScore }),
    });
    return deepFreeze({ ...prepared, coarse, lane: "rankable" as const });
  }
  const coarse: CoarseBoundedUnrankedV1 = deepFreeze({
    kind: "bounded-unranked",
    routeHash: prepared.route.routeHash,
    source: sourceView,
    reasonCode: entry.reasonCode,
    evidenceHash: entry.entryRoot,
  });
  return deepFreeze({ ...prepared, coarse, lane: "bounded-unranked" as const });
}

function validateCoarseAttemptEvidence(
  binding: CoarseRouteBindingV1,
  evidence: RouteCoarseAttemptEvidenceV1,
): readonly RouteCoarseLegAttemptEvidenceV1[] {
  if (encodeCanonicalJson(evidence.routeBinding) !== encodeCanonicalJson(binding)) {
    throw new TypeError("coarse attempt route binding mismatch");
  }
  if (!Array.isArray(evidence.attempts) || evidence.attempts.length > binding.legs.length) {
    throw new TypeError("coarse attempt receipt denominator overflow");
  }
  return deepFreeze(evidence.attempts.map((attempt, index) => {
    const leg = binding.legs[index];
    if (leg === undefined) throw new TypeError("coarse attempt receipt has no denominator leg");
    const receipt = attempt.receipt;
    const { receiptRoot, ...receiptBody } = receipt;
    if (receiptRoot !== qualifiedCoarseProjectionReceiptRootV1(receiptBody)) {
      throw new TypeError(`coarse attempt receipt ${index} root mismatch`);
    }
    const projection = receipt.projection;
    if (receipt.releaseProvenanceHash !== binding.releaseProvenanceHash
      || projection.edgeId !== leg.edgeId
      || projection.transitionRef !== leg.transitionRef
      || projection.routeBindingHash !== binding.routeBindingHash
      || projection.generationId !== binding.generationId
      || projection.graphRoot !== binding.graphRoot
      || !sameSource(projection.source, binding.source)
      || projection.objectiveRef !== binding.objectiveRef
      || projection.sampleInput.assetRef !== leg.inputAssetRef
      || (projection.estimatedOutput !== null && projection.estimatedOutput.assetRef !== leg.outputAssetRef)) {
      throw new TypeError(`coarse attempt receipt ${index} lineage mismatch`);
    }
    return deepFreeze({
      receipt,
      familyObservation: canonicalSnapshot(attempt.familyObservation, `coarseAttempt.familyObservation[${index}]`),
    });
  }));
}

function buildNativeFullFamilyAudit(
  input: RoutePipelineInputV1,
  sourceView: SourceViewV1,
  enumeration: PlanningEnumerationV1,
  preparedRoutes: readonly PreparedAssessmentRoute[],
  terminal: IssuedSearchTerminalV1,
  sixStepTrace: SearchTerminalSixStepTraceV1 | null,
  actionExpectedCandidateIds: ReadonlySet<Hash>,
  actionEvidenceByCandidate: ReadonlyMap<Hash, ExecutionProgramSixStepEvidenceV1>,
): NativeFullFamilyAuditCapabilityV1 {
  if (preparedRoutes.length !== enumeration.candidates.length) {
    throw new TypeError("native full-family audit candidate denominator mismatch");
  }
  const bindingBody = deepFreeze({
    correlationId: input.correlationId,
    sourceSessionId: assertHash(input.currentSource.sessionId, "nativeFullFamilyAudit.sourceSessionId"),
    generationId: input.lease.binding.generationId,
    readyRecordHash: input.lease.binding.readyRecordHash,
    readyCutoff: input.lease.binding.cutoff,
    graphRoot: input.lease.binding.graphRoot,
    releaseProvenanceHash: input.lease.binding.releaseProvenanceHash,
    actualCurrentSource: sourceView,
    planningProblemHash: enumeration.planningProblemHash,
    plannerEnumerationRoot: enumeration.enumerationRoot,
  });
  const binding = deepFreeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/native-full-family-audit-binding/v1", bindingBody),
  });
  const seenProjectedEdgeIds = new Set<Hash>();
  const projectedEdges = input.lease.edges.map((edge, edgeIndex) => {
    if (seenProjectedEdgeIds.has(edge.edgeId)) {
      throw new TypeError(`native full-family projected edge ${edgeIndex} is duplicated`);
    }
    seenProjectedEdgeIds.add(edge.edgeId);
    const { routeHandle: _routeHandle, ...persistedEdge } = edge;
    const factBody = deepFreeze({
      searchAuditBindingRoot: binding.bindingRoot,
      edge: deepFreeze(persistedEdge),
      edgeId: edge.edgeId,
      owningFamilyId: edge.owningFamilyId,
      owningFamilyDefinitionHash: edge.owningFamilyDefinitionHash,
      owningInstanceKey: edge.owningInstanceKey,
      instancePublicationHash: edge.instancePublicationHash,
      projectionHash: edge.projectionHash,
    });
    return deepFreeze({
      ...factBody,
      factRoot: hashDomain("aloha/native-full-family-projected-edge-fact/v1", factBody as unknown as CanonicalJson),
    });
  });
  const denominatorKeys: Hash[] = [];
  const observedRoots: Hash[] = [];
  const missingLegKeys: Hash[] = [];
  const coarseRoutes = preparedRoutes.map((prepared, routeIndex) => {
    const expected = enumeration.candidates[routeIndex];
    if (expected === undefined || expected.candidateId !== prepared.candidate.candidateId) {
      throw new TypeError(`native full-family audit candidate ${routeIndex} order mismatch`);
    }
    const routeBinding = readIssuedCoarseRouteBindingV1(prepared.bindingCapability);
    const attempts = prepared.attemptEvidence === null
      ? Object.freeze([]) as readonly RouteCoarseLegAttemptEvidenceV1[]
      : validateCoarseAttemptEvidence(routeBinding, prepared.attemptEvidence);
    const assessment = prepared.assessmentCapability === null || prepared.attemptEvidence === null
      ? null
      : readIssuedCoarseRouteAssessmentV1(prepared.assessmentCapability);
    if (assessment !== null) {
      if (attempts.length !== routeBinding.legs.length
        || assessment.orderedProjectionReceiptRoots.length !== attempts.length
        || assessment.orderedProjectionReceiptRoots.some((root, index) => root !== attempts[index]!.receipt.receiptRoot)) {
        throw new TypeError("native full-family audit assessment receipt join mismatch");
      }
    }
    const legs = routeBinding.legs.map((leg, legIndex) => {
      const edge = findEdge(input.lease, leg.edgeId);
      const denominatorKey = hashDomain("aloha/native-full-family-audit-leg-key/v1", {
        candidateId: prepared.candidate.candidateId,
        legIndex: String(legIndex),
        edgeId: leg.edgeId,
      });
      denominatorKeys.push(denominatorKey);
      const attempt = attempts[legIndex] ?? null;
      const receipt = attempt?.receipt ?? null;
      if (attempt === null) missingLegKeys.push(denominatorKey);
      else observedRoots.push(hashDomain("aloha/native-full-family-audit-observed-receipt/v1", {
        denominatorKey,
        receiptRoot: receipt.receiptRoot,
        familyObservation: attempt.familyObservation,
      }));
      const factBody = deepFreeze({
        searchAuditBindingRoot: binding.bindingRoot,
        candidateId: prepared.candidate.candidateId,
        routeHash: routeBinding.routeHash,
        routeBindingHash: routeBinding.routeBindingHash,
        legIndex: String(legIndex),
        edgeId: leg.edgeId,
        owningFamilyId: edge.owningFamilyId,
        owningFamilyDefinitionHash: edge.owningFamilyDefinitionHash,
        owningInstanceKey: edge.owningInstanceKey,
        instancePublicationHash: edge.instancePublicationHash,
        projectionHash: edge.projectionHash,
        receipt,
        familyObservation: attempt?.familyObservation ?? null,
      });
      return deepFreeze({
        ...factBody,
        factRoot: hashDomain("aloha/native-full-family-coarse-leg-fact/v1", factBody as unknown as CanonicalJson),
      });
    });
    const routeBody = deepFreeze({
      searchAuditBindingRoot: binding.bindingRoot,
      candidateId: prepared.candidate.candidateId,
      routeHash: routeBinding.routeHash,
      routeBindingHash: routeBinding.routeBindingHash,
      assessment,
      legs: deepFreeze(legs),
    });
    return deepFreeze({
      ...routeBody,
      routeFactRoot: hashDomain("aloha/native-full-family-coarse-route-fact/v1", routeBody as unknown as CanonicalJson),
    });
  });
  const successfulTerminal = terminal.kind === "unsigned-dry-run" ? terminal : null;
  if (successfulTerminal !== null && !actionExpectedCandidateIds.has(successfulTerminal.receipt.candidateId)) {
    throw new TypeError("native full-family successful action denominator mismatch");
  }
  for (const candidateId of actionEvidenceByCandidate.keys()) {
    if (!actionExpectedCandidateIds.has(candidateId)) {
      throw new TypeError("native full-family action evidence is outside the execution denominator");
    }
  }
  const orderedExpectedActionCandidateIds = preparedRoutes.flatMap(prepared => (
    actionExpectedCandidateIds.has(prepared.candidate.candidateId) ? [prepared.candidate.candidateId] : []
  ));
  if (orderedExpectedActionCandidateIds.length !== actionExpectedCandidateIds.size) {
    throw new TypeError("native full-family action denominator candidate mismatch");
  }
  const actionLineage = preparedRoutes.flatMap(prepared => {
    const evidence = actionEvidenceByCandidate.get(prepared.candidate.candidateId);
    if (evidence === undefined) return [];
    if (evidence.routeHash !== prepared.route.routeHash
      || evidence.generationId !== binding.generationId
      || !sameSource(evidence.source, binding.actualCurrentSource)) {
      throw new TypeError("native full-family action lineage mismatch");
    }
    if (successfulTerminal?.receipt.candidateId === prepared.candidate.candidateId) {
      const traced = sixStepTrace?.resolved.executionProgramOwnerEvidence;
      if (traced === null || traced === undefined || traced.evidenceRoot !== evidence.evidenceRoot) {
        throw new TypeError("native full-family successful action trace mismatch");
      }
    }
    const actionBody = deepFreeze({
      searchAuditBindingRoot: binding.bindingRoot,
      candidateId: prepared.candidate.candidateId,
      routeHash: evidence.routeHash,
      orderedEdgeIds: deepFreeze(prepared.candidate.legs.map(leg => leg.edgeId)),
      executionProgramOwnerEvidence: evidence,
    });
    return [deepFreeze({
      ...actionBody,
      factRoot: hashDomain("aloha/native-full-family-action-lineage-fact/v1", actionBody as unknown as CanonicalJson),
    })];
  });
  const observedActionCandidateIds = new Set(actionLineage.map(fact => fact.candidateId));
  const missingActionCandidateIds = orderedExpectedActionCandidateIds.filter(candidateId => !observedActionCandidateIds.has(candidateId));
  const observedProjectedEdgeIds = new Set(coarseRoutes.flatMap(route => route.legs.flatMap(leg => (
    leg.receipt === null ? [] : [leg.edgeId]
  ))));
  for (const edgeId of observedProjectedEdgeIds) {
    if (!seenProjectedEdgeIds.has(edgeId)) throw new TypeError("native full-family observed edge is outside the Graph denominator");
  }
  const missingProjectedEdgeIds = projectedEdges.flatMap(edge => (
    observedProjectedEdgeIds.has(edge.edgeId) ? [] : [edge.edgeId]
  ));
  const expectedLegCount = denominatorKeys.length.toString();
  const auditBody = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.native-full-family-audit-v1" as const,
    binding,
    expectedCandidateCount: preparedRoutes.length.toString(),
    expectedLegCount,
    observedReceiptCount: observedRoots.length.toString(),
    missingLegKeys: deepFreeze(missingLegKeys),
    expectedProjectedEdgeCount: projectedEdges.length.toString(),
    observedProjectedEdgeCount: observedProjectedEdgeIds.size.toString(),
    missingProjectedEdgeIds: deepFreeze(missingProjectedEdgeIds),
    expectedActionLineageCount: orderedExpectedActionCandidateIds.length.toString(),
    observedActionLineageCount: actionLineage.length.toString(),
    missingActionCandidateIds: deepFreeze(missingActionCandidateIds),
    denominatorRoot: hashDomain("aloha/native-full-family-audit-denominator/v1", denominatorKeys),
    observedReceiptRoot: hashDomain("aloha/native-full-family-audit-observed-receipts/v1", observedRoots),
    missingLegRoot: hashDomain("aloha/native-full-family-audit-missing-legs/v1", missingLegKeys),
    projectedEdgeDenominatorRoot: hashDomain("aloha/native-full-family-audit-projected-edge-denominator/v1", projectedEdges.map(edge => edge.factRoot)),
    missingProjectedEdgeRoot: hashDomain("aloha/native-full-family-audit-missing-projected-edges/v1", missingProjectedEdgeIds),
    actionDenominatorRoot: hashDomain("aloha/native-full-family-audit-action-denominator/v1", orderedExpectedActionCandidateIds),
    actionObservedRoot: hashDomain("aloha/native-full-family-audit-action-observed/v1", actionLineage.map(fact => fact.factRoot)),
    coarseRoutes: deepFreeze(coarseRoutes),
    projectedEdges: deepFreeze(projectedEdges),
    actionLineage: deepFreeze(actionLineage),
  });
  return issueNativeFullFamilyAudit(auditBody);
}

/**
 * The sole public search entry. It enumerates and admits complete multi-edge
 * routes; a single edge is never treated as a closed loop.
 */
export async function runSearchPipeline<Projection, Plan, Exact, Simulation>(
  ports: RoutePipelinePortsV1<Projection, Plan, Exact, Simulation>,
  input: RoutePipelineInputV1,
): Promise<RoutePipelineOutcomeV1<Simulation>> {
  const records: MutableAccounting[] = [];
  let terminalFence: (() => Promise<void>) | null = null;
  try {
    if (!input || typeof input !== "object") return Object.freeze({ kind: "invalidProgram", stage: "input", code: "input-required" });
    if (!Number.isInteger(input.admission.topK) || input.admission.topK < 0 || !Number.isInteger(input.admission.boundedUnrankedBudget) || input.admission.boundedUnrankedBudget < 0) return Object.freeze({ kind: "invalidProgram", stage: "input", code: "admission-policy-invalid" });
    let objective: SearchObjectiveV1;
    try {
      objective = validateSearchObjective(input.objective);
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram", stage: "input", code: error instanceof Error ? error.message : "objective-invalid" });
    }
    const admissionObjective = coarseObjective(objective);
    try {
      await input.lease.assertActive();
      await input.currentSource.assertCurrent();
    } catch {
      throw new RouteContextUnavailableError("route context is no longer current");
    }
    const sourceView = validateSourceView(input.currentSource.source, "routePipeline.source");
    const bindingHash = hashDomain("aloha/search-lease-binding/v1", input.lease.binding);
    const assertTerminalFence = async (): Promise<void> => {
      try {
        await input.lease.assertActive();
        await input.currentSource.assertCurrent();
      } catch {
        throw new RouteContextUnavailableError("route context is no longer current");
      }
      if (!sameSource(validateSourceView(input.currentSource.source, "routePipeline.currentSource"), sourceView)) {
        throw new TypeError("current source changed");
      }
      if (hashDomain("aloha/search-lease-binding/v1", input.lease.binding) !== bindingHash) {
        throw new TypeError("graph lease binding changed");
      }
    };
    terminalFence = assertTerminalFence;
    try {
      assertIssuedStrategyPlanningProblem(input.planningProblem);
    } catch {
      await assertTerminalFence();
      return Object.freeze({ kind: "invalidProgram", stage: "input", code: "planning-problem-not-issued" });
    }
    if (input.planningProblem.generationId !== input.lease.binding.generationId
      || input.planningProblem.definitionCatalogRoot !== input.lease.binding.definitionCatalogRoot
      || input.planningProblem.graphRoot !== input.lease.binding.graphRoot
      || input.planningProblem.readyRecordHash !== input.lease.binding.readyRecordHash
      || input.planningProblem.releaseProvenanceHash !== input.lease.binding.releaseProvenanceHash
      || input.planningProblem.strategyCompositionRoot !== input.strategyCompositionRoot
      || input.planningProblem.triggerCorrelationId !== input.correlationId
      || input.planningProblem.triggerHeadHash !== sourceView.hash
      || input.planningProblem.objectiveRef !== objective.objectiveRef
      || input.planningProblem.entryAssetRef !== admissionObjective.numeraireAssetRef
      || input.planningProblem.returnAssetRef !== admissionObjective.numeraireAssetRef) {
      await assertTerminalFence();
      return Object.freeze({ kind: "invalidProgram", stage: "input", code: "planning-problem-binding-mismatch" });
    }
    const coarseStartedMonotonicNs = process.hrtime.bigint();
    const issuedEnumeration: IssuedPlanningEnumerationV1 = enumerateClosedLoopPlanningProblem({ problem: input.planningProblem });
    const enumeration = readIssuedPlanningEnumerationV1(issuedEnumeration);
    const candidates = [...enumeration.candidates];
    let previousOrderKey: Hash | null = null;
    const seenCandidateIds = new Set<Hash>();
    const preparedRoutes: PreparedAssessmentRoute[] = [];
    const preparedByCandidate = new Map<Hash, PreparedAssessmentRoute>();
    for (const candidate of candidates) {
      const candidateStartedMonotonicNs = process.hrtime.bigint();
      validateCandidate(candidate, input.planningProblem, input.lease);
      if (previousOrderKey !== null && previousOrderKey >= candidate.orderKey) throw new TypeError("route-enumerator-order-not-strict");
      previousOrderKey = candidate.orderKey;
      if (seenCandidateIds.has(candidate.candidateId)) throw new TypeError("route-enumerator-duplicate-candidate");
      seenCandidateIds.add(candidate.candidateId);
      const prepared = await (async () => {
        try {
          return await prepareRoute(ports as RoutePipelinePortsV1<unknown, unknown, unknown, unknown>, input, candidate);
        } finally {
          await assertTerminalFence();
        }
      })();
      const bindingCapability = issueRouteCoarseBinding(input, candidate, prepared.route, prepared.selections, sourceView);
      let assessmentCapability: IssuedCoarseRouteAssessmentV1 | null = null;
      try {
        assessmentCapability = await ports.coarse.assess({
          binding: bindingCapability,
          currentSource: input.currentSource,
          objective,
          deadlineAtMs: input.deadlineAtMs,
          signal: input.signal,
        });
      } catch {
        assessmentCapability = null;
      } finally {
        await assertTerminalFence();
      }
      const attemptEvidence = ports.coarse.attemptEvidenceAuthority === undefined
        ? null
        : readOwnerIssuedCoarseAttemptEvidenceV1(ports.coarse.attemptEvidenceAuthority, bindingCapability);
      await assertTerminalFence();
      const assessed = deepFreeze({ ...prepared, candidate, startedMonotonicNs: candidateStartedMonotonicNs, bindingCapability, assessmentCapability, attemptEvidence });
      preparedRoutes.push(assessed);
      preparedByCandidate.set(candidate.candidateId, assessed);
    }
    const coarseEnumeration = issueCoarseEnumerationBindingV1({
      plannerEnumeration: issuedEnumeration,
      generationId: input.lease.binding.generationId,
      source: {
        chainId: sourceView.chainId,
        number: sourceView.number,
        hash: assertHash(sourceView.hash, "coarse.source.hash"),
        stateRoot: assertHash(sourceView.stateRoot, "coarse.source.stateRoot"),
      },
      releaseProvenanceHash: input.lease.binding.releaseProvenanceHash,
      objective: admissionObjective,
      policy: {
        rankedLimit: input.admission.topK,
        boundedUnrankedLimit: input.admission.boundedUnrankedBudget,
      },
      candidates: Object.freeze(preparedRoutes.map(prepared => Object.freeze({
        binding: prepared.bindingCapability,
        assessment: prepared.assessmentCapability,
      }))),
    });
    const admission = admitCoarseRoutesV1({ enumeration: coarseEnumeration });
    if (admission.denominator !== candidates.length.toString()
      || admission.plannerEnumerationRoot !== enumeration.enumerationRoot
      || admission.planningProblemHash !== enumeration.planningProblemHash
      || admission.enumerationTruncated !== enumeration.truncated
      || admission.observedUniqueCountLowerBound !== enumeration.observedUniqueCountLowerBound
      || admission.entries.length !== candidates.length) {
      throw new TypeError("coarse-admission-denominator-mismatch");
    }
    const selected: PreparedRoute<Projection>[] = [];
    for (const entry of admission.entries) {
      const prepared = preparedByCandidate.get(entry.candidateId);
      if (prepared === undefined || prepared.route.routeHash !== entry.routeHash) throw new TypeError("coarse-admission-route-mismatch");
      if (entry.disposition === "ranked-selected" || entry.disposition === "bounded-unranked-selected") {
        const item = admittedCoarse<Projection>(prepared, entry, sourceView);
        selected.push(item);
        records.push({ candidate: prepared.candidate, startedMonotonicNs: prepared.startedMonotonicNs, finishedMonotonicNs: null, disposition: "selected", terminalKind: "not-run", routeHash: prepared.route.routeHash, reasonCode: "admission:selected", evidenceHash: entry.entryRoot, policyTerminal: null });
      } else if (entry.disposition === "proven-pruned") {
        if (entry.pruneReceipt === null) throw new TypeError("coarse-prune-receipt-missing");
        records.push({ candidate: prepared.candidate, startedMonotonicNs: prepared.startedMonotonicNs, finishedMonotonicNs: process.hrtime.bigint(), disposition: "pruned", terminalKind: "chainProvenRejected", routeHash: prepared.route.routeHash, reasonCode: entry.reasonCode, evidenceHash: entry.pruneReceipt.pruneReceiptRoot, policyTerminal: null });
      } else {
        const lane = entry.reasonCode === "ranked-budget" ? "rankable" as const : "bounded-unranked" as const;
        const policyReceipt = admissionPolicyTerminalReceipt(input.admission, enumeration, prepared.candidate, prepared.route.routeHash, lane);
        records.push({ candidate: prepared.candidate, startedMonotonicNs: prepared.startedMonotonicNs, finishedMonotonicNs: process.hrtime.bigint(), disposition: "notProbed", terminalKind: "policyRejected", routeHash: prepared.route.routeHash, reasonCode: entry.reasonCode, evidenceHash: entry.entryRoot, policyTerminal: policyReceipt });
      }
    }
    const coarseTiming = sealRouteCoarseTimingFacts({
      correlationId: input.correlationId,
      generationId: input.lease.binding.generationId,
      graphRoot: input.lease.binding.graphRoot,
      source: sourceView,
      planningProblemHash: enumeration.planningProblemHash,
      enumerationRoot: enumeration.enumerationRoot,
      admissionPolicyHash: admissionPolicyHash(input.admission),
      startedMonotonicNs: coarseStartedMonotonicNs,
      finishedMonotonicNs: process.hrtime.bigint(),
    });

    const primitivePorts: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation> = {
      planner: ports.planner,
      exact: ports.exact,
      executionProgram: ports.executionProgram,
      finalSimulation: ports.finalSimulation,
      economicSafety: ports.economicSafety,
      unsignedDryRun: ports.unsignedDryRun,
      sixStepArtifacts: ports.sixStepArtifacts,
    };
    const actionExpectedCandidateIds = new Set<Hash>();
    const actionEvidenceByCandidate = new Map<Hash, ExecutionProgramSixStepEvidenceV1>();
    for (const item of selected) {
      const result = await runResolvedRoutePipeline(primitivePorts, {
        lease: input.lease,
        routeCandidateId: item.candidate.candidateId,
        orderedEdgeIds: item.candidate.legs.map(leg => leg.edgeId),
        strategy: item.candidate.loopIntent,
        objective,
        currentSource: input.currentSource,
        correlationId: input.correlationId,
        deadlineAtMs: input.deadlineAtMs,
        callerId: input.callerId,
        signal: input.signal,
      }, item.route, item.coarse);
      if (result.kind === "unsigned-dry-run" || (isStageFailure(result) && (
        result.stage === "final-sim"
        || result.stage === "economics-safety"
        || result.stage === "unsigned-dry-run"
      ))) {
        actionExpectedCandidateIds.add(item.candidate.candidateId);
      }
      try {
        actionEvidenceByCandidate.set(
          item.candidate.candidateId,
          readIssuedResolvedRouteExecutionProgramEvidenceV1(result),
        );
      } catch (error) {
        if (!(error instanceof TypeError) || error.message !== "resolved-route execution-program evidence was not issued") {
          throw error;
        }
      }
      const candidateFinishedMonotonicNs = process.hrtime.bigint();
      if (result.kind === "unsigned-dry-run") {
        const resolvedTrace = readIssuedResolvedRouteSixStepTraceV1(result);
        const resolvedArtifacts = readIssuedResolvedRouteSixStepArtifactCapabilitiesV1(result);
        const passedRecord = records.find(record => record.candidate.candidateId === item.candidate.candidateId)!;
        passedRecord.finishedMonotonicNs = candidateFinishedMonotonicNs;
        passedRecord.terminalKind = "passed";
        passedRecord.reasonCode = null;
        passedRecord.evidenceHash = null;
        for (const remaining of selected.slice(selected.indexOf(item) + 1)) {
          const remainingRecord = records.find(record => record.candidate.candidateId === remaining.candidate.candidateId)!;
          const decisionMonotonicNs = process.hrtime.bigint();
          const policyTerminal = postSuccessPolicyTerminalReceipt({
            policy: input.admission,
            enumeration,
            winnerCandidateId: item.candidate.candidateId,
            winnerTerminalLineageHash: result.receipt.lineageHash,
            candidateId: remaining.candidate.candidateId,
            routeHash: remaining.route.routeHash,
            decisionMonotonicNs,
          });
          remainingRecord.finishedMonotonicNs = decisionMonotonicNs;
          remainingRecord.terminalKind = "policyRejected";
          remainingRecord.reasonCode = "post-success:first-eligible";
          remainingRecord.evidenceHash = policyTerminal.receiptHash;
          remainingRecord.policyTerminal = policyTerminal;
        }
        const accounting = makeAccounting(records, enumeration, input.admission);
        const terminal = deepFreeze({ kind: "unsigned-dry-run" as const, receipt: result.receipt, accounting });
        const sixStepTrace = sealSearchTerminalSixStepTrace({
          schemaVersion: 1,
          kind: "aloha.search-terminal-six-step-trace-v1",
          strategyCompositionRoot: input.strategyCompositionRoot,
          planningProblem: canonicalSnapshot(input.planningProblem, "sixStepTrace.planningProblem"),
          planningProblemHash: input.planningProblem.problemHash,
          routeCandidate: canonicalSnapshot(item.candidate, "sixStepTrace.routeCandidate"),
          selectedGraphLegs: Object.freeze(item.candidate.legs.map(leg => {
            const edge = findEdge(input.lease, leg.edgeId);
            return Object.freeze({
              edgeId: edge.edgeId,
              owningFamilyId: edge.owningFamilyId,
              owningFamilyDefinitionHash: edge.owningFamilyDefinitionHash,
              owningInstanceKey: edge.owningInstanceKey,
              instancePublicationHash: edge.instancePublicationHash,
              staticProjectionHash: edge.staticProjectionHash,
              projectionHash: edge.projectionHash,
            });
          })),
          admission: Object.freeze({
            topK: input.admission.topK.toString(),
            boundedUnrankedBudget: input.admission.boundedUnrankedBudget.toString(),
            admissionPolicyHash: accounting.admissionPolicyHash,
            enumerationRoot: accounting.enumerationRoot,
            accountingRoot: accounting.root,
          }),
          resolved: resolvedTrace,
        });
        const candidateTerminalTimings = sealRouteCandidateTerminalTimings(
          records,
          accounting,
          input,
          terminal.receipt.lineageHash,
          sixStepTrace,
        );
        const nativeFullFamilyAudit = buildNativeFullFamilyAudit(
          input,
          sourceView,
          enumeration,
          preparedRoutes,
          terminal,
          sixStepTrace,
          actionExpectedCandidateIds,
          actionEvidenceByCandidate,
        );
        await assertTerminalFence();
        return Object.freeze({
          ...terminal,
          schedulerResourceJoin: result.schedulerResourceJoin,
          terminalCapability: issueSearchTerminalCapability(terminal, issuedEnumeration, result.schedulerResourceJoin, sixStepTrace, resolvedArtifacts, coarseTiming, candidateTerminalTimings, nativeFullFamilyAudit),
        });
      }
      if (isStageFailure(result)) {
        const facts = failureFacts(result);
        const selectedRecord = records.find(record => record.candidate.candidateId === item.candidate.candidateId)!;
        selectedRecord.finishedMonotonicNs = candidateFinishedMonotonicNs;
        selectedRecord.terminalKind = result.kind;
        selectedRecord.reasonCode = facts.reasonCode;
        selectedRecord.evidenceHash = facts.evidenceHash;
      }
    }
    const accounting = makeAccounting(records, enumeration, input.admission);
    const terminal = deepFreeze({ kind: "route-set-terminal" as const, receipt: sealRouteSetTerminalReceipt(input, sourceView, accounting) });
    const candidateTerminalTimings = sealRouteCandidateTerminalTimings(
      records,
      accounting,
      input,
      terminal.receipt.lineageHash,
      null,
    );
    const nativeFullFamilyAudit = buildNativeFullFamilyAudit(
      input,
      sourceView,
      enumeration,
      preparedRoutes,
      terminal,
      null,
      actionExpectedCandidateIds,
      actionEvidenceByCandidate,
    );
    await assertTerminalFence();
    return Object.freeze({
      ...terminal,
      schedulerResourceJoin: null,
      terminalCapability: issueSearchTerminalCapability(terminal, issuedEnumeration, null, null, null, coarseTiming, candidateTerminalTimings, nativeFullFamilyAudit),
    });
  } catch (error) {
    let terminalError = error;
    if (terminalFence !== null) {
      try {
        await terminalFence();
      } catch (fenceError) {
        terminalError = fenceError;
      }
    }
    if (terminalError instanceof RouteContextUnavailableError) {
      return Object.freeze({ kind: "retryable" as const, stage: "route" as const, code: "search-context-unavailable" });
    }
    return Object.freeze({ kind: "invalidProgram" as const, stage: "route" as const, code: terminalError instanceof Error ? terminalError.message : "route-pipeline-error" });
  }
}
