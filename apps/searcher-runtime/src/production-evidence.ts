import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalBytes,
  deepFreeze,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createSqliteDurableStore,
  readDurableAppendCapabilityV1,
  type DurableAppendCapabilityV1,
  type DurableAppendRecord,
  type DurableAppendReceipt,
  type SQLiteDurableStore,
} from "../../../packages/durable-store/src/index.ts";
import {
  readIssuedProducerLaneFactsV1,
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  producerHeadFactsRootV1,
  type CanonicalHead,
  type ProducerEligibleHeadInputV1,
  type ProducerCurrentSourceLogicalFactsV1,
  type ProducerCurrentSourcePhysicalFactsV1,
  type ProducerHeadFactsV1,
  type ProducerHeadTerminalCapabilityV1,
  type ProducerPerformancePortV1,
  type ProducerSessionV1,
  type ProducerTerminalPortV1,
  type ProducerTerminalReasonV1,
  type ProducerTerminalV1,
} from "../../../packages/producer/src/index.ts";
import type { CanonicalHeadObservationV1 } from "../../../packages/canonical-source/src/index.ts";
import {
  issueProducerPerformancePortV1,
  issueProducerTerminalPortV1,
  readIssuedProducerLaneCoarseTimingV1,
  readIssuedProducerLaneCandidateTerminalObservationsV1,
  readIssuedProducerLanePlannerEnumerationV1,
  readIssuedProducerNoInputLaneDenominatorV1,
  readIssuedProducerLaneSearchTerminalCapabilityV1,
  readIssuedProducerLaneSchedulerResourceJoinV1,
  readIssuedProducerLaneSixStepTraceV1,
} from "../../../packages/producer/src/internal/owners.ts";
import type { ProducerCandidateTerminalObservationV1 } from "../../../packages/producer/src/index.ts";
import type { ReadyStage12EvidenceBindingV1 } from "../../../packages/checkpoint/src/index.ts";
import { readProductionSixStepArtifactMaterialV1 } from "../../../packages/evidence-emitter/src/index.ts";
import {
  decodeSixStepStageFacts,
  decodeSixStepWitnessContent,
  hashSixStepWitnessContentRoot,
} from "../../../specs/evidence/src/six-step.ts";
import { validateProcessResourceObservationValue } from "../../../packages/process-resource-observer/src/index.ts";
import {
  validateSchedulerPerformanceRangeFactValue,
  validateSchedulerWorkCompletionFactValue,
} from "../../../packages/scheduler/src/index.ts";
import {
  assertIssuedEconomicSafetyFinalizationServiceV1,
  validateEconomicSafetyEvidenceV1,
  type EconomicSafetyDeclaredObligationV1,
  type EconomicSafetyEvidenceAuthorityExpectationV1,
  type EconomicSafetyFinalizationInputV1,
  type EconomicSafetyFinalizationServiceV1,
} from "../../../packages/economics-safety/src/index.ts";
import {
  decodeAssetReferenceV1,
  type AssetReferenceV1,
} from "../../../packages/asset-ref/src/index.ts";
import {
  createPerformanceWindowCommitment,
  createPerformanceAdmissionOrphanReplacementLineage,
  decodePerformanceAdmissionOrphanReplacementLineage,
  decodeHardwareProfileObservationV1,
  decodePerformanceWindowCommitment,
  decodeProductionPerformanceProfile,
  hashProcessLogAnchor,
  PERFORMANCE_TARGET_COUNT,
  performanceLaneCandidateRefV1,
  type HardwareProfileObservationV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceAdmissionOrphanReplacementLineageV1,
  type ProcessLogAnchorV1,
  type ProductionPerformanceProfileV1,
} from "../../../specs/performance/src/index.ts";
import {
  readIssuedSearchTerminalCapabilityV1,
  routeAccountingRootV1,
  type ProductionSixStepArtifactCapabilitiesV1,
  type RouteAccountingV1,
  type SearchSchedulerResourceJoinV1,
} from "../../../packages/search-pipeline/src/index.ts";
import {
  readIssuedSearchTerminalSixStepArtifactCapabilitiesV1,
  type RouteCoarseTimingFactsV1,
  type SearchSixStepGraphLegV1,
  type SearchTerminalSixStepTraceV1,
} from "../../../packages/search-pipeline/src/route-pipeline.ts";
import {
  assertIssuedRuntimeReleasePerformanceRuntimeService,
  RuntimeReleasePerformanceHeadSamplePendingError,
  type RuntimeReleasePerformanceHeadCapabilityV1,
  type RuntimeReleasePerformanceHeadFactsV1,
  type RuntimeReleasePerformanceHeadHandleV1,
  type RuntimeReleasePerformanceRuntimeServiceV1,
  type RuntimeReleasePerformanceWindowCapabilityV1,
  type RuntimeReleasePerformanceWindowFactsV1,
} from "../../../packages/runtime-release-authority/src/performance-runtime-consumer.ts";
import {
  assertIssuedStartupRuntime,
  readStartupStage12EvidenceBinding,
  type StartupRuntimeV1,
} from "../../../packages/startup-runtime/src/index.ts";
import {
  assertIssuedRuntimeReleaseStrategyRuntimeService,
  type RuntimeReleaseStrategyEvidenceExpectationV1,
  type RuntimeReleaseStrategyRuntimeServiceV1,
} from "../../../packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts";
import type { RuntimeAnchorReceiptV1 } from "./deployment.ts";
import {
  issueSearcherProductionSixStepCompleteAppendCapabilityV1,
  issueSearcherProductionSixStepPerformanceAppendCapabilityV1,
  readSearcherProductionSixStepCompleteAppendMaterialV1,
  type SearcherProductionSixStepCompleteAppendCapabilityV1,
  type SearcherProductionSixStepPerformanceAppendCapabilityV1,
} from "../../../packages/six-step-process-evidence/src/internal/complete-append-owner.ts";
import {
  issueSearcherProductionSixStepWindowSelectionV1,
} from "../../../packages/six-step-process-evidence/src/internal/window-selection-owner.ts";
import type {
  SearcherProductionSixStepWindowSelectionCapabilityV1,
} from "../../../packages/six-step-process-evidence/src/index.ts";
import {
  decodeTerminalPhaseInvalidFactV1,
  readFinalDurableWindowBindingV1,
  type FinalDurableEventAppendBindingV1,
  type FinalDurableWindowBindingV1,
  type FinalDurableWindowCapabilityV1,
  type TerminalPhaseInvalidFactV1,
  type TerminalPhaseInvalidReasonV1,
} from "../../../packages/final-durable-window/src/index.ts";
import {
  createTerminalPhaseHeadObservationV1,
  createTerminalPhaseInvalidFactV1,
  issueFinalDurableWindowCapabilityV1,
} from "../../../packages/final-durable-window/src/internal/owner.ts";
import {
  persistSearcherProductionEvidenceMaterialV1,
  readSearcherProductionEvidenceMaterialV1,
  searcherProductionEvidenceOrderedRootV1,
  type SearcherProductionEvidenceMaterialManifestV1,
} from "./production-evidence-material.ts";
import {
  exactProductionPlanningProblemV1,
  exactProductionRouteCandidateV1,
  validateProductionCandidateEvidenceJoinV1,
  validateProductionPlanningContextJoinV1,
  validateProductionPassedCandidateSixStepJoinV1,
  validateProductionResolvedRouteBindingV1,
  validateProductionStage2EdgeMembershipV1,
  validateProductionStrategyQualificationV1,
} from "./internal/production-evidence-validation.ts";

export type {
  TerminalPhaseInvalidFactV1,
  TerminalPhaseInvalidReasonV1,
} from "../../../packages/final-durable-window/src/index.ts";

const EVIDENCE_ROLE = "searcher-production-evidence";
const EVENT_KIND = "aloha.searcher-production-evidence-event" as const;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

export const SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES = Object.freeze({
  eligibleHeads: "searcher-production-evidence/eligible-heads/v1",
  headCoverage: "searcher-production-evidence/head-coverage/v1",
  routeDenominators: "searcher-production-evidence/route-denominators/v1",
  candidateSets: "searcher-production-evidence/candidate-sets/v1",
  performance: "searcher-production-evidence/performance/v1",
  producerTerminals: "searcher-production-evidence/producer-terminals/v1",
  terminalPhase: "searcher-production-evidence/terminal-phase/v1",
} as const);

type ProductionEvidenceNamespaceV1 = typeof SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES[keyof typeof SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES];
type ProductionEvidenceEventTypeV1 = "performance-window-basis" | "performance-window-commitment" | "eligible-head" | "orphan-replacement" | "head-coverage" | "route-denominator" | "candidate-set" | "performance-facts-incomplete" | "performance-facts-complete" | "producer-terminal" | "terminal-phase-invalid";

export interface SearcherProductionEvidenceReleaseV1 {
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: `${string}`;
}

export interface ServingBindingV1 {
  readonly generationId: string;
  readonly graphRoot: Hash;
  readonly readyRecordHash: Hash;
  readonly sourceCoverageRoot: Hash;
}

interface EligibleHeadPayloadV1 {
  readonly admissionId: Hash;
  readonly windowId: Hash | null;
  readonly ordinal: string;
  readonly head: CanonicalHead;
  readonly revision: string;
  readonly acceptedMonotonicNs: string;
}

interface OrphanReplacementPayloadV1 extends EligibleHeadPayloadV1 {
  readonly lineage: PerformanceAdmissionOrphanReplacementLineageV1;
}

interface PerformanceWindowBasisPayloadV1 {
  readonly basisId: Hash;
  readonly windowStartAnchor: CanonicalHead;
  readonly eligibilityRuleHash: Hash;
  readonly profile: ProductionPerformanceProfileV1;
  readonly providerRoot: Hash;
  readonly hardwareProfile: HardwareProfileObservationV1;
  readonly processLogAnchor: ProcessLogAnchorV1;
  readonly releaseBindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly runtimeAnchorHash: Hash;
  readonly targetCount: typeof PERFORMANCE_TARGET_COUNT;
  readonly committedMonotonicNs: string;
}

interface HeadCoveragePayloadV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly currentSourceLogicalFacts: readonly ProducerCurrentSourceLogicalFactsV1[];
  readonly currentSourcePhysicalFacts: ProducerCurrentSourcePhysicalFactsV1 | null;
  readonly currentSourcePhysicalFactsRoot: Hash | null;
  readonly coarseTimingFacts: readonly RouteCoarseTimingFactsV1[];
  readonly coarseTimingFactsRoot: Hash;
  readonly laneTerminalFacts: readonly (
    | Readonly<{
        readonly kind: "coverage";
        readonly lane: ProducerCurrentSourceLogicalFactsV1["lane"];
        readonly correlationId: Hash;
        readonly coverageRoot: Hash;
      }>
    | Readonly<{
        readonly kind: "failure";
        readonly lane: ProducerCurrentSourceLogicalFactsV1["lane"];
        readonly correlationId: Hash;
        readonly outcome: "retryable" | "failed" | "cancelled";
        readonly reasonCode: string;
      }>
  )[];
  readonly laneTerminalFactsRoot: Hash;
  readonly complete: boolean;
}

export interface CandidateSetPayloadV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly candidateRefs: readonly Hash[];
  readonly candidateTerminalObservations: readonly ProducerCandidateTerminalObservationV1[];
  readonly laneDenominators: readonly Readonly<{
    readonly lane: ProducerCurrentSourceLogicalFactsV1["lane"];
    readonly correlationId: Hash;
    readonly coverageRoot: Hash;
    readonly accountingRoot: Hash;
    readonly candidateCount: string;
    readonly observationRoots: readonly Hash[];
    readonly observationSetRoot: Hash;
  }>[];
  readonly candidateTerminalObservationSetRoot: Hash;
}

interface CandidateSetManifestPayloadV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly candidateRefCount: string;
  readonly candidateRefsRoot: Hash;
  readonly laneDenominators: readonly Readonly<{
    readonly lane: ProducerCurrentSourceLogicalFactsV1["lane"];
    readonly correlationId: Hash;
    readonly coverageRoot: Hash;
    readonly accountingRoot: Hash;
    readonly candidateCount: string;
    readonly observationSetRoot: Hash;
  }>[];
  readonly candidateTerminalObservationSetRoot: Hash;
  readonly material: SearcherProductionEvidenceMaterialManifestV1;
}

export interface RouteDenominatorCommonV1 {
  readonly admissionId: Hash;
  readonly headFactsRoot: Hash;
  readonly headHash: Hash;
  readonly lane: ProducerCurrentSourceLogicalFactsV1["lane"];
  readonly correlationId: Hash;
  readonly coverageRoot: Hash;
}

export interface AccountedRouteDenominatorPayloadV1 extends RouteDenominatorCommonV1 {
  readonly denominatorKind: "accounted";
  readonly plannerCandidateIdentity: Readonly<{
    readonly planningProblemHash: Hash;
    readonly objectiveRef: Hash;
    readonly entryAssetRef: Hash;
    readonly returnAssetRef: Hash;
    readonly triggerRef: Hash;
    readonly affectedEdgeIdsRoot: Hash;
  }>;
  /** Complete planner-derived candidate denominator read from the exact
   * search-pipeline terminal capability, never rebuilt from candidate-set. */
  readonly accounting: RouteAccountingV1;
}

interface AccountedRouteDenominatorManifestPayloadV1 extends RouteDenominatorCommonV1 {
  readonly denominatorKind: "accounted";
  readonly plannerCandidateIdentity: AccountedRouteDenominatorPayloadV1["plannerCandidateIdentity"];
  readonly accounting: Omit<RouteAccountingV1, "entries"> & Readonly<{
    readonly entryCount: string;
    readonly entrySequenceRoot: Hash;
  }>;
  readonly material: SearcherProductionEvidenceMaterialManifestV1;
}

export interface NoInputRouteDenominatorPayloadV1 extends RouteDenominatorCommonV1 {
  readonly denominatorKind: "no-input";
  readonly pendingSnapshot: Readonly<{
    readonly pendingNumber: string;
    readonly parentHash: Hash;
    readonly orderedTransactionHashes: readonly Hash[];
    readonly orderedTransactionHashesRoot: Hash;
    readonly transactionCount: string;
    readonly snapshotHash: Hash;
  }>;
  readonly absenceEvidenceHash: Hash;
  readonly terminalLineageHash: Hash;
  readonly currentSource: ProducerCurrentSourceLogicalFactsV1;
}

export type RouteDenominatorPayloadV1 = AccountedRouteDenominatorPayloadV1 | NoInputRouteDenominatorPayloadV1;
type RouteDenominatorWirePayloadV1 = AccountedRouteDenominatorManifestPayloadV1 | NoInputRouteDenominatorPayloadV1;

interface CanonicalProducerSchedulerJoinV1 extends Omit<SearchSchedulerResourceJoinV1, "schedulerCompletion"> {}

interface JoinedRuntimePerformanceFactsV1 extends RuntimeReleasePerformanceHeadFactsV1 {
  readonly producerSchedulerJoin: CanonicalProducerSchedulerJoinV1 | null;
}

interface JoinedSixStepPerformanceFactsV1 {
  readonly stage12: Stage12SelectedRouteFactsV1;
  readonly stage36: SearchTerminalSixStepTraceV1;
  readonly stage12Root: Hash;
  readonly stage36Root: Hash;
  readonly lineageRoot: Hash;
}

interface Stage12SelectedRouteParentV1 {
  readonly edgeId: Hash;
  readonly selectedLegRoot: Hash;
  readonly stage1EventId: Hash;
  readonly stage1ArtifactSetRoot: Hash;
  readonly stage2EventId: Hash;
  readonly stage2ArtifactSetRoot: Hash;
  readonly instancePublicationRoot: Hash;
  readonly edgeContentRoot: Hash;
}

interface Stage12SelectedRouteFactsV1 {
  readonly binding: ReadyStage12EvidenceBindingV1;
  readonly selectedParents: readonly Stage12SelectedRouteParentV1[];
  readonly stage3EventId: Hash;
  readonly stage3ArtifactSetRoot: Hash;
}

export type MissingPerformanceFactReasonV1 =
  | "head-facts-missing"
  | "head-facts-incomplete"
  | "producer-terminal-timing-capability-missing"
  | "scheduler-queue-permit-capability-missing"
  | "resource-sample-capability-missing"
  | "candidate-terminal-capability-missing"
  | "six-step-completion-capability-missing";

interface IncompletePerformanceFactsPayloadV1 {
  readonly admissionId: Hash;
  readonly terminalBindingRoot: Hash;
  readonly terminalId: Hash;
  readonly terminalMonotonicNs: string;
  readonly headHash: Hash;
  readonly sourceCoverageRoot: Hash | null;
  readonly candidateSetRoot: Hash | null;
  readonly candidateCount: string | null;
  readonly runtimeFacts: JoinedRuntimePerformanceFactsV1 | null;
  readonly sixStepFacts: JoinedSixStepPerformanceFactsV1 | null;
  readonly factStatus: "incomplete";
  readonly missingFactReasons: readonly MissingPerformanceFactReasonV1[];
}

interface CompletePerformanceFactsPayloadV1 {
  readonly admissionId: Hash;
  readonly terminalBindingRoot: Hash;
  readonly terminalId: Hash;
  readonly terminalMonotonicNs: string;
  readonly headHash: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly candidateSetRoot: Hash;
  readonly candidateCount: string;
  readonly runtimeFacts: JoinedRuntimePerformanceFactsV1;
  readonly sixStepFacts: JoinedSixStepPerformanceFactsV1 | null;
  readonly factStatus: "complete";
}

interface ProducerTerminalPayloadV1 {
  readonly terminalBindingRoot: Hash;
  readonly terminal: ProducerTerminalV1;
  readonly headFactsRoot: Hash | null;
}

interface TerminalPhaseInvalidPayloadV1 extends TerminalPhaseInvalidFactV1 {}

type PerformancePayloadV1 = IncompletePerformanceFactsPayloadV1 | CompletePerformanceFactsPayloadV1;
type ProductionEvidencePayloadV1 = PerformanceWindowBasisPayloadV1 | PerformanceWindowCommitmentV1 | EligibleHeadPayloadV1 | OrphanReplacementPayloadV1 | HeadCoveragePayloadV1 | RouteDenominatorPayloadV1 | CandidateSetPayloadV1 | PerformancePayloadV1 | ProducerTerminalPayloadV1 | TerminalPhaseInvalidPayloadV1;
type ProductionEvidenceWirePayloadV1 = Exclude<ProductionEvidencePayloadV1, RouteDenominatorPayloadV1 | CandidateSetPayloadV1>
  | RouteDenominatorWirePayloadV1
  | CandidateSetManifestPayloadV1;

interface ProductionEvidenceEventV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof EVENT_KIND;
  readonly eventId: Hash;
  readonly eventType: ProductionEvidenceEventTypeV1;
  readonly sequence: string;
  readonly namespace: ProductionEvidenceNamespaceV1;
  readonly release: SearcherProductionEvidenceReleaseV1;
  readonly runtimeAnchor: RuntimeAnchorReceiptV1;
  readonly serving: ServingBindingV1 | null;
  readonly payload: ProductionEvidencePayloadV1;
}

type ProductionEvidenceEventDraftV1 = Omit<ProductionEvidenceEventV1, "eventId" | "payload"> & Readonly<{ readonly payload: ProductionEvidenceWirePayloadV1 }>;

export interface SearcherProductionEvidencePartitionReplayV1 {
  readonly partitionId: Hash;
  readonly eventCount: string;
  readonly eventRoot: Hash;
  readonly namespaceRoots: Readonly<Record<ProductionEvidenceNamespaceV1, Hash>>;
  readonly eligibleHeadCount: string;
  readonly orphanReplacementCount: string;
  readonly headCoverageCount: string;
  readonly routeDenominatorCount: string;
  readonly candidateSetCount: string;
  readonly performanceFactsCompleteCount: string;
  readonly performanceFactsIncompleteCount: string;
  readonly producerTerminalCount: string;
  readonly terminalPhaseInvalidCount: string;
  readonly incompleteAdmissionIds: readonly Hash[];
}

export interface SearcherProductionEvidenceReplayV1 extends Omit<SearcherProductionEvidencePartitionReplayV1, "partitionId"> {
  readonly currentPartitionId: Hash | null;
  readonly partitionCount: string;
  readonly partitions: readonly SearcherProductionEvidencePartitionReplayV1[];
}

interface EligibleHeadHandleStateV1 {
  readonly payload: EligibleHeadPayloadV1;
  readonly replacementLineage: PerformanceAdmissionOrphanReplacementLineageV1 | null;
  readonly ordinal: string;
  readonly eligibleEventId: Hash;
  performanceHead: RuntimeReleasePerformanceHeadHandleV1 | null;
  serving: ServingBindingV1 | null;
  performanceSealedHead: RuntimeReleasePerformanceHeadCapabilityV1 | null;
  factsCapability: object | null;
  facts: ProducerHeadFactsV1 | null;
  terminalId: Hash | null;
}

export interface SearcherProductionEvidencePortsV1 {
  readonly performance: ProducerPerformancePortV1<unknown>;
  readonly terminal: ProducerTerminalPortV1;
  readonly window: Readonly<{
    readonly isComplete: () => boolean;
    readonly readFinalDurableWindow: () => FinalDurableWindowCapabilityV1 | null;
    readonly readFinalDurableWindowBinding: (capability: FinalDurableWindowCapabilityV1) => FinalDurableWindowBindingV1;
    readonly readCurrentProcessHeadTerminal: (
      capability: FinalDurableWindowCapabilityV1,
    ) => ProducerHeadTerminalCapabilityV1 | null;
    readonly isCurrentProcessWindow: (capability: FinalDurableWindowCapabilityV1) => boolean;
    readonly appendInvalid: (input: Readonly<{
      readonly completedWindow: FinalDurableWindowCapabilityV1;
      readonly reasonCode: TerminalPhaseInvalidReasonV1;
      readonly observed: CanonicalHeadObservationV1 | null;
    }>) => Promise<TerminalPhaseInvalidFactV1>;
    readonly readInvalid: () => TerminalPhaseInvalidFactV1 | null;
  }>;
  readonly sixStep: Readonly<{
    readonly readCompleteAppend: (
      terminal: ProducerHeadTerminalCapabilityV1,
    ) => SearcherProductionSixStepCompleteAppendCapabilityV1 | null;
    readonly readWindowSelection: (
      finalDurableWindow: FinalDurableWindowCapabilityV1,
    ) => SearcherProductionSixStepWindowSelectionCapabilityV1;
  }>;
}

export interface SearcherProductionEvidenceOwnerV1 {
  readonly bindServing: (
    startup: StartupRuntimeV1,
    performanceRuntime?: RuntimeReleasePerformanceRuntimeServiceV1,
  ) => SearcherProductionEvidencePortsV1;
  readonly replay: () => SearcherProductionEvidenceReplayV1;
  readonly close: () => void;
}

export interface SearcherProductionEvidenceOwnerInputV1 {
  readonly databasePath: string;
  readonly release: SearcherProductionEvidenceReleaseV1;
  readonly runtimeAnchor: RuntimeAnchorReceiptV1;
  /** Release-owned evaluator authority. Required at construction so durable
   * replay never derives an implementation identity from retained evidence. */
  readonly economicSafety: EconomicSafetyFinalizationServiceV1;
  /** Required by release composition. Omission keeps structural/offline
   * observers usable but makes any passed Six-Step fact fail closed. */
  readonly strategyRuntime?: RuntimeReleaseStrategyRuntimeServiceV1;
}

const ownersIssued = new WeakSet<object>();
const portsIssued = new WeakSet<object>();

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return hash;
}

function exactHead(value: unknown, path: string): CanonicalHead {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "parentHash", "stateRoot"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    chainId: assertDecimalString(record.chainId, `${path}.chainId`),
    number: assertDecimalString(record.number, `${path}.number`),
    hash: nonZeroHash(record.hash, `${path}.hash`),
    parentHash: nonZeroHash(record.parentHash, `${path}.parentHash`),
    stateRoot: nonZeroHash(record.stateRoot, `${path}.stateRoot`),
  });
}

function sameHead(left: CanonicalHead, right: CanonicalHead): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.parentHash === right.parentHash && left.stateRoot === right.stateRoot;
}

function exactRelease(value: unknown, path: string): SearcherProductionEvidenceReleaseV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    bindingId: nonZeroHash(record.bindingId, `${path}.bindingId`),
    releaseProvenanceHash: nonZeroHash(record.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    candidateReleaseCommit: gitSha40Schema.decode(record.candidateReleaseCommit, `${path}.candidateReleaseCommit`),
  });
}

function sameRelease(left: SearcherProductionEvidenceReleaseV1, right: SearcherProductionEvidenceReleaseV1): boolean {
  return left.bindingId === right.bindingId && left.releaseProvenanceHash === right.releaseProvenanceHash && left.candidateReleaseCommit === right.candidateReleaseCommit;
}

function sameExact(left: unknown, right: unknown): boolean {
  const leftBytes = encodeCanonicalBytes(left);
  const rightBytes = encodeCanonicalBytes(right);
  return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function exactRuntimeAnchor(value: unknown, path: string): RuntimeAnchorReceiptV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "bindingId", "releaseProvenanceHash", "manifestHash", "manifestArtifactSha256", "runtimeArtifactRoot",
    "implementationClosureDigest", "candidateReleaseCommit", "entrypointSha256", "nodeExecutableSha256", "bundleModulePath",
    "bundleModuleSha256", "serviceName", "systemdUnit", "bootId", "invocationId", "logDevice", "logInode", "pid",
    "processStartTicks", "dryRun",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.searcher-runtime-anchor-v1") throw new TypeError(`${path}.kind is invalid`);
  if (record.dryRun !== true) throw new TypeError(`${path}.dryRun must be true`);
  const decoded = {
    kind: "aloha.searcher-runtime-anchor-v1" as const,
    bindingId: nonZeroHash(record.bindingId, `${path}.bindingId`),
    releaseProvenanceHash: nonZeroHash(record.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    manifestHash: nonZeroHash(record.manifestHash, `${path}.manifestHash`),
    manifestArtifactSha256: nonZeroHash(record.manifestArtifactSha256, `${path}.manifestArtifactSha256`),
    runtimeArtifactRoot: nonZeroHash(record.runtimeArtifactRoot, `${path}.runtimeArtifactRoot`),
    implementationClosureDigest: nonZeroHash(record.implementationClosureDigest, `${path}.implementationClosureDigest`),
    candidateReleaseCommit: gitSha40Schema.decode(record.candidateReleaseCommit, `${path}.candidateReleaseCommit`),
    entrypointSha256: nonZeroHash(record.entrypointSha256, `${path}.entrypointSha256`),
    nodeExecutableSha256: nonZeroHash(record.nodeExecutableSha256, `${path}.nodeExecutableSha256`),
    bundleModulePath: assertNonEmptyString(record.bundleModulePath, `${path}.bundleModulePath`),
    bundleModuleSha256: nonZeroHash(record.bundleModuleSha256, `${path}.bundleModuleSha256`),
    serviceName: assertNonEmptyString(record.serviceName, `${path}.serviceName`),
    systemdUnit: assertNonEmptyString(record.systemdUnit, `${path}.systemdUnit`),
    bootId: assertNonEmptyString(record.bootId, `${path}.bootId`),
    invocationId: assertNonEmptyString(record.invocationId, `${path}.invocationId`),
    logDevice: assertDecimalString(record.logDevice, `${path}.logDevice`),
    logInode: assertDecimalString(record.logInode, `${path}.logInode`),
    pid: assertDecimalString(record.pid, `${path}.pid`),
    processStartTicks: assertDecimalString(record.processStartTicks, `${path}.processStartTicks`),
    dryRun: true as const,
  };
  if (!decoded.bundleModulePath.startsWith("/")) throw new TypeError(`${path}.bundleModulePath must be absolute`);
  return deepFreeze(decoded);
}

function runtimeAnchorRelease(anchor: RuntimeAnchorReceiptV1): SearcherProductionEvidenceReleaseV1 {
  return Object.freeze({ bindingId: anchor.bindingId, releaseProvenanceHash: anchor.releaseProvenanceHash, candidateReleaseCommit: anchor.candidateReleaseCommit });
}

function exactServing(value: unknown, path: string): ServingBindingV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["generationId", "graphRoot", "readyRecordHash", "sourceCoverageRoot"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    readyRecordHash: nonZeroHash(record.readyRecordHash, `${path}.readyRecordHash`),
    sourceCoverageRoot: nonZeroHash(record.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
  });
}

function servingFromStartupGeneration(
  startup: StartupRuntimeV1,
  generationId?: string,
): ServingBindingV1 {
  const generation = generationId === undefined
    ? startup.readActiveGeneration()
    : startup.readServingGeneration(generationId);
  return exactServing({
    generationId: generation.generationId,
    graphRoot: generation.graphRoot,
    readyRecordHash: generation.readyRecordHash,
    sourceCoverageRoot: generation.sourceCoverageRoot,
  }, "productionEvidence.startupGeneration");
}

function eventId(value: ProductionEvidenceEventDraftV1): Hash {
  return hashDomain("aloha/searcher-production-evidence-event/v1", value);
}

function performanceProcessLogAnchor(anchor: RuntimeAnchorReceiptV1): ProcessLogAnchorV1 {
  const bootIdHash = hashDomain("aloha/searcher-runtime-boot-id/v1", anchor.bootId);
  return Object.freeze({
    commitSha: anchor.candidateReleaseCommit,
    executableHash: anchor.entrypointSha256,
    pid: anchor.pid,
    processStartTicks: anchor.processStartTicks,
    bootIdHash,
    logSystemId: `${anchor.serviceName}/${anchor.systemdUnit}`,
    logBootIdHash: bootIdHash,
    logDevice: anchor.logDevice,
    logInode: anchor.logInode,
  });
}

function performanceWindowBasisPayload(
  value: PerformanceWindowBasisPayloadV1,
): Omit<PerformanceWindowBasisPayloadV1, "basisId"> {
  const { basisId: _basisId, ...payload } = value;
  return payload;
}

function createPerformanceWindowBasisPayload(
  draft: Omit<PerformanceWindowBasisPayloadV1, "basisId">,
): PerformanceWindowBasisPayloadV1 {
  const payload = deepFreeze({
    ...draft,
    windowStartAnchor: exactHead(draft.windowStartAnchor, "performanceWindowBasis.windowStartAnchor"),
    profile: decodeProductionPerformanceProfile(draft.profile),
    hardwareProfile: decodeHardwareProfileObservationV1(draft.hardwareProfile),
  });
  return deepFreeze({
    ...payload,
    basisId: hashDomain("aloha/searcher-production-evidence-performance-window-basis/v1", payload),
  });
}

function exactProcessLogAnchor(value: unknown, path: string): ProcessLogAnchorV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["commitSha", "executableHash", "pid", "processStartTicks", "bootIdHash", "logSystemId", "logBootIdHash", "logDevice", "logInode"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    commitSha: gitSha40Schema.decode(record.commitSha, `${path}.commitSha`),
    executableHash: nonZeroHash(record.executableHash, `${path}.executableHash`),
    pid: assertDecimalString(record.pid, `${path}.pid`),
    processStartTicks: assertDecimalString(record.processStartTicks, `${path}.processStartTicks`),
    bootIdHash: nonZeroHash(record.bootIdHash, `${path}.bootIdHash`),
    logSystemId: assertNonEmptyString(record.logSystemId, `${path}.logSystemId`),
    logBootIdHash: nonZeroHash(record.logBootIdHash, `${path}.logBootIdHash`),
    logDevice: assertDecimalString(record.logDevice, `${path}.logDevice`),
    logInode: assertDecimalString(record.logInode, `${path}.logInode`),
  });
}

function performanceWindowBasisAppendRecordId(record: Pick<DurableAppendRecord,
  "namespace" | "sequence" | "eventId" | "contentSha256" | "byteLength" | "offsetStart" | "offsetEnd"
>): Hash {
  return hashDomain("aloha/searcher-production-evidence-performance-window-basis-append-record/v1", {
    namespace: record.namespace,
    sequence: record.sequence,
    eventId: record.eventId,
    contentSha256: record.contentSha256,
    byteLength: record.byteLength,
    offsetStart: record.offsetStart,
    offsetEnd: record.offsetEnd,
  });
}

function performanceWindowBasisContextBindingId(input: {
  readonly release: SearcherProductionEvidenceReleaseV1;
  readonly runtimeAnchor: RuntimeAnchorReceiptV1;
  readonly basisId: Hash;
  readonly appendRecordId: Hash;
  readonly append: Pick<DurableAppendRecord, "namespace" | "sequence" | "eventId" | "contentSha256" | "byteLength" | "offsetStart" | "offsetEnd">;
}): Hash {
  return hashDomain("aloha/searcher-production-evidence-performance-window-basis-context-binding/v1", {
    release: input.release,
    runtimeAnchor: input.runtimeAnchor,
    basisId: input.basisId,
    appendRecordId: input.appendRecordId,
    append: {
      namespace: input.append.namespace,
      sequence: input.append.sequence,
      eventId: input.append.eventId,
      contentSha256: input.append.contentSha256,
      byteLength: input.append.byteLength,
      offsetStart: input.append.offsetStart,
      offsetEnd: input.append.offsetEnd,
    },
  });
}

