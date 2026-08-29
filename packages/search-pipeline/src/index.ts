import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { assertIssuedProductionSixStepTailEmissionPortV1 } from "./internal/six-step-tail-port-owner.ts";
import type {
  GraphLeaseBindingV1,
  GraphRouteHandle,
  IssuedRouteHandle,
  RuntimeGraphEdgeV1,
} from "../../graph/src/index.ts";
import type { LoopIntentV1 } from "../../strategy-sdk/src/index.ts";
import type { AssetPortV1 } from "../../catalog/src/index.ts";
import {
  normalizeEffectTransportDeclaration,
  sameEffectTransportDeclaration,
  type EffectTransportDeclarationV1,
} from "../../execution-program/src/index.ts";
import { issueSearchSchedulerResourceJoin } from "./internal/scheduler-resource-join.ts";
import {
  assertIssuedEconomicSafetyFinalizationServiceV1,
  validateEconomicSafetyEvidenceV1,
  type EconomicSafetyDeclaredObligationV1,
  type EconomicSafetyEvidenceV1,
  type EconomicSafetyFinalizationInputV1,
  type EconomicSafetyFinalizationServiceV1,
} from "../../economics-safety/src/index.ts";
import {
  readProductionSixStepArtifactMaterialV1,
  type ProductionSixStepEmissionCapabilityV1,
} from "../../evidence-emitter/src/index.ts";

/**
 * The search pipeline is deliberately a coordinator, not an authority.  It
 * accepts an already-open GraphView lease and only passes opaque route
 * capabilities to injected owners.  No Family, protocol, ABI, address,
 * selector, storage, or math type is imported here.
 */

export type SearchStageV1 =
  | "input"
  | "route"
  | "coarse"
  | "planner"
  | "exact"
  | "execution-program"
  | "final-sim"
  | "economics-safety"
  | "unsigned-dry-run";

export type SourceViewV1 = Readonly<{
  readonly chainId: string;
  readonly number: string;
  readonly hash: string;
  readonly stateRoot: string;
}>;

export interface CurrentSourceSessionV1 {
  readonly sessionId: Hash;
  readonly source: SourceViewV1;
  /** Must observe the same source again; it is never a ready-cutoff shortcut. */
  readonly assertCurrent: () => Promise<void> | void;
}

export interface SearchObjectiveV1 {
  readonly objectiveRef: Hash;
  readonly payload: CanonicalJson;
}

/** Narrow producer lease consumed by search; topology ownership stays in Graph. */
export interface SearchGraphLeaseV1 {
  readonly binding: GraphLeaseBindingV1;
  readonly edges: readonly RuntimeGraphEdgeV1[];
  assertActive(): Promise<void> | void;
  resolveRouteHandle(edgeId: Hash, handle: GraphRouteHandle): Promise<IssuedRouteHandle>;
}

export interface ResolvedRoutePipelineInputV1 {
  readonly lease: SearchGraphLeaseV1;
  readonly routeCandidateId: Hash;
  readonly orderedEdgeIds: readonly Hash[];
  readonly strategy: LoopIntentV1;
  readonly objective: SearchObjectiveV1;
  readonly currentSource: CurrentSourceSessionV1;
  readonly correlationId: Hash;
  readonly deadlineAtMs: number;
  readonly callerId: string;
  readonly signal?: AbortSignal;
}

export interface ProductionSixStepTailEmissionPortV1 {
  readonly emitPlanner: (input: Readonly<{
    readonly pipeline: ResolvedRoutePipelineInputV1;
    readonly route: RouteCapabilityV1;
    readonly coarse: CanonicalJson;
    readonly planned: CanonicalJson;
    readonly timing: SearchStageTimingFactV1;
  }>) => Promise<ProductionSixStepEmissionCapabilityV1>;
  readonly emitExact: (input: Readonly<{
    readonly parent: ProductionSixStepEmissionCapabilityV1;
    readonly pipeline: ResolvedRoutePipelineInputV1;
    readonly route: RouteCapabilityV1;
    readonly exact: CanonicalJson;
    readonly timing: SearchStageTimingFactV1;
  }>) => Promise<ProductionSixStepEmissionCapabilityV1>;
  readonly emitExecutionProgram: (input: Readonly<{
    readonly parent: ProductionSixStepEmissionCapabilityV1;
    readonly pipeline: ResolvedRoutePipelineInputV1;
    readonly route: RouteCapabilityV1;
    readonly program: ExecutionProgramArtifactV1;
    readonly ownerEvidence: ExecutionProgramSixStepEvidenceV1;
    readonly timing: SearchStageTimingFactV1;
  }>) => Promise<ProductionSixStepEmissionCapabilityV1>;
  readonly emitFinalSimulation: (input: Readonly<{
    readonly parent: ProductionSixStepEmissionCapabilityV1;
    readonly pipeline: ResolvedRoutePipelineInputV1;
    readonly route: RouteCapabilityV1;
    readonly program: ExecutionProgramArtifactV1;
    readonly simulation: CanonicalJson;
    readonly ownerEvidence: FinalSimulationSixStepEvidenceV1;
    readonly economicSafety: EconomicSafetyEvidenceV1;
    readonly timing: SearchStageTimingFactV1;
  }>) => Promise<ProductionSixStepEmissionCapabilityV1>;
  /** Exact checkpoint-owned parents consumed by the Stage 3 append. The
   * returned handles remain opaque and are retained only in owner WeakMaps. */
  readonly readStage12Parents: (
    stage3: ProductionSixStepEmissionCapabilityV1,
  ) => ProductionSixStepStage12ParentCapabilitiesV1;
}

export interface ProductionSixStepStage12ParentCapabilitiesV1 {
  readonly stage1: readonly ProductionSixStepEmissionCapabilityV1[];
  readonly stage2: readonly ProductionSixStepEmissionCapabilityV1[];
}

export interface ProductionSixStepArtifactCapabilitiesV1
  extends ProductionSixStepStage12ParentCapabilitiesV1 {
  readonly stage3: ProductionSixStepEmissionCapabilityV1;
  readonly stage4: ProductionSixStepEmissionCapabilityV1;
  readonly stage5: ProductionSixStepEmissionCapabilityV1;
  readonly stage6: ProductionSixStepEmissionCapabilityV1;
}

export { assertIssuedProductionSixStepTailEmissionPortV1 } from "./internal/six-step-tail-port-owner.ts";

export interface RouteSelectionV1 {
  readonly edgeId: Hash;
  /** Exact Graph ports selected by the generic planner for this leg. */
  readonly inputAssetPort: AssetPortV1;
  readonly outputAssetPort: AssetPortV1;
  readonly opaqueTransitionRef: Hash;
  readonly constraintRefs: readonly Hash[];
  /** An opaque generated owner identity; the pipeline never interprets it. */
  readonly ownerDefinitionRef: Hash;
  readonly graphRouteHandle: GraphRouteHandle;
  readonly issuedHandle: IssuedRouteHandle;
}

export interface RouteLegBindingV1 {
  readonly edgeId: Hash;
  readonly ownerRef: Hash;
  readonly issuedHandle: IssuedRouteHandle;
}

export interface RouteCapabilityV1 {
  readonly routeHash: Hash;
  /** Complete ordered leg authority; a route is never represented by one leg. */
  readonly legs: readonly RouteLegBindingV1[];
  /** Hash of the complete ordered edge/owner binding, supplied and checked by the coordinator. */
  readonly routeBindingHash: Hash;
}

export function routeBindingHash(legs: readonly Pick<RouteLegBindingV1, "edgeId" | "ownerRef">[]): Hash {
  return hashDomain("aloha/route-binding/v1", {
    legs: legs.map(leg => ({ edgeId: assertHash(leg.edgeId, "routeBinding.edgeId"), ownerRef: assertHash(leg.ownerRef, "routeBinding.ownerRef") })),
  });
}

export function validateRouteCapability(
  route: RouteCapabilityV1,
  expectedEdgeIds: readonly Hash[],
  expectedIssuedHandles?: readonly IssuedRouteHandle[],
): void {
  if (!route || typeof route !== "object") throw new TypeError("route-capability-incomplete");
  assertHash(route.routeHash, "route.routeHash");
  assertHash(route.routeBindingHash, "route.routeBindingHash");
  if (!Array.isArray(route.legs) || route.legs.length !== expectedEdgeIds.length) throw new TypeError("route-leg-count-mismatch");
  const bindingLegs = route.legs.map((leg, index) => {
    assertExactKeys(leg, ["edgeId", "ownerRef", "issuedHandle"], `route.legs[${index}]`);
    const edgeId = assertHash(leg.edgeId, `route.legs[${index}].edgeId`);
    const ownerRef = assertHash(leg.ownerRef, `route.legs[${index}].ownerRef`);
    if (edgeId !== expectedEdgeIds[index]) throw new TypeError("route-leg-edge-order-mismatch");
    if (leg.issuedHandle === null || typeof leg.issuedHandle !== "object") throw new TypeError("route-leg-handle-missing");
    if (expectedIssuedHandles !== undefined && leg.issuedHandle !== expectedIssuedHandles[index]) throw new TypeError("route-leg-handle-replaced");
    return { edgeId, ownerRef };
  });
  if (routeBindingHash(bindingLegs) !== route.routeBindingHash) throw new TypeError("route-binding-hash-mismatch");
}

