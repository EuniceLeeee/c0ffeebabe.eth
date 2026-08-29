import type { Hash, PerformanceFactBundleV1 } from "../../../specs/performance/src/index.ts";

export {
  DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
  PERFORMANCE_ACCEPTANCE_RECEIPT_SCHEMA_MANIFEST,
  PERFORMANCE_FACT_BUNDLE_SCHEMA_MANIFEST,
  PERFORMANCE_FACT_ENVELOPE_SCHEMA_MANIFEST,
  PERFORMANCE_CANDIDATE_SET_SCHEMA_MANIFEST,
  PERFORMANCE_CANDIDATE_TERMINAL_SCHEMA_MANIFEST,
  PERFORMANCE_ELIGIBLE_HEAD_SCHEMA_MANIFEST,
  PERFORMANCE_EVENT_SCHEMA_MANIFEST,
  PERFORMANCE_HEAD_TERMINAL_SCHEMA_MANIFEST,
  PERFORMANCE_METRIC_SAMPLE_SCHEMA_MANIFEST,
  PERFORMANCE_GENERATION_SEGMENT_SCHEMA_MANIFEST,
  PERFORMANCE_ORPHAN_REPLACEMENT_SCHEMA_MANIFEST,
  PERFORMANCE_OUTCOMES,
  PERFORMANCE_PERCENTILE_ALGORITHM,
  PERFORMANCE_PERCENTILES,
  PERFORMANCE_SCHEMA_MANIFESTS,
  PERFORMANCE_SCHEMA_MANIFESTS_ALL,
  PERFORMANCE_PROFILE_SCHEMA_MANIFEST,
  PERFORMANCE_TARGET_COUNT,
  PERFORMANCE_WINDOW_COMMITMENT_SCHEMA_MANIFEST,
  PERFORMANCE_WINDOW_RECEIPT_SCHEMA_MANIFEST,
  createCandidateSet,
  createCandidateTerminalReceipt,
  createEligibleHeadRecord,
  createHeadOrphanReplacementLineage,
  createHeadTerminalReceipt,
  createPerformanceAcceptanceReceipt,
  createPerformanceFactEnvelope,
  createPerformanceEvent,
  createPerformanceMetricSample,
  createPerformanceGenerationSegment,
  createPerformanceWindowCommitment,
  createPerformanceWindowReceipt,
  decodeCandidateSet,
  decodeCandidateTerminalReceipt,
  decodeEligibleHeadRecord,
  decodeHeadOrphanReplacementLineage,
  decodeHeadTerminalReceipt,
  decodePerformanceAcceptanceReceipt,
  decodePerformanceFactBundle,
  decodePerformanceFactEnvelope,
  decodePerformanceEvent,
  decodePerformanceMetricSample,
  decodePerformanceGenerationSegment,
  decodePerformanceWindowCommitment,
  decodePerformanceWindowReceipt,
  decodeProductionPerformanceProfile,
  encodeCandidateSet,
  encodeCandidateTerminalReceipt,
  encodeHeadOrphanReplacementLineage,
  encodeHeadTerminalReceipt,
  encodePerformanceAcceptanceReceipt,
  encodePerformanceFactBundle,
  encodePerformanceFactEnvelope,
  encodePerformanceEvent,
  encodePerformanceMetricSample,
  encodePerformanceGenerationSegment,
  encodePerformanceWindowCommitment,
  encodePerformanceWindowReceipt,
  encodeProductionPerformanceProfile,
  encodeEligibleHeadRecord,
  hashCandidateBearingHeadSetRoot,
  hashCandidatePathTimingSampleRoot,
  hashCandidateSet,
  hashEligibleHeadRecord,
  hashCandidateTerminalReceipt,
  hashCpuMemoryEventLoopRoot,
  hashFullHeadTimingSampleRoot,
  hashHeadOrphanReplacementLineage,
  hashHeadTerminalReceipt,
  hashMetricRecomputationRoot,
  hashQueueTelemetryRoot,
  hashResourceSampleRoot,
  hashTimingSampleRoot,
  hashWorkerRestartRoot,
  hashOrderedCandidateTerminalReceiptRoot,
  hashOrderedEligibleHeadRecordsRoot,
  hashOrderedHeadTerminalReceiptRoot,
  hashOrphanReplacementLineageRoot,
  hashPerformanceAcceptanceReceipt,
  hashPerformanceFactBundleBytes,
  hashPerformanceFactEnvelope,
  hashPerformanceMetricSample,
  hashPerformanceGenerationSegment,
  hashPerformanceGenerationSegmentRoot,
  derivePerformanceGenerationSegments,
  hashPerformanceWindowCommitment,
  hashPerformanceSemanticReceiptSetRoot,
  hashPerformanceWindowReceipt,
  hashProcessLogAnchor,
  hashProductionPerformanceProfile,
  hashRawReceiptSetRoot,
  isHealthyPerformanceOutcome,
  type CandidateSetV1,
  type CandidateTerminalReceiptV1,
  type CpuMemoryEventLoopSampleV1,
  type EligibleHeadRecordV1,
  type HeadOrphanReplacementLineageV1,
  type HeadTerminalReceiptV1,
  type Hash,
  type PerformanceAcceptanceReceiptV1,
  type PerformanceFactBundleV1,
  type PerformanceEventV1,
  type PerformanceFactEnvelopeDraftV1,
  type PerformanceFactEnvelopeV1,
  type PerformanceHeadOutcomeV1,
  type PerformanceMetricSampleV1,
  type PerformanceGenerationSegmentV1,
  type PerformanceWindowCommitmentV1,
  type PerformanceWindowReceiptV1,
  type PermitAccountingV1,
  type ProcessLogAnchorV1,
  type ProductionPerformanceProfileV1,
  type QueueTelemetryV1,
  type ResourceSampleV1,
  type WorkerRestartSampleV1,
} from "../../../specs/performance/src/index.ts";

/**
 * The generic acceptance envelope may carry performance facts as one qualified
 * fact object.  The adapter never trusts a producer verdict; it only accepts
 * this object after every nested fact is decoded by the executable schemas.
 */
export interface PerformanceQualifiedObservationV1 {
  readonly observationId: string;
  readonly rawFactIds: readonly Hash[];
  readonly qualifiedClaimIds: readonly Hash[];
}

export interface PerformanceRuntimeFactsV1 {
  readonly facts: readonly unknown[];
  readonly refs: readonly unknown[];
  readonly claims: readonly unknown[];
  readonly observations: readonly PerformanceQualifiedObservationV1[];
}

export type PerformancePredicateInputV1 = PerformanceFactBundleV1 | PerformanceRuntimeFactsV1;

export function isPerformanceFactBundle(value: unknown): value is PerformanceFactBundleV1 {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "profile" in value && "commitment" in value && "heads" in value && "lineages" in value
    && "candidateSets" in value && "candidateTerminals" in value && "metrics" in value
    && "terminals" in value && "generationSegments" in value && "windowReceipt" in value;
}

export function unwrapPerformanceFacts(input: PerformancePredicateInputV1): {
  readonly bundle: unknown;
  readonly observations: readonly PerformanceQualifiedObservationV1[];
  readonly envelope: boolean;
} | null {
  if (isPerformanceFactBundle(input)) return Object.freeze({ bundle: input, observations: [], envelope: false });
  if (input === null || typeof input !== "object" || !Array.isArray(input.facts)) return null;
  const bundle = input.facts.find(isPerformanceFactBundle);
  if (bundle === undefined) return null;
  if (input.observations.length === 0) return null;
  return Object.freeze({ bundle, observations: input.observations, envelope: true });
}