function performanceRuntimeAnchorHash(anchor: RuntimeAnchorReceiptV1): Hash {
  return hashDomain("aloha/performance-runtime-anchor/v1", anchor);
}

function namespaceFor(eventType: ProductionEvidenceEventTypeV1): ProductionEvidenceNamespaceV1 {
  switch (eventType) {
    case "performance-window-basis": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads;
    case "performance-window-commitment": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads;
    case "eligible-head": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads;
    case "orphan-replacement": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads;
    case "head-coverage": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.headCoverage;
    case "route-denominator": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.routeDenominators;
    case "candidate-set": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.candidateSets;
    case "performance-facts-incomplete": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.performance;
    case "performance-facts-complete": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.performance;
    case "terminal-phase-invalid": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.terminalPhase;
    case "producer-terminal": return SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.producerTerminals;
  }
}

function sortedUniqueHashes(values: readonly Hash[], path: string): readonly Hash[] {
  const hashes = values.map((value, index) => nonZeroHash(value, `${path}[${index}]`)).sort();
  for (let index = 1; index < hashes.length; index += 1) if (hashes[index - 1] === hashes[index]) throw new TypeError(`${path} contains a duplicate hash`);
  return Object.freeze(hashes);
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function exactCurrentSource(value: unknown, path: string): ProducerCurrentSourceLogicalFactsV1["source"] {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    chainId: assertDecimalString(record.chainId, `${path}.chainId`),
    number: assertDecimalString(record.number, `${path}.number`),
    hash: nonZeroHash(record.hash, `${path}.hash`),
    stateRoot: nonZeroHash(record.stateRoot, `${path}.stateRoot`),
  });
}

function exactCurrentSourceLogicalFacts(value: unknown, path: string): ProducerCurrentSourceLogicalFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "lane", "correlationId", "source", "logicalReads", "settledHits", "inFlightJoins",
    "consumerAborts", "consumerDeadlines",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.current-source-rpc.logical-scope-facts-v1") throw new TypeError(`${path}.kind is invalid`);
  if (record.lane !== "blockscan" && record.lane !== "backrun") throw new TypeError(`${path}.lane is invalid`);
  return deepFreeze({
    kind: "aloha.current-source-rpc.logical-scope-facts-v1" as const,
    lane: record.lane,
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    source: exactCurrentSource(record.source, `${path}.source`),
    logicalReads: nonNegativeSafeInteger(record.logicalReads, `${path}.logicalReads`),
    settledHits: nonNegativeSafeInteger(record.settledHits, `${path}.settledHits`),
    inFlightJoins: nonNegativeSafeInteger(record.inFlightJoins, `${path}.inFlightJoins`),
    consumerAborts: nonNegativeSafeInteger(record.consumerAborts, `${path}.consumerAborts`),
    consumerDeadlines: nonNegativeSafeInteger(record.consumerDeadlines, `${path}.consumerDeadlines`),
  });
}

function exactPendingSnapshot(value: unknown, path: string): NoInputRouteDenominatorPayloadV1["pendingSnapshot"] {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "pendingNumber", "parentHash", "orderedTransactionHashes",
    "orderedTransactionHashesRoot", "transactionCount", "snapshotHash",
  ], path);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.orderedTransactionHashes)) throw new TypeError(`${path}.orderedTransactionHashes must be an array`);
  const orderedTransactionHashes = Object.freeze(record.orderedTransactionHashes.map((value, index) => nonZeroHash(value, `${path}.orderedTransactionHashes[${index}]`)));
  const transactionCount = assertDecimalString(record.transactionCount, `${path}.transactionCount`);
  const orderedTransactionHashesRoot = nonZeroHash(record.orderedTransactionHashesRoot, `${path}.orderedTransactionHashesRoot`);
  if (transactionCount !== orderedTransactionHashes.length.toString()
    || orderedTransactionHashesRoot !== hashDomain("aloha/public-pending-transaction-set/v1", orderedTransactionHashes)) {
    throw new TypeError(`${path} transaction denominator mismatch`);
  }
  return Object.freeze({
    pendingNumber: assertDecimalString(record.pendingNumber, `${path}.pendingNumber`),
    parentHash: nonZeroHash(record.parentHash, `${path}.parentHash`),
    orderedTransactionHashes,
    orderedTransactionHashesRoot,
    transactionCount,
    snapshotHash: nonZeroHash(record.snapshotHash, `${path}.snapshotHash`),
  });
}

function exactCurrentSourcePhysicalFacts(value: unknown, path: string): ProducerCurrentSourcePhysicalFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "source", "openedMonotonicNs", "closedMonotonicNs", "elapsedUs", "logicalScopeFacts", "logicalScopeFactsRoot",
    "physicalBuilds", "buildFailures", "invalidResults", "physicalAborts", "settledEntries", "inFlightEntries", "consumers",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.current-source-rpc.physical-facts-v1") throw new TypeError(`${path}.kind is invalid`);
  const openedMonotonicNs = assertDecimalString(record.openedMonotonicNs, `${path}.openedMonotonicNs`);
  const closedMonotonicNs = assertDecimalString(record.closedMonotonicNs, `${path}.closedMonotonicNs`);
  const elapsedUs = assertDecimalString(record.elapsedUs, `${path}.elapsedUs`);
  if (BigInt(closedMonotonicNs) < BigInt(openedMonotonicNs)
    || elapsedUs !== ((BigInt(closedMonotonicNs) - BigInt(openedMonotonicNs)) / 1_000n).toString()) {
    throw new TypeError(`${path} monotonic timing is invalid`);
  }
  const inFlightEntries = nonNegativeSafeInteger(record.inFlightEntries, `${path}.inFlightEntries`);
  const consumers = nonNegativeSafeInteger(record.consumers, `${path}.consumers`);
  if (inFlightEntries !== 0 || consumers !== 0) throw new TypeError(`${path} must be sealed`);
  if (!Array.isArray(record.logicalScopeFacts)) throw new TypeError(`${path}.logicalScopeFacts must be an array`);
  const logicalScopeFacts = Object.freeze(record.logicalScopeFacts.map((facts, index) => exactCurrentSourceLogicalFacts(facts, `${path}.logicalScopeFacts[${index}]`)));
  const logicalScopeFactsRoot = nonZeroHash(record.logicalScopeFactsRoot, `${path}.logicalScopeFactsRoot`);
  if (logicalScopeFactsRoot !== currentSourceLogicalFactsRoot(logicalScopeFacts, `${path}.logicalScopeFacts`)) {
    throw new TypeError(`${path}.logicalScopeFactsRoot mismatch`);
  }
  return deepFreeze({
    kind: "aloha.current-source-rpc.physical-facts-v1" as const,
    source: exactCurrentSource(record.source, `${path}.source`),
    openedMonotonicNs,
    closedMonotonicNs,
    elapsedUs,
    logicalScopeFacts,
    logicalScopeFactsRoot,
    physicalBuilds: nonNegativeSafeInteger(record.physicalBuilds, `${path}.physicalBuilds`),
    buildFailures: nonNegativeSafeInteger(record.buildFailures, `${path}.buildFailures`),
    invalidResults: nonNegativeSafeInteger(record.invalidResults, `${path}.invalidResults`),
    physicalAborts: nonNegativeSafeInteger(record.physicalAborts, `${path}.physicalAborts`),
    settledEntries: nonNegativeSafeInteger(record.settledEntries, `${path}.settledEntries`),
    inFlightEntries: 0 as const,
    consumers: 0 as const,
  });
}

function currentSourceLogicalFactsRoot(values: readonly ProducerCurrentSourceLogicalFactsV1[], path: string): Hash {
  if (values.length !== 2 || values[0]?.lane !== "blockscan" || values[1]?.lane !== "backrun") {
    throw new TypeError(`${path} must contain blockscan then backrun`);
  }
  const [blockscan, backrun] = values as readonly [ProducerCurrentSourceLogicalFactsV1, ProducerCurrentSourceLogicalFactsV1];
  if (blockscan.correlationId === backrun.correlationId
    || blockscan.source.chainId !== backrun.source.chainId
    || blockscan.source.number !== backrun.source.number
    || blockscan.source.hash !== backrun.source.hash
    || blockscan.source.stateRoot !== backrun.source.stateRoot) {
    throw new TypeError(`${path} lane binding is invalid`);
  }
  return hashDomain("aloha/current-source-rpc/logical-scope-facts-root/v1", values);
}

function exactRouteCoarseTimingFacts(value: unknown, path: string): RouteCoarseTimingFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "correlationId", "generationId", "graphRoot", "source", "planningProblemHash", "enumerationRoot",
    "admissionPolicyHash", "startedMonotonicNs", "finishedMonotonicNs", "durationUs", "timingRoot",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.route-coarse-timing-facts-v1") throw new TypeError(`${path}.kind is invalid`);
  const startedMonotonicNs = assertDecimalString(record.startedMonotonicNs, `${path}.startedMonotonicNs`);
  const finishedMonotonicNs = assertDecimalString(record.finishedMonotonicNs, `${path}.finishedMonotonicNs`);
  const durationUs = assertDecimalString(record.durationUs, `${path}.durationUs`);
  if (BigInt(finishedMonotonicNs) < BigInt(startedMonotonicNs)
    || durationUs !== ((BigInt(finishedMonotonicNs) - BigInt(startedMonotonicNs)) / 1_000n).toString()) {
    throw new TypeError(`${path} monotonic timing is invalid`);
  }
  const payload = deepFreeze({
    kind: "aloha.route-coarse-timing-facts-v1" as const,
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    source: exactCurrentSource(record.source, `${path}.source`),
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    startedMonotonicNs,
    finishedMonotonicNs,
    durationUs,
  });
  const timingRoot = nonZeroHash(record.timingRoot, `${path}.timingRoot`);
  if (timingRoot !== hashDomain("aloha/route-coarse-timing-facts/v1", payload)) throw new TypeError(`${path}.timingRoot mismatch`);
  return deepFreeze({ ...payload, timingRoot });
}

function exactCandidatePolicyTerminal(
  value: unknown,
  path: string,
): NonNullable<ProducerCandidateTerminalObservationV1["policyTerminal"]> {
  assertPlainObject(value, path);
  const record = value as Record<string, unknown>;
  if (record.kind === "aloha.route-policy-rejection-v1") {
    assertExactKeys(value, ["kind", "policyKind", "admissionPolicyHash", "planningProblemHash", "enumerationRoot", "candidateId", "candidateOrderKey", "routeHash", "receiptHash"], path);
    if (record.policyKind !== "rankable-top-k" && record.policyKind !== "bounded-unranked-budget") throw new TypeError(`${path} kind is invalid`);
    const body = Object.freeze({
      kind: "aloha.route-policy-rejection-v1" as const,
      policyKind: record.policyKind,
      admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
      planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
      enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
      candidateId: nonZeroHash(record.candidateId, `${path}.candidateId`),
      candidateOrderKey: nonZeroHash(record.candidateOrderKey, `${path}.candidateOrderKey`),
      routeHash: nonZeroHash(record.routeHash, `${path}.routeHash`),
    });
    const receiptHash = nonZeroHash(record.receiptHash, `${path}.receiptHash`);
    if (receiptHash !== hashDomain("aloha/route-policy-rejection-receipt/v1", body)) throw new TypeError(`${path}.receiptHash mismatch`);
    return Object.freeze({ ...body, receiptHash });
  }
  assertExactKeys(value, ["kind", "policyKind", "admissionPolicyHash", "planningProblemHash", "enumerationRoot", "winnerCandidateId", "winnerTerminalLineageHash", "candidateId", "routeHash", "decisionMonotonicNs", "receiptHash"], path);
  if (record.kind !== "aloha.route-post-success-policy-terminal-v1" || record.policyKind !== "post-success-first-eligible") throw new TypeError(`${path} kind is invalid`);
  const body = Object.freeze({
    kind: "aloha.route-post-success-policy-terminal-v1" as const,
    policyKind: "post-success-first-eligible" as const,
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    winnerCandidateId: nonZeroHash(record.winnerCandidateId, `${path}.winnerCandidateId`),
    winnerTerminalLineageHash: nonZeroHash(record.winnerTerminalLineageHash, `${path}.winnerTerminalLineageHash`),
    candidateId: nonZeroHash(record.candidateId, `${path}.candidateId`),
    routeHash: nonZeroHash(record.routeHash, `${path}.routeHash`),
    decisionMonotonicNs: assertDecimalString(record.decisionMonotonicNs, `${path}.decisionMonotonicNs`),
  });
  const receiptHash = nonZeroHash(record.receiptHash, `${path}.receiptHash`);
  if (receiptHash !== hashDomain("aloha/route-post-success-policy-terminal-receipt/v1", body)) throw new TypeError(`${path}.receiptHash mismatch`);
  return Object.freeze({ ...body, receiptHash });
}

function exactRouteAccountingEntry(value: unknown, path: string): RouteAccountingV1["entries"][number] {
  assertPlainObject(value, path);
  assertExactKeys(value, ["candidateId", "legs", "disposition", "terminalKind", "routeHash", "reasonCode", "evidenceHash", "policyTerminal"], path);
  const item = value as Record<string, unknown>;
  if (!Array.isArray(item.legs) || item.legs.length < 2) throw new TypeError(`${path}.legs is invalid`);
  const legs = Object.freeze(item.legs.map((leg, legIndex) => {
    const legPath = `${path}.legs[${legIndex}]`;
    assertPlainObject(leg, legPath);
    assertExactKeys(leg, ["edgeId", "transitionRef", "inputAssetRef", "inputPortRef", "outputAssetRef", "outputPortRef"], legPath);
    const value = leg as Record<string, unknown>;
    return Object.freeze({
      edgeId: nonZeroHash(value.edgeId, `${legPath}.edgeId`),
      transitionRef: nonZeroHash(value.transitionRef, `${legPath}.transitionRef`),
      inputAssetRef: nonZeroHash(value.inputAssetRef, `${legPath}.inputAssetRef`),
      inputPortRef: nonZeroHash(value.inputPortRef, `${legPath}.inputPortRef`),
      outputAssetRef: nonZeroHash(value.outputAssetRef, `${legPath}.outputAssetRef`),
      outputPortRef: nonZeroHash(value.outputPortRef, `${legPath}.outputPortRef`),
    });
  }));
  if (item.disposition !== "selected" && item.disposition !== "pruned" && item.disposition !== "notProbed" && item.disposition !== "failed") {
    throw new TypeError(`${path}.disposition is invalid`);
  }
  if (item.terminalKind !== "not-run" && item.terminalKind !== "policyRejected" && item.terminalKind !== "passed"
    && item.terminalKind !== "retryable" && item.terminalKind !== "invalidProgram" && item.terminalKind !== "chainProvenRejected") {
    throw new TypeError(`${path}.terminalKind is invalid`);
  }
  const policyTerminal = item.policyTerminal === null ? null : exactCandidatePolicyTerminal(item.policyTerminal, `${path}.policyTerminal`);
  const normalized = Object.freeze({
    candidateId: nonZeroHash(item.candidateId, `${path}.candidateId`),
    legs,
    disposition: item.disposition,
    terminalKind: item.terminalKind,
    routeHash: nullableHash(item.routeHash, `${path}.routeHash`),
    reasonCode: item.reasonCode === null ? null : assertNonEmptyString(item.reasonCode, `${path}.reasonCode`),
    evidenceHash: nullableHash(item.evidenceHash, `${path}.evidenceHash`),
    policyTerminal,
  });
  if ((normalized.terminalKind === "policyRejected") !== (policyTerminal !== null)
    || (policyTerminal !== null && (policyTerminal.candidateId !== normalized.candidateId || policyTerminal.routeHash !== normalized.routeHash))) {
    throw new TypeError(`${path} policy terminal mismatch`);
  }
  return normalized;
}

function exactRouteAccounting(value: unknown, path: string): RouteAccountingV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "planningProblemHash", "enumerationRoot", "admissionPolicyHash", "enumerationTruncated",
    "observedUniqueCountLowerBound", "total", "selected", "pruned", "notProbed", "failed", "entries", "root",
  ], path);
  const record = value as Record<string, unknown>;
  if (typeof record.enumerationTruncated !== "boolean") throw new TypeError(`${path}.enumerationTruncated is invalid`);
  const observedUniqueCountLowerBound = assertDecimalString(record.observedUniqueCountLowerBound, `${path}.observedUniqueCountLowerBound`);
  if (!Array.isArray(record.entries)) throw new TypeError(`${path}.entries must be an array`);
  const entries = Object.freeze(record.entries.map((entry, index) => exactRouteAccountingEntry(entry, `${path}.entries[${index}]`)));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.candidateId >= entries[index]!.candidateId) throw new TypeError(`${path}.entries order mismatch`);
  }
  const counts = {
    total: nonNegativeSafeInteger(record.total, `${path}.total`),
    selected: nonNegativeSafeInteger(record.selected, `${path}.selected`),
    pruned: nonNegativeSafeInteger(record.pruned, `${path}.pruned`),
    notProbed: nonNegativeSafeInteger(record.notProbed, `${path}.notProbed`),
    failed: nonNegativeSafeInteger(record.failed, `${path}.failed`),
  };
  if (counts.total !== entries.length
    || counts.selected !== entries.filter(entry => entry.disposition === "selected").length
    || counts.pruned !== entries.filter(entry => entry.disposition === "pruned").length
    || counts.notProbed !== entries.filter(entry => entry.disposition === "notProbed").length
    || counts.failed !== entries.filter(entry => entry.disposition === "failed").length
    || counts.selected + counts.pruned + counts.notProbed + counts.failed !== counts.total
    || BigInt(observedUniqueCountLowerBound) < BigInt(counts.total)
    || (!record.enumerationTruncated && BigInt(observedUniqueCountLowerBound) !== BigInt(counts.total))) {
    throw new TypeError(`${path} denominator counts mismatch`);
  }
  const payload = Object.freeze({
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    enumerationTruncated: record.enumerationTruncated,
    observedUniqueCountLowerBound,
    ...counts,
    entries,
  });
  const root = nonZeroHash(record.root, `${path}.root`);
  if (root !== routeAccountingRootV1(payload)) throw new TypeError(`${path}.root mismatch`);
  return deepFreeze({ ...payload, root });
}

function exactProducerCandidateTerminalObservation(
  value: unknown,
  path: string,
): ProducerCandidateTerminalObservationV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "kind", "lane", "headHash", "correlationId", "generationId", "graphRoot", "planningProblemHash",
    "enumerationRoot", "admissionPolicyHash", "candidateId", "performanceCandidateRef", "disposition", "terminalKind", "performanceOutcome", "routeHash",
    "reasonCode", "evidenceHash", "policyTerminal", "terminalLineageHash", "sixStepEvidenceRoot",
    "startedMonotonicNs", "finishedMonotonicNs", "timingUs", "timingRoot", "observationRoot",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.producer-candidate-terminal-observation-v1") throw new TypeError(`${path}.kind is invalid`);
  if (record.lane !== "blockscan" && record.lane !== "backrun") throw new TypeError(`${path}.lane is invalid`);
  const lane: ProducerCandidateTerminalObservationV1["lane"] = record.lane;
  if (record.disposition !== "selected" && record.disposition !== "pruned" && record.disposition !== "notProbed" && record.disposition !== "failed") throw new TypeError(`${path}.disposition is invalid`);
  if (record.terminalKind !== "not-run" && record.terminalKind !== "policyRejected" && record.terminalKind !== "passed" && record.terminalKind !== "retryable" && record.terminalKind !== "invalidProgram" && record.terminalKind !== "chainProvenRejected") throw new TypeError(`${path}.terminalKind is invalid`);
  const disposition: ProducerCandidateTerminalObservationV1["disposition"] = record.disposition;
  const terminalKind: ProducerCandidateTerminalObservationV1["terminalKind"] = record.terminalKind;
  const performanceOutcome = (() => {
    switch (terminalKind) {
      case "passed": return "verified" as const;
      case "chainProvenRejected": return record.reasonCode === "final-sim:simulation-reverted"
        ? "simulation-reverted" as const
        : "chain-proven-rejected" as const;
      case "policyRejected": return "policy-rejected" as const;
      case "retryable":
      case "not-run": return "retryable" as const;
      case "invalidProgram": return "invalid-program" as const;
    }
  })();
  if (record.performanceOutcome !== performanceOutcome) throw new TypeError(`${path}.performanceOutcome mismatch`);
  const startedMonotonicNs = assertDecimalString(record.startedMonotonicNs, `${path}.startedMonotonicNs`);
  const finishedMonotonicNs = assertDecimalString(record.finishedMonotonicNs, `${path}.finishedMonotonicNs`);
  const timingUs = assertDecimalString(record.timingUs, `${path}.timingUs`);
  if (BigInt(finishedMonotonicNs) < BigInt(startedMonotonicNs)
    || timingUs !== ((BigInt(finishedMonotonicNs) - BigInt(startedMonotonicNs)) / 1_000n).toString()) {
    throw new TypeError(`${path} monotonic timing is invalid`);
  }
  const policyTerminal = record.policyTerminal === null ? null : exactCandidatePolicyTerminal(record.policyTerminal, `${path}.policyTerminal`);
  const timingPayload = deepFreeze({
    kind: "aloha.route-candidate-terminal-timing-facts-v1" as const,
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    planningProblemHash: nonZeroHash(record.planningProblemHash, `${path}.planningProblemHash`),
    enumerationRoot: nonZeroHash(record.enumerationRoot, `${path}.enumerationRoot`),
    admissionPolicyHash: nonZeroHash(record.admissionPolicyHash, `${path}.admissionPolicyHash`),
    candidateId: nonZeroHash(record.candidateId, `${path}.candidateId`),
    disposition,
    terminalKind,
    routeHash: nullableHash(record.routeHash, `${path}.routeHash`),
    reasonCode: record.reasonCode === null ? null : assertNonEmptyString(record.reasonCode, `${path}.reasonCode`),
    evidenceHash: nullableHash(record.evidenceHash, `${path}.evidenceHash`),
    policyTerminal,
    terminalLineageHash: nullableHash(record.terminalLineageHash, `${path}.terminalLineageHash`),
    sixStepEvidenceRoot: nullableHash(record.sixStepEvidenceRoot, `${path}.sixStepEvidenceRoot`),
    startedMonotonicNs,
    finishedMonotonicNs,
    timingUs,
  });
  const timingRoot = nonZeroHash(record.timingRoot, `${path}.timingRoot`);
  if (timingRoot !== hashDomain("aloha/route-candidate-terminal-timing-facts/v1", timingPayload)) throw new TypeError(`${path}.timingRoot mismatch`);
  const { kind: _timingKind, ...timingFields } = timingPayload;
  const performanceCandidateRef = nonZeroHash(record.performanceCandidateRef, `${path}.performanceCandidateRef`);
  if (performanceCandidateRef !== performanceLaneCandidateRefV1(lane, timingPayload.candidateId)) throw new TypeError(`${path}.performanceCandidateRef mismatch`);
  const payload = deepFreeze({
    kind: "aloha.producer-candidate-terminal-observation-v1" as const,
    lane,
    headHash: nonZeroHash(record.headHash, `${path}.headHash`),
    ...timingFields,
    performanceCandidateRef,
    performanceOutcome,
    timingRoot,
  });
  if ((payload.terminalKind === "passed" && (payload.terminalLineageHash === null || payload.sixStepEvidenceRoot === null))
    || (payload.terminalKind !== "passed" && (payload.terminalLineageHash !== null || payload.sixStepEvidenceRoot !== null))
    || (payload.terminalKind === "passed" && (payload.disposition !== "selected" || payload.evidenceHash !== payload.terminalLineageHash))
    || (payload.terminalKind === "policyRejected") !== (payload.policyTerminal !== null)
    || (payload.policyTerminal !== null && (payload.policyTerminal.candidateId !== payload.candidateId
      || payload.policyTerminal.routeHash !== payload.routeHash
      || payload.policyTerminal.admissionPolicyHash !== payload.admissionPolicyHash
      || payload.policyTerminal.planningProblemHash !== payload.planningProblemHash
      || payload.policyTerminal.enumerationRoot !== payload.enumerationRoot))
    || (payload.policyTerminal?.kind === "aloha.route-policy-rejection-v1" && payload.disposition !== "notProbed")
    || (payload.policyTerminal?.kind === "aloha.route-post-success-policy-terminal-v1"
      && (payload.disposition !== "selected" || payload.reasonCode !== "post-success:first-eligible" || payload.evidenceHash !== payload.policyTerminal.receiptHash))
    || (payload.terminalKind === "chainProvenRejected" && !["pruned", "selected"].includes(payload.disposition))
    || (payload.performanceOutcome === "simulation-reverted" && (payload.disposition !== "selected" || payload.reasonCode !== "final-sim:simulation-reverted" || payload.evidenceHash === null))) {
    throw new TypeError(`${path} terminal semantics mismatch`);
  }
  if (payload.terminalKind === "not-run"
    || ((payload.terminalKind === "retryable" || payload.terminalKind === "invalidProgram") && payload.disposition !== "selected")
    || (payload.terminalKind === "chainProvenRejected" && payload.evidenceHash === null)
    || (payload.disposition === "pruned" && payload.terminalKind !== "chainProvenRejected")) {
    throw new TypeError(`${path} terminal/disposition matrix mismatch`);
  }
  const observationRoot = nonZeroHash(record.observationRoot, `${path}.observationRoot`);
  if (observationRoot !== hashDomain("aloha/producer-candidate-terminal-observation/v1", payload)) throw new TypeError(`${path}.observationRoot mismatch`);
  return deepFreeze({ ...payload, observationRoot });
}

function headFactsRoot(facts: ProducerHeadFactsV1): Hash {
  return producerHeadFactsRootV1(facts);
}

function routeAccountingEntryRoot(entry: RouteAccountingV1["entries"][number], ordinal: number): Hash {
  return hashDomain("aloha/route-accounting-entry/v1", { ordinal: String(ordinal), entry });
}

function routeAccountingEntrySequenceRoot(entries: RouteAccountingV1["entries"]): Hash {
  return searcherProductionEvidenceOrderedRootV1(
    "aloha/searcher-production-evidence-material/route-accounting-entries/entries/v1",
    entries.map(routeAccountingEntryRoot),
  );
}

function candidateObservationSequenceRoot(observations: readonly ProducerCandidateTerminalObservationV1[]): Hash {
  return searcherProductionEvidenceOrderedRootV1(
    "aloha/searcher-production-evidence-material/candidate-terminal-observations/entries/v1",
    observations.map(observation => observation.observationRoot),
  );
}

function accountedMaterialBindingRoot(value: Omit<AccountedRouteDenominatorManifestPayloadV1, "material">): Hash {
  return hashDomain("aloha/searcher-production-evidence-accounted-route-material-binding/v1", value);
}

function candidateMaterialBindingRoot(value: Omit<CandidateSetManifestPayloadV1, "material">): Hash {
  return hashDomain("aloha/searcher-production-evidence-candidate-material-binding/v1", value);
}

function persistAccountedRouteDenominator(
  store: SQLiteDurableStore,
  value: AccountedRouteDenominatorPayloadV1,
): AccountedRouteDenominatorManifestPayloadV1 {
  const accounting = Object.freeze({
    planningProblemHash: value.accounting.planningProblemHash,
    enumerationRoot: value.accounting.enumerationRoot,
    admissionPolicyHash: value.accounting.admissionPolicyHash,
    enumerationTruncated: value.accounting.enumerationTruncated,
    observedUniqueCountLowerBound: value.accounting.observedUniqueCountLowerBound,
    total: value.accounting.total,
    selected: value.accounting.selected,
    pruned: value.accounting.pruned,
    notProbed: value.accounting.notProbed,
    failed: value.accounting.failed,
    root: value.accounting.root,
    entryCount: String(value.accounting.entries.length),
    entrySequenceRoot: routeAccountingEntrySequenceRoot(value.accounting.entries),
  });
  const withoutMaterial = deepFreeze({
    admissionId: value.admissionId,
    headFactsRoot: value.headFactsRoot,
    headHash: value.headHash,
    lane: value.lane,
    correlationId: value.correlationId,
    coverageRoot: value.coverageRoot,
    denominatorKind: "accounted" as const,
    plannerCandidateIdentity: value.plannerCandidateIdentity,
    accounting,
  });
  const bindingRoot = accountedMaterialBindingRoot(withoutMaterial);
  const material = persistSearcherProductionEvidenceMaterialV1(store, {
    materialKind: "route-accounting-entries",
    bindingRoot,
    entries: value.accounting.entries as unknown as readonly import("../../../packages/canonical-codec/src/index.ts").CanonicalJson[],
    entryRoots: value.accounting.entries.map(routeAccountingEntryRoot),
  });
  if (material.entrySequenceRoot !== accounting.entrySequenceRoot) throw new TypeError("route accounting material sequence root mismatch");
  return deepFreeze({ ...withoutMaterial, material });
}

function persistCandidateSet(
  store: SQLiteDurableStore,
  value: CandidateSetPayloadV1,
): CandidateSetManifestPayloadV1 {
  const laneDenominators = Object.freeze(value.laneDenominators.map(denominator => Object.freeze({
    lane: denominator.lane,
    correlationId: denominator.correlationId,
    coverageRoot: denominator.coverageRoot,
    accountingRoot: denominator.accountingRoot,
    candidateCount: denominator.candidateCount,
    observationSetRoot: denominator.observationSetRoot,
  })));
  const withoutMaterial = deepFreeze({
    admissionId: value.admissionId,
    headFactsRoot: value.headFactsRoot,
    headHash: value.headHash,
    candidateRefCount: String(value.candidateRefs.length),
    candidateRefsRoot: searcherProductionEvidenceOrderedRootV1("aloha/searcher-production-evidence-candidate-refs/v1", value.candidateRefs),
    laneDenominators,
    candidateTerminalObservationSetRoot: value.candidateTerminalObservationSetRoot,
  });
  const bindingRoot = candidateMaterialBindingRoot(withoutMaterial);
  const material = persistSearcherProductionEvidenceMaterialV1(store, {
    materialKind: "candidate-terminal-observations",
    bindingRoot,
    entries: value.candidateTerminalObservations as unknown as readonly import("../../../packages/canonical-codec/src/index.ts").CanonicalJson[],
    entryRoots: value.candidateTerminalObservations.map(observation => observation.observationRoot),
  });
  if (material.entrySequenceRoot !== candidateObservationSequenceRoot(value.candidateTerminalObservations)) throw new TypeError("candidate observation material sequence root mismatch");
  return deepFreeze({ ...withoutMaterial, material });
}

function terminalBindingRoot(terminal: ProducerTerminalV1, facts: ProducerHeadFactsV1 | null): Hash {
  return hashDomain("aloha/searcher-production-evidence-terminal-binding/v1", { terminalId: terminal.terminalId, headFactsRoot: facts === null ? null : headFactsRoot(facts) });
}

interface ProducerSchedulerJoinObservationV1 {
  readonly kind: "missing" | "exact" | "ambiguous";
  readonly join: SearchSchedulerResourceJoinV1 | null;
}

interface ProducerSixStepObservationV1 {
  readonly kind: "missing" | "exact" | "ambiguous";
  readonly trace: SearchTerminalSixStepTraceV1 | null;
  readonly artifacts: ProductionSixStepArtifactCapabilitiesV1 | null;
}

/**
 * Resolve the scheduler join only through the exact Producer-issued lane
 * fact. Candidate ids and terminal DTOs are deliberately not lookup keys:
 * neither can recover or substitute the process-local scheduler handle.
 */
function producerSchedulerJoin(facts: ProducerHeadFactsV1): ProducerSchedulerJoinObservationV1 {
  const joins: SearchSchedulerResourceJoinV1[] = [];
  for (const laneCapability of facts.laneFacts) {
    const lane = readIssuedProducerLaneFactsV1(laneCapability);
    const join = readIssuedProducerLaneSchedulerResourceJoinV1(laneCapability);
    if (join === null) continue;
    if (lane.terminalKind !== "unsigned-dry-run"
      || join.correlationId !== lane.correlationId
      || join.generationId !== lane.generationId
      || join.source.chainId !== lane.currentSource.source.chainId
      || join.source.number !== lane.currentSource.source.number
      || join.source.hash !== lane.currentSource.source.hash
      || join.source.stateRoot !== lane.currentSource.source.stateRoot
      || join.unsignedDryRunLineageHash !== lane.terminalLineageHash
      || !lane.candidateIds.includes(join.unsignedDryRunCandidateId)
      || !facts.candidateRefs.includes(performanceLaneCandidateRefV1(lane.lane, join.unsignedDryRunCandidateId))) {
      throw new TypeError("production evidence Producer scheduler join lineage mismatch");
    }
    joins.push(join);
  }
  if (joins.length === 0) return Object.freeze({ kind: "missing" as const, join: null });
  if (joins.length !== 1) return Object.freeze({ kind: "ambiguous" as const, join: null });
  return Object.freeze({ kind: "exact" as const, join: joins[0]! });
}