export interface CoarseRankableV1<Projection> {
  readonly kind: "rankable";
  readonly routeHash: Hash;
  readonly source: SourceViewV1;
  readonly projection: Projection;
  readonly projectionHash: Hash;
  /** Opaque deterministic ordering key; central code does not do protocol math. */
  readonly rankKey: Hash;
}

export interface CoarseBoundedUnrankedV1 {
  readonly kind: "bounded-unranked";
  readonly routeHash: Hash;
  readonly source: SourceViewV1;
  readonly reasonCode: string;
  readonly evidenceHash: Hash;
}

export type StageFailureV1 =
  | {
    readonly kind: "retryable";
    readonly stage: SearchStageV1;
    readonly code: string;
  }
  | {
    readonly kind: "invalidProgram";
    readonly stage: SearchStageV1;
    readonly code: string;
  };

/**
 * The payload is deliberately opaque.  A structural object, including a
 * clone of an earlier rejection DTO, is not evidence.  The stage owner that
 * executed the qualified program must recognize this exact process-local
 * capability through its `rejectionAuthority` port.
 */
export interface QualifiedStageRejectionCapabilityV1 {
  readonly kind: "opaque-qualified-stage-rejection-capability";
}

export interface QualifiedStageRejectionReceiptV1 {
  readonly kind: "aloha.qualified-stage-rejection-v1";
  readonly stage: Exclude<SearchStageV1, "input" | "route" | "coarse" | "unsigned-dry-run">;
  readonly routeHash: Hash;
  readonly source: SourceViewV1;
  readonly correlationId: Hash;
  /** Hash of the exact artifact consumed by this stage. */
  readonly inputArtifactHash: Hash;
  /** Present only when a compiled program existed before the rejecting stage. */
  readonly programHash: Hash | null;
  readonly code: string;
  readonly evidenceHash: Hash;
  /** Receipt owned by the qualified stage (for final-sim, the EVM execution receipt). */
  readonly ownerReceiptHash: Hash;
  readonly receiptHash: Hash;
}

export interface StageChainRejectionV1 {
  readonly kind: "chainProvenRejected";
  readonly stage: QualifiedStageRejectionReceiptV1["stage"];
  readonly code: string;
  readonly evidenceHash: Hash;
  readonly capability: QualifiedStageRejectionCapabilityV1;
}

export interface StageRejectionAuthorityPortV1 {
  readonly read: (
    capability: QualifiedStageRejectionCapabilityV1,
  ) => QualifiedStageRejectionReceiptV1;
}

export type StageTerminalFailureV1 = StageFailureV1 | StageChainRejectionV1;

export interface PlannedRouteV1<Plan> {
  readonly kind: "planned";
  readonly routeHash: Hash;
  readonly source: SourceViewV1;
  readonly plan: Plan;
  readonly planHash: Hash;
}

export type PlannerOutcomeV1<Plan> = PlannedRouteV1<Plan> | StageTerminalFailureV1;

export interface PlannerPortV1<Projection, Plan> {
  readonly plan: (input: {
    readonly binding: GraphLeaseBindingV1;
    readonly route: RouteCapabilityV1;
    readonly coarse: CoarseRankableV1<Projection> | CoarseBoundedUnrankedV1;
    readonly strategy: LoopIntentV1;
    readonly objective: SearchObjectiveV1;
    readonly correlationId: Hash;
  }) => Promise<PlannerOutcomeV1<Plan>> | PlannerOutcomeV1<Plan>;
  readonly rejectionAuthority: StageRejectionAuthorityPortV1;
}

export interface ExactResultV1<Exact> {
  readonly kind: "verified";
  readonly routeHash: Hash;
  readonly source: SourceViewV1;
  readonly exact: Exact;
  readonly exactHash: Hash;
}

export type ExactOutcomeV1<Exact> = ExactResultV1<Exact> | StageTerminalFailureV1;

export interface ExactPortV1<Plan, Exact> {
  readonly evaluate: (input: {
    readonly plan: Plan;
    readonly planHash: Hash;
    readonly route: RouteCapabilityV1;
    readonly source: CurrentSourceSessionV1;
    readonly deadlineAtMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<ExactOutcomeV1<Exact>> | ExactOutcomeV1<Exact>;
  readonly rejectionAuthority: StageRejectionAuthorityPortV1;
}

export interface ExecutionProgramArtifactV1 {
  readonly kind: "execution-program";
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly routeHash: Hash;
  readonly programBytes: string;
  readonly payloadHash: Hash;
  readonly issuerRef: Hash;
  readonly obligationRoot: Hash;
  /** Optional owner-declared effect transport capability. */
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly programHash: Hash;
}

/** Opaque process-local proof emitted by the execution-program owner. */
export type ExecutionProgramSixStepEvidenceCapabilityV1 = object;

export interface ExecutionProgramSixStepEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.execution-program-six-step-evidence-v1";
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly routeHash: Hash;
  readonly exactHash: Hash;
  readonly programHash: Hash;
  /** Protocol-neutral facts; concrete Family semantics stay inside owner entries. */
  readonly facts: CanonicalJson;
  /** Optional owner-native canonical observation. Generic economics consumes
   * only `facts`; independent Family acceptance may exact-decode this sibling
   * envelope without widening the economics schema. */
  readonly ownerObservation?: CanonicalJson;
  readonly evidenceRoot: Hash;
}

export interface ExecutionProgramSixStepEvidenceAuthorityV1 {
  readonly read: (
    capability: ExecutionProgramSixStepEvidenceCapabilityV1,
  ) => ExecutionProgramSixStepEvidenceV1;
}

export type ExecutionProgramOutcomeV1 =
  | {
    readonly kind: "compiled";
    readonly program: ExecutionProgramArtifactV1;
    readonly sixStepEvidence?: ExecutionProgramSixStepEvidenceCapabilityV1;
  }
  | StageTerminalFailureV1;

export interface ExecutionProgramPortV1<Plan, Exact> {
  readonly compile: (input: {
    readonly binding: GraphLeaseBindingV1;
    readonly plan: Plan;
    readonly planHash: Hash;
    readonly exact: Exact;
    readonly exactHash: Hash;
    readonly route: RouteCapabilityV1;
    readonly source: CurrentSourceSessionV1;
    readonly correlationId: Hash;
    readonly deadlineAtMs: number;
  }) => Promise<ExecutionProgramOutcomeV1> | ExecutionProgramOutcomeV1;
  readonly rejectionAuthority: StageRejectionAuthorityPortV1;
  readonly sixStepEvidenceAuthority?: ExecutionProgramSixStepEvidenceAuthorityV1;
}

export interface FinalSimulationReceiptV1<Simulation> {
  readonly kind: "final-simulation-passed";
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly programHash: Hash;
  readonly simulation: Simulation;
  readonly effectsHash: Hash;
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly receiptHash: Hash;
}

/** Opaque process-local proof emitted by the concrete final-simulation owner. */
export type FinalSimulationSixStepEvidenceCapabilityV1 = object;

export interface FinalSimulationSixStepEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.final-simulation-six-step-evidence-v1";
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly facts: CanonicalJson;
  readonly evidenceRoot: Hash;
}

export interface FinalSimulationSixStepEvidenceAuthorityV1 {
  readonly read: (
    capability: FinalSimulationSixStepEvidenceCapabilityV1,
  ) => FinalSimulationSixStepEvidenceV1;
}

/** Opaque owner-issued link between a passed final simulation and its scheduler permit. */
export type FinalSimulationSchedulerJoinSeedCapabilityV1 = object;

export interface FinalSimulationSchedulerJoinSeedV1 {
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  /** Process-local scheduler handle; never canonicalized, hashed, or serialized. */
  readonly schedulerCompletion: object;
}

export interface FinalSimulationSchedulerJoinAuthorityV1 {
  readonly read: (
    capability: FinalSimulationSchedulerJoinSeedCapabilityV1,
  ) => FinalSimulationSchedulerJoinSeedV1;
}

/** Opaque join retained by the successful search terminal. */
export type SearchSchedulerResourceJoinCapabilityV1 = object;

export interface SearchSchedulerResourceJoinV1 {
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: SourceViewV1;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly unsignedDryRunCandidateId: Hash;
  readonly unsignedDryRunLineageHash: Hash;
  readonly schedulerCompletion: object;
}

export type FinalSimulationOutcomeV1<Simulation> =
  | {
    readonly kind: "passed";
    readonly receipt: FinalSimulationReceiptV1<Simulation>;
    readonly schedulerJoinSeed?: FinalSimulationSchedulerJoinSeedCapabilityV1;
    readonly sixStepEvidence?: FinalSimulationSixStepEvidenceCapabilityV1;
  }
  | StageTerminalFailureV1;