function producerSixStepTrace(facts: ProducerHeadFactsV1): ProducerSixStepObservationV1 {
  const observations: Array<Readonly<{
    readonly trace: SearchTerminalSixStepTraceV1;
    readonly artifacts: ProductionSixStepArtifactCapabilitiesV1;
  }>> = [];
  for (const laneCapability of facts.laneFacts) {
    const trace = readIssuedProducerLaneSixStepTraceV1(laneCapability);
    if (trace === null) continue;
    const terminal = readIssuedProducerLaneSearchTerminalCapabilityV1(laneCapability);
    if (terminal === null) throw new TypeError("production evidence Six-Step lane lacks its search terminal capability");
    observations.push(Object.freeze({
      trace,
      artifacts: readIssuedSearchTerminalSixStepArtifactCapabilitiesV1(terminal),
    }));
  }
  if (observations.length === 0) return Object.freeze({ kind: "missing" as const, trace: null, artifacts: null });
  if (observations.length !== 1) return Object.freeze({ kind: "ambiguous" as const, trace: null, artifacts: null });
  return Object.freeze({ kind: "exact" as const, trace: observations[0]!.trace, artifacts: observations[0]!.artifacts });
}

function canonicalProducerSchedulerJoin(join: SearchSchedulerResourceJoinV1): CanonicalProducerSchedulerJoinV1 {
  const { schedulerCompletion: _schedulerCompletion, ...wire } = join;
  return deepFreeze(wire);
}

function sameSchedulerRuntime(
  left: RuntimeReleasePerformanceHeadFactsV1["schedulerRange"]["runtime"],
  right: NonNullable<RuntimeReleasePerformanceHeadFactsV1["selectedSchedulerCompletion"]>["runtime"],
): boolean {
  return left.schedulerRuntimeId === right.schedulerRuntimeId
    && left.qualifiedExecutorRegistryRoot === right.qualifiedExecutorRegistryRoot
    && left.executorAuthorityRoot === right.executorAuthorityRoot
    && left.workerEpoch === right.workerEpoch
    && left.executorSession === right.executorSession
    && left.authorityVersion === right.authorityVersion;
}

function exactProducerSchedulerJoin(value: unknown, path: string): CanonicalProducerSchedulerJoinV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "correlationId", "generationId", "source", "programHash", "finalSimulationReceiptHash",
    "unsignedDryRunCandidateId", "unsignedDryRunLineageHash",
  ], path);
  const record = value as Record<string, unknown>;
  assertPlainObject(record.source, `${path}.source`);
  assertExactKeys(record.source, ["chainId", "number", "hash", "stateRoot"], `${path}.source`);
  const source = record.source as Record<string, unknown>;
  return deepFreeze({
    correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    source: Object.freeze({
      chainId: assertDecimalString(source.chainId, `${path}.source.chainId`),
      number: assertDecimalString(source.number, `${path}.source.number`),
      hash: nonZeroHash(source.hash, `${path}.source.hash`),
      stateRoot: nonZeroHash(source.stateRoot, `${path}.source.stateRoot`),
    }),
    programHash: nonZeroHash(record.programHash, `${path}.programHash`),
    finalSimulationReceiptHash: nonZeroHash(record.finalSimulationReceiptHash, `${path}.finalSimulationReceiptHash`),
    unsignedDryRunCandidateId: nonZeroHash(record.unsignedDryRunCandidateId, `${path}.unsignedDryRunCandidateId`),
    unsignedDryRunLineageHash: nonZeroHash(record.unsignedDryRunLineageHash, `${path}.unsignedDryRunLineageHash`),
  });
}

function exactJoinedRuntimeFacts(value: unknown, path: string): JoinedRuntimePerformanceFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["schedulerRange", "schedulerCompletions", "selectedSchedulerCompletion", "resource", "producerSchedulerJoin"], path);
  const record = value as Record<string, unknown>;
  const schedulerRange = validateSchedulerPerformanceRangeFactValue(record.schedulerRange);
  if (!Array.isArray(record.schedulerCompletions)) throw new TypeError(`${path}.schedulerCompletions must be an array`);
  const schedulerCompletions = Object.freeze(record.schedulerCompletions.map((completion, index) => {
    const decoded = validateSchedulerWorkCompletionFactValue(completion);
    if (!sameSchedulerRuntime(schedulerRange.runtime, decoded.runtime)) throw new TypeError(`${path}.schedulerCompletions[${index}] runtime mismatch`);
    if (decoded.sequence !== (BigInt(schedulerRange.startSequence) + BigInt(index)).toString()) {
      throw new TypeError(`${path}.schedulerCompletions[${index}] sequence mismatch`);
    }
    return decoded;
  }));
  if (schedulerCompletions.length.toString() !== schedulerRange.completionCount
    || schedulerRange.endSequence !== (BigInt(schedulerRange.startSequence) + BigInt(schedulerCompletions.length)).toString()
    || schedulerRange.orderedCompletionRoot !== hashDomain("aloha/scheduler-performance-range-completions/v1", schedulerCompletions.map(completion => completion.completionId))) {
    throw new TypeError(`${path}.schedulerCompletions do not bind the scheduler range`);
  }
  const selectedSchedulerCompletion = record.selectedSchedulerCompletion === null
    ? null
    : validateSchedulerWorkCompletionFactValue(record.selectedSchedulerCompletion);
  const resource = validateProcessResourceObservationValue(record.resource);
  const producerJoin = record.producerSchedulerJoin === null
    ? null
    : exactProducerSchedulerJoin(record.producerSchedulerJoin, `${path}.producerSchedulerJoin`);
  if ((selectedSchedulerCompletion === null) !== (producerJoin === null)) {
    throw new TypeError(`${path} Producer/scheduler selection nullability mismatch`);
  }
  if (selectedSchedulerCompletion !== null) {
    if (!sameSchedulerRuntime(schedulerRange.runtime, selectedSchedulerCompletion.runtime)) throw new TypeError(`${path} scheduler runtime mismatch`);
    const sequence = BigInt(selectedSchedulerCompletion.sequence);
    if (sequence < BigInt(schedulerRange.startSequence) || sequence >= BigInt(schedulerRange.endSequence)) {
      throw new TypeError(`${path} selected scheduler completion is outside its continuous range`);
    }
    if (selectedSchedulerCompletion.outcome !== "completed"
      || selectedSchedulerCompletion.work.phase !== "final-sim"
      || selectedSchedulerCompletion.work.workClassRef !== "qualified-revm-final-simulation-v1"
      || selectedSchedulerCompletion.work.lane !== "final-sim"
      || selectedSchedulerCompletion.work.resource !== "final-sim") {
      throw new TypeError(`${path} selected scheduler completion is not the successful qualified final simulation`);
    }
    if (!schedulerCompletions.some(completion => completion.completionId === selectedSchedulerCompletion.completionId)) {
      throw new TypeError(`${path} selected scheduler completion is absent from the raw completion set`);
    }
  }
  return deepFreeze({ schedulerRange, schedulerCompletions, selectedSchedulerCompletion, resource, producerSchedulerJoin: producerJoin });
}

function canonicalClone<T>(value: T, path: string): T {
  try {
    return decodeCanonicalBytes(encodeCanonicalBytes(value)) as T;
  } catch {
    throw new TypeError(`${path} is not canonical durable data`);
  }
}

function exactStageTiming(value: unknown, path: string): Readonly<{
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
  readonly durationUs: string;
}> {
  assertPlainObject(value, path);
  assertExactKeys(value, ["startedMonotonicNs", "finishedMonotonicNs", "durationUs"], path);
  const record = value as Record<string, unknown>;
  const startedMonotonicNs = assertDecimalString(record.startedMonotonicNs, `${path}.startedMonotonicNs`);
  const finishedMonotonicNs = assertDecimalString(record.finishedMonotonicNs, `${path}.finishedMonotonicNs`);
  const durationUs = assertDecimalString(record.durationUs, `${path}.durationUs`);
  const started = BigInt(startedMonotonicNs);
  const finished = BigInt(finishedMonotonicNs);
  if (finished < started || durationUs !== ((finished - started) / 1_000n).toString()) {
    throw new TypeError(`${path} monotonic duration mismatch`);
  }
  return Object.freeze({ startedMonotonicNs, finishedMonotonicNs, durationUs });
}

function resolvedSixStepPayload(value: SearchTerminalSixStepTraceV1["resolved"]): Omit<SearchTerminalSixStepTraceV1["resolved"], "traceRoot"> {
  const { traceRoot: _traceRoot, ...payload } = value;
  return payload;
}

function sixStepTracePayload(value: SearchTerminalSixStepTraceV1): Omit<SearchTerminalSixStepTraceV1, "traceRoot"> {
  const { traceRoot: _traceRoot, ...payload } = value;
  return payload;
}

function exactDeclaredObligations(value: unknown, path: string): readonly EconomicSafetyDeclaredObligationV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  const obligations = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    assertPlainObject(item, itemPath);
    assertExactKeys(item, ["obligationRef", "ownerRef", "policy"], itemPath);
    const record = item as Record<string, unknown>;
    if (record.policy !== "must-satisfy") throw new TypeError(`${itemPath}.policy is invalid`);
    return Object.freeze({
      obligationRef: nonZeroHash(record.obligationRef, `${itemPath}.obligationRef`),
      ownerRef: nonZeroHash(record.ownerRef, `${itemPath}.ownerRef`),
      policy: "must-satisfy" as const,
    });
  });
  if (new Set(obligations.map(item => item.obligationRef)).size !== obligations.length) {
    throw new TypeError(`${path} contains duplicate obligation refs`);
  }
  return Object.freeze(obligations);
}

export function decodeProductionExecutionRouteAssetReferencesV1(
  value: unknown,
  actionOwners: unknown,
  sourceChainId: unknown,
  path = "productionEvidence.executionProgramOwnerEvidence.facts.routeAssetReferences",
): readonly AssetReferenceV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  if (!Array.isArray(actionOwners) || actionOwners.length === 0) throw new TypeError(`${path} action owner denominator is empty`);
  const chainId = assertDecimalString(sourceChainId, `${path}.sourceChainId`);
  const references = value.map((item, index) => decodeAssetReferenceV1(item, `${path}[${index}]`));
  for (const [index, reference] of references.entries()) {
    if (reference.identity.chainId !== chainId) throw new TypeError(`${path}[${index}] chain id mismatch`);
    if (index > 0 && references[index - 1]!.assetRef >= reference.assetRef) {
      throw new TypeError(`${path} must be strictly ordered without duplicate asset refs`);
    }
  }
  const actionAssetRefs = new Set<Hash>();
  for (const [ownerIndex, rawOwner] of actionOwners.entries()) {
    const ownerPath = `${path}.actionOwners[${ownerIndex}]`;
    const owner = canonicalRecord(rawOwner, ownerPath);
    for (const field of ["inputs", "outputs"] as const) {
      const amounts = owner[field];
      if (!Array.isArray(amounts) || amounts.length === 0) throw new TypeError(`${ownerPath}.${field} must be a non-empty array`);
      for (const [amountIndex, rawAmount] of amounts.entries()) {
        const amountPath = `${ownerPath}.${field}[${amountIndex}]`;
        const amount = canonicalRecord(rawAmount, amountPath);
        assertExactKeys(amount, ["assetRef", "amount"], amountPath);
        actionAssetRefs.add(nonZeroHash(amount.assetRef, `${amountPath}.assetRef`));
        const quantity = assertDecimalString(amount.amount, `${amountPath}.amount`);
        if (BigInt(quantity) <= 0n) throw new TypeError(`${amountPath}.amount must be positive`);
      }
    }
  }
  const referencedAssetRefs = references.map(reference => reference.assetRef);
  const expectedAssetRefs = [...actionAssetRefs].sort((left, right) => left.localeCompare(right));
  if (referencedAssetRefs.length !== expectedAssetRefs.length
    || referencedAssetRefs.some((assetRef, index) => assetRef !== expectedAssetRefs[index])) {
    throw new TypeError(`${path} does not exact-cover action input/output asset refs`);
  }
  return Object.freeze(references);
}

function exactSixStepTrace(value: unknown, path: string): SearchTerminalSixStepTraceV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schemaVersion", "kind", "strategyCompositionRoot", "planningProblem", "planningProblemHash",
    "routeCandidate", "selectedGraphLegs", "admission", "resolved", "traceRoot",
  ], path);
  const trace = value as unknown as SearchTerminalSixStepTraceV1;
  if (trace.schemaVersion !== 1 || trace.kind !== "aloha.search-terminal-six-step-trace-v1") throw new TypeError(`${path} kind/version mismatch`);
  nonZeroHash(trace.strategyCompositionRoot, `${path}.strategyCompositionRoot`);
  nonZeroHash(trace.planningProblemHash, `${path}.planningProblemHash`);
  if (!Array.isArray(trace.selectedGraphLegs) || trace.selectedGraphLegs.length < 2) throw new TypeError(`${path}.selectedGraphLegs are invalid`);
  for (const [index, leg] of trace.selectedGraphLegs.entries()) {
    const legPath = `${path}.selectedGraphLegs[${index}]`;
    assertPlainObject(leg, legPath);
    assertExactKeys(leg, ["edgeId", "owningFamilyId", "owningFamilyDefinitionHash", "owningInstanceKey", "instancePublicationHash", "staticProjectionHash", "projectionHash"], legPath);
    nonZeroHash(leg.edgeId, `${legPath}.edgeId`);
    assertNonEmptyString(leg.owningFamilyId, `${legPath}.owningFamilyId`);
    nonZeroHash(leg.owningFamilyDefinitionHash, `${legPath}.owningFamilyDefinitionHash`);
    assertNonEmptyString(leg.owningInstanceKey, `${legPath}.owningInstanceKey`);
    nonZeroHash(leg.instancePublicationHash, `${legPath}.instancePublicationHash`);
    nonZeroHash(leg.staticProjectionHash, `${legPath}.staticProjectionHash`);
    nonZeroHash(leg.projectionHash, `${legPath}.projectionHash`);
  }
  assertPlainObject(trace.admission, `${path}.admission`);
  assertExactKeys(trace.admission, ["topK", "boundedUnrankedBudget", "admissionPolicyHash", "enumerationRoot", "accountingRoot"], `${path}.admission`);
  assertDecimalString(trace.admission.topK, `${path}.admission.topK`);
  assertDecimalString(trace.admission.boundedUnrankedBudget, `${path}.admission.boundedUnrankedBudget`);
  nonZeroHash(trace.admission.admissionPolicyHash, `${path}.admission.admissionPolicyHash`);
  nonZeroHash(trace.admission.enumerationRoot, `${path}.admission.enumerationRoot`);
  nonZeroHash(trace.admission.accountingRoot, `${path}.admission.accountingRoot`);
  const resolvedPath = `${path}.resolved`;
  assertPlainObject(trace.resolved, resolvedPath);
  assertExactKeys(trace.resolved, [
    "schemaVersion", "kind", "binding", "routeCandidateId", "orderedEdgeIds", "routeBinding",
    "strategy", "objective", "source", "correlationId", "coarse", "planner", "exact",
    "executionProgram", "executionProgramOwnerEvidence", "finalSimulation", "finalSimulationOwnerEvidence",
    "economicSafety", "unsignedDryRun", "timings", "productionArtifactSetRoots", "traceRoot",
  ], resolvedPath);
  if (trace.resolved.schemaVersion !== 1 || trace.resolved.kind !== "aloha.resolved-route-six-step-trace-v1") throw new TypeError(`${resolvedPath} kind/version mismatch`);
  nonZeroHash(trace.resolved.routeCandidateId, `${resolvedPath}.routeCandidateId`);
  if (!Array.isArray(trace.resolved.orderedEdgeIds) || trace.resolved.orderedEdgeIds.length !== trace.selectedGraphLegs.length) throw new TypeError(`${resolvedPath}.orderedEdgeIds mismatch`);
  trace.resolved.orderedEdgeIds.forEach((edgeId, index) => {
    if (nonZeroHash(edgeId, `${resolvedPath}.orderedEdgeIds[${index}]`) !== trace.selectedGraphLegs[index]!.edgeId) throw new TypeError(`${resolvedPath}.orderedEdgeIds order mismatch`);
  });
  if (!Array.isArray(trace.resolved.productionArtifactSetRoots)
    || trace.resolved.productionArtifactSetRoots.length !== 4) {
    throw new TypeError(`${resolvedPath}.productionArtifactSetRoots is invalid`);
  }
  trace.resolved.productionArtifactSetRoots.forEach((root, index) => {
    nonZeroHash(root, `${resolvedPath}.productionArtifactSetRoots[${index}]`);
  });
  assertPlainObject(trace.resolved.source, `${resolvedPath}.source`);
  nonZeroHash(trace.resolved.correlationId, `${resolvedPath}.correlationId`);
  assertPlainObject(trace.resolved.timings, `${resolvedPath}.timings`);
  assertExactKeys(trace.resolved.timings, ["planner", "exact", "executionProgram", "finalSimulation"], `${resolvedPath}.timings`);
  exactStageTiming(trace.resolved.timings.planner, `${resolvedPath}.timings.planner`);
  exactStageTiming(trace.resolved.timings.exact, `${resolvedPath}.timings.exact`);
  exactStageTiming(trace.resolved.timings.executionProgram, `${resolvedPath}.timings.executionProgram`);
  exactStageTiming(trace.resolved.timings.finalSimulation, `${resolvedPath}.timings.finalSimulation`);
  const executionEvidence = trace.resolved.executionProgramOwnerEvidence;
  if (executionEvidence === null) throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence is missing`);
  assertPlainObject(executionEvidence, `${resolvedPath}.executionProgramOwnerEvidence`);
  const executionEvidenceKeys = ["schemaVersion", "kind", "correlationId", "generationId", "source", "routeHash", "exactHash", "programHash", "facts", "evidenceRoot"];
  const hasOwnerObservation = Object.prototype.hasOwnProperty.call(executionEvidence, "ownerObservation");
  if (hasOwnerObservation) executionEvidenceKeys.push("ownerObservation");
  assertExactKeys(executionEvidence, executionEvidenceKeys, `${resolvedPath}.executionProgramOwnerEvidence`);
  if (executionEvidence.schemaVersion !== 1 || executionEvidence.kind !== "aloha.execution-program-six-step-evidence-v1") throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence kind/version mismatch`);
  const executionEvidenceRoot = hashDomain("aloha/execution-program-six-step-evidence/v1", (({ evidenceRoot: _root, ...body }) => body)(executionEvidence));
  if (executionEvidence.evidenceRoot !== executionEvidenceRoot) throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence root mismatch`);
  const executionOwnerFacts = canonicalRecord(executionEvidence.facts, `${resolvedPath}.executionProgramOwnerEvidence.facts`);
  assertExactKeys(executionOwnerFacts, ["kind", "callerMode", "preCalls", "observationPairs", "observeLogs", "callSequence", "routeAssetReferences", "actionOwners", "declaredObligations", "obligationRoot"], `${resolvedPath}.executionProgramOwnerEvidence.facts`);
  if (executionOwnerFacts.kind !== "aloha.search-runtime.execution-program-owner-facts-v1"
    || typeof executionOwnerFacts.callerMode !== "string"
    || !Array.isArray(executionOwnerFacts.preCalls)
    || !Array.isArray(executionOwnerFacts.observationPairs)
    || !Array.isArray(executionOwnerFacts.callSequence)
    || !Array.isArray(executionOwnerFacts.routeAssetReferences)
    || !Array.isArray(executionOwnerFacts.actionOwners)
    || !Array.isArray(executionOwnerFacts.declaredObligations)
    || typeof executionOwnerFacts.observeLogs !== "boolean") throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence facts are incomplete`);
  decodeProductionExecutionRouteAssetReferencesV1(
    executionOwnerFacts.routeAssetReferences,
    executionOwnerFacts.actionOwners,
    trace.resolved.source.chainId,
    `${resolvedPath}.executionProgramOwnerEvidence.facts.routeAssetReferences`,
  );
  const declaredObligations = exactDeclaredObligations(executionOwnerFacts.declaredObligations, `${resolvedPath}.executionProgramOwnerEvidence.facts.declaredObligations`);
  const executionObligationRoot = nonZeroHash(executionOwnerFacts.obligationRoot, `${resolvedPath}.executionProgramOwnerEvidence.facts.obligationRoot`);
  if (hasOwnerObservation) {
    const observation = canonicalRecord(executionEvidence.ownerObservation, `${resolvedPath}.executionProgramOwnerEvidence.ownerObservation`);
    assertExactKeys(observation, ["kind", "actionArtifacts", "effectTransport"], `${resolvedPath}.executionProgramOwnerEvidence.ownerObservation`);
    if (observation.kind !== "aloha.search-runtime.execution-program-owner-observation-v1"
      || !Array.isArray(observation.actionArtifacts)
      || observation.actionArtifacts.length === 0) {
      throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence.ownerObservation is incomplete`);
    }
    if (observation.actionArtifacts.length !== executionOwnerFacts.actionOwners.length) {
      throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence action observation denominator mismatch`);
    }
    for (const [index, rawArtifact] of observation.actionArtifacts.entries()) {
      const actionPath = `${resolvedPath}.executionProgramOwnerEvidence.ownerObservation.actionArtifacts[${index}]`;
      const artifact = canonicalRecord(rawArtifact, actionPath);
      const owner = canonicalRecord(executionOwnerFacts.actionOwners[index], `${resolvedPath}.executionProgramOwnerEvidence.facts.actionOwners[${index}]`);
      if (artifact.kind !== "action" || artifact.status !== "ready"
        || artifact.artifactHash !== owner.actionArtifactHash
        || artifact.actionHash !== owner.actionHash
        || artifact.actionOwnerRef !== owner.actionOwnerRef
        || artifact.actionOwnerId !== owner.actionOwnerId
        || artifact.routeBindingHash !== owner.routeBindingHash
        || artifact.exactEvaluationHash !== owner.exactEvaluationHash
        || artifact.payloadHash !== owner.payloadHash
        || artifact.obligationRoot !== owner.obligationRoot) {
        throw new TypeError(`${actionPath} does not bind its execution owner fact`);
      }
    }
  }
  const finalEvidence = trace.resolved.finalSimulationOwnerEvidence;
  if (finalEvidence === null) throw new TypeError(`${resolvedPath}.finalSimulationOwnerEvidence is missing`);
  assertPlainObject(finalEvidence, `${resolvedPath}.finalSimulationOwnerEvidence`);
  assertExactKeys(finalEvidence, ["schemaVersion", "kind", "correlationId", "generationId", "source", "programHash", "finalSimulationReceiptHash", "facts", "evidenceRoot"], `${resolvedPath}.finalSimulationOwnerEvidence`);
  if (finalEvidence.schemaVersion !== 1 || finalEvidence.kind !== "aloha.final-simulation-six-step-evidence-v1") throw new TypeError(`${resolvedPath}.finalSimulationOwnerEvidence kind/version mismatch`);
  const finalEvidenceRoot = hashDomain("aloha/final-simulation-six-step-evidence/v1", (({ evidenceRoot: _root, ...body }) => body)(finalEvidence));
  if (finalEvidence.evidenceRoot !== finalEvidenceRoot) throw new TypeError(`${resolvedPath}.finalSimulationOwnerEvidence root mismatch`);
  const finalOwnerFacts = canonicalRecord(finalEvidence.facts, `${resolvedPath}.finalSimulationOwnerEvidence.facts`);
  assertExactKeys(finalOwnerFacts, ["kind", "artifactProgramHash", "wireProgramHash", "executorQualification", "projection", "workerReceipt"], `${resolvedPath}.finalSimulationOwnerEvidence.facts`);
  if (finalOwnerFacts.kind !== "aloha.qualified-final-simulation-owner-facts-v1") throw new TypeError(`${resolvedPath}.finalSimulationOwnerEvidence facts are incomplete`);
  const objective = canonicalRecord(trace.resolved.objective, `${resolvedPath}.objective`);
  const exact = canonicalRecord(trace.resolved.exact, `${resolvedPath}.exact`);
  const program = canonicalRecord(trace.resolved.executionProgram, `${resolvedPath}.executionProgram`);
  const simulation = canonicalRecord(trace.resolved.finalSimulation, `${resolvedPath}.finalSimulation`);
  const binding = canonicalRecord(trace.resolved.binding, `${resolvedPath}.binding`);
  const finalWorkerReceipt = canonicalRecord(finalOwnerFacts.workerReceipt, `${resolvedPath}.finalSimulationOwnerEvidence.facts.workerReceipt`);
  if (finalOwnerFacts.artifactProgramHash !== program.programHash
    || finalOwnerFacts.wireProgramHash !== finalWorkerReceipt.programHash) {
    throw new TypeError(`${resolvedPath}.finalSimulationOwnerEvidence artifact/wire program binding mismatch`);
  }
  if (hasOwnerObservation) {
    const observation = canonicalRecord(executionEvidence.ownerObservation, `${resolvedPath}.executionProgramOwnerEvidence.ownerObservation`);
    const programEffectTransport = Object.prototype.hasOwnProperty.call(program, "effectTransport") ? program.effectTransport : null;
    if (!sameExact(observation.effectTransport, programEffectTransport)) {
      throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence effect transport mismatch`);
    }
    if (observation.effectTransport === null) {
      if (executionOwnerFacts.callerMode !== "top-level"
        || executionOwnerFacts.preCalls.length !== 0
        || executionOwnerFacts.observationPairs.length !== 0
        || executionOwnerFacts.observeLogs !== false) {
        throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence empty effect transport facts mismatch`);
      }
    } else {
      const transport = canonicalRecord(observation.effectTransport, `${resolvedPath}.executionProgramOwnerEvidence.ownerObservation.effectTransport`);
      const caller = canonicalRecord(transport.caller, `${resolvedPath}.executionProgramOwnerEvidence.ownerObservation.effectTransport.caller`);
      if (executionOwnerFacts.callerMode !== caller.executionMode
        || !sameExact(executionOwnerFacts.preCalls, transport.preCalls)
        || !sameExact(executionOwnerFacts.observationPairs, transport.observeTokenBalances)
        || executionOwnerFacts.observeLogs !== transport.observeLogs) {
        throw new TypeError(`${resolvedPath}.executionProgramOwnerEvidence effect transport facts mismatch`);
      }
    }
  }
  assertPlainObject(trace.resolved.source, `${resolvedPath}.source`);
  assertExactKeys(trace.resolved.source, ["chainId", "number", "hash", "stateRoot"], `${resolvedPath}.source`);
  const economicInput: EconomicSafetyFinalizationInputV1 = {
    releaseProvenanceHash: nonZeroHash(binding.releaseProvenanceHash, `${resolvedPath}.binding.releaseProvenanceHash`),
    correlationId: nonZeroHash(trace.resolved.correlationId, `${resolvedPath}.correlationId`),
    generationId: assertNonEmptyString(binding.generationId, `${resolvedPath}.binding.generationId`),
    source: Object.freeze({
      chainId: assertDecimalString(trace.resolved.source.chainId, `${resolvedPath}.source.chainId`),
      number: assertDecimalString(trace.resolved.source.number, `${resolvedPath}.source.number`),
      hash: nonZeroHash(trace.resolved.source.hash, `${resolvedPath}.source.hash`),
      stateRoot: nonZeroHash(trace.resolved.source.stateRoot, `${resolvedPath}.source.stateRoot`),
    }),
    objectiveRef: nonZeroHash(objective.objectiveRef, `${resolvedPath}.objective.objectiveRef`),
    exactHash: nonZeroHash(exact.exactHash, `${resolvedPath}.exact.exactHash`),
    programHash: nonZeroHash(program.programHash, `${resolvedPath}.executionProgram.programHash`),
    obligationRoot: nonZeroHash(program.obligationRoot, `${resolvedPath}.executionProgram.obligationRoot`),
    finalSimulationReceiptHash: nonZeroHash(simulation.receiptHash, `${resolvedPath}.finalSimulation.receiptHash`),
    effectsHash: nonZeroHash(simulation.effectsHash, `${resolvedPath}.finalSimulation.effectsHash`),
    executionOwnerEvidenceRoot: executionEvidence.evidenceRoot,
    finalSimulationOwnerEvidenceRoot: finalEvidence.evidenceRoot,
    dryRun: true,
    executionOwnerFacts: executionEvidence.facts,
    finalSimulationOwnerFacts: finalEvidence.facts,
    declaredObligations,
  };
  if (executionObligationRoot !== economicInput.obligationRoot) throw new TypeError(`${resolvedPath} execution obligation root mismatch`);
  validateEconomicSafetyEvidenceV1(trace.resolved.economicSafety, economicInput);
  if (trace.resolved.traceRoot !== hashDomain("aloha/resolved-route-six-step-trace/v1", resolvedSixStepPayload(trace.resolved))) throw new TypeError(`${resolvedPath}.traceRoot mismatch`);
  if (trace.traceRoot !== hashDomain("aloha/search-terminal-six-step-trace/v1", sixStepTracePayload(trace))) throw new TypeError(`${path}.traceRoot mismatch`);
  return deepFreeze(trace);
}

function exactStage12Binding(value: unknown, path: string): ReadyStage12EvidenceBindingV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["readyRecordHash", "generationId", "cutoff", "definitionCatalogRoot", "sourceCoverageRoot", "candidatePartitionRoot", "exactOutcomePartitionRoot", "verifiedMemoSetRoot", "instanceCatalogRoot", "graphRoot", "releaseProvenanceHash", "promotionRevision"], path);
  const record = value as Record<string, unknown>;
  assertPlainObject(record.cutoff, `${path}.cutoff`);
  assertExactKeys(record.cutoff, ["chainId", "number", "hash", "stateRoot"], `${path}.cutoff`);
  const cutoff = record.cutoff as Record<string, unknown>;
  return deepFreeze({
    readyRecordHash: nonZeroHash(record.readyRecordHash, `${path}.readyRecordHash`),
    generationId: assertNonEmptyString(record.generationId, `${path}.generationId`),
    cutoff: Object.freeze({
      chainId: assertDecimalString(cutoff.chainId, `${path}.cutoff.chainId`),
      number: assertDecimalString(cutoff.number, `${path}.cutoff.number`),
      hash: nonZeroHash(cutoff.hash, `${path}.cutoff.hash`),
      stateRoot: nonZeroHash(cutoff.stateRoot, `${path}.cutoff.stateRoot`),
    }),
    definitionCatalogRoot: nonZeroHash(record.definitionCatalogRoot, `${path}.definitionCatalogRoot`),
    sourceCoverageRoot: nonZeroHash(record.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
    candidatePartitionRoot: nonZeroHash(record.candidatePartitionRoot, `${path}.candidatePartitionRoot`),
    exactOutcomePartitionRoot: nonZeroHash(record.exactOutcomePartitionRoot, `${path}.exactOutcomePartitionRoot`),
    verifiedMemoSetRoot: nonZeroHash(record.verifiedMemoSetRoot, `${path}.verifiedMemoSetRoot`),
    instanceCatalogRoot: nonZeroHash(record.instanceCatalogRoot, `${path}.instanceCatalogRoot`),
    graphRoot: nonZeroHash(record.graphRoot, `${path}.graphRoot`),
    releaseProvenanceHash: nonZeroHash(record.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    promotionRevision: assertDecimalString(record.promotionRevision, `${path}.promotionRevision`),
  });
}

function exactStage12SelectedRouteFacts(value: unknown, path: string): Stage12SelectedRouteFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["binding", "selectedParents", "stage3EventId", "stage3ArtifactSetRoot"], path);
  const record = value as Record<string, unknown>;
  const binding = exactStage12Binding(record.binding, `${path}.binding`);
  if (!Array.isArray(record.selectedParents) || record.selectedParents.length < 2) throw new TypeError(`${path}.selectedParents is invalid`);
  const selectedParents = record.selectedParents.map((value, index) => {
    const parentPath = `${path}.selectedParents[${index}]`;
    assertPlainObject(value, parentPath);
    assertExactKeys(value, ["edgeId", "selectedLegRoot", "stage1EventId", "stage1ArtifactSetRoot", "stage2EventId", "stage2ArtifactSetRoot", "instancePublicationRoot", "edgeContentRoot"], parentPath);
    const parent = value as Record<string, unknown>;
    return Object.freeze({
      edgeId: nonZeroHash(parent.edgeId, `${parentPath}.edgeId`),
      selectedLegRoot: nonZeroHash(parent.selectedLegRoot, `${parentPath}.selectedLegRoot`),
      stage1EventId: nonZeroHash(parent.stage1EventId, `${parentPath}.stage1EventId`),
      stage1ArtifactSetRoot: nonZeroHash(parent.stage1ArtifactSetRoot, `${parentPath}.stage1ArtifactSetRoot`),
      stage2EventId: nonZeroHash(parent.stage2EventId, `${parentPath}.stage2EventId`),
      stage2ArtifactSetRoot: nonZeroHash(parent.stage2ArtifactSetRoot, `${parentPath}.stage2ArtifactSetRoot`),
      instancePublicationRoot: nonZeroHash(parent.instancePublicationRoot, `${parentPath}.instancePublicationRoot`),
      edgeContentRoot: nonZeroHash(parent.edgeContentRoot, `${parentPath}.edgeContentRoot`),
    });
  });
  if (new Set(selectedParents.map(parent => parent.edgeId)).size !== selectedParents.length) throw new TypeError(`${path}.selectedParents contains duplicate edges`);
  return deepFreeze({
    binding,
    selectedParents: Object.freeze(selectedParents),
    stage3EventId: nonZeroHash(record.stage3EventId, `${path}.stage3EventId`),
    stage3ArtifactSetRoot: nonZeroHash(record.stage3ArtifactSetRoot, `${path}.stage3ArtifactSetRoot`),
  });
}

function stage12Root(value: Stage12SelectedRouteFactsV1): Hash {
  return hashDomain("aloha/searcher-production-evidence-stage12/v1", value);
}

function exactJoinedSixStepFacts(value: unknown, path: string): JoinedSixStepPerformanceFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["stage12", "stage36", "stage12Root", "stage36Root", "lineageRoot"], path);
  const record = value as Record<string, unknown>;
  const stage12 = exactStage12SelectedRouteFacts(record.stage12, `${path}.stage12`);
  const stage36 = exactSixStepTrace(record.stage36, `${path}.stage36`);
  const stage12Identity = nonZeroHash(record.stage12Root, `${path}.stage12Root`);
  const stage36Root = nonZeroHash(record.stage36Root, `${path}.stage36Root`);
  const lineageRoot = nonZeroHash(record.lineageRoot, `${path}.lineageRoot`);
  if (stage12Identity !== stage12Root(stage12) || stage36Root !== stage36.traceRoot) throw new TypeError(`${path} root mismatch`);
  const expectedLineage = hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", { stage12Root: stage12Identity, stage36Root });
  if (lineageRoot !== expectedLineage) throw new TypeError(`${path}.lineageRoot mismatch`);
  return deepFreeze({ stage12, stage36, stage12Root: stage12Identity, stage36Root, lineageRoot });
}

function canonicalRecord(value: unknown, path: string): Record<string, unknown> {
  assertPlainObject(value, path);
  return value as Record<string, unknown>;
}

function selectedLegRoot(leg: SearchSixStepGraphLegV1): Hash {
  return hashDomain("aloha/searcher-production-evidence-selected-graph-leg/v1", leg);
}

function selectedWitnessContent(
  material: ReturnType<typeof readProductionSixStepArtifactMaterialV1>,
  role: string,
  expectedContentRoot: Hash,
): ReturnType<typeof decodeSixStepWitnessContent> {
  const matches = material.witnessArtifacts.map(artifact => decodeSixStepWitnessContent(artifact.bytes)).filter(value => value.role === role);
  if (matches.length !== 1 || hashSixStepWitnessContentRoot(matches[0]!) !== expectedContentRoot) {
    throw new TypeError(`production evidence Stage1/2 ${role} witness is not exact`);
  }
  return matches[0]!;
}

function buildStage12SelectedRouteFacts(input: Readonly<{
  readonly binding: ReadyStage12EvidenceBindingV1;
  readonly trace: SearchTerminalSixStepTraceV1;
  readonly artifacts: ProductionSixStepArtifactCapabilitiesV1;
  readonly routeLegs: RouteAccountingV1["entries"][number]["legs"];
}>): Stage12SelectedRouteFactsV1 {
  const binding = exactStage12Binding(input.binding, "productionEvidence.stage12.binding");
  if (input.artifacts.stage1.length !== input.trace.selectedGraphLegs.length
    || input.artifacts.stage2.length !== input.trace.selectedGraphLegs.length
    || input.routeLegs.length !== input.trace.selectedGraphLegs.length) {
    throw new TypeError("production evidence Stage1/2 artifact denominator mismatch");
  }
  const stage3 = readProductionSixStepArtifactMaterialV1(input.artifacts.stage3);
  const stage3Facts = decodeSixStepStageFacts(stage3.event.facts);
  if (stage3.event.stage.ordinal !== 3 || stage3Facts.stageId !== "planner_consumption"
    || stage3.artifactSetRoot !== input.trace.resolved.productionArtifactSetRoots[0]
    || stage3.event.parentEventIds.length !== input.trace.selectedGraphLegs.length
    || stage3Facts.orderedInstanceBindings.length !== input.trace.selectedGraphLegs.length) {
    throw new TypeError("production evidence Stage3 artifact denominator mismatch");
  }
  const selectedParents = input.trace.selectedGraphLegs.map((leg, index) => {
    const stage1 = readProductionSixStepArtifactMaterialV1(input.artifacts.stage1[index]!);
    const stage2 = readProductionSixStepArtifactMaterialV1(input.artifacts.stage2[index]!);
    const stage1Facts = decodeSixStepStageFacts(stage1.event.facts);
    const stage2Facts = decodeSixStepStageFacts(stage2.event.facts);
    const routeBinding = stage3Facts.orderedInstanceBindings[index]!;
    if (stage1.event.stage.ordinal !== 1 || stage1Facts.stageId !== "universe_instance"
      || stage2.event.stage.ordinal !== 2 || stage2Facts.stageId !== "edge_ready_generation"
      || stage1.event.parentEventIds.length !== 0
      || stage2.event.parentEventIds.length !== 1 || stage2.event.parentEventIds[0] !== stage1.event.eventId
      || stage3.event.parentEventIds[index] !== stage2.event.eventId
      || routeBinding.edgeId !== leg.edgeId
      || routeBinding.instanceKey !== leg.owningInstanceKey
      || routeBinding.stage1EventId !== stage1.event.eventId
      || routeBinding.stage2EventId !== stage2.event.eventId
      || routeBinding.instancePublicationRoot !== stage2Facts.instancePublication.contentRoot
      || stage1Facts.instancePublication.contentRoot !== stage2Facts.instancePublication.contentRoot
      || stage2Facts.generationId !== binding.generationId
      || stage2Facts.promotionRevision !== binding.promotionRevision
      || stage2.event.scope.generationId !== binding.generationId
      || stage2.event.definitionCatalogRoot !== binding.definitionCatalogRoot
      || stage2.event.instanceCatalogRoot !== binding.instanceCatalogRoot
      || stage2.event.graphRoot !== binding.graphRoot
      || stage2.event.cutoff.number !== binding.cutoff.number
      || stage2.event.cutoff.hash !== binding.cutoff.hash
      || stage2.event.cutoff.stateRoot !== binding.cutoff.stateRoot
      || stage2.event.familyId !== leg.owningFamilyId
      || stage2.event.familyDefinitionHash !== leg.owningFamilyDefinitionHash
      || stage2.event.instanceKey !== leg.owningInstanceKey) {
      throw new TypeError(`production evidence Stage1/2 selected parent ${index} lineage mismatch`);
    }
    const publication = canonicalRecord(
      selectedWitnessContent(stage2, "instance-publication", stage2Facts.instancePublication.contentRoot).payload,
      `productionEvidence.stage12.selectedParents[${index}].publication`,
    );
    const edge = canonicalRecord(
      selectedWitnessContent(stage2, "edge", stage2Facts.edge.contentRoot).payload,
      `productionEvidence.stage12.selectedParents[${index}].edge`,
    );
    validateProductionStage2EdgeMembershipV1(
      edge,
      input.routeLegs[index]!,
      `productionEvidence.stage12.selectedParents[${index}].edge`,
    );
    if (publication.instancePublicationHash !== leg.instancePublicationHash
      || publication.instanceKey !== leg.owningInstanceKey
      || publication.familyDefinitionHash !== leg.owningFamilyDefinitionHash
      || edge.edgeId !== leg.edgeId
      || edge.owningFamilyId !== leg.owningFamilyId
      || edge.owningFamilyDefinitionHash !== leg.owningFamilyDefinitionHash
      || edge.owningInstanceKey !== leg.owningInstanceKey
      || edge.instancePublicationHash !== leg.instancePublicationHash
      || edge.staticProjectionHash !== leg.staticProjectionHash
      || edge.projectionHash !== leg.projectionHash) {
      throw new TypeError(`production evidence Stage1/2 selected parent ${index} does not bind the selected Graph leg`);
    }
    return Object.freeze({
      edgeId: leg.edgeId,
      selectedLegRoot: selectedLegRoot(leg),
      stage1EventId: stage1.event.eventId,
      stage1ArtifactSetRoot: stage1.artifactSetRoot,
      stage2EventId: stage2.event.eventId,
      stage2ArtifactSetRoot: stage2.artifactSetRoot,
      instancePublicationRoot: stage2Facts.instancePublication.contentRoot,
      edgeContentRoot: stage2Facts.edge.contentRoot,
    });
  });
  return exactStage12SelectedRouteFacts({
    binding,
    selectedParents,
    stage3EventId: stage3.event.eventId,
    stage3ArtifactSetRoot: stage3.artifactSetRoot,
  }, "productionEvidence.stage12");
}

function validateJoinedSixStepContext(input: {
  readonly facts: JoinedSixStepPerformanceFactsV1;
  readonly runtimeFacts: JoinedRuntimePerformanceFactsV1;
  readonly release: SearcherProductionEvidenceReleaseV1;
  readonly serving: ServingBindingV1;
  readonly head: CanonicalHead;
  readonly candidateObservation: ProducerCandidateTerminalObservationV1;
  readonly accounting: RouteAccountingV1;
  readonly candidateEntry: RouteAccountingV1["entries"][number];
  readonly plannerCandidateIdentity: AccountedRouteDenominatorPayloadV1["plannerCandidateIdentity"];
  readonly economicSafetyAuthority: EconomicSafetyEvidenceAuthorityExpectationV1;
  readonly strategyExpectation: RuntimeReleaseStrategyEvidenceExpectationV1 | null;
}): void {
  const { stage12, stage36 } = input.facts;
  const binding = stage12.binding;
  if (input.candidateEntry.terminalKind !== "passed"
    || input.candidateEntry.reasonCode !== null
    || input.candidateObservation.performanceOutcome !== "verified"
    || input.candidateObservation.candidateId !== input.candidateEntry.candidateId
    || input.accounting.entries.filter(entry => entry.candidateId === input.candidateEntry.candidateId).length !== 1
    || !input.accounting.entries.some(entry => sameExact(entry, input.candidateEntry))
    || input.candidateObservation.planningProblemHash !== input.accounting.planningProblemHash
    || input.candidateObservation.enumerationRoot !== input.accounting.enumerationRoot
    || input.candidateObservation.admissionPolicyHash !== input.accounting.admissionPolicyHash) {
    throw new TypeError("production evidence passed candidate accounting witness splice");
  }
  validateProductionCandidateEvidenceJoinV1(input.candidateEntry, input.candidateObservation);
  if (binding.readyRecordHash !== input.serving.readyRecordHash
    || binding.generationId !== input.serving.generationId
    || binding.graphRoot !== input.serving.graphRoot
    || binding.sourceCoverageRoot !== input.serving.sourceCoverageRoot
    || binding.releaseProvenanceHash !== input.release.releaseProvenanceHash) {
    throw new TypeError("production evidence Stage1/2 serving lineage mismatch");
  }
  const planningProblem = exactProductionPlanningProblemV1(stage36.planningProblem, "productionEvidence.sixStep.stage36.planningProblem");
  validateProductionStrategyQualificationV1(planningProblem, input.strategyExpectation);
  const candidateLimit = BigInt(planningProblem.candidateLimit);
  const observedUniqueCountLowerBound = BigInt(assertDecimalString(
    input.accounting.observedUniqueCountLowerBound,
    "productionEvidence.accounting.observedUniqueCountLowerBound",
  ));
  if (!Number.isSafeInteger(input.accounting.total) || input.accounting.total < 0
    || BigInt(input.accounting.total) > candidateLimit
    || (input.accounting.enumerationTruncated
      ? BigInt(input.accounting.total) !== candidateLimit
        || observedUniqueCountLowerBound <= BigInt(input.accounting.total)
      : observedUniqueCountLowerBound !== BigInt(input.accounting.total))) {
    throw new TypeError("production evidence planner candidate denominator/truncation mismatch");
  }
  const routeCandidate = exactProductionRouteCandidateV1(
    stage36.routeCandidate,
    planningProblem,
    input.candidateEntry,
    "productionEvidence.sixStep.stage36.routeCandidate",
  );
  const resolvedObjective = canonicalRecord(
    stage36.resolved.objective,
    "productionEvidence.sixStep.stage36.resolved.objective",
  );
  validateProductionPlanningContextJoinV1({
    problem: planningProblem,
    candidateCorrelationId: input.candidateObservation.correlationId,
    resolvedCorrelationId: nonZeroHash(
      stage36.resolved.correlationId,
      "productionEvidence.sixStep.stage36.resolved.correlationId",
    ),
    resolvedObjectiveRef: nonZeroHash(
      resolvedObjective.objectiveRef,
      "productionEvidence.sixStep.stage36.resolved.objective.objectiveRef",
    ),
  });
  if (input.plannerCandidateIdentity.triggerRef !== planningProblem.triggerRef
    || input.plannerCandidateIdentity.affectedEdgeIdsRoot !== hashDomain(
      "aloha/producer-trigger-affected-edges/v1",
      planningProblem.requiredAnchorEdgeIds,
    )) {
    throw new TypeError("production evidence owner-issued trigger/planning splice");
  }
  const topK = Number(assertDecimalString(stage36.admission.topK, "productionEvidence.sixStep.stage36.admission.topK"));
  const boundedUnrankedBudget = Number(assertDecimalString(stage36.admission.boundedUnrankedBudget, "productionEvidence.sixStep.stage36.admission.boundedUnrankedBudget"));
  if (!Number.isSafeInteger(topK) || !Number.isSafeInteger(boundedUnrankedBudget)
    || topK < 0 || boundedUnrankedBudget < 0
    || stage36.admission.admissionPolicyHash !== hashDomain("aloha/route-admission-policy/v1", { topK, boundedUnrankedBudget })
    || stage36.admission.enumerationRoot !== input.accounting.enumerationRoot
    || stage36.admission.accountingRoot !== input.accounting.root
    || planningProblem.problemHash !== input.accounting.planningProblemHash
    || planningProblem.generationId !== input.serving.generationId
    || planningProblem.graphRoot !== input.serving.graphRoot
    || planningProblem.readyRecordHash !== input.serving.readyRecordHash
    || planningProblem.definitionCatalogRoot !== binding.definitionCatalogRoot
    || planningProblem.releaseProvenanceHash !== input.release.releaseProvenanceHash
    || planningProblem.triggerHeadHash !== input.head.hash
    || planningProblem.lane !== input.candidateObservation.lane
    || planningProblem.strategyCompositionRoot !== stage36.strategyCompositionRoot
    || input.candidateObservation.generationId !== binding.generationId
    || input.candidateObservation.graphRoot !== binding.graphRoot) {
    throw new TypeError("production evidence Stage3 planning/admission witness splice");
  }
  const resolvedBinding = canonicalRecord(stage36.resolved.binding, "productionEvidence.sixStep.stage36.resolved.binding");
  if (resolvedBinding.readyRecordHash !== binding.readyRecordHash
    || resolvedBinding.generationId !== binding.generationId
    || resolvedBinding.graphRoot !== binding.graphRoot
    || resolvedBinding.instanceCatalogRoot !== binding.instanceCatalogRoot
    || resolvedBinding.definitionCatalogRoot !== binding.definitionCatalogRoot
    || resolvedBinding.releaseProvenanceHash !== binding.releaseProvenanceHash
    || !sameExact(resolvedBinding.cutoff, binding.cutoff)) {
    throw new TypeError("production evidence Stage3 lease does not join Stage1/2 ready evidence");
  }
  if (stage36.resolved.source.chainId !== input.head.chainId
    || stage36.resolved.source.number !== input.head.number
    || stage36.resolved.source.hash !== input.head.hash
    || stage36.resolved.source.stateRoot !== input.head.stateRoot) {
    throw new TypeError("production evidence Stage3-6 source does not join the canonical head");
  }
  if (planningProblem.problemHash !== stage36.planningProblemHash
    || routeCandidate.planningProblemHash !== stage36.planningProblemHash
    || routeCandidate.candidateId !== stage36.resolved.routeCandidateId
    || routeCandidate.candidateId !== input.candidateEntry.candidateId
    || input.candidateObservation.candidateId !== input.candidateEntry.candidateId) {
    throw new TypeError("production evidence Stage3 planning/candidate lineage mismatch");
  }
  if (new Set(stage36.selectedGraphLegs.map(leg => leg.edgeId)).size !== stage36.selectedGraphLegs.length) throw new TypeError("production evidence Stage3 selected duplicate Graph edges");
  if (stage12.selectedParents.length !== stage36.selectedGraphLegs.length
    || routeCandidate.legs.length !== stage36.selectedGraphLegs.length
    || stage12.selectedParents.some((parent, index) => parent.edgeId !== stage36.selectedGraphLegs[index]!.edgeId
      || parent.selectedLegRoot !== selectedLegRoot(stage36.selectedGraphLegs[index]!)
      || routeCandidate.legs[index]!.edgeId !== stage36.selectedGraphLegs[index]!.edgeId)) {
    throw new TypeError("production evidence Stage3 legs do not join their selected Stage1/2 parents");
  }
  const program = canonicalRecord(stage36.resolved.executionProgram, "productionEvidence.sixStep.stage36.executionProgram");
  const exact = canonicalRecord(stage36.resolved.exact, "productionEvidence.sixStep.stage36.exact");
  const simulation = canonicalRecord(stage36.resolved.finalSimulation, "productionEvidence.sixStep.stage36.finalSimulation");
  const dryRun = canonicalRecord(stage36.resolved.unsignedDryRun, "productionEvidence.sixStep.stage36.unsignedDryRun");
  const economicSafety = stage36.resolved.economicSafety;
  const executionEvidence = stage36.resolved.executionProgramOwnerEvidence;
  const finalEvidence = stage36.resolved.finalSimulationOwnerEvidence;
  if (executionEvidence === null) throw new TypeError("production evidence execution owner evidence is missing");
  const executionOwnerFacts = canonicalRecord(
    executionEvidence.facts,
    "productionEvidence.sixStep.stage36.executionProgramOwnerEvidence.facts",
  );
  if (!Array.isArray(executionOwnerFacts.actionOwners)) {
    throw new TypeError("production evidence execution action-owner denominator is missing");
  }
  const routeBinding = validateProductionResolvedRouteBindingV1({
    value: stage36.resolved.routeBinding,
    candidate: routeCandidate,
    problem: planningProblem,
    generationId: binding.generationId,
    graphRoot: binding.graphRoot,
    source: input.head,
    objectiveRef: planningProblem.objectiveRef,
    releaseProvenanceHash: input.release.releaseProvenanceHash,
    actionOwners: executionOwnerFacts.actionOwners,
    path: "productionEvidence.sixStep.stage36.routeBinding",
  });
  const join = input.runtimeFacts.producerSchedulerJoin;
  const coarse = canonicalRecord(stage36.resolved.coarse, "productionEvidence.sixStep.stage36.coarse");
  const planned = canonicalRecord(stage36.resolved.planner, "productionEvidence.sixStep.stage36.planner");
  validateProductionPassedCandidateSixStepJoinV1({
    candidate: input.candidateObservation,
    accountingRoot: input.accounting.root,
    sixStep: {
      candidateId: stage36.resolved.routeCandidateId,
      correlationId: stage36.resolved.correlationId,
      generationId: binding.generationId,
      graphRoot: binding.graphRoot,
      planningProblemHash: stage36.planningProblemHash,
      enumerationRoot: stage36.admission.enumerationRoot,
      admissionPolicyHash: stage36.admission.admissionPolicyHash,
      accountingRoot: stage36.admission.accountingRoot,
      routeHash: nonZeroHash(routeBinding.routeHash, "productionEvidence.sixStep.stage36.routeBinding.routeHash"),
      unsignedDryRunLineageHash: nonZeroHash(dryRun.lineageHash, "productionEvidence.sixStep.stage36.unsignedDryRun.lineageHash"),
      stage36Root: stage36.traceRoot,
    },
  });
  if (!Object.prototype.hasOwnProperty.call(executionEvidence, "ownerObservation")
    || finalEvidence === null
    || join === null || input.runtimeFacts.selectedSchedulerCompletion === null
    || join.correlationId !== stage36.resolved.correlationId
    || join.generationId !== binding.generationId
    || join.unsignedDryRunCandidateId !== stage36.resolved.routeCandidateId
    || join.programHash !== program.programHash
    || join.finalSimulationReceiptHash !== simulation.receiptHash
    || executionEvidence.correlationId !== stage36.resolved.correlationId
    || executionEvidence.generationId !== binding.generationId
    || executionEvidence.routeHash !== routeBinding.routeHash
    || input.candidateEntry.routeHash !== routeBinding.routeHash
    || coarse.routeHash !== routeBinding.routeHash
    || planned.routeHash !== routeBinding.routeHash
    || exact.routeHash !== routeBinding.routeHash
    || program.routeHash !== routeBinding.routeHash
    || dryRun.routeHash !== routeBinding.routeHash
    || dryRun.routeBindingHash !== routeBinding.routeBindingHash
    || executionEvidence.exactHash !== exact.exactHash
    || executionEvidence.programHash !== program.programHash
    || finalEvidence.correlationId !== stage36.resolved.correlationId
    || finalEvidence.generationId !== binding.generationId
    || finalEvidence.programHash !== program.programHash
    || finalEvidence.finalSimulationReceiptHash !== simulation.receiptHash
    || dryRun.correlationId !== stage36.resolved.correlationId
    || dryRun.generationId !== binding.generationId
    || dryRun.readyRecordHash !== binding.readyRecordHash
    || dryRun.graphRoot !== binding.graphRoot
    || dryRun.candidateId !== stage36.resolved.routeCandidateId
    || dryRun.programHash !== join.programHash
    || dryRun.finalSimulationReceiptHash !== join.finalSimulationReceiptHash
    || dryRun.lineageHash !== join.unsignedDryRunLineageHash
    || dryRun.safetyRoot !== economicSafety.evidenceRoot
    || economicSafety.authorityRoot !== input.economicSafetyAuthority.authorityRoot
    || economicSafety.implementationHash !== input.economicSafetyAuthority.implementationHash
    || economicSafety.releaseProvenanceHash !== input.economicSafetyAuthority.releaseProvenanceHash
    || economicSafety.releaseProvenanceHash !== input.release.releaseProvenanceHash) {
    throw new TypeError("production evidence Stage5/6 scheduler/dry-run lineage mismatch");
  }
}

async function joinSixStepFacts(input: {
  readonly startup: StartupRuntimeV1;
  readonly trace: SearchTerminalSixStepTraceV1;
  readonly artifacts: ProductionSixStepArtifactCapabilitiesV1;
  readonly runtimeFacts: JoinedRuntimePerformanceFactsV1;
  readonly release: SearcherProductionEvidenceReleaseV1;
  readonly serving: ServingBindingV1;
  readonly head: CanonicalHead;
  readonly candidateObservation: ProducerCandidateTerminalObservationV1;
  readonly accounting: RouteAccountingV1;
  readonly candidateEntry: RouteAccountingV1["entries"][number];
  readonly plannerCandidateIdentity: AccountedRouteDenominatorPayloadV1["plannerCandidateIdentity"];
  readonly economicSafetyAuthority: EconomicSafetyEvidenceAuthorityExpectationV1;
  readonly strategyExpectation: RuntimeReleaseStrategyEvidenceExpectationV1 | null;
}): Promise<JoinedSixStepPerformanceFactsV1> {
  const stage36 = exactSixStepTrace(
    canonicalClone(input.trace, "productionEvidence.stage36"),
    "productionEvidence.stage36",
  );
  const stage12 = buildStage12SelectedRouteFacts({
    binding: readStartupStage12EvidenceBinding(input.startup),
    trace: stage36,
    artifacts: input.artifacts,
    routeLegs: input.candidateEntry.legs,
  });
  const stage12Identity = stage12Root(stage12);
  const stage36Root = stage36.traceRoot;
  const facts = deepFreeze({
    stage12,
    stage36,
    stage12Root: stage12Identity,
    stage36Root,
    lineageRoot: hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", { stage12Root: stage12Identity, stage36Root }),
  });
  validateJoinedSixStepContext({
    facts,
    runtimeFacts: input.runtimeFacts,
    release: input.release,
    serving: input.serving,
    head: input.head,
    candidateObservation: input.candidateObservation,
    accounting: input.accounting,
    candidateEntry: input.candidateEntry,
    plannerCandidateIdentity: input.plannerCandidateIdentity,
    economicSafetyAuthority: input.economicSafetyAuthority,
    strategyExpectation: input.strategyExpectation,
  });
  return facts;
}

function nullableHash(value: unknown, path: string): Hash | null {
  return value === null ? null : nonZeroHash(value, path);
}

function exactProducerTerminal(value: unknown, path: string): ProducerTerminalV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["kind", "terminalId", "acceptedId", "sequence", "ordinal", "head", "revision", "status", "reason", "generationId", "graphRoot", "laneOutcomes"], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "aloha.producer-terminal-v1") throw new TypeError(`${path}.kind is invalid`);
  if (record.status !== "completed" && record.status !== "failed" && record.status !== "cancelled" && record.status !== "dropped" && record.status !== "rejected") throw new TypeError(`${path}.status is invalid`);
  const reasons = new Set(["completed", "completed-with-no-backrun-input", "scheduler_coalesced", "shutdown_pending_dropped", "shutdown_active_cancelled", "same_height_reorg", "explicit_invalidation", "startup_session_failed", "lane_failed", "lane_retryable", "performance_append_failed", "terminal_append_failed", "shutdown_rejected"]);
  if (typeof record.reason !== "string" || !reasons.has(record.reason)) throw new TypeError(`${path}.reason is invalid`);
  if (!Array.isArray(record.laneOutcomes)) throw new TypeError(`${path}.laneOutcomes must be an array`);
  const laneOutcomes = record.laneOutcomes.map((value, index) => {
    const lanePath = `${path}.laneOutcomes[${index}]`;
    assertPlainObject(value, lanePath);
    assertExactKeys(value, ["kind", "outcome", "reasonCode"], lanePath);
    const lane = value as Record<string, unknown>;
    if (lane.kind !== "blockscan" && lane.kind !== "backrun") throw new TypeError(`${lanePath}.kind is invalid`);
    if (lane.outcome !== "completed" && lane.outcome !== "no-input" && lane.outcome !== "retryable" && lane.outcome !== "failed" && lane.outcome !== "cancelled") throw new TypeError(`${lanePath}.outcome is invalid`);
    if (lane.reasonCode !== null && typeof lane.reasonCode !== "string") throw new TypeError(`${lanePath}.reasonCode is invalid`);
    return Object.freeze({ kind: lane.kind, outcome: lane.outcome, reasonCode: lane.reasonCode }) as ProducerTerminalV1["laneOutcomes"][number];
  });
  const terminalWithoutId = {
    acceptedId: nonZeroHash(record.acceptedId, `${path}.acceptedId`),
    sequence: assertDecimalString(record.sequence, `${path}.sequence`),
    ordinal: assertDecimalString(record.ordinal, `${path}.ordinal`),
    status: record.status,
    reason: record.reason as ProducerTerminalReasonV1,
    head: exactHead(record.head, `${path}.head`),
    revision: assertDecimalString(record.revision, `${path}.revision`),
    generationId: record.generationId === null ? null : assertNonEmptyString(record.generationId, `${path}.generationId`),
    graphRoot: nullableHash(record.graphRoot, `${path}.graphRoot`),
    laneOutcomes: Object.freeze(laneOutcomes),
  } as const;
  const terminalId = nonZeroHash(record.terminalId, `${path}.terminalId`);
  if (terminalId !== hashDomain("aloha/producer-terminal/v1", terminalWithoutId)) throw new TypeError(`${path}.terminalId mismatch`);
  return deepFreeze({ kind: "aloha.producer-terminal-v1" as const, terminalId, ...terminalWithoutId });
}

function materializeAccountedRouteDenominator(
  store: Pick<SQLiteDurableStore, "readContent" | "readIndex">,
  record: Record<string, unknown>,
  path: string,
  common: RouteDenominatorCommonV1,
): AccountedRouteDenominatorPayloadV1 {
  assertExactKeys(record, ["admissionId", "headFactsRoot", "headHash", "lane", "correlationId", "coverageRoot", "denominatorKind", "plannerCandidateIdentity", "accounting", "material"], path);
  if (record.denominatorKind !== "accounted") throw new TypeError(`${path}.denominatorKind is invalid`);
  assertPlainObject(record.plannerCandidateIdentity, `${path}.plannerCandidateIdentity`);
  assertExactKeys(record.plannerCandidateIdentity, [
    "planningProblemHash", "objectiveRef", "entryAssetRef", "returnAssetRef", "triggerRef", "affectedEdgeIdsRoot",
  ], `${path}.plannerCandidateIdentity`);
  const rawIdentity = record.plannerCandidateIdentity as Record<string, unknown>;
  const plannerCandidateIdentity = Object.freeze({
    planningProblemHash: nonZeroHash(rawIdentity.planningProblemHash, `${path}.plannerCandidateIdentity.planningProblemHash`),
    objectiveRef: nonZeroHash(rawIdentity.objectiveRef, `${path}.plannerCandidateIdentity.objectiveRef`),
    entryAssetRef: nonZeroHash(rawIdentity.entryAssetRef, `${path}.plannerCandidateIdentity.entryAssetRef`),
    returnAssetRef: nonZeroHash(rawIdentity.returnAssetRef, `${path}.plannerCandidateIdentity.returnAssetRef`),
    triggerRef: nonZeroHash(rawIdentity.triggerRef, `${path}.plannerCandidateIdentity.triggerRef`),
    affectedEdgeIdsRoot: nonZeroHash(rawIdentity.affectedEdgeIdsRoot, `${path}.plannerCandidateIdentity.affectedEdgeIdsRoot`),
  });
  assertPlainObject(record.accounting, `${path}.accounting`);
  assertExactKeys(record.accounting, [
    "planningProblemHash", "enumerationRoot", "admissionPolicyHash", "enumerationTruncated",
    "observedUniqueCountLowerBound", "total", "selected", "pruned", "notProbed", "failed", "root",
    "entryCount", "entrySequenceRoot",
  ], `${path}.accounting`);
  const rawAccounting = record.accounting as Record<string, unknown>;
  if (typeof rawAccounting.enumerationTruncated !== "boolean") throw new TypeError(`${path}.accounting.enumerationTruncated is invalid`);
  const accountingSummary = Object.freeze({
    planningProblemHash: nonZeroHash(rawAccounting.planningProblemHash, `${path}.accounting.planningProblemHash`),
    enumerationRoot: nonZeroHash(rawAccounting.enumerationRoot, `${path}.accounting.enumerationRoot`),
    admissionPolicyHash: nonZeroHash(rawAccounting.admissionPolicyHash, `${path}.accounting.admissionPolicyHash`),
    enumerationTruncated: rawAccounting.enumerationTruncated,
    observedUniqueCountLowerBound: assertDecimalString(rawAccounting.observedUniqueCountLowerBound, `${path}.accounting.observedUniqueCountLowerBound`),
    total: nonNegativeSafeInteger(rawAccounting.total, `${path}.accounting.total`),
    selected: nonNegativeSafeInteger(rawAccounting.selected, `${path}.accounting.selected`),
    pruned: nonNegativeSafeInteger(rawAccounting.pruned, `${path}.accounting.pruned`),
    notProbed: nonNegativeSafeInteger(rawAccounting.notProbed, `${path}.accounting.notProbed`),
    failed: nonNegativeSafeInteger(rawAccounting.failed, `${path}.accounting.failed`),
    root: nonZeroHash(rawAccounting.root, `${path}.accounting.root`),
    entryCount: assertDecimalString(rawAccounting.entryCount, `${path}.accounting.entryCount`),
    entrySequenceRoot: nonZeroHash(rawAccounting.entrySequenceRoot, `${path}.accounting.entrySequenceRoot`),
  });
  const withoutMaterial = deepFreeze({ ...common, denominatorKind: "accounted" as const, plannerCandidateIdentity, accounting: accountingSummary });
  const bindingRoot = accountedMaterialBindingRoot(withoutMaterial);
  const materialized = readSearcherProductionEvidenceMaterialV1(store, record.material, {
    materialKind: "route-accounting-entries",
    bindingRoot,
    decodeEntry: (entry, ordinal) => exactRouteAccountingEntry(entry, `${path}.material.entries[${ordinal}]`),
    entryRoot: routeAccountingEntryRoot,
  });
  if (accountingSummary.entryCount !== String(materialized.entries.length)
    || accountingSummary.entrySequenceRoot !== materialized.manifest.entrySequenceRoot) {
    throw new TypeError(`${path}.accounting material summary mismatch`);
  }
  const accounting = exactRouteAccounting({
    planningProblemHash: accountingSummary.planningProblemHash,
    enumerationRoot: accountingSummary.enumerationRoot,
    admissionPolicyHash: accountingSummary.admissionPolicyHash,
    enumerationTruncated: accountingSummary.enumerationTruncated,
    observedUniqueCountLowerBound: accountingSummary.observedUniqueCountLowerBound,
    total: accountingSummary.total,
    selected: accountingSummary.selected,
    pruned: accountingSummary.pruned,
    notProbed: accountingSummary.notProbed,
    failed: accountingSummary.failed,
    entries: materialized.entries,
    root: accountingSummary.root,
  }, `${path}.accountingMaterialized`);
  if (plannerCandidateIdentity.planningProblemHash !== accounting.planningProblemHash
    || plannerCandidateIdentity.entryAssetRef !== plannerCandidateIdentity.returnAssetRef
    || accounting.entries.some(entry => entry.candidateId !== hashDomain("aloha/planner-route-candidate/v1", {
      planningProblemHash: plannerCandidateIdentity.planningProblemHash,
      objectiveRef: plannerCandidateIdentity.objectiveRef,
      entryAssetRef: plannerCandidateIdentity.entryAssetRef,
      returnAssetRef: plannerCandidateIdentity.returnAssetRef,
      legs: entry.legs,
    }))) {
    throw new TypeError(`${path}.plannerCandidateIdentity mismatch`);
  }
  return deepFreeze({ ...common, denominatorKind: "accounted" as const, plannerCandidateIdentity, accounting });
}