export interface FinalSimulationPortV1<Simulation> {
  readonly simulate: (input: {
    readonly binding: GraphLeaseBindingV1;
    readonly program: ExecutionProgramArtifactV1;
    readonly source: CurrentSourceSessionV1;
    readonly callerId: string;
    readonly correlationId: Hash;
    readonly deadlineAtMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<FinalSimulationOutcomeV1<Simulation>> | FinalSimulationOutcomeV1<Simulation>;
  readonly rejectionAuthority: StageRejectionAuthorityPortV1;
  /** Absent only for generic/unbound contract fixtures that claim no scheduler lineage. */
  readonly schedulerJoinAuthority?: FinalSimulationSchedulerJoinAuthorityV1;
  readonly sixStepEvidenceAuthority?: FinalSimulationSixStepEvidenceAuthorityV1;
}

export interface UnsignedDryRunReceiptV1 {
  readonly kind: "aloha.unsigned-dry-run-v1";
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly cutoff: GraphLeaseBindingV1["cutoff"];
  readonly graphRoot: Hash;
  readonly candidateId: Hash;
  readonly orderedEdgeIds: readonly Hash[];
  readonly orderedEdgeIdsRoot: Hash;
  readonly routeHash: Hash;
  readonly routeBindingHash: Hash;
  readonly objectiveRef: Hash;
  readonly source: SourceViewV1;
  readonly coarseKind: "rankable" | "bounded-unranked";
  readonly planHash: Hash;
  readonly exactHash: Hash;
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly safetyRoot: Hash;
  readonly lineageHash: Hash;
  readonly signer: null;
  readonly transactionHash: null;
}

export interface UnsignedDryRunInputV1<Projection, Plan, Exact, Simulation> {
  readonly binding: GraphLeaseBindingV1;
  readonly candidateId: Hash;
  readonly orderedEdgeIds: readonly Hash[];
  readonly route: RouteCapabilityV1;
  readonly coarse: CoarseRankableV1<Projection> | CoarseBoundedUnrankedV1;
  readonly plan: PlannedRouteV1<Plan>;
  readonly exact: ExactResultV1<Exact>;
  readonly program: ExecutionProgramArtifactV1;
  readonly simulation: FinalSimulationReceiptV1<Simulation>;
  readonly economicSafety: EconomicSafetyEvidenceV1;
  readonly objectiveRef: Hash;
  readonly correlationId: Hash;
}

export interface UnsignedDryRunPortV1<Projection, Plan, Exact, Simulation> {
  readonly issue: (
    input: UnsignedDryRunInputV1<Projection, Plan, Exact, Simulation>,
  ) => UnsignedDryRunReceiptV1;
}

export interface SearchPipelinePortsV1<Projection, Plan, Exact, Simulation> {
  readonly planner: PlannerPortV1<Projection, Plan>;
  readonly exact: ExactPortV1<Plan, Exact>;
  readonly executionProgram: ExecutionProgramPortV1<Plan, Exact>;
  readonly finalSimulation: FinalSimulationPortV1<Simulation>;
  readonly economicSafety: EconomicSafetyFinalizationServiceV1;
  readonly unsignedDryRun: UnsignedDryRunPortV1<Projection, Plan, Exact, Simulation>;
  readonly sixStepArtifacts: ProductionSixStepTailEmissionPortV1;
}

/** Tail ports for one route that has already passed the authoritative coarse
 * denominator gate. Coarse projection/prune ports are deliberately absent so
 * the exact tail cannot re-read or replace the ranked assessment. */
export type ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation> =
  SearchPipelinePortsV1<Projection, Plan, Exact, Simulation>;

export type SearchPipelineOutcomeV1<Simulation> =
  | {
    readonly kind: "unsigned-dry-run";
    readonly receipt: UnsignedDryRunReceiptV1;
    readonly schedulerResourceJoin: SearchSchedulerResourceJoinCapabilityV1 | null;
  }
  | { readonly kind: "retryable"; readonly stage: SearchStageV1; readonly code: string }
  | { readonly kind: "invalidProgram"; readonly stage: SearchStageV1; readonly code: string }
  | StageChainRejectionV1;

export interface SearchStageTimingFactV1 {
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly durationUs: string;
}

/**
 * Process-local trace of the four producer-session stages that actually ran.
 *
 * This value is never accepted as an input to the search pipeline and is not
 * carried by the public outcome DTO.  It can only be recovered by identity
 * from the exact successful outcome object issued below, allowing the route
 * coordinator to retain real stage objects without adding a caller-authored
 * success/evidence field.
 */
export interface ResolvedRouteSixStepTraceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.resolved-route-six-step-trace-v1";
  readonly binding: CanonicalJson;
  readonly routeCandidateId: Hash;
  readonly orderedEdgeIds: readonly Hash[];
  readonly routeBinding: CanonicalJson;
  readonly strategy: CanonicalJson;
  readonly objective: CanonicalJson;
  readonly source: SourceViewV1;
  readonly correlationId: Hash;
  readonly coarse: CanonicalJson;
  readonly planner: CanonicalJson;
  readonly exact: CanonicalJson;
  readonly executionProgram: CanonicalJson;
  readonly executionProgramOwnerEvidence: ExecutionProgramSixStepEvidenceV1 | null;
  readonly finalSimulation: CanonicalJson;
  readonly finalSimulationOwnerEvidence: FinalSimulationSixStepEvidenceV1 | null;
  readonly economicSafety: EconomicSafetyEvidenceV1;
  readonly unsignedDryRun: CanonicalJson;
  readonly timings: Readonly<{
    readonly planner: SearchStageTimingFactV1;
    readonly exact: SearchStageTimingFactV1;
    readonly executionProgram: SearchStageTimingFactV1;
    readonly finalSimulation: SearchStageTimingFactV1;
  }>;
  readonly productionArtifactSetRoots: readonly [Hash, Hash, Hash, Hash];
  readonly traceRoot: Hash;
}

const resolvedRouteSixStepTraces = new WeakMap<object, ResolvedRouteSixStepTraceV1>();
const resolvedRouteSixStepArtifactCapabilities = new WeakMap<object, ProductionSixStepArtifactCapabilitiesV1>();
const resolvedRouteExecutionProgramEvidence = new WeakMap<object, ExecutionProgramSixStepEvidenceV1>();

function retainResolvedRouteExecutionProgramEvidence<T extends object>(
  outcome: T,
  evidence: ExecutionProgramSixStepEvidenceV1 | null,
): T {
  if (evidence !== null) resolvedRouteExecutionProgramEvidence.set(outcome, evidence);
  return outcome;
}

/** Read the execution-owner evidence retained by the exact route invocation.
 * Structural failures/results and outcomes that never compiled an owned
 * action have no authority in this WeakMap. */
export function readIssuedResolvedRouteExecutionProgramEvidenceV1(
  outcome: unknown,
): ExecutionProgramSixStepEvidenceV1 {
  if (outcome === null || typeof outcome !== "object") {
    throw new TypeError("resolved-route outcome is required");
  }
  const evidence = resolvedRouteExecutionProgramEvidence.get(outcome);
  if (evidence === undefined) throw new TypeError("resolved-route execution-program evidence was not issued");
  const { evidenceRoot: _evidenceRoot, ...body } = evidence;
  if (evidence.evidenceRoot !== hashDomain("aloha/execution-program-six-step-evidence/v1", body as unknown as CanonicalJson)) {
    throw new TypeError("resolved-route execution-program evidence identity mismatch");
  }
  return evidence;
}

function resolvedRouteSixStepTracePayload(
  value: Omit<ResolvedRouteSixStepTraceV1, "traceRoot">,
): CanonicalJson {
  return value as unknown as CanonicalJson;
}

function sealResolvedRouteSixStepTrace(
  value: Omit<ResolvedRouteSixStepTraceV1, "traceRoot">,
): ResolvedRouteSixStepTraceV1 {
  const traceRoot = hashDomain(
    "aloha/resolved-route-six-step-trace/v1",
    resolvedRouteSixStepTracePayload(value),
  );
  return deepFreeze({ ...value, traceRoot });
}

/** Read-only identity gate used by the complete-route coordinator. */
export function readIssuedResolvedRouteSixStepTraceV1(
  successfulOutcome: unknown,
): ResolvedRouteSixStepTraceV1 {
  if (successfulOutcome === null || typeof successfulOutcome !== "object") {
    throw new TypeError("successful resolved-route outcome is required");
  }
  const trace = resolvedRouteSixStepTraces.get(successfulOutcome);
  if (trace === undefined) throw new TypeError("resolved-route six-step trace was not issued");
  const { traceRoot: _traceRoot, ...payload } = trace;
  if (trace.traceRoot !== hashDomain("aloha/resolved-route-six-step-trace/v1", resolvedRouteSixStepTracePayload(payload))) {
    throw new TypeError("resolved-route six-step trace identity mismatch");
  }
  return trace;
}

export function readIssuedResolvedRouteSixStepArtifactCapabilitiesV1(
  successfulOutcome: unknown,
): ProductionSixStepArtifactCapabilitiesV1 {
  if (successfulOutcome === null || typeof successfulOutcome !== "object") {
    throw new TypeError("successful resolved-route outcome is required");
  }
  const capabilities = resolvedRouteSixStepArtifactCapabilities.get(successfulOutcome);
  if (capabilities === undefined) {
    throw new TypeError("resolved-route production Six-Step artifacts were not issued");
  }
  return capabilities;
}

function source(value: unknown, path: string): SourceViewV1 {
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    chainId: assertNonEmptyString(record.chainId, `${path}.chainId`),
    number: assertNonEmptyString(record.number, `${path}.number`),
    hash: assertHash(record.hash, `${path}.hash`),
    stateRoot: assertHash(record.stateRoot, `${path}.stateRoot`),
  });
}

export function validateSourceView(value: unknown, path = "source"): SourceViewV1 {
  return source(value, path);
}

function sameSource(left: SourceViewV1, right: SourceViewV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function nonEmptyHash(value: unknown, path: string): Hash {
  return assertHash(value, path);
}

function canonicalValue(value: unknown, path: string): CanonicalJson {
  try {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function executionProgramEvidenceBody(
  value: Omit<ExecutionProgramSixStepEvidenceV1, "evidenceRoot">,
): CanonicalJson {
  return value as unknown as CanonicalJson;
}

function normalizeExecutionProgramEvidence(
  value: ExecutionProgramSixStepEvidenceV1,
  expected: {
    readonly correlationId: Hash;
    readonly generationId: string;
    readonly source: SourceViewV1;
    readonly routeHash: Hash;
    readonly exactHash: Hash;
    readonly programHash: Hash;
  },
): ExecutionProgramSixStepEvidenceV1 {
  const keys = ["schemaVersion", "kind", "correlationId", "generationId", "source", "routeHash", "exactHash", "programHash", "facts", "evidenceRoot"];
  if (Object.prototype.hasOwnProperty.call(value, "ownerObservation")) keys.push("ownerObservation");
  assertExactKeys(value, keys, "executionProgramSixStepEvidence");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.execution-program-six-step-evidence-v1") throw new TypeError("execution-program six-step evidence kind is unsupported");
  const body = {
    schemaVersion: 1 as const,
    kind: "aloha.execution-program-six-step-evidence-v1" as const,
    correlationId: nonEmptyHash(value.correlationId, "executionProgramSixStepEvidence.correlationId"),
    generationId: assertNonEmptyString(value.generationId, "executionProgramSixStepEvidence.generationId"),
    source: source(value.source, "executionProgramSixStepEvidence.source"),
    routeHash: nonEmptyHash(value.routeHash, "executionProgramSixStepEvidence.routeHash"),
    exactHash: nonEmptyHash(value.exactHash, "executionProgramSixStepEvidence.exactHash"),
    programHash: nonEmptyHash(value.programHash, "executionProgramSixStepEvidence.programHash"),
    facts: canonicalValue(value.facts, "executionProgramSixStepEvidence.facts"),
    ...(Object.prototype.hasOwnProperty.call(value, "ownerObservation")
      ? { ownerObservation: canonicalValue(value.ownerObservation, "executionProgramSixStepEvidence.ownerObservation") }
      : {}),
  };
  const evidenceRoot = nonEmptyHash(value.evidenceRoot, "executionProgramSixStepEvidence.evidenceRoot");
  if (evidenceRoot !== hashDomain("aloha/execution-program-six-step-evidence/v1", executionProgramEvidenceBody(body))) throw new TypeError("execution-program six-step evidence root mismatch");
  if (body.correlationId !== expected.correlationId
    || body.generationId !== expected.generationId
    || !sameSource(body.source, expected.source)
    || body.routeHash !== expected.routeHash
    || body.exactHash !== expected.exactHash
    || body.programHash !== expected.programHash) {
    throw new TypeError("execution-program six-step evidence lineage mismatch");
  }
  return deepFreeze({ ...body, evidenceRoot });
}

function finalSimulationEvidenceBody(
  value: Omit<FinalSimulationSixStepEvidenceV1, "evidenceRoot">,
): CanonicalJson {
  return value as unknown as CanonicalJson;
}

function normalizeFinalSimulationEvidence(
  value: FinalSimulationSixStepEvidenceV1,
  expected: {
    readonly correlationId: Hash;
    readonly generationId: string;
    readonly source: SourceViewV1;
    readonly programHash: Hash;
    readonly finalSimulationReceiptHash: Hash;
  },
): FinalSimulationSixStepEvidenceV1 {
  assertExactKeys(value, ["schemaVersion", "kind", "correlationId", "generationId", "source", "programHash", "finalSimulationReceiptHash", "facts", "evidenceRoot"], "finalSimulationSixStepEvidence");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.final-simulation-six-step-evidence-v1") throw new TypeError("final-simulation six-step evidence kind is unsupported");
  const body = {
    schemaVersion: 1 as const,
    kind: "aloha.final-simulation-six-step-evidence-v1" as const,
    correlationId: nonEmptyHash(value.correlationId, "finalSimulationSixStepEvidence.correlationId"),
    generationId: assertNonEmptyString(value.generationId, "finalSimulationSixStepEvidence.generationId"),
    source: source(value.source, "finalSimulationSixStepEvidence.source"),
    programHash: nonEmptyHash(value.programHash, "finalSimulationSixStepEvidence.programHash"),
    finalSimulationReceiptHash: nonEmptyHash(value.finalSimulationReceiptHash, "finalSimulationSixStepEvidence.finalSimulationReceiptHash"),
    facts: canonicalValue(value.facts, "finalSimulationSixStepEvidence.facts"),
  };
  const evidenceRoot = nonEmptyHash(value.evidenceRoot, "finalSimulationSixStepEvidence.evidenceRoot");
  if (evidenceRoot !== hashDomain("aloha/final-simulation-six-step-evidence/v1", finalSimulationEvidenceBody(body))) throw new TypeError("final-simulation six-step evidence root mismatch");
  if (body.correlationId !== expected.correlationId
    || body.generationId !== expected.generationId
    || !sameSource(body.source, expected.source)
    || body.programHash !== expected.programHash
    || body.finalSimulationReceiptHash !== expected.finalSimulationReceiptHash) {
    throw new TypeError("final-simulation six-step evidence lineage mismatch");
  }
  return deepFreeze({ ...body, evidenceRoot });
}

function objectiveRef(objective: SearchObjectiveV1): Hash {
  return hashDomain("aloha/search-objective/v1", canonicalValue(objective.payload, "objective.payload"));
}

/**
 * Objectives are admission inputs, not merely metadata carried to a later
 * stage.  Normalize and bind the payload before any coarse projection,
 * ranking, pruning, or denominator accounting can observe it.
 */
export function validateSearchObjective(value: unknown, path = "objective"): SearchObjectiveV1 {
  assertExactKeys(value, ["objectiveRef", "payload"], path);
  const record = value as Record<string, unknown>;
  const objective = Object.freeze({
    objectiveRef: nonEmptyHash(record.objectiveRef, `${path}.objectiveRef`),
    payload: canonicalValue(record.payload, `${path}.payload`),
  });
  if (objectiveRef(objective) !== objective.objectiveRef) {
    throw new TypeError("objective-hash-mismatch");
  }
  return objective;
}

function failure(
  kind: StageFailureV1["kind"],
  stage: SearchStageV1,
  code: string,
): StageFailureV1 {
  return Object.freeze({ kind, stage, code });
}

class SearchContextUnavailableError extends Error {}

function mapThrown(stage: SearchStageV1, error: unknown): StageFailureV1 {
  if (error instanceof SearchContextUnavailableError) return failure("retryable", stage, "search-context-unavailable");
  const aborted = error instanceof Error && error.name === "AbortError";
  return failure(aborted ? "retryable" : "invalidProgram", stage, aborted ? "abort" : "port-error");
}

function requireSource(sourceSession: CurrentSourceSessionV1): SourceViewV1 {
  if (!sourceSession || typeof sourceSession !== "object" || typeof sourceSession.assertCurrent !== "function") throw new TypeError("current source session is invalid");
  const sessionId = nonEmptyHash(sourceSession.sessionId, "currentSource.sessionId");
  const view = source(sourceSession.source, "currentSource.source");
  if (sessionId.length === 0) throw new TypeError("current source session id is empty");
  return view;
}

function sealProgram(value: ExecutionProgramArtifactV1): ExecutionProgramArtifactV1 {
  const keys = ["kind", "generationId", "source", "routeHash", "programBytes", "payloadHash", "issuerRef", "obligationRoot", "programHash"];
  if (Object.prototype.hasOwnProperty.call(value, "effectTransport")) keys.push("effectTransport");
  assertExactKeys(value, keys, "executionProgram");
  const body = {
    kind: "execution-program" as const,
    generationId: assertNonEmptyString(value.generationId, "executionProgram.generationId"),
    source: source(value.source, "executionProgram.source"),
    routeHash: nonEmptyHash(value.routeHash, "executionProgram.routeHash"),
    programBytes: assertNonEmptyString(value.programBytes, "executionProgram.programBytes"),
    payloadHash: nonEmptyHash(value.payloadHash, "executionProgram.payloadHash"),
    issuerRef: nonEmptyHash(value.issuerRef, "executionProgram.issuerRef"),
    obligationRoot: nonEmptyHash(value.obligationRoot, "executionProgram.obligationRoot"),
    ...(Object.prototype.hasOwnProperty.call(value, "effectTransport")
      ? { effectTransport: normalizeEffectTransportDeclaration(value.effectTransport, "executionProgram.effectTransport") }
      : {}),
  };
  const programHash = hashDomain("aloha/execution-program-artifact/v1", body);
  if (value.programHash !== programHash) throw new TypeError("execution program hash mismatch");
  return deepFreeze({ ...body, programHash });
}

function lineageHash(input: Omit<UnsignedDryRunReceiptV1, "lineageHash">): Hash {
  return hashDomain("aloha/unsigned-dry-run-lineage/v1", input);
}

function orderedEdgeIdsRoot(edgeIds: readonly Hash[]): Hash {
  return hashDomain("aloha/ordered-route-edge-ids/v1", edgeIds.map((edgeId, index) => assertHash(edgeId, `orderedEdgeIds[${index}]`)));
}

function validateUnsignedDryRunReceipt(
  receipt: UnsignedDryRunReceiptV1,
  input: UnsignedDryRunInputV1<unknown, unknown, unknown, unknown>,
): void {
  assertExactKeys(receipt, [
    "kind", "correlationId", "generationId", "readyRecordHash", "cutoff", "graphRoot", "candidateId", "orderedEdgeIds", "orderedEdgeIdsRoot", "routeHash", "routeBindingHash", "objectiveRef", "source", "coarseKind", "planHash", "exactHash", "programHash", "finalSimulationReceiptHash", "safetyRoot", "lineageHash", "signer", "transactionHash",
  ], "unsignedDryRunReceipt");
  if (receipt.kind !== "aloha.unsigned-dry-run-v1" || receipt.signer !== null || receipt.transactionHash !== null) throw new TypeError("unsigned dry-run receipt is not unsigned");
  if (receipt.correlationId !== input.correlationId || receipt.generationId !== input.binding.generationId || receipt.readyRecordHash !== input.binding.readyRecordHash || receipt.graphRoot !== input.binding.graphRoot || receipt.candidateId !== input.candidateId || receipt.routeHash !== input.route.routeHash || receipt.routeBindingHash !== input.route.routeBindingHash || receipt.objectiveRef !== input.objectiveRef || receipt.source.hash !== input.program.source.hash || receipt.programHash !== input.program.programHash || receipt.finalSimulationReceiptHash !== input.simulation.receiptHash || receipt.planHash !== input.plan.planHash || receipt.exactHash !== input.exact.exactHash || receipt.safetyRoot !== input.economicSafety.evidenceRoot) throw new TypeError("unsigned dry-run lineage mismatch");
  if (!Array.isArray(receipt.orderedEdgeIds) || receipt.orderedEdgeIds.length !== input.orderedEdgeIds.length || receipt.orderedEdgeIds.some((edgeId, index) => edgeId !== input.orderedEdgeIds[index])) throw new TypeError("unsigned dry-run route-edge lineage mismatch");
  if (receipt.orderedEdgeIdsRoot !== orderedEdgeIdsRoot(input.orderedEdgeIds)) throw new TypeError("unsigned dry-run route-edge root mismatch");
  if (receipt.coarseKind !== input.coarse.kind) throw new TypeError("unsigned dry-run coarse lineage mismatch");
  if (!sameSource(source(receipt.source, "unsignedDryRunReceipt.source"), input.program.source)) throw new TypeError("unsigned dry-run source mismatch");
  const { lineageHash: ignored, ...body } = receipt;
  if (lineageHash(body) !== receipt.lineageHash) throw new TypeError("unsigned dry-run lineage hash mismatch");
}

async function fence(
  lease: SearchGraphLeaseV1,
  sourceSession: CurrentSourceSessionV1,
  expectedSource: SourceViewV1,
  expectedBindingHash: Hash,
): Promise<void> {
  try {
    await lease.assertActive();
    await sourceSession.assertCurrent();
  } catch {
    throw new SearchContextUnavailableError("search context is no longer current");
  }
  if (!sameSource(source(sourceSession.source, "currentSource.source"), expectedSource)) throw new TypeError("current source changed");
  if (hashDomain("aloha/search-lease-binding/v1", lease.binding) !== expectedBindingHash) throw new TypeError("graph lease binding changed");
}

function sameHashList(left: readonly Hash[], right: readonly Hash[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertRouteStable(
  route: RouteCapabilityV1,
  expectedRouteHash: Hash,
  expectedRouteBindingHash: Hash,
  expectedEdgeIds: readonly Hash[],
  expectedIssuedHandles: readonly IssuedRouteHandle[],
  currentEdgeIds: readonly Hash[],
): void {
  if (!sameHashList(currentEdgeIds, expectedEdgeIds)) throw new TypeError("ordered route edges changed");
  if (route.routeHash !== expectedRouteHash || route.routeBindingHash !== expectedRouteBindingHash) throw new TypeError("route binding changed");
  validateRouteCapability(route, expectedEdgeIds, expectedIssuedHandles);
}

function hasTerminalFailureKind(value: unknown): value is StageTerminalFailureV1 {
  return value !== null
    && typeof value === "object"
    && "kind" in value
    && ["retryable", "invalidProgram", "chainProvenRejected"].includes((value as { kind?: unknown }).kind as string);
}

function decodeStageFailure(value: unknown, expectedStage: SearchStageV1): StageFailureV1 {
  assertExactKeys(value, ["kind", "stage", "code"], "stageFailure");
  const record = value as Record<string, unknown>;
  if (record.kind !== "retryable" && record.kind !== "invalidProgram") throw new TypeError("stage failure kind is unsupported");
  if (record.stage !== expectedStage) throw new TypeError("stage failure owner mismatch");
  return Object.freeze({
    kind: record.kind,
    stage: expectedStage,
    code: assertNonEmptyString(record.code, "stageFailure.code"),
  });
}

export function qualifiedStageRejectionReceiptHash(
  value: Omit<QualifiedStageRejectionReceiptV1, "receiptHash">,
): Hash {
  return hashDomain("aloha/qualified-stage-rejection-receipt/v1", value);
}

function decodeQualifiedStageRejectionReceipt(value: unknown): QualifiedStageRejectionReceiptV1 {
  assertExactKeys(value, [
    "kind", "stage", "routeHash", "source", "correlationId", "inputArtifactHash", "programHash", "code", "evidenceHash", "ownerReceiptHash", "receiptHash",
  ], "qualifiedStageRejectionReceipt");
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.qualified-stage-rejection-v1") throw new TypeError("qualified stage rejection receipt kind is unsupported");
  if (record.stage !== "planner" && record.stage !== "exact" && record.stage !== "execution-program" && record.stage !== "final-sim") {
    throw new TypeError("qualified stage rejection receipt stage is unsupported");
  }
  const body = {
    kind: record.kind,
    stage: record.stage,
    routeHash: assertHash(record.routeHash, "qualifiedStageRejectionReceipt.routeHash"),
    source: source(record.source, "qualifiedStageRejectionReceipt.source"),
    correlationId: assertHash(record.correlationId, "qualifiedStageRejectionReceipt.correlationId"),
    inputArtifactHash: assertHash(record.inputArtifactHash, "qualifiedStageRejectionReceipt.inputArtifactHash"),
    programHash: record.programHash === null ? null : assertHash(record.programHash, "qualifiedStageRejectionReceipt.programHash"),
    code: assertNonEmptyString(record.code, "qualifiedStageRejectionReceipt.code"),
    evidenceHash: assertHash(record.evidenceHash, "qualifiedStageRejectionReceipt.evidenceHash"),
    ownerReceiptHash: assertHash(record.ownerReceiptHash, "qualifiedStageRejectionReceipt.ownerReceiptHash"),
  } satisfies Omit<QualifiedStageRejectionReceiptV1, "receiptHash">;
  const receiptHash = assertHash(record.receiptHash, "qualifiedStageRejectionReceipt.receiptHash");
  if (receiptHash !== qualifiedStageRejectionReceiptHash(body)) throw new TypeError("qualified stage rejection receipt hash mismatch");
  return deepFreeze({ ...body, receiptHash });
}

type ExpectedStageRejectionBindingV1 = Readonly<{
  readonly stage: QualifiedStageRejectionReceiptV1["stage"];
  readonly routeHash: Hash;
  readonly source: SourceViewV1;
  readonly correlationId: Hash;
  readonly inputArtifactHash: Hash;
  readonly programHash: Hash | null;
}>;

function decodeStageRejection(
  value: unknown,
  authority: StageRejectionAuthorityPortV1,
  expected: ExpectedStageRejectionBindingV1,
): StageChainRejectionV1 {
  assertExactKeys(value, ["kind", "stage", "code", "evidenceHash", "capability"], "stageRejection");
  const record = value as Record<string, unknown>;
  if (record.kind !== "chainProvenRejected" || record.stage !== expected.stage) throw new TypeError("stage rejection owner mismatch");
  const code = assertNonEmptyString(record.code, "stageRejection.code");
  const evidenceHash = assertHash(record.evidenceHash, "stageRejection.evidenceHash");
  if (record.capability === null || typeof record.capability !== "object") throw new TypeError("stage rejection capability is missing");
  if (authority === null || typeof authority !== "object" || typeof authority.read !== "function") throw new TypeError("stage rejection authority is missing");
  const receipt = decodeQualifiedStageRejectionReceipt(authority.read(record.capability as QualifiedStageRejectionCapabilityV1));
  if (receipt.stage !== expected.stage
    || receipt.routeHash !== expected.routeHash
    || !sameSource(receipt.source, expected.source)
    || receipt.correlationId !== expected.correlationId
    || receipt.inputArtifactHash !== expected.inputArtifactHash
    || receipt.programHash !== expected.programHash
    || receipt.code !== code
    || receipt.evidenceHash !== evidenceHash) {
    throw new TypeError("qualified stage rejection lineage mismatch");
  }
  return Object.freeze({
    kind: "chainProvenRejected",
    stage: expected.stage,
    code,
    evidenceHash,
    capability: record.capability as QualifiedStageRejectionCapabilityV1,
  });
}

function normalizeStageTerminalFailure(
  value: StageTerminalFailureV1,
  authority: StageRejectionAuthorityPortV1,
  expected: ExpectedStageRejectionBindingV1,
): StageTerminalFailureV1 {
  try {
    return value.kind === "chainProvenRejected"
      ? decodeStageRejection(value, authority, expected)
      : decodeStageFailure(value, expected.stage);
  } catch {
    return failure("invalidProgram", expected.stage, "stage-terminal-authority-invalid");
  }
}

function completedStageTiming(
  startedMonotonicNs: bigint,
  finishedMonotonicNs: bigint,
): SearchStageTimingFactV1 {
  if (finishedMonotonicNs < startedMonotonicNs) throw new TypeError("search stage monotonic clock regressed");
  return Object.freeze({
    startedMonotonicNs: startedMonotonicNs.toString(),
    finishedMonotonicNs: finishedMonotonicNs.toString(),
    durationUs: ((finishedMonotonicNs - startedMonotonicNs) / 1_000n).toString(),
  });
}

function economicSafetyDeclarations(
  evidence: ExecutionProgramSixStepEvidenceV1,
  program: ExecutionProgramArtifactV1,
): readonly EconomicSafetyDeclaredObligationV1[] {
  const facts = canonicalValue(evidence.facts, "economicSafety.executionOwnerFacts");
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) throw new TypeError("economic safety execution owner facts are invalid");
  const record = facts as Record<string, CanonicalJson>;
  if (record.obligationRoot !== program.obligationRoot || !Array.isArray(record.declaredObligations)) {
    throw new TypeError("economic safety declared obligations are missing");
  }
  return Object.freeze(record.declaredObligations.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`economic safety declared obligation ${index} is invalid`);
    assertExactKeys(value, ["obligationRef", "ownerRef", "policy"], `economicSafety.declaredObligations[${index}]`);
    const declaration = value as Record<string, unknown>;
    if (declaration.policy !== "must-satisfy") throw new TypeError("economic safety declared obligation policy is unsupported");
    return Object.freeze({
      obligationRef: nonEmptyHash(declaration.obligationRef, `economicSafety.declaredObligations[${index}].obligationRef`),
      ownerRef: nonEmptyHash(declaration.ownerRef, `economicSafety.declaredObligations[${index}].ownerRef`),
      policy: "must-satisfy" as const,
    });
  }));
}

/**
 * Continue one already-admitted route after the route and coarse stages have
 * been completed by the route enumerator.  Keeping this primitive separate is
 * important: the multi-route coordinator must not re-run coarse projection
 * after Top-K admission, because a second read could change the denominator
 * or silently replace the route that was actually ranked.
 */
export async function runResolvedRoutePipeline<Projection, Plan, Exact, Simulation>(
  ports: ResolvedRoutePipelinePortsV1<Projection, Plan, Exact, Simulation>,
  input: ResolvedRoutePipelineInputV1,
  route: RouteCapabilityV1,
  coarse: CoarseRankableV1<Projection> | CoarseBoundedUnrankedV1,
): Promise<SearchPipelineOutcomeV1<Simulation>> {
  let stage: SearchStageV1 = "planner";
  let executionProgramOwnerEvidence: ExecutionProgramSixStepEvidenceV1 | null = null;
  let stage3Artifact: ProductionSixStepEmissionCapabilityV1 | null = null;
  let stage4Artifact: ProductionSixStepEmissionCapabilityV1 | null = null;
  let stage5Artifact: ProductionSixStepEmissionCapabilityV1 | null = null;
  let stage6Artifact: ProductionSixStepEmissionCapabilityV1 | null = null;
  try {
    assertIssuedEconomicSafetyFinalizationServiceV1(ports.economicSafety);
    assertIssuedProductionSixStepTailEmissionPortV1(ports.sixStepArtifacts);
    const sourceSession = input.currentSource;
    const sourceView = requireSource(sourceSession);
    const bindingHash = hashDomain("aloha/search-lease-binding/v1", input.lease.binding);
    const orderedEdgeIds = Object.freeze(input.orderedEdgeIds.map((edgeId, index) => nonEmptyHash(edgeId, `orderedEdgeIds[${index}]`)));
    const objective = validateSearchObjective(input.objective);
    await fence(input.lease, sourceSession, sourceView, bindingHash);
    validateRouteCapability(route, orderedEdgeIds);
    const expectedRouteHash = route.routeHash;
    const expectedRouteBindingHash = route.routeBindingHash;
    const expectedIssuedHandles = Object.freeze(route.legs.map(leg => leg.issuedHandle));
    const assertPostStageFence = async (): Promise<void> => {
      await fence(input.lease, sourceSession, sourceView, bindingHash);
      assertRouteStable(route, expectedRouteHash, expectedRouteBindingHash, orderedEdgeIds, expectedIssuedHandles, input.orderedEdgeIds);
    };
    if (coarse.routeHash !== route.routeHash || !sameSource(source(coarse.source, "coarse.source"), sourceView)) return failure("invalidProgram", "coarse", "coarse-binding-mismatch") as SearchPipelineOutcomeV1<Simulation>;

    stage = "planner";
    const plannerStartedMonotonicNs = process.hrtime.bigint();
    const planned = await (async () => {
      try {
        return await ports.planner.plan({ binding: input.lease.binding, route, coarse, strategy: input.strategy, objective, correlationId: input.correlationId });
      } finally {
        await assertPostStageFence();
      }
    })();
    const plannerFinishedMonotonicNs = process.hrtime.bigint();
    if (hasTerminalFailureKind(planned)) return normalizeStageTerminalFailure(planned, ports.planner.rejectionAuthority, {
      stage: "planner",
      routeHash: route.routeHash,
      source: sourceView,
      correlationId: input.correlationId,
      inputArtifactHash: coarse.kind === "rankable" ? coarse.projectionHash : coarse.evidenceHash,
      programHash: null,
    });
    if (planned.kind !== "planned" || planned.routeHash !== route.routeHash || !sameSource(source(planned.source, "planned.source"), sourceView)) return failure("invalidProgram", "planner", "plan-binding-mismatch") as SearchPipelineOutcomeV1<Simulation>;
    const plannerTiming = completedStageTiming(plannerStartedMonotonicNs, plannerFinishedMonotonicNs);
    stage3Artifact = await ports.sixStepArtifacts.emitPlanner({
      pipeline: input,
      route,
      coarse: canonicalValue(coarse, "sixStepEmission.coarse"),
      planned: canonicalValue(planned, "sixStepEmission.planned"),
      timing: plannerTiming,
    });
    stage = "exact";
    const exactStartedMonotonicNs = process.hrtime.bigint();
    const exact = await (async () => {
      try {
        return await ports.exact.evaluate({ plan: planned.plan, planHash: planned.planHash, route, source: sourceSession, deadlineAtMs: input.deadlineAtMs, signal: input.signal });
      } finally {
        await assertPostStageFence();
      }
    })();
    const exactFinishedMonotonicNs = process.hrtime.bigint();
    if (hasTerminalFailureKind(exact)) return normalizeStageTerminalFailure(exact, ports.exact.rejectionAuthority, {
      stage: "exact",
      routeHash: route.routeHash,
      source: sourceView,
      correlationId: input.correlationId,
      inputArtifactHash: planned.planHash,
      programHash: null,
    });
    if (exact.kind !== "verified" || exact.routeHash !== route.routeHash || !sameSource(source(exact.source, "exact.source"), sourceView)) return failure("invalidProgram", "exact", "exact-binding-mismatch") as SearchPipelineOutcomeV1<Simulation>;
    const exactTiming = completedStageTiming(exactStartedMonotonicNs, exactFinishedMonotonicNs);
    stage4Artifact = await ports.sixStepArtifacts.emitExact({
      parent: stage3Artifact,
      pipeline: input,
      route,
      exact: canonicalValue(exact, "sixStepEmission.exact"),
      timing: exactTiming,
    });
    stage = "execution-program";
    const executionProgramStartedMonotonicNs = process.hrtime.bigint();
    const compiled = await (async () => {
      try {
        return await ports.executionProgram.compile({ binding: input.lease.binding, plan: planned.plan, planHash: planned.planHash, exact: exact.exact, exactHash: exact.exactHash, route, source: sourceSession, correlationId: input.correlationId, deadlineAtMs: input.deadlineAtMs });
      } finally {
        await assertPostStageFence();
      }
    })();
    const executionProgramFinishedMonotonicNs = process.hrtime.bigint();
    if (hasTerminalFailureKind(compiled)) return normalizeStageTerminalFailure(compiled, ports.executionProgram.rejectionAuthority, {
      stage: "execution-program",
      routeHash: route.routeHash,
      source: sourceView,
      correlationId: input.correlationId,
      inputArtifactHash: exact.exactHash,
      programHash: null,
    });
    if (compiled.kind !== "compiled") return failure("invalidProgram", "execution-program", "program-not-compiled") as SearchPipelineOutcomeV1<Simulation>;
    const program = sealProgram(compiled.program);
    if (program.generationId !== input.lease.binding.generationId || program.routeHash !== route.routeHash || !sameSource(program.source, sourceView)) return failure("invalidProgram", "execution-program", "program-binding-mismatch") as SearchPipelineOutcomeV1<Simulation>;
    const executionEvidenceCapability = Object.prototype.hasOwnProperty.call(compiled, "sixStepEvidence")
      ? compiled.sixStepEvidence
      : undefined;
    const executionEvidenceAuthority = ports.executionProgram.sixStepEvidenceAuthority;
    if ((executionEvidenceCapability === undefined) !== (executionEvidenceAuthority === undefined)) {
      return failure("invalidProgram", "execution-program", "six-step-evidence-authority-incomplete") as SearchPipelineOutcomeV1<Simulation>;
    }
    if (executionEvidenceCapability !== undefined && executionEvidenceAuthority !== undefined) {
      try {
        executionProgramOwnerEvidence = normalizeExecutionProgramEvidence(
          executionEvidenceAuthority.read(executionEvidenceCapability),
          {
            correlationId: input.correlationId,
            generationId: input.lease.binding.generationId,
            source: sourceView,
            routeHash: route.routeHash,
            exactHash: exact.exactHash,
            programHash: program.programHash,
          },
        );
      } catch {
        return failure("invalidProgram", "execution-program", "six-step-evidence-authority-invalid") as SearchPipelineOutcomeV1<Simulation>;
      }
    }
    if (executionProgramOwnerEvidence === null) {
      return failure("invalidProgram", "execution-program", "owner-evidence-missing") as SearchPipelineOutcomeV1<Simulation>;
    }
    const executionProgramTiming = completedStageTiming(executionProgramStartedMonotonicNs, executionProgramFinishedMonotonicNs);
    stage5Artifact = await ports.sixStepArtifacts.emitExecutionProgram({
      parent: stage4Artifact,
      pipeline: input,
      route,
      program,
      ownerEvidence: executionProgramOwnerEvidence,
      timing: executionProgramTiming,
    });
    stage = "final-sim";
    const finalSimulationStartedMonotonicNs = process.hrtime.bigint();
    const simulation = await (async () => {
      try {
        return await ports.finalSimulation.simulate({ binding: input.lease.binding, program, source: sourceSession, callerId: input.callerId, correlationId: input.correlationId, deadlineAtMs: input.deadlineAtMs, signal: input.signal });
      } finally {
        await assertPostStageFence();
      }
    })();
    const finalSimulationFinishedMonotonicNs = process.hrtime.bigint();
    if (hasTerminalFailureKind(simulation)) return retainResolvedRouteExecutionProgramEvidence(normalizeStageTerminalFailure(simulation, ports.finalSimulation.rejectionAuthority, {
      stage: "final-sim",
      routeHash: route.routeHash,
      source: sourceView,
      correlationId: input.correlationId,
      inputArtifactHash: program.programHash,
      programHash: program.programHash,
    }), executionProgramOwnerEvidence);
    if (simulation.kind !== "passed") return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "simulation-not-passed") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
    const simReceipt = simulation.receipt;
    if (simReceipt.generationId !== input.lease.binding.generationId || !sameSource(source(simReceipt.source, "simulation.source"), sourceView) || simReceipt.programHash !== program.programHash || !nonEmptyHash(simReceipt.effectsHash, "simulation.effectsHash") || !nonEmptyHash(simReceipt.receiptHash, "simulation.receiptHash")) return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "simulation-binding-mismatch") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
    if (!sameEffectTransportDeclaration(program.effectTransport, simReceipt.effectTransport)) return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "effect-transport-binding-mismatch") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
    const finalEvidenceCapability = Object.prototype.hasOwnProperty.call(simulation, "sixStepEvidence")
      ? simulation.sixStepEvidence
      : undefined;
    const finalEvidenceAuthority = ports.finalSimulation.sixStepEvidenceAuthority;
    if ((finalEvidenceCapability === undefined) !== (finalEvidenceAuthority === undefined)) {
      return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "six-step-evidence-authority-incomplete") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
    }
    let finalSimulationOwnerEvidence: FinalSimulationSixStepEvidenceV1 | null = null;
    if (finalEvidenceCapability !== undefined && finalEvidenceAuthority !== undefined) {
      try {
        finalSimulationOwnerEvidence = normalizeFinalSimulationEvidence(
          finalEvidenceAuthority.read(finalEvidenceCapability),
          {
            correlationId: input.correlationId,
            generationId: input.lease.binding.generationId,
            source: sourceView,
            programHash: program.programHash,
            finalSimulationReceiptHash: simReceipt.receiptHash,
          },
        );
      } catch {
        return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "six-step-evidence-authority-invalid") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
      }
    }
    const seedCapability = Object.prototype.hasOwnProperty.call(simulation, "schedulerJoinSeed")
      ? simulation.schedulerJoinSeed
      : undefined;
    const seedAuthority = ports.finalSimulation.schedulerJoinAuthority;
    if ((seedCapability === undefined) !== (seedAuthority === undefined)) {
      return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "scheduler-resource-join-incomplete") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
    }
    let schedulerJoinSeed: FinalSimulationSchedulerJoinSeedV1 | null = null;
    if (seedCapability !== undefined && seedAuthority !== undefined) {
      try {
        schedulerJoinSeed = seedAuthority.read(seedCapability);
        if (schedulerJoinSeed.correlationId !== input.correlationId
          || schedulerJoinSeed.generationId !== input.lease.binding.generationId
          || !sameSource(source(schedulerJoinSeed.source, "schedulerJoinSeed.source"), sourceView)
          || schedulerJoinSeed.programHash !== program.programHash
          || schedulerJoinSeed.finalSimulationReceiptHash !== simReceipt.receiptHash
          || schedulerJoinSeed.schedulerCompletion === null
          || typeof schedulerJoinSeed.schedulerCompletion !== "object") {
          return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "scheduler-resource-join-binding-mismatch") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
        }
      } catch {
        return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "final-sim", "scheduler-resource-join-authority-invalid") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
      }
    }
    stage = "economics-safety";
    if (executionProgramOwnerEvidence === null || finalSimulationOwnerEvidence === null) {
      return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "economics-safety", "owner-evidence-missing") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
    }
    let economicSafety: EconomicSafetyEvidenceV1;
    try {
      const finalizationInput: EconomicSafetyFinalizationInputV1 = {
        releaseProvenanceHash: input.lease.binding.releaseProvenanceHash,
        correlationId: input.correlationId,
        generationId: input.lease.binding.generationId,
        source: Object.freeze({
          chainId: sourceView.chainId,
          number: sourceView.number,
          hash: nonEmptyHash(sourceView.hash, "economicSafety.source.hash"),
          stateRoot: nonEmptyHash(sourceView.stateRoot, "economicSafety.source.stateRoot"),
        }),
        objectiveRef: objective.objectiveRef,
        exactHash: exact.exactHash,
        programHash: program.programHash,
        obligationRoot: program.obligationRoot,
        finalSimulationReceiptHash: simReceipt.receiptHash,
        effectsHash: simReceipt.effectsHash,
        executionOwnerEvidenceRoot: executionProgramOwnerEvidence.evidenceRoot,
        finalSimulationOwnerEvidenceRoot: finalSimulationOwnerEvidence.evidenceRoot,
        dryRun: true,
        executionOwnerFacts: executionProgramOwnerEvidence.facts,
        finalSimulationOwnerFacts: finalSimulationOwnerEvidence.facts,
        declaredObligations: economicSafetyDeclarations(executionProgramOwnerEvidence, program),
      };
      const capability = await ports.economicSafety.finalize(finalizationInput);
      economicSafety = validateEconomicSafetyEvidenceV1(
        ports.economicSafety.read(capability),
        finalizationInput,
        ports.economicSafety.binding(),
      );
    } catch {
      await assertPostStageFence();
      return retainResolvedRouteExecutionProgramEvidence(failure("invalidProgram", "economics-safety", "finalization-authority-invalid") as SearchPipelineOutcomeV1<Simulation>, executionProgramOwnerEvidence);
    }
    await assertPostStageFence();

    const finalSimulationTiming = completedStageTiming(finalSimulationStartedMonotonicNs, finalSimulationFinishedMonotonicNs);
    stage6Artifact = await ports.sixStepArtifacts.emitFinalSimulation({
      parent: stage5Artifact,
      pipeline: input,
      route,
      program,
      simulation: canonicalValue(simReceipt, "sixStepEmission.finalSimulation"),
      ownerEvidence: finalSimulationOwnerEvidence,
      economicSafety,
      timing: finalSimulationTiming,
    });

    stage = "unsigned-dry-run";
    const receipt = await (async () => {
      try {
        return ports.unsignedDryRun.issue({ binding: input.lease.binding, candidateId: input.routeCandidateId, orderedEdgeIds, route, coarse, plan: planned, exact, program, simulation: simReceipt, economicSafety, objectiveRef: objective.objectiveRef, correlationId: input.correlationId });
      } finally {
        await assertPostStageFence();
      }
    })();
    validateUnsignedDryRunReceipt(receipt, { binding: input.lease.binding, candidateId: input.routeCandidateId, orderedEdgeIds, route, coarse, plan: planned, exact, program, simulation: simReceipt, economicSafety, objectiveRef: objective.objectiveRef, correlationId: input.correlationId });
    const schedulerResourceJoin = schedulerJoinSeed === null
      ? null
      : issueSearchSchedulerResourceJoin(schedulerJoinSeed, receipt);
    const successfulOutcome = Object.freeze({ kind: "unsigned-dry-run" as const, receipt, schedulerResourceJoin });
    const trace = sealResolvedRouteSixStepTrace({
      schemaVersion: 1,
      kind: "aloha.resolved-route-six-step-trace-v1",
      binding: canonicalValue(input.lease.binding, "sixStepTrace.binding"),
      routeCandidateId: input.routeCandidateId,
      orderedEdgeIds,
      routeBinding: canonicalValue({
        routeHash: route.routeHash,
        routeBindingHash: route.routeBindingHash,
        legs: route.legs.map(leg => ({ edgeId: leg.edgeId, ownerRef: leg.ownerRef })),
      }, "sixStepTrace.routeBinding"),
      strategy: canonicalValue(input.strategy, "sixStepTrace.strategy"),
      objective: canonicalValue(objective, "sixStepTrace.objective"),
      source: sourceView,
      correlationId: input.correlationId,
      coarse: canonicalValue(coarse, "sixStepTrace.coarse"),
      planner: canonicalValue(planned, "sixStepTrace.planner"),
      exact: canonicalValue(exact, "sixStepTrace.exact"),
      executionProgram: canonicalValue(program, "sixStepTrace.executionProgram"),
      executionProgramOwnerEvidence,
      finalSimulation: canonicalValue(simReceipt, "sixStepTrace.finalSimulation"),
      finalSimulationOwnerEvidence,
      economicSafety,
      unsignedDryRun: canonicalValue(receipt, "sixStepTrace.unsignedDryRun"),
      timings: Object.freeze({
        planner: plannerTiming,
        exact: exactTiming,
        executionProgram: executionProgramTiming,
        finalSimulation: finalSimulationTiming,
      }),
      productionArtifactSetRoots: Object.freeze([
        readProductionSixStepArtifactMaterialV1(stage3Artifact).artifactSetRoot,
        readProductionSixStepArtifactMaterialV1(stage4Artifact).artifactSetRoot,
        readProductionSixStepArtifactMaterialV1(stage5Artifact).artifactSetRoot,
        readProductionSixStepArtifactMaterialV1(stage6Artifact).artifactSetRoot,
      ]),
    });
    resolvedRouteSixStepTraces.set(successfulOutcome, trace);
    const stage12 = ports.sixStepArtifacts.readStage12Parents(stage3Artifact);
    if (stage12.stage1.length === 0
      || stage12.stage1.length !== stage12.stage2.length
      || stage12.stage2.length !== route.legs.length) {
      throw new TypeError("production Six-Step Stage 1/2 route parents are incomplete");
    }
    resolvedRouteSixStepArtifactCapabilities.set(successfulOutcome, Object.freeze({
      stage1: Object.freeze([...stage12.stage1]),
      stage2: Object.freeze([...stage12.stage2]),
      stage3: stage3Artifact,
      stage4: stage4Artifact,
      stage5: stage5Artifact,
      stage6: stage6Artifact,
    }));
    return retainResolvedRouteExecutionProgramEvidence(successfulOutcome, executionProgramOwnerEvidence);
  } catch (error) {
    return retainResolvedRouteExecutionProgramEvidence(
      mapThrown(stage, error) as SearchPipelineOutcomeV1<Simulation>,
      executionProgramOwnerEvidence,
    );
  }
}