function materializeCandidateSet(
  store: Pick<SQLiteDurableStore, "readContent" | "readIndex">,
  record: Record<string, unknown>,
  path: string,
): CandidateSetPayloadV1 {
  assertExactKeys(record, [
    "admissionId", "headFactsRoot", "headHash", "candidateRefCount", "candidateRefsRoot",
    "laneDenominators", "candidateTerminalObservationSetRoot", "material",
  ], path);
  const admissionId = nonZeroHash(record.admissionId, `${path}.admissionId`);
  const headFactsRoot = nonZeroHash(record.headFactsRoot, `${path}.headFactsRoot`);
  const headHash = nonZeroHash(record.headHash, `${path}.headHash`);
  const candidateRefCount = assertDecimalString(record.candidateRefCount, `${path}.candidateRefCount`);
  const candidateRefsRoot = nonZeroHash(record.candidateRefsRoot, `${path}.candidateRefsRoot`);
  if (!Array.isArray(record.laneDenominators)) throw new TypeError(`${path}.laneDenominators must be an array`);
  const laneSummaries = Object.freeze(record.laneDenominators.map((value, index) => {
    const itemPath = `${path}.laneDenominators[${index}]`;
    assertPlainObject(value, itemPath);
    assertExactKeys(value, ["lane", "correlationId", "coverageRoot", "accountingRoot", "candidateCount", "observationSetRoot"], itemPath);
    const item = value as Record<string, unknown>;
    if (item.lane !== "blockscan" && item.lane !== "backrun") throw new TypeError(`${itemPath}.lane is invalid`);
    return Object.freeze({
      lane: item.lane,
      correlationId: nonZeroHash(item.correlationId, `${itemPath}.correlationId`),
      coverageRoot: nonZeroHash(item.coverageRoot, `${itemPath}.coverageRoot`),
      accountingRoot: nonZeroHash(item.accountingRoot, `${itemPath}.accountingRoot`),
      candidateCount: assertDecimalString(item.candidateCount, `${itemPath}.candidateCount`),
      observationSetRoot: nonZeroHash(item.observationSetRoot, `${itemPath}.observationSetRoot`),
    });
  }));
  if (new Set(laneSummaries.map(value => value.lane)).size !== laneSummaries.length
    || laneSummaries.some((value, index) => value.lane !== (["blockscan", "backrun"] as const).filter(lane => laneSummaries.some(item => item.lane === lane))[index])) {
    throw new TypeError(`${path}.laneDenominators order is invalid`);
  }
  const candidateTerminalObservationSetRoot = nonZeroHash(record.candidateTerminalObservationSetRoot, `${path}.candidateTerminalObservationSetRoot`);
  const withoutMaterial = deepFreeze({ admissionId, headFactsRoot, headHash, candidateRefCount, candidateRefsRoot, laneDenominators: laneSummaries, candidateTerminalObservationSetRoot });
  const materialized = readSearcherProductionEvidenceMaterialV1(store, record.material, {
    materialKind: "candidate-terminal-observations",
    bindingRoot: candidateMaterialBindingRoot(withoutMaterial),
    decodeEntry: (entry, ordinal) => exactProducerCandidateTerminalObservation(entry, `${path}.material.entries[${ordinal}]`),
    entryRoot: observation => observation.observationRoot,
  });
  const observations = materialized.entries;
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!;
    const current = observations[index]!;
    if ((previous.lane === "backrun" && current.lane === "blockscan")
      || (previous.lane === current.lane && previous.candidateId >= current.candidateId)) {
      throw new TypeError(`${path}.candidateTerminalObservations must be lane/candidate ordered`);
    }
  }
  const candidateRefs = sortedUniqueHashes(observations.map(value => value.performanceCandidateRef), `${path}.candidateRefs`);
  if (candidateRefCount !== String(candidateRefs.length)
    || candidateRefsRoot !== searcherProductionEvidenceOrderedRootV1("aloha/searcher-production-evidence-candidate-refs/v1", candidateRefs)) {
    throw new TypeError(`${path}.candidateRefs closure mismatch`);
  }
  const laneDenominators = Object.freeze(laneSummaries.map(summary => {
    const laneObservations = observations.filter(observation => observation.lane === summary.lane);
    const observationRoots = Object.freeze(laneObservations.map(observation => observation.observationRoot));
    if (summary.candidateCount !== String(laneObservations.length)
      || laneObservations.some(observation => observation.correlationId !== summary.correlationId)
      || summary.observationSetRoot !== hashDomain("aloha/producer-lane-candidate-terminal-observation-set/v1", {
        lane: summary.lane,
        correlationId: summary.correlationId,
        accountingRoot: summary.accountingRoot,
        observationRoots,
      })) throw new TypeError(`${path}.${summary.lane} observation denominator mismatch`);
    return Object.freeze({ ...summary, observationRoots });
  }));
  if (laneDenominators.flatMap(value => value.observationRoots).length !== observations.length
    || candidateTerminalObservationSetRoot !== hashDomain("aloha/performance-candidate-terminal-observation-set-root/v1", laneDenominators.map(value => value.observationSetRoot))
    || observations.some(value => value.headHash !== headHash)) {
    throw new TypeError(`${path} observation set closure mismatch`);
  }
  for (const observation of observations) {
    if (observation.policyTerminal?.kind !== "aloha.route-post-success-policy-terminal-v1") continue;
    const policyTerminal = observation.policyTerminal;
    const winner = observations.find(candidate => candidate.lane === observation.lane
      && candidate.candidateId === policyTerminal.winnerCandidateId);
    if (winner?.performanceOutcome !== "verified"
      || winner.terminalLineageHash !== policyTerminal.winnerTerminalLineageHash
      || policyTerminal.decisionMonotonicNs !== observation.finishedMonotonicNs) {
      throw new TypeError(`${path}.candidateTerminalObservations post-success winner mismatch`);
    }
  }
  return deepFreeze({ admissionId, headFactsRoot, headHash, candidateRefs, candidateTerminalObservations: observations, laneDenominators, candidateTerminalObservationSetRoot });
}

function exactPayload(
  eventType: ProductionEvidenceEventTypeV1,
  value: unknown,
  envelope: Readonly<{ release: SearcherProductionEvidenceReleaseV1; runtimeAnchor: RuntimeAnchorReceiptV1 }>,
  store: Pick<SQLiteDurableStore, "readContent" | "readIndex">,
): ProductionEvidencePayloadV1 {
  const path = `productionEvidence.${eventType}.payload`;
  assertPlainObject(value, path);
  const record = value as Record<string, unknown>;
  if (eventType === "performance-window-basis") {
    assertExactKeys(record, ["basisId", "windowStartAnchor", "eligibilityRuleHash", "profile", "providerRoot", "hardwareProfile", "processLogAnchor", "releaseBindingId", "releaseProvenanceHash", "runtimeAnchorHash", "targetCount", "committedMonotonicNs"], path);
    if (record.targetCount !== PERFORMANCE_TARGET_COUNT) throw new TypeError(`${path}.targetCount is invalid`);
    const basis = createPerformanceWindowBasisPayload({
      windowStartAnchor: exactHead(record.windowStartAnchor, `${path}.windowStartAnchor`),
      eligibilityRuleHash: nonZeroHash(record.eligibilityRuleHash, `${path}.eligibilityRuleHash`),
      profile: decodeProductionPerformanceProfile(record.profile as object),
      providerRoot: nonZeroHash(record.providerRoot, `${path}.providerRoot`),
      hardwareProfile: decodeHardwareProfileObservationV1(record.hardwareProfile as object),
      processLogAnchor: exactProcessLogAnchor(record.processLogAnchor, `${path}.processLogAnchor`),
      releaseBindingId: nonZeroHash(record.releaseBindingId, `${path}.releaseBindingId`),
      releaseProvenanceHash: nonZeroHash(record.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
      runtimeAnchorHash: nonZeroHash(record.runtimeAnchorHash, `${path}.runtimeAnchorHash`),
      targetCount: PERFORMANCE_TARGET_COUNT,
      committedMonotonicNs: assertDecimalString(record.committedMonotonicNs, `${path}.committedMonotonicNs`),
    });
    if (basis.basisId !== nonZeroHash(record.basisId, `${path}.basisId`)) throw new TypeError(`${path}.basisId mismatch`);
    return basis;
  }
  if (eventType === "performance-window-commitment") {
    return decodePerformanceWindowCommitment(record);
  }
  if (eventType === "eligible-head" || eventType === "orphan-replacement") {
    assertExactKeys(
      record,
      eventType === "eligible-head"
        ? ["admissionId", "windowId", "ordinal", "head", "revision", "acceptedMonotonicNs"]
        : ["admissionId", "windowId", "ordinal", "head", "revision", "acceptedMonotonicNs", "lineage"],
      path,
    );
    const payload = {
      admissionId: nonZeroHash(record.admissionId, `${path}.admissionId`),
      windowId: record.windowId === null ? null : nonZeroHash(record.windowId, `${path}.windowId`),
      ordinal: assertDecimalString(record.ordinal, `${path}.ordinal`),
      head: exactHead(record.head, `${path}.head`),
      revision: assertDecimalString(record.revision, `${path}.revision`),
      acceptedMonotonicNs: assertDecimalString(record.acceptedMonotonicNs, `${path}.acceptedMonotonicNs`),
    };
    const expected = hashDomain("aloha/searcher-production-evidence-admission/v1", { ...envelope, windowId: payload.windowId, ordinal: payload.ordinal, head: payload.head, revision: payload.revision, acceptedMonotonicNs: payload.acceptedMonotonicNs });
    if (payload.admissionId !== expected) throw new TypeError(`${path}.admissionId mismatch`);
    if (eventType === "eligible-head") {
      if (payload.revision !== "0") throw new TypeError(`${path}.revision requires an orphan-replacement event`);
      return Object.freeze(payload);
    }
    if (payload.windowId === null) throw new TypeError(`${path}.windowId is required for a replacement`);
    const lineage = decodePerformanceAdmissionOrphanReplacementLineage(record.lineage as object);
    if (lineage.windowId !== payload.windowId
      || lineage.ordinal !== payload.ordinal
      || lineage.replacementAdmissionId !== payload.admissionId
      || lineage.replacementCanonicalHead.chainId !== payload.head.chainId
      || lineage.replacementCanonicalHead.number !== payload.head.number
      || lineage.replacementCanonicalHead.hash !== payload.head.hash
      || lineage.replacementCanonicalHead.parentHash !== payload.head.parentHash
      || lineage.replacementCanonicalHead.stateRoot !== payload.head.stateRoot
      || lineage.replacementRevision !== payload.revision
      || lineage.replacementAcceptedMonotonicNs !== payload.acceptedMonotonicNs) {
      throw new TypeError(`${path}.lineage does not bind the replacement admission`);
    }
    return Object.freeze({ ...payload, lineage });
  }
  if (eventType === "head-coverage") {
    assertExactKeys(record, [
      "admissionId", "headFactsRoot", "headHash", "sourceCoverageRoot", "currentSourceLogicalFacts",
      "currentSourcePhysicalFacts", "currentSourcePhysicalFactsRoot", "coarseTimingFacts", "coarseTimingFactsRoot",
      "laneTerminalFacts", "laneTerminalFactsRoot", "complete",
    ], path);
    if (!Array.isArray(record.currentSourceLogicalFacts) || !Array.isArray(record.coarseTimingFacts) || !Array.isArray(record.laneTerminalFacts) || typeof record.complete !== "boolean") throw new TypeError(`${path} arrays/complete are invalid`);
    const currentSourceLogicalFacts = Object.freeze(record.currentSourceLogicalFacts.map((facts, index) => exactCurrentSourceLogicalFacts(facts, `${path}.currentSourceLogicalFacts[${index}]`)));
    if (currentSourceLogicalFacts.length > 2
      || (currentSourceLogicalFacts.length === 2
        && (currentSourceLogicalFacts[0]?.lane !== "blockscan" || currentSourceLogicalFacts[1]?.lane !== "backrun"))) {
      throw new TypeError(`${path}.currentSourceLogicalFacts ordering is invalid`);
    }
    const currentSourcePhysicalFacts = record.currentSourcePhysicalFacts === null
      ? null
      : exactCurrentSourcePhysicalFacts(record.currentSourcePhysicalFacts, `${path}.currentSourcePhysicalFacts`);
    const currentSourcePhysicalFactsRoot = nullableHash(record.currentSourcePhysicalFactsRoot, `${path}.currentSourcePhysicalFactsRoot`);
    if ((currentSourcePhysicalFacts === null) !== (currentSourcePhysicalFactsRoot === null)) throw new TypeError(`${path} current-source physical facts/root nullability mismatch`);
    if (currentSourcePhysicalFacts !== null) {
      if (currentSourcePhysicalFactsRoot !== hashDomain("aloha/current-source-rpc-physical-facts/v1", currentSourcePhysicalFacts)) throw new TypeError(`${path}.currentSourcePhysicalFactsRoot mismatch`);
      if (currentSourcePhysicalFacts.logicalScopeFactsRoot !== currentSourceLogicalFactsRoot(currentSourceLogicalFacts, `${path}.currentSourceLogicalFacts`)) throw new TypeError(`${path} current-source logical/physical root mismatch`);
    }
    if (record.complete && currentSourcePhysicalFacts === null) throw new TypeError(`${path} complete coverage lacks current-source physical facts`);
    const coarseTimingFacts = Object.freeze(record.coarseTimingFacts.map((facts, index) => exactRouteCoarseTimingFacts(facts, `${path}.coarseTimingFacts[${index}]`)));
    const coarseTimingFactsRoot = nonZeroHash(record.coarseTimingFactsRoot, `${path}.coarseTimingFactsRoot`);
    if (coarseTimingFactsRoot !== hashDomain("aloha/route-coarse-timing-facts-set/v1", coarseTimingFacts)) throw new TypeError(`${path}.coarseTimingFactsRoot mismatch`);
    const coarseCorrelations = new Set(coarseTimingFacts.map(facts => facts.correlationId));
    if (coarseCorrelations.size !== coarseTimingFacts.length
      || coarseTimingFacts.some(facts => !currentSourceLogicalFacts.some(current => current.correlationId === facts.correlationId))) {
      throw new TypeError(`${path} coarse/current-source correlation mismatch`);
    }
    const laneTerminalFacts = Object.freeze(record.laneTerminalFacts.map((value, index) => {
      const itemPath = `${path}.laneTerminalFacts[${index}]`;
      assertPlainObject(value, itemPath);
      const item = value as Record<string, unknown>;
      if (item.lane !== "blockscan" && item.lane !== "backrun") throw new TypeError(`${itemPath}.lane is invalid`);
      const lane = item.lane;
      const correlationId = nonZeroHash(item.correlationId, `${itemPath}.correlationId`);
      if (item.kind === "coverage") {
        assertExactKeys(value, ["kind", "lane", "correlationId", "coverageRoot"], itemPath);
        return Object.freeze({ kind: "coverage" as const, lane, correlationId, coverageRoot: nonZeroHash(item.coverageRoot, `${itemPath}.coverageRoot`) });
      }
      if (item.kind === "failure") {
        assertExactKeys(value, ["kind", "lane", "correlationId", "outcome", "reasonCode"], itemPath);
        if (item.outcome !== "retryable" && item.outcome !== "failed" && item.outcome !== "cancelled") throw new TypeError(`${itemPath}.outcome is invalid`);
        return Object.freeze({
          kind: "failure" as const,
          lane,
          correlationId,
          outcome: item.outcome,
          reasonCode: assertNonEmptyString(item.reasonCode, `${itemPath}.reasonCode`),
        });
      }
      throw new TypeError(`${itemPath}.kind is invalid`);
    }));
    const laneTerminalFactsRoot = nonZeroHash(record.laneTerminalFactsRoot, `${path}.laneTerminalFactsRoot`);
    if (laneTerminalFactsRoot !== hashDomain("aloha/searcher-production-evidence-lane-terminal-facts-root/v1", laneTerminalFacts)) {
      throw new TypeError(`${path}.laneTerminalFactsRoot mismatch`);
    }
    if (laneTerminalFacts.length !== currentSourceLogicalFacts.length
      || laneTerminalFacts.some((fact, index) => fact.lane !== currentSourceLogicalFacts[index]?.lane
        || fact.correlationId !== currentSourceLogicalFacts[index]?.correlationId)
      || (record.complete && laneTerminalFacts.some(fact => fact.kind !== "coverage"))) {
      throw new TypeError(`${path} lane/current-source coverage binding mismatch`);
    }
    return deepFreeze({
      admissionId: nonZeroHash(record.admissionId, `${path}.admissionId`),
      headFactsRoot: nonZeroHash(record.headFactsRoot, `${path}.headFactsRoot`),
      headHash: nonZeroHash(record.headHash, `${path}.headHash`),
      sourceCoverageRoot: nonZeroHash(record.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
      currentSourceLogicalFacts,
      currentSourcePhysicalFacts,
      currentSourcePhysicalFactsRoot,
      coarseTimingFacts,
      coarseTimingFactsRoot,
      laneTerminalFacts,
      laneTerminalFactsRoot,
      complete: record.complete,
    });
  }
  if (eventType === "route-denominator") {
    if (record.lane !== "blockscan" && record.lane !== "backrun") throw new TypeError(`${path}.lane is invalid`);
    const common = {
      admissionId: nonZeroHash(record.admissionId, `${path}.admissionId`),
      headFactsRoot: nonZeroHash(record.headFactsRoot, `${path}.headFactsRoot`),
      headHash: nonZeroHash(record.headHash, `${path}.headHash`),
      lane: record.lane,
      correlationId: nonZeroHash(record.correlationId, `${path}.correlationId`),
      coverageRoot: nonZeroHash(record.coverageRoot, `${path}.coverageRoot`),
    } as const;
    if (record.denominatorKind === "no-input") {
      assertExactKeys(record, [
        "admissionId", "headFactsRoot", "headHash", "lane", "correlationId", "coverageRoot", "denominatorKind",
        "pendingSnapshot", "absenceEvidenceHash", "terminalLineageHash", "currentSource",
      ], path);
      if (record.lane !== "backrun") throw new TypeError(`${path} no-input denominator must be backrun`);
      const pendingSnapshot = exactPendingSnapshot(record.pendingSnapshot, `${path}.pendingSnapshot`);
      if (pendingSnapshot.transactionCount !== "0" || pendingSnapshot.orderedTransactionHashes.length !== 0) {
        throw new TypeError(`${path} no-input denominator snapshot is not empty`);
      }
      const currentSource = exactCurrentSourceLogicalFacts(record.currentSource, `${path}.currentSource`);
      if (currentSource.lane !== "backrun" || currentSource.correlationId !== common.correlationId) {
        throw new TypeError(`${path} no-input current-source identity mismatch`);
      }
      return deepFreeze({
        ...common,
        denominatorKind: "no-input" as const,
        pendingSnapshot,
        absenceEvidenceHash: nonZeroHash(record.absenceEvidenceHash, `${path}.absenceEvidenceHash`),
        terminalLineageHash: nonZeroHash(record.terminalLineageHash, `${path}.terminalLineageHash`),
        currentSource,
      });
    }
    return materializeAccountedRouteDenominator(store, record, path, common);
  }
  if (eventType === "candidate-set") {
    return materializeCandidateSet(store, record, path);
  }
  if (eventType === "performance-facts-incomplete") {
    assertExactKeys(record, ["admissionId", "terminalBindingRoot", "terminalId", "terminalMonotonicNs", "headHash", "sourceCoverageRoot", "candidateSetRoot", "candidateCount", "runtimeFacts", "sixStepFacts", "factStatus", "missingFactReasons"], path);
    if (record.factStatus !== "incomplete" || !Array.isArray(record.missingFactReasons) || record.missingFactReasons.length === 0) throw new TypeError(`${path} fact status/reasons are invalid`);
    const validReasons = new Set<MissingPerformanceFactReasonV1>(["head-facts-missing", "head-facts-incomplete", "producer-terminal-timing-capability-missing", "scheduler-queue-permit-capability-missing", "resource-sample-capability-missing", "candidate-terminal-capability-missing", "six-step-completion-capability-missing"]);
    const missingFactReasons = record.missingFactReasons.map((reason, index) => {
      if (typeof reason !== "string" || !validReasons.has(reason as MissingPerformanceFactReasonV1)) throw new TypeError(`${path}.missingFactReasons[${index}] is invalid`);
      return reason as MissingPerformanceFactReasonV1;
    });
    if (missingFactReasons.join("\u0000") !== [...missingFactReasons].sort().join("\u0000") || new Set(missingFactReasons).size !== missingFactReasons.length) throw new TypeError(`${path}.missingFactReasons must be sorted and unique`);
    return Object.freeze({
      admissionId: nonZeroHash(record.admissionId, `${path}.admissionId`),
      terminalBindingRoot: nonZeroHash(record.terminalBindingRoot, `${path}.terminalBindingRoot`),
      terminalId: nonZeroHash(record.terminalId, `${path}.terminalId`),
      terminalMonotonicNs: assertDecimalString(record.terminalMonotonicNs, `${path}.terminalMonotonicNs`),
      headHash: nonZeroHash(record.headHash, `${path}.headHash`),
      sourceCoverageRoot: nullableHash(record.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
      candidateSetRoot: nullableHash(record.candidateSetRoot, `${path}.candidateSetRoot`),
      candidateCount: record.candidateCount === null ? null : assertDecimalString(record.candidateCount, `${path}.candidateCount`),
      runtimeFacts: record.runtimeFacts === null ? null : exactJoinedRuntimeFacts(record.runtimeFacts, `${path}.runtimeFacts`),
      sixStepFacts: record.sixStepFacts === null ? null : exactJoinedSixStepFacts(record.sixStepFacts, `${path}.sixStepFacts`),
      factStatus: "incomplete" as const,
      missingFactReasons: Object.freeze(missingFactReasons),
    });
  }
  if (eventType === "performance-facts-complete") {
    assertExactKeys(record, ["admissionId", "terminalBindingRoot", "terminalId", "terminalMonotonicNs", "headHash", "sourceCoverageRoot", "candidateSetRoot", "candidateCount", "runtimeFacts", "sixStepFacts", "factStatus"], path);
    if (record.factStatus !== "complete") throw new TypeError(`${path}.factStatus is invalid`);
    const payload = Object.freeze({
      admissionId: nonZeroHash(record.admissionId, `${path}.admissionId`),
      terminalBindingRoot: nonZeroHash(record.terminalBindingRoot, `${path}.terminalBindingRoot`),
      terminalId: nonZeroHash(record.terminalId, `${path}.terminalId`),
      terminalMonotonicNs: assertDecimalString(record.terminalMonotonicNs, `${path}.terminalMonotonicNs`),
      headHash: nonZeroHash(record.headHash, `${path}.headHash`),
      sourceCoverageRoot: nonZeroHash(record.sourceCoverageRoot, `${path}.sourceCoverageRoot`),
      candidateSetRoot: nonZeroHash(record.candidateSetRoot, `${path}.candidateSetRoot`),
      candidateCount: assertDecimalString(record.candidateCount, `${path}.candidateCount`),
      runtimeFacts: exactJoinedRuntimeFacts(record.runtimeFacts, `${path}.runtimeFacts`),
      sixStepFacts: record.sixStepFacts === null ? null : exactJoinedSixStepFacts(record.sixStepFacts, `${path}.sixStepFacts`),
      factStatus: "complete" as const,
    });
    return payload;
  }
  if (eventType === "terminal-phase-invalid") {
    return decodeTerminalPhaseInvalidFactV1(record);
  }
  assertExactKeys(record, ["terminalBindingRoot", "terminal", "headFactsRoot"], path);
  const terminal = exactProducerTerminal(record.terminal, `${path}.terminal`);
  const factsRoot = nullableHash(record.headFactsRoot, `${path}.headFactsRoot`);
  const bindingRoot = nonZeroHash(record.terminalBindingRoot, `${path}.terminalBindingRoot`);
  if (bindingRoot !== hashDomain("aloha/searcher-production-evidence-terminal-binding/v1", { terminalId: terminal.terminalId, headFactsRoot: factsRoot })) throw new TypeError(`${path}.terminalBindingRoot mismatch`);
  return Object.freeze({ terminalBindingRoot: bindingRoot, terminal, headFactsRoot: factsRoot });
}

function exactEvent(raw: DurableAppendRecord, store: Pick<SQLiteDurableStore, "readContent" | "readIndex">): ProductionEvidenceEventV1 {
  const value = decodeCanonicalBytes(raw.bytes);
  const path = `productionEvidence.${raw.namespace}/${raw.sequence}`;
  assertPlainObject(value, path);
  assertExactKeys(value, ["schemaVersion", "kind", "eventId", "eventType", "sequence", "namespace", "release", "runtimeAnchor", "serving", "payload"], path);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== EVENT_KIND) throw new TypeError("production evidence schema/kind mismatch");
  const eventType = record.eventType;
  if (eventType !== "performance-window-basis" && eventType !== "performance-window-commitment" && eventType !== "eligible-head" && eventType !== "orphan-replacement" && eventType !== "head-coverage" && eventType !== "route-denominator" && eventType !== "candidate-set" && eventType !== "performance-facts-incomplete" && eventType !== "performance-facts-complete" && eventType !== "producer-terminal" && eventType !== "terminal-phase-invalid") throw new TypeError("production evidence event type is invalid");
  const namespace = namespaceFor(eventType);
  if (record.namespace !== namespace || raw.namespace !== namespace) throw new TypeError("production evidence namespace mismatch");
  const sequence = assertDecimalString(record.sequence, "productionEvidence.sequence");
  if (sequence !== raw.sequence) throw new TypeError("production evidence sequence mismatch");
  const release = exactRelease(record.release, "productionEvidence.release");
  const runtimeAnchor = exactRuntimeAnchor(record.runtimeAnchor, "productionEvidence.runtimeAnchor");
  if (!sameRelease(release, runtimeAnchorRelease(runtimeAnchor))) throw new TypeError("production evidence runtime release mismatch");
  const serving = record.serving === null ? null : exactServing(record.serving, "productionEvidence.serving");
  const provisional = eventType === "performance-window-basis"
    || eventType === "performance-window-commitment"
    || eventType === "eligible-head"
    || eventType === "orphan-replacement";
  const requiresServing = eventType === "head-coverage"
    || eventType === "route-denominator"
    || eventType === "candidate-set"
    || eventType === "performance-facts-complete"
    || eventType === "terminal-phase-invalid";
  if ((provisional && serving !== null) || (requiresServing && serving === null)) {
    throw new TypeError("production evidence event serving phase mismatch");
  }
  const decodedEventId = nonZeroHash(record.eventId, "productionEvidence.eventId");
  const wireDraft: ProductionEvidenceEventDraftV1 = deepFreeze({
    schemaVersion: 1 as const,
    kind: EVENT_KIND,
    eventType,
    sequence,
    namespace,
    release,
    runtimeAnchor,
    serving,
    payload: record.payload as ProductionEvidenceWirePayloadV1,
  });
  if (decodedEventId !== eventId(wireDraft)) throw new TypeError("production evidence event identity mismatch");
  const decoded: ProductionEvidenceEventV1 = deepFreeze({
    schemaVersion: 1 as const,
    kind: EVENT_KIND,
    eventId: decodedEventId,
    eventType,
    sequence,
    namespace,
    release,
    runtimeAnchor,
    serving,
    payload: exactPayload(eventType, record.payload, { release, runtimeAnchor }, store),
  });
  if (eventType === "producer-terminal") {
    const terminal = (decoded.payload as ProducerTerminalPayloadV1).terminal;
    if ((terminal.generationId === null) !== (decoded.serving === null)
      || (decoded.serving !== null
        && (terminal.generationId !== decoded.serving.generationId
          || terminal.graphRoot !== decoded.serving.graphRoot))) {
      throw new TypeError("production evidence producer terminal serving mismatch");
    }
  }
  if (raw.eventId !== decoded.eventId || raw.contentSha256 !== sha256Hex(raw.bytes)) throw new TypeError("production evidence append receipt mismatch");
  return decoded;
}

function evidencePartitionId(event: Pick<ProductionEvidenceEventV1, "release" | "runtimeAnchor">): Hash {
  return hashDomain("aloha/searcher-production-evidence-partition/v1", {
    release: event.release,
    runtimeAnchor: event.runtimeAnchor,
  });
}

function finalDurableAppendBinding(record: DurableAppendRecord): FinalDurableEventAppendBindingV1 {
  if (record.fsynced !== true) throw new TypeError("final durable window append is not fsynced");
  return Object.freeze({
    namespace: record.namespace,
    sequence: record.sequence,
    eventId: record.eventId,
    contentSha256: record.contentSha256,
    byteLength: record.byteLength,
    offsetStart: record.offsetStart,
    offsetEnd: record.offsetEnd,
  });
}

function partitionReplay(
  partitionId: Hash,
  events: readonly ProductionEvidenceEventV1[],
): SearcherProductionEvidencePartitionReplayV1 {
  const eligible = events.filter(event => event.eventType === "eligible-head" || event.eventType === "orphan-replacement");
  const replacements = events.filter(event => event.eventType === "orphan-replacement");
  const coverage = events.filter(event => event.eventType === "head-coverage");
  const routeDenominators = events.filter(event => event.eventType === "route-denominator");
  const candidates = events.filter(event => event.eventType === "candidate-set");
  const performanceFactsComplete = events.filter(event => event.eventType === "performance-facts-complete");
  const performanceFactsIncomplete = events.filter(event => event.eventType === "performance-facts-incomplete");
  const performance = [...performanceFactsComplete, ...performanceFactsIncomplete];
  const terminals = events.filter(event => event.eventType === "producer-terminal");
  const terminalPhaseInvalid = events.filter(event => event.eventType === "terminal-phase-invalid");
  const performanceAdmissions = new Set(performance.map(event => (event.payload as PerformancePayloadV1).admissionId));
  const incompleteAdmissionIds = eligible
    .map(event => (event.payload as EligibleHeadPayloadV1).admissionId)
    .filter(admissionId => !performanceAdmissions.has(admissionId))
    .sort();
  const namespaceRoots = Object.fromEntries(Object.values(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES).map(namespace => [
    namespace,
    hashDomain("aloha/searcher-production-evidence-namespace-root/v1", events.filter(event => event.namespace === namespace).map(event => event.eventId)),
  ])) as Record<ProductionEvidenceNamespaceV1, Hash>;
  const orderedEvents = [...events].sort((left, right) => {
    const namespaceOrder = left.namespace.localeCompare(right.namespace);
    if (namespaceOrder !== 0) return namespaceOrder;
    return BigInt(left.sequence) < BigInt(right.sequence) ? -1 : BigInt(left.sequence) > BigInt(right.sequence) ? 1 : 0;
  });
  return deepFreeze({
    partitionId,
    eventCount: events.length.toString(),
    eventRoot: hashDomain("aloha/searcher-production-evidence-root/v1", orderedEvents.map(event => event.eventId)),
    namespaceRoots,
    eligibleHeadCount: eligible.length.toString(),
    orphanReplacementCount: replacements.length.toString(),
    headCoverageCount: coverage.length.toString(),
    routeDenominatorCount: routeDenominators.length.toString(),
    candidateSetCount: candidates.length.toString(),
    performanceFactsCompleteCount: performanceFactsComplete.length.toString(),
    performanceFactsIncompleteCount: performanceFactsIncomplete.length.toString(),
    producerTerminalCount: terminals.length.toString(),
    terminalPhaseInvalidCount: terminalPhaseInvalid.length.toString(),
    incompleteAdmissionIds,
  });
}

function projectionFromFacts(admissionId: Hash, facts: ProducerHeadFactsV1): {
  readonly coverage: HeadCoveragePayloadV1;
  readonly routeDenominators: readonly RouteDenominatorPayloadV1[];
  readonly candidates: CandidateSetPayloadV1;
} {
  const accountedLaneDrafts = facts.laneFacts.flatMap(lane => {
    const observations = readIssuedProducerLaneCandidateTerminalObservationsV1(lane);
    if (lane.accounting === null) {
      if (observations.length !== 0) throw new TypeError("producer lane without accounting published candidate observations");
      return [];
    }
    if (observations.length !== lane.accounting.entries.length
      || observations.some((observation, index) => observation.candidateId !== lane.accounting!.entries[index]?.candidateId)) {
      throw new TypeError("producer lane candidate observation/accounting denominator mismatch");
    }
    const terminalCapability = readIssuedProducerLaneSearchTerminalCapabilityV1(lane);
    if (terminalCapability === null) throw new TypeError("producer lane accounting lacks its search terminal capability");
    const terminal = readIssuedSearchTerminalCapabilityV1(terminalCapability);
    const upstreamAccounting = terminal.kind === "unsigned-dry-run" ? terminal.accounting : terminal.receipt.accounting;
    if (upstreamAccounting.root !== lane.accounting.root) {
      throw new TypeError("producer lane accounting changed after search terminal issuance");
    }
    const enumeration = readIssuedProducerLanePlannerEnumerationV1(lane);
    if (enumeration === null
      || enumeration.planningProblemHash !== upstreamAccounting.planningProblemHash
      || enumeration.enumerationRoot !== upstreamAccounting.enumerationRoot
      || enumeration.candidates.length !== upstreamAccounting.entries.length
      || upstreamAccounting.entries.some(entry => {
        const candidate = enumeration.candidates.find(value => value.candidateId === entry.candidateId);
        return candidate === undefined || !sameExact(candidate.legs, entry.legs);
      })) {
      throw new TypeError("producer lane planner enumeration/accounting mismatch");
    }
    const planningProblem = enumeration.planningProblem;
    if (planningProblem.lane !== lane.lane
      || planningProblem.triggerRef !== lane.triggerRef
      || planningProblem.triggerCorrelationId !== lane.correlationId
      || planningProblem.triggerHeadHash !== lane.headHash
      || planningProblem.generationId !== lane.generationId
      || planningProblem.graphRoot !== lane.graphRoot
      || hashDomain("aloha/producer-trigger-affected-edges/v1", planningProblem.requiredAnchorEdgeIds) !== lane.affectedEdgeIdsRoot) {
      throw new TypeError("producer lane owner-issued trigger/planning problem mismatch");
    }
    const plannerCandidateIdentity = Object.freeze({
      planningProblemHash: enumeration.planningProblemHash,
      objectiveRef: planningProblem.objectiveRef,
      entryAssetRef: planningProblem.entryAssetRef,
      returnAssetRef: planningProblem.returnAssetRef,
      triggerRef: lane.triggerRef,
      affectedEdgeIdsRoot: lane.affectedEdgeIdsRoot,
    });
    const observationRoots = Object.freeze(observations.map(observation => observation.observationRoot));
    return [Object.freeze({ lane, upstreamAccounting, plannerCandidateIdentity, observations, observationRoots })];
  });
  const candidateTerminalObservations = Object.freeze(accountedLaneDrafts.flatMap(value => value.observations));
  const laneDenominators = Object.freeze(accountedLaneDrafts.map(({ lane, observationRoots }) => {
    const payload = Object.freeze({
      lane: lane.lane,
      correlationId: lane.correlationId,
      coverageRoot: lane.coverageRoot,
      accountingRoot: lane.accounting!.root,
      candidateCount: observationRoots.length.toString(),
      observationRoots,
    });
    return Object.freeze({
      ...payload,
      observationSetRoot: hashDomain("aloha/producer-lane-candidate-terminal-observation-set/v1", {
        lane: payload.lane,
        correlationId: payload.correlationId,
        accountingRoot: payload.accountingRoot,
        observationRoots: payload.observationRoots,
      }),
    });
  }));
  const candidateRefs = sortedUniqueHashes(candidateTerminalObservations.map(value => value.performanceCandidateRef), "producerHeadFacts.candidateTerminalObservations");
  if (!sameExact(candidateRefs, sortedUniqueHashes(facts.candidateRefs, "producerHeadFacts.candidateRefs"))) {
    throw new TypeError("producer head facts candidate terminal denominator mismatch");
  }
  const factsRoot = headFactsRoot(facts);
  const currentSourcePhysicalFacts = facts.currentSourcePhysical;
  const publishedLaneObservations = [
    ...facts.laneFacts.map(lane => Object.freeze({ kind: "coverage" as const, lane: lane.lane, currentSource: lane.currentSource, coverageRoot: lane.coverageRoot })),
    ...facts.laneFailureObservations.map(observation => Object.freeze({
      kind: "failure" as const,
      lane: observation.lane,
      currentSource: observation.currentSource,
      outcome: observation.outcome,
      reasonCode: observation.reasonCode,
    })),
  ].sort((left, right) => left.lane === right.lane ? 0 : left.lane === "blockscan" ? -1 : 1);
  if (new Set(publishedLaneObservations.map(value => value.lane)).size !== publishedLaneObservations.length) {
    throw new TypeError("producer head facts publish more than one terminal observation for a lane");
  }
  const currentSourceLogicalFacts = currentSourcePhysicalFacts === null
    ? Object.freeze(publishedLaneObservations.map(observation => observation.currentSource))
    : currentSourcePhysicalFacts.logicalScopeFacts;
  const laneTerminalFacts = Object.freeze(currentSourceLogicalFacts.map(current => {
    const observation = publishedLaneObservations.find(candidate => candidate.lane === current.lane
      && candidate.currentSource.correlationId === current.correlationId);
    if (observation === undefined) throw new TypeError(`producerHeadFacts.${current.lane} lacks an owner-issued terminal observation`);
    if (observation.kind === "coverage") {
      return Object.freeze({
        kind: "coverage" as const,
        lane: current.lane,
        correlationId: current.correlationId,
        coverageRoot: nonZeroHash(observation.coverageRoot, `producerHeadFacts.${current.lane}.coverageRoot`),
      });
    }
    return Object.freeze({
      kind: "failure" as const,
      lane: current.lane,
      correlationId: current.correlationId,
      outcome: observation.outcome,
      reasonCode: observation.reasonCode,
    });
  }));
  const laneTerminalFactsRoot = hashDomain("aloha/searcher-production-evidence-lane-terminal-facts-root/v1", laneTerminalFacts);
  const currentSourcePhysicalFactsRoot = currentSourcePhysicalFacts === null ? null : hashDomain("aloha/current-source-rpc-physical-facts/v1", currentSourcePhysicalFacts);
  const coarseTimingFacts = Object.freeze(facts.laneFacts.flatMap(lane => {
    const timing = readIssuedProducerLaneCoarseTimingV1(lane);
    return timing === null ? [] : [timing];
  }));
  const coarseTimingFactsRoot = hashDomain("aloha/route-coarse-timing-facts-set/v1", coarseTimingFacts);
  const accountedByLane = new Map(accountedLaneDrafts.map(value => [value.lane.lane, value] as const));
  const routeDenominators = Object.freeze(facts.laneFacts
    .map(lane => {
      const accounted = accountedByLane.get(lane.lane);
      if (accounted !== undefined) return deepFreeze({
        admissionId,
        headFactsRoot: factsRoot,
        headHash: facts.headHash,
        lane: lane.lane,
        correlationId: lane.correlationId,
        coverageRoot: lane.coverageRoot,
        denominatorKind: "accounted" as const,
        plannerCandidateIdentity: accounted.plannerCandidateIdentity,
        accounting: accounted.upstreamAccounting,
      });
      const noInput = readIssuedProducerNoInputLaneDenominatorV1(lane);
      if (noInput === null) throw new TypeError("producer completed lane lacks accounted or no-input denominator evidence");
      return deepFreeze({
        admissionId,
        headFactsRoot: factsRoot,
        headHash: facts.headHash,
        lane: lane.lane,
        correlationId: lane.correlationId,
        coverageRoot: lane.coverageRoot,
        denominatorKind: "no-input" as const,
        pendingSnapshot: noInput.pendingSnapshot,
        absenceEvidenceHash: noInput.absenceEvidenceHash,
        terminalLineageHash: noInput.terminalLineageHash,
        currentSource: noInput.currentSource,
      });
    })
    .sort((left, right) => left.lane === right.lane ? 0 : left.lane === "blockscan" ? -1 : 1));
  if (facts.complete && (routeDenominators.length !== 2
    || routeDenominators[0]?.lane !== "blockscan"
    || routeDenominators[1]?.lane !== "backrun")) {
    throw new TypeError("producer complete head lacks the exact two-lane route denominator union");
  }
  return Object.freeze({
    coverage: deepFreeze({
      admissionId,
      headFactsRoot: factsRoot,
      headHash: facts.headHash,
      sourceCoverageRoot: facts.sourceCoverageRoot,
      currentSourceLogicalFacts,
      currentSourcePhysicalFacts,
      currentSourcePhysicalFactsRoot,
      coarseTimingFacts,
      coarseTimingFactsRoot,
      laneTerminalFacts,
      laneTerminalFactsRoot,
      complete: facts.complete,
    }),
    routeDenominators,
    candidates: Object.freeze({
      admissionId,
      headFactsRoot: factsRoot,
      headHash: facts.headHash,
      candidateRefs,
      candidateTerminalObservations,
      laneDenominators,
      candidateTerminalObservationSetRoot: hashDomain("aloha/performance-candidate-terminal-observation-set-root/v1", laneDenominators.map(value => value.observationSetRoot)),
    }),
  });
}

function performanceCandidateSetRoot(candidateRefs: readonly Hash[]): Hash {
  const sorted = sortedUniqueHashes(candidateRefs, "performanceCandidateSet.candidateRefs");
  return hashDomain("aloha/performance-candidate-set-root/v1", sorted);
}

function passedCandidateObservations(facts: ProducerHeadFactsV1): readonly ProducerCandidateTerminalObservationV1[] {
  return Object.freeze(facts.laneFacts.flatMap(lane => readIssuedProducerLaneCandidateTerminalObservationsV1(lane))
    .filter(observation => observation.performanceOutcome === "verified"));
}

function incompletePerformanceFacts(
  admissionId: Hash,
  terminal: ProducerTerminalV1,
  terminalMonotonicNs: string,
  facts: ProducerHeadFactsV1 | null,
  runtimeFacts: JoinedRuntimePerformanceFactsV1 | null,
  sixStepFacts: JoinedSixStepPerformanceFactsV1 | null = null,
): IncompletePerformanceFactsPayloadV1 {
  const reasons: MissingPerformanceFactReasonV1[] = [];
  const passed = facts === null ? [] : passedCandidateObservations(facts);
  if (facts === null) reasons.push("head-facts-missing");
  else {
    if (!facts.complete) reasons.push("head-facts-incomplete");
    if (passed.length > 0 && runtimeFacts?.selectedSchedulerCompletion === null) {
      reasons.push("candidate-terminal-capability-missing");
    }
  }
  if (runtimeFacts === null) reasons.push("producer-terminal-timing-capability-missing", "scheduler-queue-permit-capability-missing", "resource-sample-capability-missing");
  else if (passed.length > 0 && runtimeFacts.selectedSchedulerCompletion === null) reasons.push("scheduler-queue-permit-capability-missing");
  if (passed.length > 0 && sixStepFacts === null) reasons.push("six-step-completion-capability-missing");
  const projection = facts === null ? null : projectionFromFacts(admissionId, facts);
  return Object.freeze({
    admissionId,
    terminalBindingRoot: terminalBindingRoot(terminal, facts),
    terminalId: terminal.terminalId,
    terminalMonotonicNs,
    headHash: terminal.head.hash,
    sourceCoverageRoot: projection?.coverage.sourceCoverageRoot ?? null,
    candidateSetRoot: projection === null ? null : performanceCandidateSetRoot(projection.candidates.candidateRefs),
    candidateCount: projection?.candidates.candidateRefs.length.toString() ?? null,
    runtimeFacts,
    sixStepFacts,
    factStatus: "incomplete" as const,
    missingFactReasons: Object.freeze([...new Set(reasons)].sort()) as readonly MissingPerformanceFactReasonV1[],
  });
}

function completePerformanceFacts(
  admissionId: Hash,
  terminal: ProducerTerminalV1,
  terminalMonotonicNs: string,
  facts: ProducerHeadFactsV1,
  runtimeFacts: JoinedRuntimePerformanceFactsV1,
  sixStepFacts: JoinedSixStepPerformanceFactsV1 | null,
): CompletePerformanceFactsPayloadV1 {
  const projection = projectionFromFacts(admissionId, facts);
  const passed = projection.candidates.candidateTerminalObservations.filter(observation => observation.performanceOutcome === "verified");
  if (!facts.complete || passed.length > 1
    || (passed.length === 0 && (runtimeFacts.selectedSchedulerCompletion !== null || runtimeFacts.producerSchedulerJoin !== null || sixStepFacts !== null))
    || (passed.length === 1 && (runtimeFacts.selectedSchedulerCompletion === null || runtimeFacts.producerSchedulerJoin === null || sixStepFacts === null))) {
    throw new TypeError("production evidence complete-facts prerequisites are incomplete");
  }
  return deepFreeze({
    admissionId,
    terminalBindingRoot: terminalBindingRoot(terminal, facts),
    terminalId: terminal.terminalId,
    terminalMonotonicNs,
    headHash: terminal.head.hash,
    sourceCoverageRoot: projection.coverage.sourceCoverageRoot,
    candidateSetRoot: performanceCandidateSetRoot(projection.candidates.candidateRefs),
    candidateCount: projection.candidates.candidateRefs.length.toString(),
    runtimeFacts,
    sixStepFacts,
    factStatus: "complete" as const,
  });
}

function processLogAnchorHash(anchor: RuntimeAnchorReceiptV1): Hash {
  return hashProcessLogAnchor(performanceProcessLogAnchor(anchor));
}

class ProductionEvidenceOwnerStateV1 {
  readonly #store: SQLiteDurableStore;
  readonly #release: SearcherProductionEvidenceReleaseV1;
  readonly #runtimeAnchor: RuntimeAnchorReceiptV1;
  readonly #handles = new WeakMap<object, EligibleHeadHandleStateV1>();
  readonly #admissionIds = new Set<Hash>();
  readonly #eligiblePayloads = new Map<Hash, EligibleHeadPayloadV1>();
  readonly #eligibleEventIds = new Map<Hash, Hash>();
  readonly #activeAdmissionByOrdinal = new Map<string, Hash>();
  readonly #terminalIds = new Set<Hash>();
  readonly #performanceTerminalBindings = new Map<Hash, Hash>();
  readonly #performanceTerminalAdmissions = new Map<Hash, Hash>();
  readonly #performanceTerminalMonotonicNs = new Map<Hash, string>();
  readonly #producerTerminalByAdmission = new Map<Hash, Hash>();
  readonly #producerTerminalEventByAdmission = new Map<Hash, Hash>();
  readonly #servingByAdmission = new Map<Hash, ServingBindingV1>();
  readonly #currentProcessHeadTerminalById = new Map<Hash, ProducerHeadTerminalCapabilityV1>();
  readonly #sixStepPerformanceAppendByTerminal = new WeakMap<object, SearcherProductionSixStepPerformanceAppendCapabilityV1>();
  readonly #sixStepCompleteAppendByTerminal = new WeakMap<object, SearcherProductionSixStepCompleteAppendCapabilityV1>();
  readonly #sixStepCompleteAppends: SearcherProductionSixStepCompleteAppendCapabilityV1[] = [];
  #performanceRuntime: RuntimeReleasePerformanceRuntimeServiceV1 | null = null;
  readonly #economicSafetyAuthority: EconomicSafetyEvidenceAuthorityExpectationV1;
  readonly #strategyExpectation: RuntimeReleaseStrategyEvidenceExpectationV1 | null;
  #performanceWindowBasis: RuntimeReleasePerformanceWindowFactsV1 | null = null;
  #performanceCommitment: PerformanceWindowCommitmentV1 | null = null;
  #performanceWindow: RuntimeReleasePerformanceWindowCapabilityV1 | null = null;
  #processLogAnchorHash: Hash | null = null;
  #performanceWindowId: Hash | null = null;
  #startup: StartupRuntimeV1 | null = null;
  #serving: ServingBindingV1 | null = null;
  #ports: SearcherProductionEvidencePortsV1 | null = null;
  #finalDurableWindowBinding: FinalDurableWindowBindingV1 | null = null;
  #finalDurableWindowCapability: FinalDurableWindowCapabilityV1 | null = null;
  #terminalPhaseInvalidFact: TerminalPhaseInvalidFactV1 | null = null;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  readonly #nextAppendSequenceByNamespace = new Map<ProductionEvidenceNamespaceV1, string>();

  constructor(input: SearcherProductionEvidenceOwnerInputV1) {
    assertPlainObject(input, "searcherProductionEvidenceOwner");
    const inputKeys = ["databasePath", "release", "runtimeAnchor", "economicSafety"];
    if (Object.prototype.hasOwnProperty.call(input, "strategyRuntime")) inputKeys.push("strategyRuntime");
    assertExactKeys(input, inputKeys, "searcherProductionEvidenceOwner");
    if (typeof input.databasePath !== "string" || !input.databasePath.startsWith("/")) throw new TypeError("production evidence database path must be absolute");
    this.#release = exactRelease(input.release, "searcherProductionEvidenceOwner.release");
    this.#runtimeAnchor = exactRuntimeAnchor(input.runtimeAnchor, "searcherProductionEvidenceOwner.runtimeAnchor");
    if (!sameRelease(this.#release, runtimeAnchorRelease(this.#runtimeAnchor))) throw new TypeError("production evidence runtime anchor release mismatch");
    assertIssuedEconomicSafetyFinalizationServiceV1(input.economicSafety);
    this.#economicSafetyAuthority = input.economicSafety.binding();
    if (this.#economicSafetyAuthority.releaseProvenanceHash !== this.#release.releaseProvenanceHash) {
      throw new TypeError("production evidence economic-safety release mismatch");
    }
    if (input.strategyRuntime === undefined) this.#strategyExpectation = null;
    else {
      assertIssuedRuntimeReleaseStrategyRuntimeService(input.strategyRuntime);
      this.#strategyExpectation = input.strategyRuntime.readEvidenceExpectation();
      if (this.#strategyExpectation.releaseProvenanceHash !== this.#release.releaseProvenanceHash) {
        throw new TypeError("production evidence Strategy qualification release mismatch");
      }
    }
    this.#store = createSqliteDurableStore(input.databasePath);
    try {
      this.#store.bindStoreRole(EVIDENCE_ROLE);
      this.replay();
    } catch (error) {
      this.#store.close();
      throw error;
    }
  }

  bindServing(
    startup: StartupRuntimeV1,
    performanceRuntime?: RuntimeReleasePerformanceRuntimeServiceV1,
  ): SearcherProductionEvidencePortsV1 {
    this.#assertOpen();
    assertIssuedStartupRuntime(startup);
    if (this.#ports !== null || this.#serving !== null) throw new TypeError("production evidence owner is already bound to a serving generation");
    const startupGeneration = startup.readActiveGeneration();
    if (startup.releaseBindingId !== this.#release.bindingId || startup.candidateReleaseCommit !== this.#release.candidateReleaseCommit || startupGeneration.releaseProvenanceHash !== this.#release.releaseProvenanceHash) throw new TypeError("production evidence serving release mismatch");
    const serving = servingFromStartupGeneration(startup);
    this.#startup = startup;
    this.#serving = serving;
    this.replay();
    if (performanceRuntime !== undefined) {
      assertIssuedRuntimeReleasePerformanceRuntimeService(performanceRuntime);
      this.#performanceWindowBasis = performanceRuntime.readWindowBasis();
      this.#performanceRuntime = performanceRuntime;
    }
    const performance = issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead: input => this.#acceptEligibleHead(input),
      readEligibleHeadBinding: eligibleHead => {
        if (eligibleHead === null || typeof eligibleHead !== "object") {
          throw new TypeError("production evidence eligible head handle is not owner-issued");
        }
        const state = this.#handles.get(eligibleHead);
        if (state === undefined) throw new TypeError("production evidence eligible head handle is not owner-issued");
        return Object.freeze({
          admissionId: state.payload.admissionId,
          ordinal: state.ordinal,
          headHash: state.payload.head.hash,
          revision: state.payload.revision,
        });
      },
      bindEligibleHeadSession: input => this.#bindEligibleHeadSession(input.eligibleHead, input.session),
      bindEligibleHeadFacts: input => this.#bindEligibleHeadFacts(input.eligibleHead, input.facts),
      sealHeadTerminal: input => this.#sealPerformance(input.eligibleHead, input.terminal),
    });
    const terminal = issueProducerTerminalPortV1({ appendTerminal: input => this.#appendProducerTerminal(input.terminal) });
    const window = Object.freeze({
      isComplete: () => this.#finalDurableWindowBinding !== null || (this.#performanceRuntime !== null
        && BigInt([...this.#activeAdmissionByOrdinal.values()].filter(admissionId => this.#producerTerminalByAdmission.has(admissionId)).length) === BigInt(PERFORMANCE_TARGET_COUNT)),
      readFinalDurableWindow: () => this.#readFinalDurableWindow(),
      readFinalDurableWindowBinding: (capability: FinalDurableWindowCapabilityV1) => this.#readFinalDurableWindowBinding(capability),
      readCurrentProcessHeadTerminal: (capability: FinalDurableWindowCapabilityV1) => {
        const completed = this.#readFinalDurableWindowBinding(capability);
        if (!sameExact(completed.runtimeAnchor, this.#runtimeAnchor)) return null;
        const terminal = this.#currentProcessHeadTerminalById.get(completed.terminalId) ?? null;
        if (terminal !== null
          && readIssuedProducerHeadTerminalCapabilityV1(terminal).terminal.terminalId !== completed.terminalId) {
          throw new TypeError("final durable window current-process Producer terminal mismatch");
        }
        return terminal;
      },
      isCurrentProcessWindow: (capability: FinalDurableWindowCapabilityV1) => {
        const completed = this.#readFinalDurableWindowBinding(capability);
        return sameExact(completed.runtimeAnchor, this.#runtimeAnchor);
      },
      appendInvalid: (invalidInput: Readonly<{
        readonly completedWindow: FinalDurableWindowCapabilityV1;
        readonly reasonCode: TerminalPhaseInvalidReasonV1;
        readonly observed: CanonicalHeadObservationV1 | null;
      }>) => this.#appendTerminalPhaseInvalid(invalidInput),
      readInvalid: () => this.#terminalPhaseInvalidFact,
    });
    const sixStep = Object.freeze({
      readCompleteAppend: (terminalCapability: ProducerHeadTerminalCapabilityV1) => {
        readIssuedProducerHeadTerminalCapabilityV1(terminalCapability);
        return this.#sixStepCompleteAppendByTerminal.get(terminalCapability) ?? null;
      },
      readWindowSelection: (finalDurableWindow: FinalDurableWindowCapabilityV1) => {
        this.#readFinalDurableWindowBinding(finalDurableWindow);
        const activeCompleteAppends = this.#sixStepCompleteAppends.filter(capability => {
          const material = readSearcherProductionSixStepCompleteAppendMaterialV1(capability);
          return this.#activeAdmissionByOrdinal.get(material.ordinal) === material.admissionId;
        });
        return issueSearcherProductionSixStepWindowSelectionV1({
          finalDurableWindow,
          completeAppends: Object.freeze(activeCompleteAppends),
        });
      },
    });
    const ports: SearcherProductionEvidencePortsV1 = Object.freeze({ performance, terminal, window, sixStep });
    portsIssued.add(ports);
    this.#ports = ports;
    return ports;
  }

  replay(): SearcherProductionEvidenceReplayV1 {
    this.#assertOpen();
    const allEvents: ProductionEvidenceEventV1[] = [];
    const nextAppendSequenceByNamespace = new Map<ProductionEvidenceNamespaceV1, string>();
    const rawByEventId = new Map<Hash, DurableAppendRecord>();
    for (const namespace of Object.values(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES)) {
      const records = this.#store.readAppendLog(namespace);
      nextAppendSequenceByNamespace.set(namespace, records.length.toString());
      const events = Object.freeze(records.map(record => {
        const event = exactEvent(record, this.#store);
        rawByEventId.set(event.eventId, record);
        return event;
      }));
      for (const event of events) if (!sameRelease(event.release, this.#release)) throw new TypeError("production evidence release changed across restart");
      allEvents.push(...events);
    }
    const windowBases = new Map<Hash, ProductionEvidenceEventV1>();
    const windowCommitments = new Map<Hash, ProductionEvidenceEventV1>();
    const eligible = new Map<Hash, ProductionEvidenceEventV1>();
    const replacements: ProductionEvidenceEventV1[] = [];
    const coverage = new Map<Hash, ProductionEvidenceEventV1>();
    const routeDenominators = new Map<string, ProductionEvidenceEventV1>();
    const candidates = new Map<Hash, ProductionEvidenceEventV1>();
    const performance = new Map<Hash, ProductionEvidenceEventV1>();
    const terminals = new Map<Hash, ProductionEvidenceEventV1>();
    const terminalPhaseInvalid: ProductionEvidenceEventV1[] = [];
    for (const event of allEvents) {
      if (event.eventType === "performance-window-basis") {
        const partitionId = evidencePartitionId(event);
        if (windowBases.has(partitionId)) throw new TypeError("production evidence duplicate performance window basis");
        windowBases.set(partitionId, event);
      } else if (event.eventType === "performance-window-commitment") {
        const partitionId = evidencePartitionId(event);
        if (windowCommitments.has(partitionId)) throw new TypeError("production evidence duplicate performance window commitment");
        windowCommitments.set(partitionId, event);
      } else if (event.eventType === "eligible-head" || event.eventType === "orphan-replacement") {
        const payload = event.payload as EligibleHeadPayloadV1;
        if (eligible.has(payload.admissionId)) throw new TypeError("production evidence duplicate eligible admission");
        eligible.set(payload.admissionId, event);
        if (event.eventType === "orphan-replacement") replacements.push(event);
      } else if (event.eventType === "head-coverage") {
        const payload = event.payload as HeadCoveragePayloadV1;
        if (!eligible.has(payload.admissionId) || coverage.has(payload.admissionId)) throw new TypeError("production evidence orphan/duplicate coverage");
        coverage.set(payload.admissionId, event);
      } else if (event.eventType === "route-denominator") {
        const payload = event.payload as RouteDenominatorPayloadV1;
        const key = `${payload.admissionId}:${payload.lane}`;
        if (!eligible.has(payload.admissionId) || routeDenominators.has(key)) throw new TypeError("production evidence orphan/duplicate route denominator");
        routeDenominators.set(key, event);
      } else if (event.eventType === "candidate-set") {
        const payload = event.payload as CandidateSetPayloadV1;
        if (!eligible.has(payload.admissionId) || candidates.has(payload.admissionId)) throw new TypeError("production evidence orphan/duplicate candidate set");
        candidates.set(payload.admissionId, event);
      } else if (event.eventType === "performance-facts-incomplete" || event.eventType === "performance-facts-complete") {
        const payload = event.payload as PerformancePayloadV1;
        if (!eligible.has(payload.admissionId) || performance.has(payload.admissionId)) throw new TypeError("production evidence orphan/duplicate performance terminal");
        performance.set(payload.admissionId, event);
      } else if (event.eventType === "producer-terminal") {
        const payload = event.payload as ProducerTerminalPayloadV1;
        if (terminals.has(payload.terminal.terminalId)) throw new TypeError("production evidence duplicate producer terminal");
        terminals.set(payload.terminal.terminalId, event);
      } else if (event.eventType === "terminal-phase-invalid") {
        terminalPhaseInvalid.push(event);
      }
    }
    for (const [partitionId, commitmentEvent] of windowCommitments) {
      const basisEvent = windowBases.get(partitionId);
      if (basisEvent === undefined) throw new TypeError("production evidence performance window commitment lacks its durable basis");
      const basis = basisEvent.payload as PerformanceWindowBasisPayloadV1;
      const commitment = commitmentEvent.payload as PerformanceWindowCommitmentV1;
      const rawBasis = rawByEventId.get(basisEvent.eventId);
      if (rawBasis === undefined) throw new TypeError("production evidence performance window basis append receipt is missing");
      const appendRecordId = performanceWindowBasisAppendRecordId(rawBasis);
      const contextBindingId = performanceWindowBasisContextBindingId({
        release: basisEvent.release,
        runtimeAnchor: basisEvent.runtimeAnchor,
        basisId: basis.basisId,
        appendRecordId,
        append: rawBasis,
      });
      if (commitment.windowStartAnchor.hash !== basis.windowStartAnchor.hash
        || commitment.windowStartAnchor.number !== basis.windowStartAnchor.number
        || commitment.windowStartAnchor.stateRoot !== basis.windowStartAnchor.stateRoot
        || commitment.eligibilityRuleHash !== basis.eligibilityRuleHash
        || commitment.performanceProfileHash !== basis.profile.profileHash
        || commitment.processLogAnchor.commitSha !== basis.processLogAnchor.commitSha
        || hashProcessLogAnchor(commitment.processLogAnchor) !== hashProcessLogAnchor(basis.processLogAnchor)
        || basis.releaseBindingId !== basisEvent.release.bindingId
        || basis.releaseProvenanceHash !== basisEvent.release.releaseProvenanceHash
        || basis.runtimeAnchorHash !== performanceRuntimeAnchorHash(basisEvent.runtimeAnchor)
        || commitment.releaseBindingId !== basis.releaseBindingId
        || commitment.releaseProvenanceHash !== basis.releaseProvenanceHash
        || commitment.runtimeAnchorHash !== basis.runtimeAnchorHash
        || commitment.providerRoot !== basis.providerRoot
        || commitment.hardwareProfileRoot !== basis.hardwareProfile.profileRoot
        || commitment.targetCount !== basis.targetCount
        || commitment.committedMonotonicNs !== basis.committedMonotonicNs
        || commitment.commitAppendRecordId !== appendRecordId
        || commitment.commitContextBindingId !== contextBindingId
        || BigInt(commitmentEvent.sequence) !== BigInt(basisEvent.sequence) + 1n) {
        throw new TypeError("production evidence performance window commitment/basis mismatch");
      }
    }
    const activeAdmissionsByPartition = new Map<Hash, Map<string, ProductionEvidenceEventV1>>();
    for (const [partitionId, basisEvent] of windowBases) {
      if (!windowCommitments.has(partitionId)) throw new TypeError("production evidence performance window basis lacks its commitment");
      const commitmentEvent = windowCommitments.get(partitionId)!;
      const commitment = commitmentEvent.payload as PerformanceWindowCommitmentV1;
      const partitionEligible = [...eligible.values()]
        .filter(event => evidencePartitionId(event) === partitionId)
        .sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1);
      const firstEvent = partitionEligible[0];
      const first = firstEvent?.payload as EligibleHeadPayloadV1 | undefined;
      if (first !== undefined && (BigInt(firstEvent!.sequence) !== BigInt(commitmentEvent.sequence) + 1n
        || first.windowId !== commitment.windowId
        || first.ordinal !== "1"
        || first.revision !== "0"
        || first.head.hash !== commitment.windowStartAnchor.hash
        || first.head.number !== commitment.windowStartAnchor.number
        || first.head.stateRoot !== commitment.windowStartAnchor.stateRoot
        || BigInt(first.acceptedMonotonicNs) <= BigInt(commitment.committedMonotonicNs))) {
        throw new TypeError("production evidence first eligible head does not follow the committed performance window");
      }
      const activeByOrdinal = new Map<string, ProductionEvidenceEventV1>();
      let nextOrdinal = 1n;
      for (const [index, admissionEvent] of partitionEligible.entries()) {
        if (index > 0 && BigInt(admissionEvent.sequence) !== BigInt(partitionEligible[index - 1]!.sequence) + 1n) {
          throw new TypeError("production evidence eligible head sequence is not contiguous after the committed window");
        }
        const payload = admissionEvent.payload as EligibleHeadPayloadV1;
        if (admissionEvent.eventType === "eligible-head") {
          if (payload.revision !== "0" || BigInt(payload.ordinal) !== nextOrdinal || nextOrdinal > BigInt(PERFORMANCE_TARGET_COUNT)) {
            throw new TypeError("production evidence fresh eligible ordinal/revision is invalid");
          }
          if (nextOrdinal > 1n) {
            const previous = activeByOrdinal.get((nextOrdinal - 1n).toString())?.payload as EligibleHeadPayloadV1 | undefined;
            if (previous === undefined || payload.head.chainId !== previous.head.chainId
              || BigInt(payload.head.number) !== BigInt(previous.head.number) + 1n
              || payload.head.parentHash !== previous.head.hash) {
              throw new TypeError("production evidence eligible canonical continuity mismatch");
            }
          }
          activeByOrdinal.set(payload.ordinal, admissionEvent);
          nextOrdinal += 1n;
          continue;
        }
        const replacement = admissionEvent.payload as OrphanReplacementPayloadV1;
        const lineage = replacement.lineage;
        const orphanEvent = eligible.get(lineage.orphanAdmissionId);
        const orphanPayload = orphanEvent?.payload as EligibleHeadPayloadV1 | undefined;
        const orphanPerformance = performance.get(lineage.orphanAdmissionId)?.payload as PerformancePayloadV1 | undefined;
        const orphanTerminalEvent = terminals.get(lineage.orphanProducerTerminalId);
        const orphanTerminal = orphanTerminalEvent?.payload as ProducerTerminalPayloadV1 | undefined;
        if (BigInt(lineage.ordinal) !== nextOrdinal - 1n
          || activeByOrdinal.get(lineage.ordinal) !== orphanEvent
          || orphanEvent === undefined
          || orphanPayload === undefined
          || orphanEvent.eventId !== lineage.orphanEligibleEventId
          || !sameHead(orphanPayload.head, lineage.orphanCanonicalHead)
          || orphanPayload.ordinal !== lineage.ordinal
          || orphanPayload.revision !== lineage.orphanRevision
          || orphanPayload.acceptedMonotonicNs !== lineage.orphanAcceptedMonotonicNs
          || orphanPerformance?.terminalId !== lineage.orphanProducerTerminalId
          || orphanPerformance.terminalMonotonicNs !== lineage.orphanTerminalMonotonicNs
          || orphanTerminalEvent?.eventId !== lineage.orphanProducerTerminalEventId
          || orphanTerminal?.terminal.terminalId !== lineage.orphanProducerTerminalId
          || orphanTerminal.terminal.ordinal !== lineage.ordinal
          || orphanTerminal.terminal.revision !== lineage.orphanRevision
          || !sameHead(orphanTerminal.terminal.head, lineage.orphanCanonicalHead)) {
          throw new TypeError("production evidence orphan replacement lineage is not bound to the active durable terminal");
        }
        if (BigInt(lineage.ordinal) > 1n) {
          const previous = activeByOrdinal.get((BigInt(lineage.ordinal) - 1n).toString())?.payload as EligibleHeadPayloadV1 | undefined;
          if (previous === undefined || replacement.head.parentHash !== previous.head.hash) {
            throw new TypeError("production evidence replacement breaks canonical parent continuity");
          }
        }
        activeByOrdinal.set(lineage.ordinal, admissionEvent);
      }
      activeAdmissionsByPartition.set(partitionId, activeByOrdinal);
      void basisEvent;
    }
    for (const event of eligible.values()) {
      const payload = event.payload as EligibleHeadPayloadV1;
      const commitment = windowCommitments.get(evidencePartitionId(event))?.payload as PerformanceWindowCommitmentV1 | undefined;
      if ((payload.windowId === null) !== (commitment === undefined)
        || (commitment !== undefined && payload.windowId !== commitment.windowId)) {
        throw new TypeError("production evidence eligible head performance window mismatch");
      }
    }
    for (const [admissionId, coverageEvent] of coverage) {
      const eligibleEvent = eligible.get(admissionId)!;
      const coveragePayload = coverageEvent.payload as HeadCoveragePayloadV1;
      const eligiblePayload = eligibleEvent.payload as EligibleHeadPayloadV1;
      if (coverageEvent.serving === null
        || coveragePayload.headHash !== eligiblePayload.head.hash
        || !sameExact(coverageEvent.runtimeAnchor, eligibleEvent.runtimeAnchor)) throw new TypeError("production evidence coverage context splice");
      for (const facts of coveragePayload.currentSourceLogicalFacts) {
        if (facts.source.chainId !== eligiblePayload.head.chainId
          || facts.source.number !== eligiblePayload.head.number
          || facts.source.hash !== eligiblePayload.head.hash
          || facts.source.stateRoot !== eligiblePayload.head.stateRoot) {
          throw new TypeError("production evidence current-source logical facts/head splice");
        }
      }
      const physical = coveragePayload.currentSourcePhysicalFacts;
      if (physical !== null && (physical.source.chainId !== eligiblePayload.head.chainId
        || physical.source.number !== eligiblePayload.head.number
        || physical.source.hash !== eligiblePayload.head.hash
        || physical.source.stateRoot !== eligiblePayload.head.stateRoot)) {
        throw new TypeError("production evidence current-source physical facts/head splice");
      }
      for (const timing of coveragePayload.coarseTimingFacts) {
        if (timing.generationId !== coverageEvent.serving.generationId
          || timing.graphRoot !== coverageEvent.serving.graphRoot
          || timing.source.chainId !== eligiblePayload.head.chainId
          || timing.source.number !== eligiblePayload.head.number
          || timing.source.hash !== eligiblePayload.head.hash
          || timing.source.stateRoot !== eligiblePayload.head.stateRoot) {
          throw new TypeError("production evidence coarse timing context splice");
        }
        if (physical !== null && (BigInt(timing.startedMonotonicNs) < BigInt(physical.openedMonotonicNs)
          || BigInt(timing.finishedMonotonicNs) > BigInt(physical.closedMonotonicNs))) {
          throw new TypeError("production evidence coarse timing is outside current-source interval");
        }
      }
    }
    for (const [admissionId, candidateEvent] of candidates) {
      const eligibleEvent = eligible.get(admissionId)!;
      const candidatePayload = candidateEvent.payload as CandidateSetPayloadV1;
      const eligiblePayload = eligibleEvent.payload as EligibleHeadPayloadV1;
      const coverageEvent = coverage.get(admissionId);
      if (candidateEvent.serving === null
        || candidatePayload.headHash !== eligiblePayload.head.hash
        || coverageEvent === undefined
        || !sameExact(candidateEvent.serving, coverageEvent.serving)
        || !sameExact(candidateEvent.runtimeAnchor, eligibleEvent.runtimeAnchor)) throw new TypeError("production evidence candidate context splice");
      const coveragePayload = coverageEvent.payload as HeadCoveragePayloadV1;
      if (coveragePayload === undefined || coveragePayload.headFactsRoot !== candidatePayload.headFactsRoot) throw new TypeError("production evidence candidate denominator lacks head coverage");
      const admissionDenominatorEvents = [...routeDenominators.values()]
        .filter(event => (event.payload as RouteDenominatorPayloadV1).admissionId === admissionId)
        .sort((left, right) => {
          const leftLane = (left.payload as RouteDenominatorPayloadV1).lane;
          const rightLane = (right.payload as RouteDenominatorPayloadV1).lane;
          return leftLane === rightLane ? 0 : leftLane === "blockscan" ? -1 : 1;
        });
      const admissionDenominators = admissionDenominatorEvents.map(event => event.payload as RouteDenominatorPayloadV1);
      const coverageLaneUniverse = coveragePayload.laneTerminalFacts.filter(value => value.kind === "coverage");
      if (admissionDenominators.length !== coverageLaneUniverse.length
        || coverageLaneUniverse.some(lane => !admissionDenominators.some(denominator => denominator.lane === lane.lane
          && denominator.correlationId === lane.correlationId
          && denominator.coverageRoot === lane.coverageRoot))
        || (coveragePayload.complete && (admissionDenominators.length !== 2
          || admissionDenominators[0]?.lane !== "blockscan"
          || admissionDenominators[1]?.lane !== "backrun"))) {
        throw new TypeError("production evidence route denominator lane set mismatch");
      }
      const accountedDenominators = admissionDenominators.filter((value): value is AccountedRouteDenominatorPayloadV1 => value.denominatorKind === "accounted");
      if (accountedDenominators.length !== candidatePayload.laneDenominators.length
        || accountedDenominators.length !== coveragePayload.coarseTimingFacts.length
        || coveragePayload.coarseTimingFacts.some(coarse => !accountedDenominators.some(denominator => denominator.correlationId === coarse.correlationId
          && denominator.accounting.planningProblemHash === coarse.planningProblemHash
          && denominator.accounting.enumerationRoot === coarse.enumerationRoot
          && denominator.accounting.admissionPolicyHash === coarse.admissionPolicyHash))) {
        throw new TypeError("production evidence accounted route denominator subset mismatch");
      }
      if (admissionDenominatorEvents.some(event => !sameExact(event.serving, candidateEvent.serving)
        || !sameExact(event.runtimeAnchor, candidateEvent.runtimeAnchor))) {
        throw new TypeError("production evidence route denominator context splice");
      }
      for (const denominator of candidatePayload.laneDenominators) {
        const laneTerminal = coveragePayload.laneTerminalFacts.find(value => value.lane === denominator.lane);
        const routeDenominator = accountedDenominators.find(value => value.lane === denominator.lane);
        const observations = candidatePayload.candidateTerminalObservations.filter(value => value.lane === denominator.lane);
        if (laneTerminal === undefined || laneTerminal.kind !== "coverage") {
          throw new TypeError("production evidence candidate denominator lacks lane coverage");
        }
        if (routeDenominator === undefined) {
          throw new TypeError("production evidence candidate denominator lacks accounted route denominator");
        }
        if (routeDenominator.headFactsRoot !== candidatePayload.headFactsRoot) {
          throw new TypeError("production evidence candidate denominator head-facts root splice");
        }
        if (routeDenominator.headHash !== candidatePayload.headHash) {
          throw new TypeError("production evidence candidate denominator head hash splice");
        }
        if (routeDenominator.correlationId !== denominator.correlationId) {
          throw new TypeError("production evidence candidate denominator correlation splice");
        }
        if (routeDenominator.coverageRoot !== denominator.coverageRoot) {
          throw new TypeError("production evidence candidate denominator route coverage root splice");
        }
        if (routeDenominator.accounting.root !== denominator.accountingRoot) {
          throw new TypeError("production evidence candidate denominator accounting root splice");
        }
        if (routeDenominator.accounting.entries.length !== observations.length) {
          throw new TypeError("production evidence candidate denominator observation count splice");
        }
        for (const [index, entry] of routeDenominator.accounting.entries.entries()) {
          const observation = observations[index]!;
          if (entry.candidateId !== observation.candidateId) throw new TypeError("production evidence candidate denominator candidate id splice");
          if (observation.planningProblemHash !== routeDenominator.accounting.planningProblemHash) throw new TypeError("production evidence candidate denominator planning problem splice");
          if (observation.enumerationRoot !== routeDenominator.accounting.enumerationRoot) throw new TypeError("production evidence candidate denominator enumeration splice");
          if (observation.admissionPolicyHash !== routeDenominator.accounting.admissionPolicyHash) throw new TypeError("production evidence candidate denominator admission policy splice");
          if (entry.disposition !== observation.disposition) throw new TypeError("production evidence candidate denominator disposition splice");
          validateProductionCandidateEvidenceJoinV1(entry, observation);
          if (entry.routeHash !== observation.routeHash) throw new TypeError("production evidence candidate denominator route hash splice");
          if (entry.reasonCode !== observation.reasonCode) throw new TypeError("production evidence candidate denominator reason code splice");
          if (!sameExact(entry.policyTerminal, observation.policyTerminal)) throw new TypeError("production evidence candidate denominator policy terminal splice");
        }
        if (laneTerminal.correlationId !== denominator.correlationId) {
          throw new TypeError("production evidence candidate coverage correlation splice");
        }
        if (laneTerminal.coverageRoot !== denominator.coverageRoot) {
          throw new TypeError("production evidence candidate lane coverage root splice");
        }
      }
      for (const denominator of admissionDenominators.filter((value): value is NoInputRouteDenominatorPayloadV1 => value.denominatorKind === "no-input")) {
        const laneTerminal = coverageLaneUniverse.find(value => value.lane === denominator.lane);
        const expectedSnapshotHash = hashDomain("aloha/public-pending-snapshot/v1", {
          head: eligiblePayload.head,
          pendingNumber: denominator.pendingSnapshot.pendingNumber,
          parentHash: denominator.pendingSnapshot.parentHash,
          orderedTransactionHashes: denominator.pendingSnapshot.orderedTransactionHashes,
          orderedTransactionHashesRoot: denominator.pendingSnapshot.orderedTransactionHashesRoot,
          transactionCount: denominator.pendingSnapshot.transactionCount,
        });
        const expectedAbsenceEvidenceHash = hashDomain("aloha/public-pending-absence-evidence/v1", {
          head: eligiblePayload.head,
          snapshotHash: denominator.pendingSnapshot.snapshotHash,
        });
        const expectedTerminalLineageHash = hashDomain("aloha/searcher-lane-no-input/v1", {
          kind: "no-input",
          lane: "backrun",
          headHash: eligiblePayload.head.hash,
          generationId: candidateEvent.serving.generationId,
          graphRoot: candidateEvent.serving.graphRoot,
          correlationId: denominator.correlationId,
          pendingSnapshotHash: denominator.pendingSnapshot.snapshotHash,
          absenceEvidenceHash: denominator.absenceEvidenceHash,
          reasonCode: "pending-set-observed-empty",
        });
        const coverageCurrentSource = coveragePayload.currentSourceLogicalFacts.find(value => value.lane === denominator.lane);
        if (laneTerminal?.kind !== "coverage"
          || denominator.lane !== "backrun"
          || denominator.pendingSnapshot.snapshotHash !== expectedSnapshotHash
          || denominator.absenceEvidenceHash !== expectedAbsenceEvidenceHash
          || denominator.terminalLineageHash !== expectedTerminalLineageHash
          || coverageCurrentSource === undefined
          || !sameExact(denominator.currentSource, coverageCurrentSource)) {
          throw new TypeError("production evidence no-input route denominator splice");
        }
      }
      for (const observation of candidatePayload.candidateTerminalObservations) {
        if (observation.headHash !== eligiblePayload.head.hash
          || observation.generationId !== candidateEvent.serving.generationId
          || observation.graphRoot !== candidateEvent.serving.graphRoot) {
          throw new TypeError("production evidence candidate terminal context splice");
        }
        const physical = coveragePayload.currentSourcePhysicalFacts;
        if (physical !== null && (BigInt(observation.startedMonotonicNs) < BigInt(physical.openedMonotonicNs)
          || BigInt(observation.finishedMonotonicNs) > BigInt(physical.closedMonotonicNs))) {
          throw new TypeError("production evidence candidate terminal timing is outside current-source interval");
        }
      }
    }
    for (const [admissionId, performanceEvent] of performance) {
      const payload = performanceEvent.payload as PerformancePayloadV1;
      const eligiblePayload = eligible.get(admissionId)?.payload as EligibleHeadPayloadV1 | undefined;
      if (eligiblePayload === undefined || eligiblePayload.head.hash !== payload.headHash) throw new TypeError("production evidence performance/eligible head mismatch");
      if (BigInt(payload.terminalMonotonicNs) < BigInt(eligiblePayload.acceptedMonotonicNs)) {
        throw new TypeError("production evidence terminal monotonic clock precedes eligible admission");
      }
      const eligibleEvent = eligible.get(admissionId)!;
      const performanceServing = performanceEvent.serving;
      const joinedServingEvents = [
        coverage.get(admissionId),
        candidates.get(admissionId),
        ...[...routeDenominators.values()].filter(event => (event.payload as RouteDenominatorPayloadV1).admissionId === admissionId),
      ].filter((event): event is ProductionEvidenceEventV1 => event !== undefined);
      for (const joined of [...joinedServingEvents, performanceEvent]) {
        if (!sameExact(joined.runtimeAnchor, eligibleEvent.runtimeAnchor)) throw new TypeError("production evidence admission context splice");
      }
      if (joinedServingEvents.some(joined => performanceEvent.serving === null || !sameExact(joined.serving, performanceEvent.serving))) {
        throw new TypeError("production evidence admission serving splice");
      }
      if ((payload.factStatus === "complete" || payload.runtimeFacts !== null || payload.sixStepFacts !== null)
        && performanceServing === null) {
        throw new TypeError("production evidence qualified performance facts lack serving identity");
      }
      const coveragePayload = coverage.get(admissionId)?.payload as HeadCoveragePayloadV1 | undefined;
      const candidatePayload = candidates.get(admissionId)?.payload as CandidateSetPayloadV1 | undefined;
      if (performanceServing === null && (payload.factStatus !== "incomplete"
        || coveragePayload !== undefined
        || candidatePayload !== undefined
        || payload.runtimeFacts !== null
        || payload.sixStepFacts !== null
        || payload.sourceCoverageRoot !== null
        || payload.candidateSetRoot !== null
        || payload.candidateCount !== null)) {
        throw new TypeError("production evidence generation-neutral terminal is not strictly incomplete");
      }
      if (payload.sourceCoverageRoot !== (coveragePayload?.sourceCoverageRoot ?? null)
        || payload.candidateSetRoot !== (candidatePayload === undefined ? null : performanceCandidateSetRoot(candidatePayload.candidateRefs))
        || payload.candidateCount !== (candidatePayload?.candidateRefs.length.toString() ?? null)) throw new TypeError("production evidence performance projection mismatch");
      if (coveragePayload !== undefined && candidatePayload !== undefined && coveragePayload.headFactsRoot !== candidatePayload.headFactsRoot) throw new TypeError("production evidence facts projections mismatch");
      if (candidatePayload !== undefined && candidatePayload.candidateTerminalObservations.some(observation => BigInt(observation.finishedMonotonicNs) > BigInt(payload.terminalMonotonicNs))) {
        throw new TypeError("production evidence terminal precedes a candidate terminal observation");
      }
      const passed = candidatePayload?.candidateTerminalObservations.filter(observation => observation.performanceOutcome === "verified") ?? [];
      const passedRouteDenominator = passed.length === 1
        ? [...routeDenominators.values()]
          .map(event => event.payload as RouteDenominatorPayloadV1)
          .find((denominator): denominator is AccountedRouteDenominatorPayloadV1 => denominator.admissionId === admissionId
            && denominator.denominatorKind === "accounted"
            && denominator.lane === passed[0]!.lane)
        : undefined;
      const passedEntry = passedRouteDenominator?.accounting.entries.find(entry => entry.candidateId === passed[0]?.candidateId);
      if (payload.runtimeFacts !== null) {
        const resourceScope = payload.runtimeFacts.resource.scope;
        if (eligiblePayload.windowId === null
          || resourceScope.admissionId !== admissionId
          || resourceScope.generationId !== performanceServing!.generationId
          || resourceScope.windowId !== eligiblePayload.windowId
          || resourceScope.processLogAnchorHash !== processLogAnchorHash(performanceEvent.runtimeAnchor)) {
          throw new TypeError("production evidence durable resource context splice");
        }
        const join = payload.runtimeFacts.producerSchedulerJoin;
        if (join !== null && (join.generationId !== performanceServing!.generationId
          || join.source.chainId !== eligiblePayload.head.chainId
          || join.source.number !== eligiblePayload.head.number
          || join.source.hash !== eligiblePayload.head.hash
          || join.source.stateRoot !== eligiblePayload.head.stateRoot
          || candidatePayload === undefined
          || !candidatePayload.candidateTerminalObservations.some(observation => observation.candidateId === join.unsignedDryRunCandidateId
            && observation.performanceOutcome === "verified"))) {
          throw new TypeError("production evidence durable Producer scheduler join splice");
        }
      }
      if (payload.factStatus === "complete") {
        if (coveragePayload === undefined || candidatePayload === undefined || !coveragePayload.complete) throw new TypeError("production evidence complete facts lack complete head facts");
        if (passed.length === 0) {
          if (payload.sixStepFacts !== null || payload.runtimeFacts.selectedSchedulerCompletion !== null || payload.runtimeFacts.producerSchedulerJoin !== null) {
            throw new TypeError("production evidence no-pass head carries selected execution facts");
          }
        } else if (passed.length === 1 && passedRouteDenominator !== undefined && passedEntry !== undefined && payload.sixStepFacts !== null && payload.runtimeFacts.selectedSchedulerCompletion !== null && payload.runtimeFacts.producerSchedulerJoin !== null) {
          validateJoinedSixStepContext({
            facts: payload.sixStepFacts,
            runtimeFacts: payload.runtimeFacts,
            release: performanceEvent.release,
            serving: performanceServing!,
            head: eligiblePayload.head,
            candidateObservation: passed[0]!,
            accounting: passedRouteDenominator.accounting,
            candidateEntry: passedEntry,
            plannerCandidateIdentity: passedRouteDenominator.plannerCandidateIdentity,
            economicSafetyAuthority: this.#economicSafetyAuthority,
            strategyExpectation: this.#strategyExpectation,
          });
        } else {
          throw new TypeError("production evidence passed head lacks exact selected execution facts");
        }
      } else if (payload.sixStepFacts !== null) {
        if (payload.runtimeFacts === null || coveragePayload === undefined || candidatePayload === undefined || passed.length !== 1 || passedRouteDenominator === undefined || passedEntry === undefined) throw new TypeError("production evidence retained SixStep facts lack their runtime/head projections");
        validateJoinedSixStepContext({
          facts: payload.sixStepFacts,
          runtimeFacts: payload.runtimeFacts,
          release: performanceEvent.release,
          serving: performanceServing!,
          head: eligiblePayload.head,
          candidateObservation: passed[0]!,
          accounting: passedRouteDenominator.accounting,
          candidateEntry: passedEntry,
          plannerCandidateIdentity: passedRouteDenominator.plannerCandidateIdentity,
          economicSafetyAuthority: this.#economicSafetyAuthority,
          strategyExpectation: this.#strategyExpectation,
        });
      }
      const terminalPayload = terminals.get(payload.terminalId)?.payload as ProducerTerminalPayloadV1 | undefined;
      if (terminalPayload !== undefined) {
        const terminalEvent = terminals.get(payload.terminalId)!;
        if (!sameExact(terminalEvent.serving, performanceEvent.serving) || !sameExact(terminalEvent.runtimeAnchor, eligibleEvent.runtimeAnchor)) throw new TypeError("production evidence terminal context splice");
        if (terminalPayload.terminalBindingRoot !== payload.terminalBindingRoot
          || !sameHead(terminalPayload.terminal.head, eligiblePayload.head)
          || terminalPayload.terminal.ordinal !== eligiblePayload.ordinal
          || terminalPayload.terminal.revision !== eligiblePayload.revision) {
          throw new TypeError("production evidence performance/terminal binding mismatch");
        }
        const projectedFactsRoot = coveragePayload?.headFactsRoot ?? candidatePayload?.headFactsRoot ?? null;
        if (terminalPayload.headFactsRoot !== projectedFactsRoot) throw new TypeError("production evidence terminal/facts root mismatch");
      }
    }
    const currentPartition = (event: ProductionEvidenceEventV1): boolean => sameExact(event.runtimeAnchor, this.#runtimeAnchor);
    const currentEvents = allEvents.filter(currentPartition);
    const partitionEvents = new Map<Hash, ProductionEvidenceEventV1[]>();
    for (const event of allEvents) {
      const id = evidencePartitionId(event);
      const group = partitionEvents.get(id);
      if (group === undefined) partitionEvents.set(id, [event]);
      else {
        const first = group[0]!;
        if (!sameExact(first.release, event.release)
          || !sameExact(first.runtimeAnchor, event.runtimeAnchor)) {
          throw new TypeError("production evidence partition identity collision");
        }
        group.push(event);
      }
    }
    const partitions = [...partitionEvents]
      .map(([id, events]) => partitionReplay(id, events))
      .sort((left, right) => left.partitionId.localeCompare(right.partitionId));
    const completedBindings: FinalDurableWindowBindingV1[] = [];
    for (const [partitionId, activeByOrdinal] of activeAdmissionsByPartition) {
      if (activeByOrdinal.size !== Number(PERFORMANCE_TARGET_COUNT)) continue;
      const orderedAdmissions = Array.from({ length: Number(PERFORMANCE_TARGET_COUNT) }, (_, index) => {
        const ordinal = (index + 1).toString();
        const event = activeByOrdinal.get(ordinal);
        if (event === undefined) throw new TypeError("production evidence completed window ordinal set is not contiguous");
        return event;
      });
      const complete = orderedAdmissions.every(event => {
        const admissionId = (event.payload as EligibleHeadPayloadV1).admissionId;
        const performanceEvent = performance.get(admissionId);
        if (performanceEvent === undefined || evidencePartitionId(performanceEvent) !== partitionId) return false;
        const terminalId = (performanceEvent.payload as PerformancePayloadV1).terminalId;
        const terminalEvent = terminals.get(terminalId);
        return terminalEvent !== undefined && evidencePartitionId(terminalEvent) === partitionId;
      });
      if (!complete) continue;
      const finalEligibleEvent = orderedAdmissions.at(-1)!;
      const finalEligible = finalEligibleEvent.payload as EligibleHeadPayloadV1;
      const finalPerformanceEvent = performance.get(finalEligible.admissionId)!;
      const finalPerformance = finalPerformanceEvent.payload as PerformancePayloadV1;
      const finalServing = finalPerformanceEvent.serving;
      if (finalServing === null) throw new TypeError("production evidence completed window final head lacks serving facts");
      const finalTerminalEvent = terminals.get(finalPerformance.terminalId)!;
      const finalTerminal = finalTerminalEvent.payload as ProducerTerminalPayloadV1;
      const commitmentEvent = windowCommitments.get(partitionId);
      const performanceRaw = rawByEventId.get(finalPerformanceEvent.eventId);
      const terminalRaw = rawByEventId.get(finalTerminalEvent.eventId);
      if (commitmentEvent === undefined || performanceRaw === undefined || terminalRaw === undefined) {
        throw new TypeError("production evidence completed window lacks its exact durable append lineage");
      }
      const commitment = commitmentEvent.payload as PerformanceWindowCommitmentV1;
      if (commitment.targetCount !== PERFORMANCE_TARGET_COUNT
        || finalEligible.ordinal !== PERFORMANCE_TARGET_COUNT
        || finalTerminal.terminal.ordinal !== PERFORMANCE_TARGET_COUNT
        || finalTerminal.terminal.revision !== finalEligible.revision
        || !sameHead(finalTerminal.terminal.head, finalEligible.head)
        || finalTerminal.terminalBindingRoot !== finalPerformance.terminalBindingRoot) {
        throw new TypeError("production evidence completed window final terminal binding mismatch");
      }
      const capability = issueFinalDurableWindowCapabilityV1({
        release: finalEligibleEvent.release,
        runtimeAnchor: finalEligibleEvent.runtimeAnchor,
        serving: finalServing,
        windowId: commitment.windowId,
        targetCount: PERFORMANCE_TARGET_COUNT,
        ordinal: PERFORMANCE_TARGET_COUNT,
        head: finalEligible.head,
        revision: finalEligible.revision,
        terminalId: finalTerminal.terminal.terminalId,
        terminalBindingRoot: finalTerminal.terminalBindingRoot,
        performanceFactStatus: finalPerformance.factStatus,
        performanceAppend: finalDurableAppendBinding(performanceRaw),
        producerTerminalAppend: finalDurableAppendBinding(terminalRaw),
      });
      const binding = readFinalDurableWindowBindingV1(capability);
      completedBindings.push(binding);
      if (this.#finalDurableWindowCapability === null) this.#finalDurableWindowCapability = capability;
    }
    if (completedBindings.length > 1) throw new TypeError("production evidence contains multiple completed terminal windows");
    const completedBinding = completedBindings[0] ?? null;
    if (this.#finalDurableWindowBinding !== null && completedBinding !== null
      && this.#finalDurableWindowBinding.finalDurableWindowId !== completedBinding.finalDurableWindowId) {
      throw new TypeError("production evidence completed window changed after issuance");
    }
    this.#finalDurableWindowBinding = completedBinding;
    if (completedBinding === null && terminalPhaseInvalid.length !== 0) {
      throw new TypeError("production evidence terminal-phase invalid fact lacks a completed durable window");
    }
    const matchingInvalid = terminalPhaseInvalid.filter(event => (event.payload as TerminalPhaseInvalidPayloadV1).finalDurableWindowId === completedBinding?.finalDurableWindowId);
    if (matchingInvalid.length > 1 || matchingInvalid.length !== terminalPhaseInvalid.length) {
      throw new TypeError("production evidence terminal-phase invalid lineage is duplicate or orphaned");
    }
    if (matchingInvalid.length === 1) {
      const invalidEvent = matchingInvalid[0]!;
      const invalid = invalidEvent.payload as TerminalPhaseInvalidPayloadV1;
      const sameProcess = sameExact(invalidEvent.runtimeAnchor, completedBinding!.runtimeAnchor);
      if ((invalid.reasonCode === "terminal-phase-process-anchor-changed") === sameProcess) {
        throw new TypeError("production evidence terminal-phase invalid process binding mismatch");
      }
      if (invalid.reasonCode === "terminal-phase-current-source-moved"
        && !sameExact(invalidEvent.serving, completedBinding!.serving)) {
        throw new TypeError("production evidence moved-head terminal fact serving mismatch");
      }
      this.#terminalPhaseInvalidFact = invalid;
    } else {
      this.#terminalPhaseInvalidFact = null;
    }
    const currentPartitionIds = [...new Set(currentEvents.map(evidencePartitionId))];
    if (currentPartitionIds.length > 1) throw new TypeError("production evidence current runtime spans multiple serving partitions");
    const currentPartitionId = this.#serving === null
      ? currentPartitionIds[0] ?? null
      : evidencePartitionId({ release: this.#release, runtimeAnchor: this.#runtimeAnchor });
    const currentEligible = new Map([...eligible].filter(([, event]) => currentPartition(event)));
    const currentPerformance = new Map([...performance].filter(([, event]) => currentPartition(event)));
    const currentTerminals = new Map([...terminals].filter(([, event]) => currentPartition(event)));
    this.#admissionIds.clear();
    this.#eligiblePayloads.clear();
    this.#eligibleEventIds.clear();
    this.#servingByAdmission.clear();
    for (const [admissionId, event] of currentEligible) {
      this.#admissionIds.add(admissionId);
      this.#eligiblePayloads.set(admissionId, event.payload as EligibleHeadPayloadV1);
      this.#eligibleEventIds.set(admissionId, event.eventId);
      const serving = coverage.get(admissionId)?.serving ?? performance.get(admissionId)?.serving ?? null;
      if (serving !== null) this.#servingByAdmission.set(admissionId, serving);
    }
    this.#activeAdmissionByOrdinal.clear();
    if (currentPartitionId !== null) {
      for (const [ordinal, event] of activeAdmissionsByPartition.get(currentPartitionId) ?? []) {
        this.#activeAdmissionByOrdinal.set(ordinal, (event.payload as EligibleHeadPayloadV1).admissionId);
      }
    }
    this.#terminalIds.clear();
    for (const terminalId of currentTerminals.keys()) this.#terminalIds.add(terminalId);
    this.#performanceTerminalBindings.clear();
    this.#performanceTerminalAdmissions.clear();
    this.#performanceTerminalMonotonicNs.clear();
    for (const event of currentPerformance.values()) {
      const payload = event.payload as PerformancePayloadV1;
      this.#performanceTerminalBindings.set(payload.terminalId, payload.terminalBindingRoot);
      this.#performanceTerminalAdmissions.set(payload.terminalId, payload.admissionId);
      this.#performanceTerminalMonotonicNs.set(payload.terminalId, payload.terminalMonotonicNs);
    }
    this.#producerTerminalByAdmission.clear();
    this.#producerTerminalEventByAdmission.clear();
    for (const [terminalId, terminalEvent] of currentTerminals) {
      const payload = terminalEvent.payload as ProducerTerminalPayloadV1;
      const expectedBinding = this.#performanceTerminalBindings.get(terminalId);
      const admissionId = this.#performanceTerminalAdmissions.get(terminalId);
      if (expectedBinding === undefined || admissionId === undefined || expectedBinding !== payload.terminalBindingRoot) {
        throw new TypeError("production evidence orphan producer terminal");
      }
      if (this.#producerTerminalByAdmission.has(admissionId)) throw new TypeError("production evidence admission has duplicate Producer terminals");
      this.#producerTerminalByAdmission.set(admissionId, terminalId);
      this.#producerTerminalEventByAdmission.set(admissionId, terminalEvent.eventId);
    }
    const current = partitionReplay(
      currentPartitionId ?? hashDomain("aloha/searcher-production-evidence-unbound-partition/v1", { release: this.#release, runtimeAnchor: this.#runtimeAnchor }),
      currentEvents,
    );
    this.#nextAppendSequenceByNamespace.clear();
    for (const [namespace, sequence] of nextAppendSequenceByNamespace) {
      this.#nextAppendSequenceByNamespace.set(namespace, sequence);
    }
    const { partitionId: _partitionId, ...currentValues } = current;
    return deepFreeze({
      ...currentValues,
      currentPartitionId,
      partitionCount: partitions.length.toString(),
      partitions: Object.freeze(partitions),
    });
  }

  #readFinalDurableWindow(): FinalDurableWindowCapabilityV1 | null {
    this.#assertOpen();
    this.replay();
    const binding = this.#finalDurableWindowBinding;
    if (binding === null) return null;
    if (this.#finalDurableWindowCapability === null) throw new TypeError("final durable window capability was not issued from replay");
    return this.#finalDurableWindowCapability;
  }

  #readFinalDurableWindowBinding(
    capability: FinalDurableWindowCapabilityV1,
  ): FinalDurableWindowBindingV1 {
    const binding = readFinalDurableWindowBindingV1(capability);
    if (capability !== this.#finalDurableWindowCapability
      || binding.finalDurableWindowId !== this.#finalDurableWindowBinding?.finalDurableWindowId) {
      throw new TypeError("final durable window capability belongs to another evidence owner");
    }
    return binding;
  }

  async #appendTerminalPhaseInvalid(input: Readonly<{
    readonly completedWindow: FinalDurableWindowCapabilityV1;
    readonly reasonCode: TerminalPhaseInvalidReasonV1;
    readonly observed: CanonicalHeadObservationV1 | null;
  }>): Promise<TerminalPhaseInvalidFactV1> {
    return this.#enqueue(async () => {
      assertPlainObject(input, "terminalPhaseInvalid");
      assertExactKeys(input, ["completedWindow", "reasonCode", "observed"], "terminalPhaseInvalid");
      if (this.#terminalPhaseInvalidFact !== null) throw new TypeError("terminal-phase invalid fact is already durable");
      const completed = this.#readFinalDurableWindowBinding(input.completedWindow);
      if (this.#startup === null) throw new TypeError("production evidence startup authority is missing");
      const currentServing = servingFromStartupGeneration(this.#startup);
      const sameProcess = sameExact(completed.runtimeAnchor, this.#runtimeAnchor);
      if (input.reasonCode === "terminal-phase-process-anchor-changed") {
        if (sameProcess || input.observed !== null) {
          throw new TypeError("process-anchor terminal invalid fact has inconsistent evidence");
        }
      } else if (input.reasonCode === "terminal-phase-current-source-moved") {
        if (!sameProcess || !sameExact(completed.serving, currentServing) || input.observed === null) {
          throw new TypeError("moved-head terminal invalid fact has inconsistent authority");
        }
        if (sameHead(completed.head, input.observed.head)) {
          throw new TypeError("moved-head terminal invalid fact did not observe a moved head");
        }
      } else {
        throw new TypeError("terminal-phase invalid reason is invalid");
      }
      const observed = input.observed === null ? null : createTerminalPhaseHeadObservationV1({
        head: input.observed.head,
        journalEpoch: input.observed.journalEpoch,
        canonicalJournalRoot: input.observed.canonicalJournalRoot,
        observedMonotonicNs: input.observed.observedMonotonicNs,
      });
      const fact = createTerminalPhaseInvalidFactV1({
        finalDurableWindowId: completed.finalDurableWindowId,
        reasonCode: input.reasonCode,
        observed,
        recordedMonotonicNs: process.hrtime.bigint().toString(),
      });
      await this.#append("terminal-phase-invalid", fact, completed.serving);
      this.#terminalPhaseInvalidFact = fact;
      return fact;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store.close();
  }

  async #acceptEligibleHead(input: ProducerEligibleHeadInputV1): Promise<object> {
    return this.#enqueue(async () => {
      assertPlainObject(input, "productionEvidence.eligibleHead");
      assertExactKeys(input, ["head", "revision"], "productionEvidence.eligibleHead");
      const head = exactHead(input.head, "productionEvidence.eligibleHead.head");
      const revision = assertDecimalString(input.revision, "productionEvidence.eligibleHead.revision");
      await this.#ensurePerformanceWindow(head);
      const windowId = this.#performanceCommitment?.windowId ?? null;
      const activeAtHeight = [...this.#activeAdmissionByOrdinal.entries()].find(([, admissionId]) => {
        const active = this.#eligiblePayloads.get(admissionId);
        return active?.head.chainId === head.chainId && active.head.number === head.number;
      });
      let replacement: readonly [string, Hash] | null = null;
      if (revision === "0") {
        if (activeAtHeight !== undefined) throw new TypeError("same-height canonical change requires the next replacement revision");
        if (this.#performanceRuntime !== null && BigInt(this.#activeAdmissionByOrdinal.size) >= BigInt(PERFORMANCE_TARGET_COUNT)) {
          throw new TypeError("production evidence performance window is complete");
        }
      } else {
        if (activeAtHeight === undefined) throw new TypeError("replacement revision lacks an active same-height orphan");
        replacement = activeAtHeight;
      }
      const ordinal = replacement?.[0] ?? (this.#activeAdmissionByOrdinal.size + 1).toString();
      const acceptedMonotonicNs = process.hrtime.bigint().toString();
      if (this.#performanceCommitment !== null
        && BigInt(acceptedMonotonicNs) <= BigInt(this.#performanceCommitment.committedMonotonicNs)) {
        throw new TypeError("eligible head monotonic anchor does not follow the durable window commitment");
      }
      const admissionId = hashDomain("aloha/searcher-production-evidence-admission/v1", { release: this.#release, runtimeAnchor: this.#runtimeAnchor, windowId, ordinal, head, revision, acceptedMonotonicNs });
      if (this.#admissionIds.has(admissionId)) throw new TypeError("production evidence duplicate eligible admission");
      const payload: EligibleHeadPayloadV1 = Object.freeze({ admissionId, windowId, ordinal, head, revision, acceptedMonotonicNs });
      let lineage: PerformanceAdmissionOrphanReplacementLineageV1 | null = null;
      let append: DurableAppendReceipt;
      if (replacement === null) {
        append = await this.#append("eligible-head", payload, null);
      } else {
        if (windowId === null || this.#performanceRuntime === null) throw new TypeError("performance replacement requires an active release-owned window");
        const orphanAdmissionId = replacement[1];
        const orphan = this.#eligiblePayloads.get(orphanAdmissionId);
        const orphanEligibleEventId = this.#eligibleEventIds.get(orphanAdmissionId);
        const orphanProducerTerminalId = this.#producerTerminalByAdmission.get(orphanAdmissionId);
        const orphanProducerTerminalEventId = this.#producerTerminalEventByAdmission.get(orphanAdmissionId);
        const orphanTerminalMonotonicNs = orphanProducerTerminalId === undefined ? undefined : this.#performanceTerminalMonotonicNs.get(orphanProducerTerminalId);
        if (orphan === undefined || orphanEligibleEventId === undefined || orphanProducerTerminalId === undefined
          || orphanProducerTerminalEventId === undefined || orphanTerminalMonotonicNs === undefined
          || !sameHead(orphan.head, head) && (orphan.head.chainId !== head.chainId || orphan.head.number !== head.number)
          || sameHead(orphan.head, head)
          || BigInt(revision) !== BigInt(orphan.revision) + 1n) {
          throw new TypeError("replacement does not bind the active durable orphan terminal");
        }
        lineage = createPerformanceAdmissionOrphanReplacementLineage({
          windowId,
          ordinal,
          orphanAdmissionId,
          orphanEligibleEventId,
          orphanProducerTerminalId,
          orphanProducerTerminalEventId,
          orphanCanonicalHead: orphan.head,
          orphanRevision: orphan.revision,
          orphanAcceptedMonotonicNs: orphan.acceptedMonotonicNs,
          orphanTerminalMonotonicNs,
          replacementAdmissionId: admissionId,
          replacementCanonicalHead: head,
          replacementRevision: revision,
          replacementAcceptedMonotonicNs: acceptedMonotonicNs,
        });
        append = await this.#append("orphan-replacement", Object.freeze({ ...payload, lineage }), null);
      }
      const handle = Object.freeze(Object.create(null));
      this.#handles.set(handle, {
        payload,
        replacementLineage: lineage,
        ordinal,
        eligibleEventId: append.eventId,
        performanceHead: null,
        serving: null,
        performanceSealedHead: null,
        factsCapability: null,
        facts: null,
        terminalId: null,
      });
      this.#admissionIds.add(admissionId);
      this.#eligiblePayloads.set(admissionId, payload);
      this.#eligibleEventIds.set(admissionId, append.eventId);
      this.#activeAdmissionByOrdinal.set(ordinal, admissionId);
      return handle;
    });
  }

  async #ensurePerformanceWindow(head: CanonicalHead): Promise<void> {
    if (this.#performanceRuntime === null) return;
    if (this.#performanceWindow !== null) return;
    if (this.#performanceWindowBasis === null || this.#startup === null || this.#admissionIds.size !== 0) {
      throw new TypeError("performance window cannot be committed after denominator admission");
    }
    const basis = this.#performanceWindowBasis;
    const committedMonotonicNs = process.hrtime.bigint().toString();
    const basisPayload = createPerformanceWindowBasisPayload({
      windowStartAnchor: head,
      eligibilityRuleHash: basis.eligibilityRuleHash,
      profile: basis.profile,
      providerRoot: basis.providerRoot,
      hardwareProfile: basis.hardwareProfile,
      processLogAnchor: performanceProcessLogAnchor(this.#runtimeAnchor),
      releaseBindingId: this.#release.bindingId,
      releaseProvenanceHash: this.#release.releaseProvenanceHash,
      runtimeAnchorHash: performanceRuntimeAnchorHash(this.#runtimeAnchor),
      targetCount: PERFORMANCE_TARGET_COUNT,
      committedMonotonicNs,
    });
    const basisAppend = await this.#append("performance-window-basis", basisPayload, null);
    const appendRecordId = performanceWindowBasisAppendRecordId(basisAppend);
    const contextBindingId = performanceWindowBasisContextBindingId({
      release: this.#release,
      runtimeAnchor: this.#runtimeAnchor,
      basisId: basisPayload.basisId,
      appendRecordId,
      append: basisAppend,
    });
    const commitment = createPerformanceWindowCommitment({
      windowStartAnchor: basisPayload.windowStartAnchor,
      eligibilityRuleHash: basisPayload.eligibilityRuleHash,
      performanceProfileHash: basisPayload.profile.profileHash,
      targetCount: PERFORMANCE_TARGET_COUNT,
      processLogAnchor: basisPayload.processLogAnchor,
      releaseBindingId: basisPayload.releaseBindingId,
      releaseProvenanceHash: basisPayload.releaseProvenanceHash,
      runtimeAnchorHash: basisPayload.runtimeAnchorHash,
      providerRoot: basisPayload.providerRoot,
      hardwareProfileRoot: basisPayload.hardwareProfile.profileRoot,
      commitContextBindingId: contextBindingId,
      commitAppendRecordId: appendRecordId,
      committedMonotonicNs,
    });
    await this.#append("performance-window-commitment", commitment, null);
    this.#performanceWindow = this.#performanceRuntime.openWindow({ startup: this.#startup, commitment });
    this.#performanceCommitment = commitment;
    this.#processLogAnchorHash = hashProcessLogAnchor(commitment.processLogAnchor);
    this.#performanceWindowId = commitment.windowId;
  }

  async #bindEligibleHeadFacts(handle: unknown, capability: unknown): Promise<object> {
    return this.#enqueue(async () => {
      const state = this.#handleState(handle);
      if (state.facts !== null) throw new TypeError("production evidence head facts already bound");
      const facts = readIssuedProducerHeadFactsCapabilityV1(capability);
      if (facts.headHash !== state.payload.head.hash) throw new TypeError("production evidence facts head mismatch");
      const serving = state.serving;
      if (serving === null || this.#startup === null) throw new TypeError("production evidence eligible head serving authority is missing");
      const resolved = servingFromStartupGeneration(this.#startup, serving.generationId);
      if (!sameExact(resolved, serving)) throw new TypeError("production evidence eligible head serving changed after admission");
      if (facts.generationId !== serving.generationId || facts.graphRoot !== serving.graphRoot) {
        throw new TypeError("production evidence facts serving mismatch");
      }
      const projection = projectionFromFacts(state.payload.admissionId, facts);
      await this.#append("head-coverage", projection.coverage, serving);
      for (const denominator of projection.routeDenominators) {
        await this.#append(
          "route-denominator",
          denominator.denominatorKind === "accounted"
            ? persistAccountedRouteDenominator(this.#store, denominator)
            : denominator,
          serving,
        );
      }
      await this.#append("candidate-set", persistCandidateSet(this.#store, projection.candidates), serving);
      state.factsCapability = capability as object;
      state.facts = facts;
      this.#servingByAdmission.set(state.payload.admissionId, serving);
      return handle as object;
    });
  }

  async #bindEligibleHeadSession(handle: unknown, session: ProducerSessionV1): Promise<object> {
    return this.#enqueue(async () => {
      const state = this.#handleState(handle);
      if (state.serving !== null || state.performanceHead !== null || state.facts !== null) {
        throw new TypeError("production evidence eligible head session is already bound");
      }
      if (this.#startup === null) throw new TypeError("production evidence startup authority is missing");
      const generation = this.#startup.readProducerSessionGeneration(session);
      if (generation.releaseProvenanceHash !== this.#release.releaseProvenanceHash) {
        throw new TypeError("production evidence session release provenance mismatch");
      }
      const serving = exactServing({
        generationId: generation.generationId,
        graphRoot: generation.graphRoot,
        readyRecordHash: generation.readyRecordHash,
        sourceCoverageRoot: generation.sourceCoverageRoot,
      }, "productionEvidence.sessionGeneration");
      if (this.#performanceRuntime !== null) {
        if (this.#performanceWindow === null) throw new TypeError("production evidence performance window is missing");
        state.performanceHead = state.replacementLineage === null
          ? this.#performanceRuntime.openHead(this.#performanceWindow, {
              admissionId: state.payload.admissionId,
              headHash: state.payload.head.hash,
              ordinal: state.ordinal,
              revision: "0",
              serving,
            })
          : this.#performanceRuntime.openReplacementHead(this.#performanceWindow, state.replacementLineage, serving);
      }
      state.serving = serving;
      this.#servingByAdmission.set(state.payload.admissionId, serving);
      return handle as object;
    });
  }

  async #sealPerformance(handle: unknown, capability: ProducerHeadTerminalCapabilityV1): Promise<void> {
    return this.#enqueue(async () => {
      const state = this.#handleState(handle);
      if (state.terminalId !== null) throw new TypeError("production evidence performance terminal already sealed");
      const evidence = readIssuedProducerHeadTerminalCapabilityV1(capability);
      if (!sameHead(evidence.terminal.head, state.payload.head)) throw new TypeError("production evidence terminal head mismatch");
      if ((evidence.terminal.generationId === null) !== (evidence.terminal.graphRoot === null)) throw new TypeError("production evidence terminal generation/Graph nullability mismatch");
      const serving = evidence.terminal.generationId === null ? null : state.serving;
      if (evidence.terminal.generationId !== null && (serving === null
        || evidence.terminal.generationId !== serving.generationId
        || evidence.terminal.graphRoot !== serving.graphRoot)) throw new TypeError("production evidence terminal serving mismatch");
      if (evidence.facts === null) {
        if (state.facts !== null) throw new TypeError("production evidence terminal discarded bound head facts");
      } else {
        if (evidence.facts !== state.factsCapability) throw new TypeError("production evidence terminal replaced the bound head facts capability");
        const terminalFacts = readIssuedProducerHeadFactsCapabilityV1(evidence.facts);
        if (state.facts === null || headFactsRoot(terminalFacts) !== headFactsRoot(state.facts)) throw new TypeError("production evidence terminal head facts mismatch");
      }
      const schedulerJoin = state.facts === null
        ? Object.freeze({ kind: "missing" as const, join: null })
        : producerSchedulerJoin(state.facts);
      const sixStep = state.facts === null
        ? Object.freeze({ kind: "missing" as const, trace: null, artifacts: null })
        : producerSixStepTrace(state.facts);
      let runtimeFacts: JoinedRuntimePerformanceFactsV1 | null = null;
      let claim: ReturnType<RuntimeReleasePerformanceRuntimeServiceV1["claimHead"]> | null = null;
      try {
        if (this.#performanceRuntime !== null && serving !== null) {
          if (state.performanceHead === null || this.#performanceWindow === null
            || this.#performanceWindowId === null || this.#processLogAnchorHash === null) {
            throw new TypeError("production evidence performance head authority is missing");
          }
          if (state.performanceSealedHead === null) {
            while (state.performanceSealedHead === null) {
              try {
                state.performanceSealedHead = this.#performanceRuntime.sealHead(this.#performanceWindow, state.performanceHead);
              } catch (error) {
                if (!(error instanceof RuntimeReleasePerformanceHeadSamplePendingError)) throw error;
                // Cross a real event-loop turn, then retry the same active
                // release-owned head handle. No fact or histogram sample is
                // synthesized and no scheduler/resource authority is replaced.
                await new Promise<void>(resolve => setImmediate(resolve));
                this.#assertOpen();
              }
            }
          }
          claim = this.#performanceRuntime.claimHead(this.#performanceWindow, state.performanceSealedHead, { terminal: capability });
          const observed = this.#performanceRuntime.readClaim(claim);
          runtimeFacts = exactJoinedRuntimeFacts({
            schedulerRange: observed.schedulerRange,
            schedulerCompletions: observed.schedulerCompletions,
            selectedSchedulerCompletion: observed.selectedSchedulerCompletion,
            resource: observed.resource,
            producerSchedulerJoin: schedulerJoin.kind === "exact" ? canonicalProducerSchedulerJoin(schedulerJoin.join!) : null,
          }, "productionEvidence.runtimeFacts");
          if ((runtimeFacts.selectedSchedulerCompletion === null) !== (schedulerJoin.kind !== "exact")) {
            throw new TypeError("production evidence selected scheduler completion does not match Producer terminal authority");
          }
          if (runtimeFacts.resource.scope.admissionId !== state.payload.admissionId
            || runtimeFacts.resource.scope.ordinal !== state.ordinal
            || runtimeFacts.resource.scope.generationId !== serving.generationId
            || runtimeFacts.resource.scope.windowId !== this.#performanceWindowId
            || runtimeFacts.resource.scope.processLogAnchorHash !== this.#processLogAnchorHash) {
            throw new TypeError("production evidence resource scope context mismatch");
          }
          if (runtimeFacts.producerSchedulerJoin !== null
            && (runtimeFacts.producerSchedulerJoin.generationId !== serving.generationId
              || runtimeFacts.producerSchedulerJoin.source.chainId !== state.payload.head.chainId
              || runtimeFacts.producerSchedulerJoin.source.number !== state.payload.head.number
              || runtimeFacts.producerSchedulerJoin.source.hash !== state.payload.head.hash
              || runtimeFacts.producerSchedulerJoin.source.stateRoot !== state.payload.head.stateRoot)) {
            throw new TypeError("production evidence scheduler join head context mismatch");
          }
        }
        const passed = state.facts === null ? [] : passedCandidateObservations(state.facts);
        const passedLaneFacts = passed.length === 1 && state.facts !== null
          ? state.facts.laneFacts.find(lane => lane.lane === passed[0]!.lane) ?? null
          : null;
        const passedAccounting = passedLaneFacts?.accounting ?? null;
        const passedEnumeration = passedLaneFacts === null ? null : readIssuedProducerLanePlannerEnumerationV1(passedLaneFacts);
        const passedPlannerCandidateIdentity = passedLaneFacts === null || passedEnumeration === null ? null : Object.freeze({
          planningProblemHash: passedEnumeration.planningProblemHash,
          objectiveRef: passedEnumeration.planningProblem.objectiveRef,
          entryAssetRef: passedEnumeration.planningProblem.entryAssetRef,
          returnAssetRef: passedEnumeration.planningProblem.returnAssetRef,
          triggerRef: passedLaneFacts.triggerRef,
          affectedEdgeIdsRoot: passedLaneFacts.affectedEdgeIdsRoot,
        });
        const passedEntry = passedAccounting?.entries.find(entry => entry.candidateId === passed[0]?.candidateId) ?? null;
        const canJoinSixStep = passed.length === 1
          && passedAccounting !== null
          && passedPlannerCandidateIdentity !== null
          && passedEntry !== null
          && state.facts !== null
          && serving !== null
          && state.facts.complete
          && runtimeFacts !== null
          && schedulerJoin.kind === "exact"
          && sixStep.kind === "exact"
          && sixStep.trace !== null
          && sixStep.artifacts !== null
          && sixStep.trace.resolved.executionProgramOwnerEvidence !== null
          && Object.prototype.hasOwnProperty.call(
            sixStep.trace.resolved.executionProgramOwnerEvidence,
            "ownerObservation",
          );
        const joinedSixStep = canJoinSixStep
          ? await joinSixStepFacts({
            startup: this.#startup!,
            trace: sixStep.trace!,
            artifacts: sixStep.artifacts!,
            runtimeFacts: runtimeFacts!,
            release: this.#release,
            serving: serving!,
            head: state.payload.head,
            candidateObservation: passed[0]!,
            accounting: passedAccounting!,
            candidateEntry: passedEntry!,
            plannerCandidateIdentity: passedPlannerCandidateIdentity!,
            economicSafetyAuthority: this.#economicSafetyAuthority,
            strategyExpectation: this.#strategyExpectation,
          })
          : null;
        const terminalMonotonicNs = process.hrtime.bigint().toString();
        const completeWithoutSixStep = state.facts !== null
          && serving !== null
          && state.facts.complete
          && runtimeFacts !== null
          && passed.length === 0
          && schedulerJoin.kind === "missing"
          && sixStep.kind === "missing"
          && runtimeFacts.selectedSchedulerCompletion === null
          && runtimeFacts.producerSchedulerJoin === null;
        const completeWithSixStep = state.facts !== null
          && serving !== null
          && state.facts.complete
          && runtimeFacts !== null
          && passed.length === 1
          && joinedSixStep !== null;
        const payload = completeWithoutSixStep || completeWithSixStep
          ? completePerformanceFacts(state.payload.admissionId, evidence.terminal, terminalMonotonicNs, state.facts!, runtimeFacts!, joinedSixStep)
          : incompletePerformanceFacts(state.payload.admissionId, evidence.terminal, terminalMonotonicNs, state.facts, runtimeFacts, joinedSixStep);
        const appended = await this.#appendWithEvent(
          payload.factStatus === "complete" ? "performance-facts-complete" : "performance-facts-incomplete",
          payload,
          serving,
        );
        if (completeWithSixStep) {
          if (claim === null || this.#performanceRuntime === null || this.#startup === null) {
            throw new TypeError("Six-Step complete append lacks its active release authorities");
          }
          const performanceAppend = await issueSearcherProductionSixStepPerformanceAppendCapabilityV1({
            startup: this.#startup,
            performanceRuntime: this.#performanceRuntime,
            performanceClaim: claim,
            headTerminalCapability: capability,
            durableAppend: appended.durableAppend,
          });
          claim = null;
          this.#sixStepPerformanceAppendByTerminal.set(capability, performanceAppend);
        } else if (claim !== null) {
          this.#performanceRuntime!.commitClaim(claim);
          claim = null;
        }
        this.#performanceTerminalBindings.set(evidence.terminal.terminalId, payload.terminalBindingRoot);
        this.#performanceTerminalAdmissions.set(evidence.terminal.terminalId, state.payload.admissionId);
        this.#performanceTerminalMonotonicNs.set(evidence.terminal.terminalId, payload.terminalMonotonicNs);
      } catch (error) {
        if (claim !== null) {
          try { this.#performanceRuntime!.abortClaim(claim); } catch { /* Preserve the original durable/join failure. */ }
        }
        throw error;
      }
      state.terminalId = evidence.terminal.terminalId;
    });
  }

  async #appendProducerTerminal(capability: ProducerHeadTerminalCapabilityV1): Promise<void> {
    return this.#enqueue(async () => {
      const evidence = readIssuedProducerHeadTerminalCapabilityV1(capability);
      if (this.#terminalIds.has(evidence.terminal.terminalId)) throw new TypeError("production evidence producer terminal already persisted");
      const facts = evidence.facts === null ? null : readIssuedProducerHeadFactsCapabilityV1(evidence.facts);
      const bindingRoot = terminalBindingRoot(evidence.terminal, facts);
      if (this.#performanceTerminalBindings.get(evidence.terminal.terminalId) !== bindingRoot) {
        throw new TypeError("production evidence producer terminal is not bound to a persisted performance terminal");
      }
      const admissionId = this.#performanceTerminalAdmissions.get(evidence.terminal.terminalId);
      if (admissionId === undefined) throw new TypeError("production evidence producer terminal admission is missing");
      const serving = evidence.terminal.generationId === null ? null : this.#servingByAdmission.get(admissionId) ?? null;
      if (evidence.terminal.generationId !== null && (serving === null
        || evidence.terminal.generationId !== serving.generationId
        || evidence.terminal.graphRoot !== serving.graphRoot)) {
        throw new TypeError("production evidence producer terminal serving mismatch");
      }
      if (serving === null && facts !== null) throw new TypeError("production evidence generation-neutral terminal carries head facts");
      const appended = await this.#appendWithEvent("producer-terminal", Object.freeze({ terminalBindingRoot: bindingRoot, terminal: evidence.terminal, headFactsRoot: facts === null ? null : headFactsRoot(facts) }), serving);
      const performanceAppend = this.#sixStepPerformanceAppendByTerminal.get(capability);
      if (performanceAppend !== undefined) {
        const completeAppend = issueSearcherProductionSixStepCompleteAppendCapabilityV1({
          performanceAppend,
          headTerminalCapability: capability,
          producerTerminalAppend: appended.durableAppend,
        });
        this.#sixStepPerformanceAppendByTerminal.delete(capability);
        this.#sixStepCompleteAppendByTerminal.set(capability, completeAppend);
        this.#sixStepCompleteAppends.push(completeAppend);
      }
      this.#terminalIds.add(evidence.terminal.terminalId);
      this.#producerTerminalByAdmission.set(admissionId, evidence.terminal.terminalId);
      this.#producerTerminalEventByAdmission.set(admissionId, appended.receipt.eventId);
      this.#currentProcessHeadTerminalById.set(evidence.terminal.terminalId, capability);
    });
  }

  async #appendWithEvent(
    eventType: ProductionEvidenceEventTypeV1,
    payload: ProductionEvidenceWirePayloadV1,
    serving: ServingBindingV1 | null,
  ): Promise<Readonly<{ readonly receipt: DurableAppendReceipt; readonly durableAppend: DurableAppendCapabilityV1 }>> {
    const namespace = namespaceFor(eventType);
    const sequence = this.#nextAppendSequenceByNamespace.get(namespace);
    if (sequence === undefined) {
      throw new TypeError(`production evidence append namespace ${namespace} was not initialized by replay`);
    }
    const draft: ProductionEvidenceEventDraftV1 = deepFreeze({ schemaVersion: 1 as const, kind: EVENT_KIND, eventType, sequence, namespace, release: this.#release, runtimeAnchor: this.#runtimeAnchor, serving, payload });
    const event = Object.freeze({ ...draft, eventId: eventId(draft) });
    const bytes = encodeCanonicalBytes(event);
    const durableAppend = this.#store.appendFsyncMonotonicCapability({ namespace, sequence, eventId: event.eventId, contentSha256: sha256Hex(bytes), bytes });
    const persisted = readDurableAppendCapabilityV1(durableAppend);
    const { bytes: _persistedBytes, ...receipt } = persisted;
    if (receipt.fsynced !== true || receipt.eventId !== event.eventId || receipt.sequence !== sequence || receipt.contentSha256 !== sha256Hex(bytes) || receipt.byteLength !== bytes.byteLength.toString()) throw new TypeError("production evidence durable acknowledgement mismatch");
    if (Buffer.compare(Buffer.from(persisted.bytes), Buffer.from(bytes)) !== 0) {
      throw new TypeError("production evidence fixed durable row reader mismatch");
    }
    this.#nextAppendSequenceByNamespace.set(namespace, (BigInt(sequence) + 1n).toString());
    return Object.freeze({ receipt: Object.freeze(receipt), durableAppend });
  }

  async #append(
    eventType: ProductionEvidenceEventTypeV1,
    payload: ProductionEvidenceWirePayloadV1,
    serving: ServingBindingV1 | null,
  ): Promise<DurableAppendReceipt> {
    return (await this.#appendWithEvent(eventType, payload, serving)).receipt;
  }

  #handleState(handle: unknown): EligibleHeadHandleStateV1 {
    if (handle === null || typeof handle !== "object") throw new TypeError("production evidence eligible head is not owner-issued");
    const state = this.#handles.get(handle);
    if (state === undefined) throw new TypeError("production evidence eligible head is not owner-issued");
    return state;
  }

  #requireServing(): ServingBindingV1 {
    this.#assertOpen();
    if (this.#serving === null) throw new TypeError("production evidence owner is not bound to serving");
    return this.#serving;
  }

  #assertOpen(): void {
    if (this.#closed) throw new TypeError("production evidence owner is closed");
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const run = this.#tail.then(operation);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export interface SearcherProductionEvidenceMaterializedRouteDenominatorEventV1 {
  readonly eventId: Hash;
  readonly sequence: string;
  readonly release: SearcherProductionEvidenceReleaseV1;
  readonly runtimeAnchor: RuntimeAnchorReceiptV1;
  readonly serving: ServingBindingV1;
  readonly payload: RouteDenominatorPayloadV1;
}

export interface SearcherProductionEvidenceMaterializedCandidateSetEventV1 {
  readonly eventId: Hash;
  readonly sequence: string;
  readonly release: SearcherProductionEvidenceReleaseV1;
  readonly runtimeAnchor: RuntimeAnchorReceiptV1;
  readonly serving: ServingBindingV1;
  readonly payload: CandidateSetPayloadV1;
}

/** Read-only physical contract for advisory observers. Every returned route
 * entry and candidate observation has been reopened from SQLite content,
 * traversed through the exact linked manifest, and rejoined to its semantic
 * denominator root. */
export function readSearcherProductionEvidenceHighCardinalityV1(databasePath: string): Readonly<{
  readonly routeDenominators: readonly SearcherProductionEvidenceMaterializedRouteDenominatorEventV1[];
  readonly candidateSets: readonly SearcherProductionEvidenceMaterializedCandidateSetEventV1[];
}> {
  if (typeof databasePath !== "string" || !databasePath.startsWith("/")) throw new TypeError("production evidence database path must be absolute");
  const store = createSqliteDurableStore(databasePath);
  try {
    store.bindStoreRole(EVIDENCE_ROLE);
    const routeDenominators = store.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.routeDenominators).map(record => {
      const event = exactEvent(record, store);
      if (event.eventType !== "route-denominator" || event.serving === null) throw new TypeError("production evidence route denominator physical event mismatch");
      return deepFreeze({
        eventId: event.eventId,
        sequence: event.sequence,
        release: event.release,
        runtimeAnchor: event.runtimeAnchor,
        serving: event.serving,
        payload: event.payload as RouteDenominatorPayloadV1,
      });
    });
    const candidateSets = store.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.candidateSets).map(record => {
      const event = exactEvent(record, store);
      if (event.eventType !== "candidate-set" || event.serving === null) throw new TypeError("production evidence candidate set physical event mismatch");
      return deepFreeze({
        eventId: event.eventId,
        sequence: event.sequence,
        release: event.release,
        runtimeAnchor: event.runtimeAnchor,
        serving: event.serving,
        payload: event.payload as CandidateSetPayloadV1,
      });
    });
    return deepFreeze({ routeDenominators, candidateSets });
  } finally {
    store.close();
  }
}

export function issueSearcherProductionEvidenceOwnerV1(input: SearcherProductionEvidenceOwnerInputV1): SearcherProductionEvidenceOwnerV1 {
  const state = new ProductionEvidenceOwnerStateV1(input);
  const owner: SearcherProductionEvidenceOwnerV1 = Object.freeze({
    bindServing: (
      startup: StartupRuntimeV1,
      performanceRuntime?: RuntimeReleasePerformanceRuntimeServiceV1,
    ) => state.bindServing(startup, performanceRuntime),
    replay: () => state.replay(),
    close: () => state.close(),
  });
  ownersIssued.add(owner);
  return owner;
}

export function assertIssuedSearcherProductionEvidenceOwnerV1(value: unknown): asserts value is SearcherProductionEvidenceOwnerV1 {
  if (value === null || typeof value !== "object" || !ownersIssued.has(value)) throw new TypeError("searcher production evidence owner is not owner-issued");
}

export function assertIssuedSearcherProductionEvidencePortsV1(value: unknown): asserts value is SearcherProductionEvidencePortsV1 {
  if (value === null || typeof value !== "object" || !portsIssued.has(value)) throw new TypeError("searcher production evidence ports are not owner-issued");
}

/** Structural/offline integration has no production runtime anchor. */
export interface MissingExternalRuntimeAnchorEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.searcher-production-evidence-status";
  readonly factStatus: "incomplete";
  readonly reasonCode: "external-runtime-anchor-missing";
  readonly runtimeAnchorReceipt: null;
}

const MISSING_EXTERNAL_RUNTIME_ANCHOR_EVIDENCE: MissingExternalRuntimeAnchorEvidenceV1 = Object.freeze({
  schemaVersion: 1,
  kind: "aloha.searcher-production-evidence-status",
  factStatus: "incomplete",
  reasonCode: "external-runtime-anchor-missing",
  runtimeAnchorReceipt: null,
});

export function missingExternalRuntimeAnchorEvidenceV1(): MissingExternalRuntimeAnchorEvidenceV1 {
  return MISSING_EXTERNAL_RUNTIME_ANCHOR_EVIDENCE;
}