export function sealExecutionProgram(
  input: Omit<ExecutionProgramArtifactV1, "programHash">,
): ExecutionProgramArtifactV1 {
  const body = {
    kind: "execution-program" as const,
    generationId: assertNonEmptyString(input.generationId, "executionProgram.generationId"),
    source: source(input.source, "executionProgram.source"),
    routeHash: nonEmptyHash(input.routeHash, "executionProgram.routeHash"),
    programBytes: assertNonEmptyString(input.programBytes, "executionProgram.programBytes"),
    payloadHash: nonEmptyHash(input.payloadHash, "executionProgram.payloadHash"),
    issuerRef: nonEmptyHash(input.issuerRef, "executionProgram.issuerRef"),
    obligationRoot: nonEmptyHash(input.obligationRoot, "executionProgram.obligationRoot"),
    ...(input.effectTransport === undefined
      ? {}
      : { effectTransport: normalizeEffectTransportDeclaration(input.effectTransport, "executionProgram.effectTransport") }),
  };
  return deepFreeze({ ...body, programHash: hashDomain("aloha/execution-program-artifact/v1", body) });
}

export function sealUnsignedDryRunReceipt<Projection, Plan, Exact, Simulation>(
  input: UnsignedDryRunInputV1<Projection, Plan, Exact, Simulation>,
): UnsignedDryRunReceiptV1 {
  validateRouteCapability(input.route, input.orderedEdgeIds, input.route.legs.map(leg => leg.issuedHandle));
  const program = sealProgram(input.program);
  if (program.programHash !== input.program.programHash) throw new TypeError("unsigned dry-run program was not sealed");
  if (input.simulation.programHash !== program.programHash) throw new TypeError("unsigned dry-run simulation program mismatch");
  const body = {
    kind: "aloha.unsigned-dry-run-v1" as const,
    correlationId: nonEmptyHash(input.correlationId, "correlationId"),
    generationId: input.binding.generationId,
    readyRecordHash: input.binding.readyRecordHash,
    cutoff: input.binding.cutoff,
    graphRoot: input.binding.graphRoot,
    candidateId: nonEmptyHash(input.candidateId, "candidateId"),
    orderedEdgeIds: Object.freeze(input.orderedEdgeIds.map((edgeId, index) => nonEmptyHash(edgeId, `orderedEdgeIds[${index}]`))),
    orderedEdgeIdsRoot: orderedEdgeIdsRoot(input.orderedEdgeIds),
    routeHash: input.route.routeHash,
    routeBindingHash: input.route.routeBindingHash,
    objectiveRef: input.objectiveRef,
    source: source(program.source, "program.source"),
    coarseKind: input.coarse.kind,
    planHash: input.plan.planHash,
    exactHash: input.exact.exactHash,
    programHash: program.programHash,
    finalSimulationReceiptHash: input.simulation.receiptHash,
    safetyRoot: input.economicSafety.evidenceRoot,
    signer: null,
    transactionHash: null,
  };
  return deepFreeze({ ...body, lineageHash: lineageHash(body) });
}

export function validateUnsignedDryRunReceiptValue(value: UnsignedDryRunReceiptV1): void {
  assertExactKeys(value, [
    "kind", "correlationId", "generationId", "readyRecordHash", "cutoff", "graphRoot", "candidateId", "orderedEdgeIds", "orderedEdgeIdsRoot", "routeHash", "routeBindingHash", "objectiveRef", "source", "coarseKind", "planHash", "exactHash", "programHash", "finalSimulationReceiptHash", "safetyRoot", "lineageHash", "signer", "transactionHash",
  ], "unsignedDryRunReceipt");
  if (value.kind !== "aloha.unsigned-dry-run-v1" || value.signer !== null || value.transactionHash !== null) throw new TypeError("receipt is not unsigned");
  nonEmptyHash(value.candidateId, "unsignedDryRunReceipt.candidateId");
  if (!Array.isArray(value.orderedEdgeIds) || value.orderedEdgeIds.length === 0) throw new TypeError("unsignedDryRunReceipt.orderedEdgeIds is empty");
  if (value.orderedEdgeIdsRoot !== orderedEdgeIdsRoot(value.orderedEdgeIds)) throw new TypeError("unsignedDryRunReceipt.orderedEdgeIdsRoot mismatch");
  nonEmptyHash(value.routeBindingHash, "unsignedDryRunReceipt.routeBindingHash");
  nonEmptyHash(value.lineageHash, "unsignedDryRunReceipt.lineageHash");
  const { lineageHash: ignored, ...body } = value;
  if (lineageHash(body) !== value.lineageHash) throw new TypeError("unsigned dry-run receipt lineage hash mismatch");
}

// The multi-route coordinator is kept in a separate module so the per-route
// primitive above remains easy to audit while the public composition grows.
export * from "./route-pipeline.ts";
