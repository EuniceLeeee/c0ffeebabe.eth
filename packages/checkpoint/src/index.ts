import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  assertExactKeys,
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  decodeExactObject,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  readOwnEnumerableDataProperty,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  EMPTY_PROBE_RECEIPT_LINEAGE_ROOT,
  assertPromotablePartition,
  candidateFinalOutcomeHash,
  sealProbeReceipt,
  validateAttestationPartition,
  validateCandidateFinalOutcome,
  decodeAttestationIdentityCommitmentV1,
  attestationPartialIdentitySemanticHash,
  validateRejectionEvidenceBundle,
  validateIdentityObservation,
  type AttestationOutcomeCapabilityV1,
  type AttestationValidationAuthorityV1,
  type AttestationEvidenceAuthoritySnapshotV1,
  type AttestationPartitionCapabilityV1,
  type AttestationWriterCapabilityV1,
  type AttestationPersistenceCapabilityV1,
  type AttestationPersistenceBatchClaimV1,
  type AttestationPersistedOutcomeV1,
  type AttestationIdentityResumeCapabilityV1,
  type AttestationOutcomeResumeCapabilityV1,
  type AttestationVerifiedMemoReuseCapabilityV1,
  type IdentityVerifiedV1,
  validateProbeReceipt,
  type AttestationPartitionV1,
  type CandidateFinalOutcomeV1,
  type RejectionEvidenceBundleV2,
  type ProbeReceiptV1,
  type ProbeStorePort,
  type StoredRetryableProbeV1,
  type RetryableProbeCapabilityV1,
} from "../../attestation/src/index.ts";
import { assertAttestationValidationAuthority } from "../../attestation/src/internal/validation-authority-verifier.ts";
import {
  rehydrateIdentityResumeCapabilityForCheckpoint,
  rehydrateOutcomeResumeCapabilityForCheckpoint,
  rehydrateVerifiedMemoReuseCapabilityForCheckpoint,
} from "../../attestation/src/internal/validation-authority-rehydrator.ts";
import {
  candidatePartitionKeysRoot,
  createCandidatePartitionCommitmentV1,
  decodeCandidatePartitionCommitmentBytesV1,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  decodeNominationClosureV1,
  decodePersistedNominationClosureV1,
  encodePersistedNominationClosureV1,
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  type NominationClaimChunkRefV1,
  type NominationClosureV1,
} from "../../../specs/nomination-authority/src/index.ts";
import {
  CandidatePartitionCapabilityRegistryV1,
  consumeCandidatePartitionBootstrap,
  createCandidatePartitionBootstrap,
  type CandidatePartitionBootstrapV1,
} from "./candidate-partition.ts";
import { bindCheckpointDurableAuthorityLayoutV1 } from "./durable-authority-layout.ts";
import {
  decodeInstanceCatalogV1,
  encodeInstanceCatalogV1,
  sealInstanceCatalog,
  validateInstanceCatalog,
  validateInstancePublication,
  type InstanceCatalogPublicationChunkRefV1,
  type InstanceCatalogV1,
  type InstancePublicationV1,
} from "../../catalog/src/index.ts";
import {
  candidatePartitionRoot,
  decodeCanonicalCutoff,
  decodePersistedSourcePlanExecutionSet,
  decodeSourcePlanEvidenceReceipt,
  sourcePlanIdentity,
  validateSourceCoverageCertificate,
  validateSourcePlanEvidenceReceipts,
  validatePersistedExecutionCoverage,
  type CanonicalCutoffV1,
  type CandidateRecordV1,
  type SourceCoverageCertificateV1,
  type SourcePlanEvidenceReceiptV1,
  type SourcePlanRefV1,
  type PersistedSourcePlanExecutionSetV1,
} from "../../discovery/src/index.ts";
import {
  decodePersistedGraphV1,
  encodePersistedGraphV1,
  validatePersistedGraphForCatalog,
  type ActiveReadyAuthorityBindingV1,
  type PersistedGraphEdgeChunkRefV1,
  type PersistedGraphV1,
} from "../../graph/src/index.ts";
import {
  validateRecentObservationReceipt,
  type RawEvidenceLocatorContentV1,
  type RecentObservationReceiptV1,
} from "../../observation/src/index.ts";
import type {
  BeginRunInputV1,
  BuilderCheckpointPort,
  BuilderCheckpointRootV1,
  InProgressBuilderRunV1,
  SourcePlanPredecessorClosureV1,
} from "../../generation-builder/src/index.ts";
import {
  assertIssuedReadyPromotionAuthorityPort,
  type ReadyCommitResultV1,
  type ReadyGenerationV1,
  type ReadyGenerationBaseV1,
  type ReadyStageInputV1,
  type ReadyStageResultV1,
  type ReadyActivationInputV1,
  type ReadyPromotionAuthorityGuardPort,
  type ReadyPromotionAbandonAuthorizationV1,
  type ReadyPromotionAbandonResultV1,
  type ReadyPromotionDurableStateV1,
  type ReadyStageIdentityV1,
  type ReadyStorePort,
  type CanonicalFenceV1,
  type SealedRunCapabilityV1,
} from "../../ready-generation/src/index.ts";
import type { SealedRunSnapshotV1 } from "../../sealed-run-runtime/src/contract.ts";
import type { SealedRunReaderPortV1 } from "../../sealed-run-runtime/src/contract.ts";
import { SealedRunCapabilityRegistryV1, sealedRunBinding } from "./sealed-run.ts";
import {
  assertVerifiedPublicationCatalog,
  generationRefreshPolicyHash,
  readyGenerationBaseHash,
  ReadyPromotionFatalError,
  ReadyPromotionRetryError,
  assertReadyPromotionAbandonAuthorization,
  validateReadyStageIdentity,
  validateReadyGenerationBase,
  validateReadyGeneration,
} from "../../ready-generation/src/index.ts";
import { CanonicalSource } from "../../canonical-source/src/index.ts";
import {
  CASConflictError,
  CorruptDurableStoreError,
  DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN,
  SQLiteDurableStore,
  type DurableContentRecord,
  type DurableRootRecord,
  type DurableTransaction,
  type WriterLease,
} from "../../durable-store/src/index.ts";
import {
  type ReadyStage12EvidenceBindingV1,
  type ReadyStage12EvidenceCapabilityV1,
  type ReadyStage12EvidenceReaderPortV1,
  type ReadyStage12EvidenceSnapshotV1,
} from "./ready-stage12-evidence.ts";
import {
  decodeRuntimeAuthorityProjectionV1,
} from "../../runtime-authority/src/index.ts";
import { registerCheckpointReadyStage12EvidenceReader } from "./internal/ready-stage12-evidence-issuer.ts";
import { assertCheckpointSixStepArtifactPortV1 } from "./internal/six-step-artifact-port-owner.ts";
import type {
  ReadyFullFamilyEvidenceReaderPortV1,
  ReadyFullFamilyEvidenceSnapshotV1,
} from "./ready-full-family-evidence.ts";
import { registerCheckpointReadyFullFamilyEvidenceReader } from "./internal/ready-full-family-evidence-issuer.ts";

export type {
  ReadyStage12EvidenceBindingV1,
  ReadyStage12EvidenceCapabilityV1,
  ReadyStage12EvidenceReaderPortV1,
  ReadyStage12EvidenceSnapshotV1,
  ReadyStage12VerifiedInstanceV1,
} from "./ready-stage12-evidence.ts";
export type {
  ReadyFullFamilyEvidenceReaderPortV1,
  ReadyFullFamilyEvidenceSnapshotV1,
} from "./ready-full-family-evidence.ts";
export {
  CHECKPOINT_DURABLE_LAYOUT_V1,
  bindCheckpointDurableAuthorityLayoutV1,
  checkpointDurableAuthorityLayoutV1,
  type CheckpointDurableAuthorityLayoutV1,
} from "./durable-authority-layout.ts";
export {
  CandidatePartitionCapabilityRegistryV1,
  type CandidatePartitionRawEvidenceSourceV1,
} from "./candidate-partition.ts";

const CHECKPOINT_ROOT_KIND = "aloha/checkpoint-root/v1";
const RUN_KIND = "aloha/in-progress-run/v1";
const CANDIDATE_KIND = "aloha/candidate-record/v2";
const CANDIDATE_PARTITION_COMMITMENT_KIND = "aloha/candidate-partition-commitment/v2";
const CANDIDATE_PARTITION_AUTHORITY_KIND = "aloha/candidate-partition-commitment/v1";
const OUTCOME_KIND = "aloha/candidate-final-outcome/v1";
const PARTIAL_OUTCOME_KIND = "aloha/attestation-partial-outcome/v1";
const REJECTION_BUNDLE_KIND = "aloha/rejection-evidence-bundle/v2";
const REJECTION_REQUEST_RAW_KIND = "aloha/rejection-request-raw/v1";
const REJECTION_TRANSPORT_RAW_KIND = "aloha/rejection-transport-raw/v1";
const REJECTION_EFFECT_RAW_KIND = "aloha/rejection-effect-raw/v1";
const REJECTION_DECISION_RAW_KIND = "aloha/rejection-decision-raw/v1";
const ATTESTATION_PARTITION_KIND = "aloha/attestation-partition/v1";
const RAW_EVIDENCE_LOCATOR_KIND = "aloha/raw-evidence-locator/v1";
const PARTITION_PAGE_KIND = "aloha/checkpoint-partition-page/v1";
const PARTITION_MANIFEST_KIND = "aloha/checkpoint-partition-manifest/v1";
const RECENT_OBSERVATION_KIND = "aloha/recent-observation/v1";
const SOURCE_COVERAGE_KIND = "aloha/source-coverage/v1";
const SOURCE_EXECUTION_SET_KIND = "aloha/persisted-source-plan-execution-set/v1";
const SOURCE_PLAN_EVIDENCE_KIND = "aloha/source-plan-evidence/v1";
const NOMINATION_CLOSURE_KIND = "aloha/nomination-closure/v1";
const NOMINATION_CLAIM_CHUNK_KIND = "aloha/nomination-claim-chunk/v1";
const VERIFIED_MEMO_SET_KIND = "aloha/verified-memo-set/v1";
const INSTANCE_CATALOG_KIND = "aloha/instance-catalog-manifest/v1";
const INSTANCE_CATALOG_CHUNK_KIND = "aloha/instance-catalog-publication-chunk/v1";
const GRAPH_KIND = "aloha/persisted-graph-manifest/v1";
const GRAPH_CHUNK_KIND = "aloha/persisted-graph-edge-chunk/v1";
const READY_CLOSURE_KIND = "aloha/ready-closure/v1";
const READY_STAGE_KIND = "aloha/ready-stage/v1";
const DIAGNOSTIC_KIND = "aloha/checkpoint-diagnostic/v1";
const PROBE_RECEIPT_KIND = "aloha/probe-transition-receipt/v1";
const PARTITION_PAGE_SIZE = 128;
const EMPTY_MEMO_SEED_LINEAGE_ROOT = hashDomain("aloha/memo-seed-lineage-empty/v1", {});

/**
 * Process-local identity for the checkpoint owner.  A structural object with
 * the same public methods must never be accepted as the runtime-owned
 * persisted-attestation checkpoint edge.
 */
const checkpointStoreInstances = new WeakSet<object>();

type DurableContentReader = (hash: Hash) => DurableContentRecord | null;

const ROOT_FIELDS = ["revision", "verifiedMemoRoot", "inProgressRunId", "stagedReadyStorageHash", "latestMemoSeedReceiptHash", "memoSeedSequence", "memoSeedLineageRoot", "latestProbeReceiptHash", "probeReceiptSequence", "probeReceiptLineageRoot", "readyGenerationId", "readyGenerationRecordHash", "schemaHash"] as const;
const RUN_FIELDS = ["runId", "parentGenerationId", "checkpointRevision", "candidatePartitionRevision", "cutoff", "recentObservationRoot", "recentObservationStorageHash", "definitionCatalogRoot", "sourceCoverageRoot", "sourceCoverageStorageHash", "sourceExecutionSetRoot", "sourceExecutionSetStorageHash", "sourcePlanEvidenceStorageHash", "nominationClosureRoot", "nominationClosureStorageHash", "candidatePartitionRoot", "candidatePartitionStorageHash", "candidatePartitionCommitmentStorageHash", "candidateRecordCount", "outcomePartitionRoot", "outcomePartitionStorageHash", "partialOutcomePartitionStorageHash", "attestationPartitionStorageHash", "verifiedMemoSetRoot", "verifiedMemoSetStorageHash", "accounting"] as const;
const PARTITION_MANIFEST_FIELDS = ["runId", "partitionKind", "count", "pageStorageHashes"] as const;
const PARTITION_PAGE_FIELDS = ["runId", "partitionKind", "pageIndex", "entries"] as const;
const VERIFIED_MEMO_SET_FIELDS = ["schemaVersion", "kind", "memoCount", "memoCatalogRoot", "retainedRawLocatorCount", "retainedRawLocatorSequenceRoot", "verifiedMemoSetRoot"] as const;
const CANDIDATE_PARTITION_COMMITMENT_FIELDS = ["readyRecordHash", "runId", "cutoff", "candidatePartitionRoot", "candidatePartitionStorageHash", "nominationClosureRoot", "nominationClosureStorageHash", "candidateRecordCount", "candidateKeysRoot", "recentObservationRoot", "sourceCoverageRoot", "checkpointRevision", "candidatePartitionCommitmentStorageHash", "exactOutcomePartitionRoot", "sealedRevision", "stageRevision", "stageRecordHash", "readyBaseHash"] as const;
const READY_CLOSURE_FIELDS = ["ready", "candidatePartitionStorageHash", "outcomePartitionStorageHash", "attestationPartitionStorageHash", "nominationClosureRoot", "nominationClosureStorageHash", "candidateRecordCount", "candidateKeysRoot", "recentObservationRoot", "sourceCoverageRoot", "candidatePartitionRevision", "sourceCoverageStorageHash", "sourceExecutionSetRoot", "sourceExecutionSetStorageHash", "sourcePlanEvidenceStorageHash", "candidatePartitionReadyCommitmentStorageHash", "candidatePartitionCommitmentStorageHash", "verifiedMemoSetStorageHash", "instanceCatalogStorageHash", "graphStorageHash"] as const;
const READY_STAGE_FIELDS = ["stageRevision", "stageRecordHash", "expectedRevision", "runId", "readyBase", "readyBaseHash", "sourceCoverageStorageHash", "sourceExecutionSetRoot", "sourceExecutionSetStorageHash", "sourcePlanEvidenceStorageHash", "nominationClosureRoot", "nominationClosureStorageHash", "verifiedMemoSetStorageHash", "instanceCatalogStorageHash", "graphStorageHash", "sealedRevision"] as const;
const MEMO_SEED_RECEIPT_FIELDS = ["runId", "cutoff", "reason", "sealedRevision", "definitionCatalogRoot", "checkpointSchemaHash", "candidatePartitionRoot", "sourceCoverageRoot", "exactOutcomePartitionRoot", "verifiedMemoRoot", "canonicalJournalEpoch", "canonicalJournalRoot", "sequence", "priorReceiptHash", "priorLineageRoot", "receiptLineageRoot"] as const;
const STORED_PROBE_RECEIPT_FIELDS = ["receipt", "candidatePartitionStorageHash", "priorOutcomePartitionStorageHash", "activeOutcomePartitionStorageHash"] as const;

export const CHECKPOINT_SCHEMA_MANIFEST = deepFreeze({
  id: "aloha.checkpoint-durable-closure",
  version: "15.0.0",
  physicalEnvelope: {
    hashDomain: DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN,
    identityFields: ["kind", "payloadHash", "references"],
  },
  partition: {
    pageSize: String(PARTITION_PAGE_SIZE),
    kinds: ["candidate", "outcome", "partial-outcome"],
    outcomeRootDomain: "aloha/checkpoint-outcome-partition/v1",
    outcomeLeafDomain: "aloha/candidate-outcomes/v1",
  },
  records: [
    { kind: CHECKPOINT_ROOT_KIND, fields: ROOT_FIELDS, codecAuthority: "checkpoint.decodeRoot", referenceContract: "exact active memo + optional active run + optional active ready closure + optional latest memo-seed receipt; no extra physical references" },
    { kind: RUN_KIND, fields: RUN_FIELDS, codecAuthority: "checkpoint.decodeRun", referenceContract: "exact run closure including source-plan evidence and its raw locator envelopes" },
    { kind: CANDIDATE_KIND, fields: ["kind", "version", "familyId", "familyDefinitionHash", "instanceNominationKey", "familyCandidateKey", "candidateSubjectHash", "candidateEvidenceRoot", "evidence"], codecAuthority: "discovery.CandidateRecordV1", referenceContract: "all and only raw locator physical envelopes named by evidence" },
    { kind: CANDIDATE_PARTITION_COMMITMENT_KIND, fields: CANDIDATE_PARTITION_COMMITMENT_FIELDS, codecAuthority: "checkpoint.decodeCandidatePartitionCommitment", referenceContract: "exact candidate partition content commitment + candidate manifest/record closure" },
    { kind: CANDIDATE_PARTITION_AUTHORITY_KIND, codecAuthority: "candidate-partition-authority.decodeCandidatePartitionCommitmentV1", referenceContract: "exact content commitment for the active run" },
    { kind: OUTCOME_KIND, variants: {
      verified: ["kind", "runCandidateKey", "familyCandidateKey", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "instanceKey", "publication", "identityCommitment", "outcomeCommitment"],
      chainProvenRejected: ["kind", "runCandidateKey", "familyCandidateKey", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "proof", "rejectionEvidence", "identityCommitment", "outcomeCommitment"],
      retryable: ["kind", "runCandidateKey", "familyCandidateKey", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "failure", "identityCommitment", "outcomeCommitment"],
      invalidProgram: ["kind", "runCandidateKey", "familyCandidateKey", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "failure", "identityCommitment", "outcomeCommitment"],
    }, codecAuthority: "attestation.validateCandidateFinalOutcome", referenceContract: "chainProvenRejected: exactly one rejection evidence bundle; all other variants: no physical references", semanticHashDomain: "aloha/candidate-final-outcome/v1" },
    { kind: PARTIAL_OUTCOME_KIND, fields: ["runId", "candidatePartitionRoot", "familyCandidateKey", "outcomeHash", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "kind", "identity", "outcome"], codecAuthority: "attestation.AttestationPersistedOutcomeV1", referenceContract: "exact partial identity commitment; no physical references" },
    { kind: REJECTION_BUNDLE_KIND, fields: ["kind", "version", "issuerId", "runId", "chainId", "cutoffNumber", "cutoffHash", "cutoffStateRoot", "stage", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash", "identitySubjectHash", "instanceNominationKey", "executorAuthorityRoot", "workerEpoch", "executorSessionHash", "executionSessionHash", "request", "transportFacts", "effectObservations", "decisionCode", "decisionBytesHex", "requestFingerprint", "orderedTransportFactsRoot", "effectObservationRoot", "decisionBytesHash", "evidenceBundleRoot"], codecAuthority: "attestation.validateRejectionEvidenceBundle", referenceContract: "exactly one request raw + ordered transport raw + ordered effect raw + one decision raw; no extras" },
    { kind: REJECTION_REQUEST_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.request.canonicalBytesHex", referenceContract: "none" },
    { kind: REJECTION_TRANSPORT_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.transportFacts[*].canonicalBytesHex", referenceContract: "none" },
    { kind: REJECTION_EFFECT_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.effectObservations[*].canonicalBytesHex", referenceContract: "none" },
    { kind: REJECTION_DECISION_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.decisionBytesHex", referenceContract: "none" },
    { kind: ATTESTATION_PARTITION_KIND, fields: ["schemaVersion", "kind", "runId", "cutoff", "candidatePartitionRoot", "outcomeCount", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "accounting", "exactOutcomePartitionRoot"], codecAuthority: "checkpoint.decodeAttestationPartitionRecordWith+attestation.validateAttestationPartition", referenceContract: "exact outcome partition manifest" },
    { kind: RAW_EVIDENCE_LOCATOR_KIND, wire: "opaque-bytes", codecAuthority: "sha256(raw locator bytes)", referenceContract: "none" },
    { kind: PARTITION_PAGE_KIND, fields: PARTITION_PAGE_FIELDS, codecAuthority: "checkpoint.loadPartition", referenceContract: "exact ordered entry storage envelopes" },
    { kind: PARTITION_MANIFEST_KIND, fields: PARTITION_MANIFEST_FIELDS, codecAuthority: "checkpoint.loadPartition", referenceContract: "exact ordered page storage envelopes" },
    { kind: RECENT_OBSERVATION_KIND, fields: ["cutoff", "range", "orderedHeaders", "evidence", "observationRoot"], codecAuthority: "observation.validateRecentObservationReceipt", referenceContract: "all and only raw locator physical envelopes named by observation evidence" },
    { kind: SOURCE_COVERAGE_KIND, fields: ["cutoff", "entries", "sourceCoverageRoot"], codecAuthority: "discovery.validateSourceCoverageCertificate", referenceContract: "none" },
    { kind: SOURCE_EXECUTION_SET_KIND, fields: ["kind", "version", "cutoff", "executions", "executionSetRoot"], codecAuthority: "discovery.decodePersistedSourcePlanExecutionSet", referenceContract: "all and only raw locator physical envelopes named by the exact persisted executions; predecessor roots resolve through the active parent ready closure" },
    { kind: SOURCE_PLAN_EVIDENCE_KIND, wire: "canonical-array", codecAuthority: "discovery.decodeSourcePlanEvidenceReceipt", referenceContract: "all and only raw locator physical envelopes named by source-plan evidence receipts" },
    { kind: NOMINATION_CLOSURE_KIND, codecAuthority: "nomination-authority.decodePersistedNominationClosureV1", referenceContract: "all and only linked claim chunks + exact recent observation + source coverage + persisted source execution set + source-plan evidence + candidate manifest", semanticHashDomain: "aloha/nomination-closure/v1" },
    { kind: NOMINATION_CLAIM_CHUNK_KIND, fields: ["schemaVersion", "kind", "sourcePlanIdentity", "claims", "relevantEvidenceRefHashes", "nextClaimChunkRef"], codecAuthority: "nomination-authority.decodePersistedNominationClosureV1", referenceContract: "none" },
    { kind: VERIFIED_MEMO_SET_KIND, fields: VERIFIED_MEMO_SET_FIELDS, codecAuthority: "checkpoint.decodeMemoSetRecordWith+catalog.decodeInstanceCatalogV1", referenceContract: "exact memo catalog manifest/chunks plus all and only retained raw locator physical envelopes", semanticHashDomain: "aloha/verified-memo-set/v3" },
    { kind: INSTANCE_CATALOG_KIND, fields: ["schemaVersion", "kind", "cutoff", "instanceCount", "publicationSequenceRoot", "publicationChunkCount", "firstPublicationChunkRef", "instanceCatalogRoot"], codecAuthority: "catalog.decodeInstanceCatalogV1", referenceContract: "all and only linked publication chunks" },
    { kind: INSTANCE_CATALOG_CHUNK_KIND, fields: ["schemaVersion", "kind", "publications", "nextPublicationChunkRef"], codecAuthority: "catalog.decodeInstanceCatalogV1", referenceContract: "none" },
    { kind: GRAPH_KIND, fields: ["schemaVersion", "kind", "cutoff", "instanceCatalogRoot", "edgeCount", "edgeSequenceRoot", "edgeChunkCount", "firstEdgeChunkRef", "graphRoot"], codecAuthority: "graph.decodePersistedGraphV1", referenceContract: "all and only linked edge chunks", semanticHashDomain: "aloha/persisted-graph/v2" },
    { kind: GRAPH_CHUNK_KIND, fields: ["schemaVersion", "kind", "edges", "nextEdgeChunkRef"], codecAuthority: "graph.decodePersistedGraphV1", referenceContract: "none" },
    { kind: READY_CLOSURE_KIND, fields: READY_CLOSURE_FIELDS, codecAuthority: "checkpoint.decodeReadyClosure", referenceContract: "exact source coverage + candidate manifest/records + outcome manifest/records + attestation partition + ready commitment + candidate partition commitment + verified memo + instance catalog + graph", semanticHashDomain: "aloha/ready-generation/v1" },
    { kind: READY_STAGE_KIND, fields: READY_STAGE_FIELDS, codecAuthority: "checkpoint.decodeReadyStage", referenceContract: "exact source coverage + verified memo + instance catalog + graph; staged is never a serving authority", semanticHashDomain: "aloha/ready-stage/v1" },
    { kind: DIAGNOSTIC_KIND, fields: MEMO_SEED_RECEIPT_FIELDS, codecAuthority: "checkpoint.decodeMemoSeedReceipt", referenceContract: "exact prior memo-seed receipt when sequence is greater than one" },
    { kind: PROBE_RECEIPT_KIND, fields: STORED_PROBE_RECEIPT_FIELDS, codecAuthority: "checkpoint.decodeStoredProbeReceipt+attestation.validateProbeReceipt", referenceContract: "exact prior probe receipt plus the immutable candidate and before/after outcome partitions", semanticHashDomain: "aloha/single-instance-probe-receipt/v2" },
  ],
});

export function checkpointSchemaHash(manifest: unknown = CHECKPOINT_SCHEMA_MANIFEST): Hash {
  return hashDomain("aloha/checkpoint-executable-schema-manifest/v1", manifest);
}

export const CHECKPOINT_SCHEMA_HASH = checkpointSchemaHash();

export interface CheckpointRootV1 {
  readonly revision: string;
  readonly verifiedMemoRoot: Hash;
  readonly inProgressRunId: string | null;
  readonly stagedReadyStorageHash: Hash | null;
  readonly latestMemoSeedReceiptHash: Hash | null;
  readonly memoSeedSequence: string;
  readonly memoSeedLineageRoot: Hash;
  readonly latestProbeReceiptHash: Hash | null;
  readonly probeReceiptSequence: string;
  readonly probeReceiptLineageRoot: Hash;
  readonly readyGenerationId: string | null;
  readonly readyGenerationRecordHash: Hash | null;
  readonly schemaHash: Hash;
}

interface RunAccountingV1 {
  readonly pending: string;
  readonly verified: string;
  readonly chainProvenRejected: string;
  readonly retryable: string;
  readonly invalidProgram: string;
}

interface AttestationPartitionManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.attestation-partition-manifest-v1";
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly outcomeCount: string;
  readonly runtimeAuthority: import("../../runtime-authority/src/index.ts").RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly accounting: RunAccountingV1;
  readonly exactOutcomePartitionRoot: Hash;
}

interface StoredRunEnvelopeV2 {
  readonly runId: string;
  readonly parentGenerationId: string | null;
  readonly checkpointRevision: string;
  /** Immutable revision at which the candidate partition commitment was created. */
  readonly candidatePartitionRevision: string;
  readonly cutoff: CandidateRecordV1 extends never ? never : BeginRunInputV1["cutoff"];
  readonly recentObservationRoot: Hash;
  readonly recentObservationStorageHash: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly sourceCoverageStorageHash: Hash;
  readonly sourceExecutionSetRoot: Hash;
  readonly sourceExecutionSetStorageHash: Hash;
  readonly sourcePlanEvidenceStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly candidatePartitionCommitmentStorageHash: Hash;
  readonly candidateRecordCount: string;
  readonly outcomePartitionRoot: Hash;
  readonly outcomePartitionStorageHash: Hash;
  readonly partialOutcomePartitionStorageHash: Hash | null;
  readonly attestationPartitionStorageHash: Hash | null;
  readonly verifiedMemoSetRoot: Hash;
  readonly verifiedMemoSetStorageHash: Hash;
  readonly accounting: RunAccountingV1;
}

function runContentReferences(run: StoredRunEnvelopeV2): readonly Hash[] {
  return Object.freeze([
    run.recentObservationStorageHash,
    run.sourceCoverageStorageHash,
    run.sourceExecutionSetStorageHash,
    run.sourcePlanEvidenceStorageHash,
    run.nominationClosureStorageHash,
    run.candidatePartitionStorageHash,
    run.candidatePartitionCommitmentStorageHash,
    run.outcomePartitionStorageHash,
    ...(run.partialOutcomePartitionStorageHash === null ? [] : [run.partialOutcomePartitionStorageHash]),
    ...(run.attestationPartitionStorageHash === null ? [] : [run.attestationPartitionStorageHash]),
    run.verifiedMemoSetStorageHash,
  ]);
}

/** Internal hydration view; raw candidates never cross the checkpoint port. */
type InternalBuilderRunV1 = Omit<InProgressBuilderRunV1, "candidatePartition" | "candidatePartitionBinding"> & {
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  readonly candidatePartitionBinding: import("../../../specs/candidate-partition-authority/src/index.ts").CandidatePartitionCommitmentV1;
  readonly candidates: readonly CandidateRecordV1[];
};

interface RetryableProbeCapabilityStateV1 {
  readonly runId: string;
  readonly familyCandidateKey: Hash;
  readonly expectedOutcomeHash: Hash;
  readonly checkpointRevision: string;
  readonly candidateSubjectHash: Hash;
  readonly candidatePartitionBinding: import("../../../specs/candidate-partition-authority/src/index.ts").CandidatePartitionCommitmentV1;
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  used: boolean;
}

interface StoredProbeReceiptEnvelopeV1 {
  readonly receipt: ProbeReceiptV1;
  readonly candidatePartitionStorageHash: Hash;
  readonly priorOutcomePartitionStorageHash: Hash;
  readonly activeOutcomePartitionStorageHash: Hash;
}

/** Root-reachable, read-only evidence for one actually committed retryable
 * probe.  Both outcome partitions are loaded from immutable checkpoint
 * records retained by the stored receipt; no caller supplies either set. */
export interface CheckpointProbeEvidenceV1 {
  readonly receipt: ProbeReceiptV1;
  readonly beforeOutcomes: readonly CandidateFinalOutcomeV1[];
  readonly afterOutcomes: readonly CandidateFinalOutcomeV1[];
  readonly candidatePartitionStorageHash: Hash;
  readonly priorOutcomePartitionStorageHash: Hash;
  readonly activeOutcomePartitionStorageHash: Hash;
  readonly evidenceRoot: Hash;
}

/**
 * Read-only, root-reachable active-run snapshot used by the external runtime
 * restart observer.  The two storage hashes are locators into the same raw
 * SQLite content graph; they are not producer verdicts.  Acceptance reopens
 * that database and exact-joins the decoded rows to this snapshot.
 */
export interface CheckpointRuntimeRestartSnapshotV1 {
  readonly checkpointStore: CheckpointRuntimeStoreAnchorV1;
  readonly checkpointRevision: string;
  readonly checkpointRootEnvelopeHash: Hash;
  readonly runEnvelopeStorageHash: Hash;
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly outcomePartitionRoot: Hash;
  readonly candidates: readonly CandidateRecordV1[];
  readonly partials: readonly AttestationPersistedOutcomeV1[];
  readonly outcomes: readonly CandidateFinalOutcomeV1[];
  readonly probeEvidence: CheckpointProbeEvidenceV1 | null;
}

export interface CheckpointRuntimeStoreAnchorV1 {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
}

function decodeStoredProbeReceiptEnvelope(
  bytes: Uint8Array,
  context = "stored probe receipt",
): StoredProbeReceiptEnvelopeV1 {
  const value = cloneCanonical<Record<string, unknown>>(decodeCanonicalJson(bytes));
  const exact = exactObject(value, STORED_PROBE_RECEIPT_FIELDS, context);
  return deepFreeze({
    receipt: validateProbeReceipt(exact.receipt as ProbeReceiptV1),
    candidatePartitionStorageHash: assertHash(
      exact.candidatePartitionStorageHash,
      `${context}.candidatePartitionStorageHash`,
    ),
    priorOutcomePartitionStorageHash: assertHash(
      exact.priorOutcomePartitionStorageHash,
      `${context}.priorOutcomePartitionStorageHash`,
    ),
    activeOutcomePartitionStorageHash: assertHash(
      exact.activeOutcomePartitionStorageHash,
      `${context}.activeOutcomePartitionStorageHash`,
    ),
  });
}

function publicBuilderRun(run: InternalBuilderRunV1): InProgressBuilderRunV1 {
  return deepFreeze({
    runId: run.runId,
    parentGenerationId: run.parentGenerationId,
    checkpointRevision: run.checkpointRevision,
    cutoff: run.cutoff,
    recentObservation: run.recentObservation,
    sourcePlanEvidence: run.sourcePlanEvidence,
    definitionCatalogRoot: run.definitionCatalogRoot,
    sourceCoverage: run.sourceCoverage,
    sourceExecutionSet: run.sourceExecutionSet,
    nominationClosure: run.nominationClosure,
    candidatePartition: run.candidatePartition,
    candidatePartitionBinding: run.candidatePartitionBinding,
  });
}

interface PartitionEntryV1 {
  readonly key: string;
  readonly storageHash: Hash;
}

type PartitionKindV1 = "candidate" | "outcome" | "partial-outcome";

interface PartitionManifestV1 {
  readonly runId: string;
  readonly partitionKind: PartitionKindV1;
  readonly count: string;
  readonly pageStorageHashes: readonly Hash[];
}

interface ReadyClosureV1 {
  readonly ready: ReadyGenerationV1;
  /** The immutable candidate manifest remains a transitive descendant of the ready root. */
  readonly candidatePartitionStorageHash: Hash;
  /** Exact final outcomes remain reachable after the mutable run indexes are cleared. */
  readonly outcomePartitionStorageHash: Hash;
  /** The sealed partition binds the exact outcome set and authority roots. */
  readonly attestationPartitionStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidateRecordCount: string;
  readonly candidateKeysRoot: Hash;
  readonly recentObservationRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  /** The commitment's checkpointRevision (equal to the immutable candidatePartitionRevision). */
  readonly candidatePartitionRevision: string;
  readonly sourceCoverageStorageHash: Hash;
  readonly sourceExecutionSetRoot: Hash;
  readonly sourceExecutionSetStorageHash: Hash;
  readonly sourcePlanEvidenceStorageHash: Hash;
  readonly candidatePartitionReadyCommitmentStorageHash: Hash;
  readonly candidatePartitionCommitmentStorageHash: Hash;
  readonly verifiedMemoSetStorageHash: Hash;
  readonly instanceCatalogStorageHash: Hash;
  readonly graphStorageHash: Hash;
}

interface ReadyStage12EvidenceCapabilityStateV1 {
  readonly binding: ReadyStage12EvidenceBindingV1;
  readonly ready: ReadyGenerationV1;
  readonly artifacts: ReadyStage12ArtifactAuthorityV1;
}

interface ReadyStage12ArtifactAuthorityV1 {
  readonly stage1ByEdgeId: ReadonlyMap<Hash, CheckpointSixStepArtifactCapabilityV1>;
  readonly stage2ByEdgeId: ReadonlyMap<Hash, CheckpointSixStepArtifactCapabilityV1>;
}

export type CheckpointSixStepArtifactCapabilityV1 = object;

export interface CheckpointSixStepVerifiedOutcomeInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
  readonly outcome: Extract<CandidateFinalOutcomeV1, { readonly kind: "verified" }>;
  readonly sourceCoverage: SourceCoverageCertificateV1;
}

export interface CheckpointSixStepReadyEdgeInputV1 {
  readonly parent: CheckpointSixStepArtifactCapabilityV1;
  readonly ready: ReadyGenerationV1;
  readonly candidate: CandidateRecordV1;
  readonly outcome: Extract<CandidateFinalOutcomeV1, { readonly kind: "verified" }>;
  readonly publication: InstancePublicationV1;
  readonly edge: PersistedGraphV1["edges"][number];
  readonly sourceCoverage: SourceCoverageCertificateV1;
}

/** Producer-native Stage 1/2 append authority. Its issuer lives behind the
 * internal runtime composition boundary. */
export interface CheckpointSixStepArtifactPortV1 {
  readonly emitVerifiedOutcome: (
    input: CheckpointSixStepVerifiedOutcomeInputV1,
  ) => Promise<CheckpointSixStepArtifactCapabilityV1>;
  readonly emitReadyEdge: (
    input: CheckpointSixStepReadyEdgeInputV1,
  ) => Promise<CheckpointSixStepArtifactCapabilityV1>;
}

interface ReadyStageV1 {
  readonly stageRevision: string;
  readonly stageRecordHash: Hash;
  readonly expectedRevision: string;
  readonly runId: string;
  readonly readyBase: ReadyGenerationBaseV1;
  readonly readyBaseHash: Hash;
  readonly sourceCoverageStorageHash: Hash;
  readonly sourceExecutionSetRoot: Hash;
  readonly sourceExecutionSetStorageHash: Hash;
  readonly sourcePlanEvidenceStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly verifiedMemoSetStorageHash: Hash;
  readonly instanceCatalogStorageHash: Hash;
  readonly graphStorageHash: Hash;
  readonly sealedRevision: string;
}

interface CandidatePartitionCommitmentV1 {
  readonly readyRecordHash: Hash;
  readonly runId: string;
  readonly cutoff: BeginRunInputV1["cutoff"];
  readonly candidatePartitionRoot: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly nominationClosureRoot: Hash;
  readonly nominationClosureStorageHash: Hash;
  readonly candidateRecordCount: string;
  readonly candidateKeysRoot: Hash;
  readonly recentObservationRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  /** The immutable candidate partition revision bound by the content commitment. */
  readonly checkpointRevision: string;
  readonly candidatePartitionCommitmentStorageHash: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  readonly sealedRevision: string;
  readonly stageRevision: string;
  readonly stageRecordHash: Hash;
  readonly readyBaseHash: Hash;
}

export interface VerifiedMemoSetV1 {
  readonly memos: readonly InstancePublicationV1[];
  readonly retainedRawLocatorHashes: readonly Hash[];
  readonly verifiedMemoSetRoot: Hash;
}

interface VerifiedMemoSetManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.verified-memo-set-manifest-v1";
  readonly memoCount: string;
  readonly memoCatalogRoot: Hash | null;
  readonly retainedRawLocatorCount: string;
  readonly retainedRawLocatorSequenceRoot: Hash;
  readonly verifiedMemoSetRoot: Hash;
}

export interface OutcomeWriterOptions {
  readonly writerCapability: AttestationWriterCapabilityV1;
  readonly writerId?: string;
  readonly flushEveryItems?: number;
  readonly flushEveryMs?: number;
  readonly mailboxCapacity?: number;
}

/** Exact active-run difference used by the runtime-owned attestation
 * coordinator. Both sets are issued atomically from the current durable
 * closure; neither contains raw DTO authority. */
export interface AttestationResumeCapabilitiesV1 {
  readonly identity: readonly AttestationIdentityResumeCapabilityV1[];
  readonly final: readonly AttestationOutcomeResumeCapabilityV1[];
  /** Durable retryable outcomes are re-executed through the checkpoint CAS
   * edge; they are intentionally not converted into final-resume handles. */
  readonly retryable: readonly Hash[];
  /** Prior-generation verified publications, represented only by one-shot
   * process-local handles bound to exact current candidates. */
  readonly memoReuse: readonly AttestationVerifiedMemoReuseCapabilityV1[];
  /**
   * Two-phase claim for the returned process-local handles.  The checkpoint
   * does not permanently consume the durable difference until the owner has
   * successfully opened and sealed the corresponding session.  Any startup
   * failure must call abort so a same-process retry can mint a fresh handle.
   */
  readonly claim: AttestationResumeClaimV1;
}

export interface AttestationResumeClaimV1 {
  commit(): void;
  abort(): void;
}

export interface SignalHookPort {
  on(signal: "SIGTERM" | "SIGINT", handler: () => void): void;
  off?(signal: "SIGTERM" | "SIGINT", handler: () => void): void;
}

export class CheckpointError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

export class CheckpointRunStateError extends CheckpointError {
  constructor(message: string) {
    super("run-state", message);
  }
}

export class OutcomeWriterClosedError extends CheckpointError {
  constructor() {
    super("writer-closed", "checkpoint outcome writer is closed");
  }
}

export class OutcomeStateConflictError extends CheckpointError {
  constructor(message: string) {
    super("outcome-state-conflict", message);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decimal(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CorruptDurableStoreError(`invalid decimal at ${context}`);
  }
  return value;
}

function nullableString(value: unknown, context: string): string | null {
  return value === null ? null : assertNonEmptyString(value, context);
}

function nullableHash(value: unknown, context: string): Hash | null {
  return value === null ? null : assertHash(value, context);
}

function exactObject(value: unknown, fields: readonly string[], context: string): Record<string, unknown> {
  assertPlainObject(value, context);
  assertExactKeys(value, fields, context);
  return value;
}

function cloneCanonical<T>(value: unknown): T {
  return deepFreeze(decodeCanonicalJson(encodeCanonicalBytes(value)) as T);
}

function rawEvidenceLocatorContents(
  values: readonly RawEvidenceLocatorContentV1[],
): readonly { readonly rawLocatorHash: Hash; readonly bytes: Uint8Array }[] {
  if (!Array.isArray(values)) throw new CheckpointRunStateError("raw evidence locators must be an array");
  const seen = new Set<Hash>();
  return Object.freeze(values.map((raw, index) => {
    assertPlainObject(raw, `rawEvidenceLocators[${index}]`);
    assertExactKeys(raw, ["kind", "version", "rawLocatorHash", "bytes"], `rawEvidenceLocators[${index}]`);
    if (
      readOwnEnumerableDataProperty(raw, "kind", `rawEvidenceLocators[${index}]`) !== "raw-evidence-locator"
      || readOwnEnumerableDataProperty(raw, "version", `rawEvidenceLocators[${index}]`) !== 1
    ) throw new CheckpointRunStateError(`raw evidence locator ${index} kind/version is invalid`);
    const rawLocatorHash = assertHash(
      readOwnEnumerableDataProperty(raw, "rawLocatorHash", `rawEvidenceLocators[${index}]`),
      `rawEvidenceLocators[${index}].rawLocatorHash`,
    );
    const rawBytes = readOwnEnumerableDataProperty(raw, "bytes", `rawEvidenceLocators[${index}]`);
    if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength === 0) {
      throw new CheckpointRunStateError(`raw evidence locator ${rawLocatorHash} has no bytes`);
    }
    const bytes = new Uint8Array(rawBytes);
    if (sha256Hex(bytes) !== rawLocatorHash) {
      throw new CheckpointRunStateError(`raw evidence locator ${rawLocatorHash} content hash mismatch`);
    }
    if (seen.has(rawLocatorHash)) throw new CheckpointRunStateError(`duplicate raw evidence locator ${rawLocatorHash}`);
    seen.add(rawLocatorHash);
    return Object.freeze({ rawLocatorHash, bytes });
  }).sort((left, right) => compareText(left.rawLocatorHash, right.rawLocatorHash)));
}

function mergedRawEvidenceLocatorContents(
  recent: readonly RawEvidenceLocatorContentV1[],
  sourcePlan: readonly RawEvidenceLocatorContentV1[],
): readonly { readonly rawLocatorHash: Hash; readonly bytes: Uint8Array }[] {
  const byHash = new Map<Hash, RawEvidenceLocatorContentV1>();
  for (const value of [...recent, ...sourcePlan]) {
    const previous = byHash.get(value.rawLocatorHash);
    if (previous !== undefined) {
      if (!sameBytes(previous.bytes, value.bytes)) {
        throw new CheckpointRunStateError(`raw evidence locator ${value.rawLocatorHash} has conflicting bytes`);
      }
      continue;
    }
    byHash.set(value.rawLocatorHash, value);
  }
  return rawEvidenceLocatorContents([...byHash.values()]);
}

function sourcePlanRefsFromCoverage(
  sourceCoverage: SourceCoverageCertificateV1,
): readonly SourcePlanRefV1[] {
  return Object.freeze(sourceCoverage.entries.map(entry => Object.freeze({
    ownerRef: entry.ownerRef,
    sourcePlanRef: entry.sourcePlanRef,
    familyDefinitionHash: entry.familyDefinitionHash,
    completeness: entry.completeness,
    historyStartBlock: entry.historyStartBlock,
  })));
}

function decodeSourcePlanEvidenceSet(
  bytes: Uint8Array,
  context: string,
): readonly SourcePlanEvidenceReceiptV1[] {
  const raw = decodeCanonicalJson(bytes);
  if (!Array.isArray(raw)) throw new CorruptDurableStoreError(`${context} must be an array`);
  const decoded = raw.map((value, index) => decodeSourcePlanEvidenceReceipt(value, `${context}[${index}]`));
  const identity = (value: SourcePlanEvidenceReceiptV1): Hash => sourcePlanIdentity(value.plan);
  const sorted = [...decoded].sort((left, right) => compareText(identity(left), identity(right)));
  if (decoded.some((value, index) => identity(value) !== identity(sorted[index]!))) {
    throw new CorruptDurableStoreError(`${context} is not in canonical source-plan order`);
  }
  return deepFreeze(decoded);
}

function validateSourcePlanEvidenceExecutionJoin(
  receipts: readonly SourcePlanEvidenceReceiptV1[],
  executionSet: PersistedSourcePlanExecutionSetV1,
): void {
  const byIdentity = new Map(receipts.map(receipt => [sourcePlanIdentity(receipt.plan), receipt]));
  if (byIdentity.size !== receipts.length || receipts.length !== executionSet.executions.length) {
    throw new CheckpointRunStateError("source-plan evidence/execution partition mismatch");
  }
  for (const persisted of executionSet.executions) {
    const execution = persisted.execution;
    const receipt = byIdentity.get(sourcePlanIdentity(execution.plan));
    if (receipt === undefined
      || receipt.evidenceRoot !== execution.sourceEvidenceRoot
      || encodeCanonicalJson(receipt.plan) !== encodeCanonicalJson(execution.plan)
      || encodeCanonicalJson(receipt.cutoff) !== encodeCanonicalJson(execution.cutoff)
      || encodeCanonicalJson(receipt.refs) !== encodeCanonicalJson(execution.sourceEvidenceRefs)
      || encodeCanonicalJson(receipt.rawLocatorHashes) !== encodeCanonicalJson(execution.rawLocatorHashes)) {
      throw new CheckpointRunStateError("source-plan evidence/execution bytes mismatch");
    }
  }
}

function sameCutoff(left: BeginRunInputV1["cutoff"], right: BeginRunInputV1["cutoff"]): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function emptyMemoSet(): VerifiedMemoSetV1 {
  return verifiedMemoSet([], []);
}

function decodeRoot(bytes: Uint8Array): CheckpointRootV1 {
  const value = exactObject(decodeCanonicalJson(bytes), ROOT_FIELDS, "checkpointRoot");
  const root = deepFreeze({
    revision: decimal(value.revision, "root.revision"),
    verifiedMemoRoot: assertHash(value.verifiedMemoRoot, "root.verifiedMemoRoot"),
    inProgressRunId: nullableString(value.inProgressRunId, "root.inProgressRunId"),
    stagedReadyStorageHash: nullableHash(value.stagedReadyStorageHash, "root.stagedReadyStorageHash"),
    latestMemoSeedReceiptHash: nullableHash(value.latestMemoSeedReceiptHash, "root.latestMemoSeedReceiptHash"),
    memoSeedSequence: decimal(value.memoSeedSequence, "root.memoSeedSequence"),
    memoSeedLineageRoot: assertHash(value.memoSeedLineageRoot, "root.memoSeedLineageRoot"),
    latestProbeReceiptHash: nullableHash(value.latestProbeReceiptHash, "root.latestProbeReceiptHash"),
    probeReceiptSequence: decimal(value.probeReceiptSequence, "root.probeReceiptSequence"),
    probeReceiptLineageRoot: assertHash(value.probeReceiptLineageRoot, "root.probeReceiptLineageRoot"),
    readyGenerationId: nullableString(value.readyGenerationId, "root.readyGenerationId"),
    readyGenerationRecordHash: nullableHash(value.readyGenerationRecordHash, "root.readyGenerationRecordHash"),
    schemaHash: assertHash(value.schemaHash, "root.schemaHash"),
  });
  if (root.schemaHash !== CHECKPOINT_SCHEMA_HASH) throw new CorruptDurableStoreError("checkpoint schema mismatch");
  return root;
}

function decodeRun(bytes: Uint8Array): StoredRunEnvelopeV2 {
  const value = exactObject(decodeCanonicalJson(bytes), RUN_FIELDS, "storedRun");
  const cutoff = exactObject(value.cutoff, ["chainId", "number", "hash", "stateRoot"], "storedRun.cutoff");
  const accounting = exactObject(value.accounting, ["pending", "verified", "chainProvenRejected", "retryable", "invalidProgram"], "storedRun.accounting");
  return deepFreeze({
    runId: assertNonEmptyString(value.runId, "storedRun.runId"),
    parentGenerationId: nullableString(value.parentGenerationId, "storedRun.parentGenerationId"),
    checkpointRevision: decimal(value.checkpointRevision, "storedRun.checkpointRevision"),
    candidatePartitionRevision: decimal(value.candidatePartitionRevision, "storedRun.candidatePartitionRevision"),
    cutoff: {
      chainId: assertNonEmptyString(cutoff.chainId, "storedRun.cutoff.chainId"),
      number: decimal(cutoff.number, "storedRun.cutoff.number"),
      hash: assertHash(cutoff.hash, "storedRun.cutoff.hash"),
      stateRoot: assertHash(cutoff.stateRoot, "storedRun.cutoff.stateRoot"),
    },
    recentObservationRoot: assertHash(value.recentObservationRoot, "storedRun.recentObservationRoot"),
    recentObservationStorageHash: assertHash(value.recentObservationStorageHash, "storedRun.recentObservationStorageHash"),
    definitionCatalogRoot: assertHash(value.definitionCatalogRoot, "storedRun.definitionCatalogRoot"),
    sourceCoverageRoot: assertHash(value.sourceCoverageRoot, "storedRun.sourceCoverageRoot"),
    sourceCoverageStorageHash: assertHash(value.sourceCoverageStorageHash, "storedRun.sourceCoverageStorageHash"),
    sourceExecutionSetRoot: assertHash(value.sourceExecutionSetRoot, "storedRun.sourceExecutionSetRoot"),
    sourceExecutionSetStorageHash: assertHash(value.sourceExecutionSetStorageHash, "storedRun.sourceExecutionSetStorageHash"),
    sourcePlanEvidenceStorageHash: assertHash(value.sourcePlanEvidenceStorageHash, "storedRun.sourcePlanEvidenceStorageHash"),
    nominationClosureRoot: assertHash(value.nominationClosureRoot, "storedRun.nominationClosureRoot"),
    nominationClosureStorageHash: assertHash(value.nominationClosureStorageHash, "storedRun.nominationClosureStorageHash"),
    candidatePartitionRoot: assertHash(value.candidatePartitionRoot, "storedRun.candidatePartitionRoot"),
    candidatePartitionStorageHash: assertHash(value.candidatePartitionStorageHash, "storedRun.candidatePartitionStorageHash"),
    candidatePartitionCommitmentStorageHash: assertHash(value.candidatePartitionCommitmentStorageHash, "storedRun.candidatePartitionCommitmentStorageHash"),
    candidateRecordCount: decimal(value.candidateRecordCount, "storedRun.candidateRecordCount"),
    outcomePartitionRoot: assertHash(value.outcomePartitionRoot, "storedRun.outcomePartitionRoot"),
    outcomePartitionStorageHash: assertHash(value.outcomePartitionStorageHash, "storedRun.outcomePartitionStorageHash"),
    partialOutcomePartitionStorageHash: nullableHash(value.partialOutcomePartitionStorageHash, "storedRun.partialOutcomePartitionStorageHash"),
    attestationPartitionStorageHash: nullableHash(value.attestationPartitionStorageHash, "storedRun.attestationPartitionStorageHash"),
    verifiedMemoSetRoot: assertHash(value.verifiedMemoSetRoot, "storedRun.verifiedMemoSetRoot"),
    verifiedMemoSetStorageHash: assertHash(value.verifiedMemoSetStorageHash, "storedRun.verifiedMemoSetStorageHash"),
    accounting: {
      pending: decimal(accounting.pending, "storedRun.accounting.pending"),
      verified: decimal(accounting.verified, "storedRun.accounting.verified"),
      chainProvenRejected: decimal(accounting.chainProvenRejected, "storedRun.accounting.chainProvenRejected"),
      retryable: decimal(accounting.retryable, "storedRun.accounting.retryable"),
      invalidProgram: decimal(accounting.invalidProgram, "storedRun.accounting.invalidProgram"),
    },
  });
}

function decodePersistedIdentity(value: unknown, context: string): IdentityVerifiedV1 {
  const raw = exactObject(value, ["kind", "familyInstanceKey", "identityMemo", "identityMemoHash", "descriptorHash", "evidenceRoot", "identityCommitment"], context);
  if (raw.kind !== "identityVerified") throw new CorruptDurableStoreError(`${context}.kind is invalid`);
  const observation = validateIdentityObservation({
    kind: raw.kind,
    familyInstanceKey: raw.familyInstanceKey,
    identityMemo: raw.identityMemo,
    identityMemoHash: raw.identityMemoHash,
    descriptorHash: raw.descriptorHash,
    evidenceRoot: raw.evidenceRoot,
  }, context);
  return deepFreeze({
    ...observation,
    identityCommitment: decodeAttestationIdentityCommitmentV1(raw.identityCommitment),
  });
}

function decodePartialOutcome(bytes: Uint8Array, context: string): AttestationPersistedOutcomeV1 {
  const raw = exactObject(
    decodeCanonicalJson(bytes),
    ["runId", "candidatePartitionRoot", "familyCandidateKey", "outcomeHash", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "kind", "identity", "outcome"],
    context,
  );
  if (raw.kind !== "partial-identity" || raw.outcome !== null || raw.identity === null) {
    throw new CorruptDurableStoreError(`${context} is not a partial identity outcome`);
  }
  return deepFreeze({
    runId: assertNonEmptyString(raw.runId, `${context}.runId`),
    candidatePartitionRoot: assertHash(raw.candidatePartitionRoot, `${context}.candidatePartitionRoot`),
    familyCandidateKey: assertHash(raw.familyCandidateKey, `${context}.familyCandidateKey`),
    outcomeHash: assertHash(raw.outcomeHash, `${context}.outcomeHash`),
    runtimeAuthority: decodeRuntimeAuthorityProjectionV1(raw.runtimeAuthority),
    attestationAuthorityRoot: assertHash(raw.attestationAuthorityRoot, `${context}.attestationAuthorityRoot`),
    frameworkAuthorityRoot: assertHash(raw.frameworkAuthorityRoot, `${context}.frameworkAuthorityRoot`),
    executorAuthorityRoot: assertHash(raw.executorAuthorityRoot, `${context}.executorAuthorityRoot`),
    kind: "partial-identity" as const,
    identity: decodePersistedIdentity(raw.identity, `${context}.identity`),
    outcome: null,
  });
}

function readContent(tx: DurableTransaction, hash: Hash, kind: string, context: string): Uint8Array {
  const record = tx.readContent(hash);
  if (!record) throw new CorruptDurableStoreError(`${context} is missing ${hash}`);
  if (record.kind !== kind) throw new CorruptDurableStoreError(`${context} kind mismatch`);
  return record.bytes;
}

function readContentStore(store: SQLiteDurableStore, hash: Hash, kind: string, context: string): Uint8Array {
  const record = store.readContent(hash);
  if (!record) throw new CorruptDurableStoreError(`${context} is missing ${hash}`);
  if (record.kind !== kind) throw new CorruptDurableStoreError(`${context} kind mismatch`);
  return record.bytes;
}

function linkedChunkReader<Ref extends { readonly contentSha256: Hash }>(
  read: DurableContentReader,
  manifestRecord: DurableContentRecord,
  chunkKind: string,
  context: string,
): {
  readonly readChunk: (ref: Ref) => Uint8Array;
  readonly assertComplete: () => void;
} {
  if (new Set(manifestRecord.references).size !== manifestRecord.references.length) {
    throw new CorruptDurableStoreError(`${context} has duplicate physical references`);
  }
  const byContentSha = new Map<Hash, { readonly storageHash: Hash; readonly bytes: Uint8Array }>();
  for (const storageHash of manifestRecord.references) {
    const record = read(storageHash);
    if (!record || record.kind !== chunkKind) {
      throw new CorruptDurableStoreError(`${context} chunk kind or content is missing`);
    }
    if (record.references.length !== 0) {
      throw new CorruptDurableStoreError(`${context} chunk physical references must be empty`);
    }
    const contentSha = sha256Hex(record.bytes);
    if (byContentSha.has(contentSha)) {
      throw new CorruptDurableStoreError(`${context} has duplicate chunk content`);
    }
    byContentSha.set(contentSha, { storageHash, bytes: record.bytes });
  }
  const consumed = new Set<Hash>();
  return Object.freeze({
    readChunk(ref: Ref): Uint8Array {
      const found = byContentSha.get(ref.contentSha256);
      if (!found) throw new CorruptDurableStoreError(`${context} linked chunk is not referenced`);
      if (consumed.has(found.storageHash)) {
        throw new CorruptDurableStoreError(`${context} linked chunk is reused`);
      }
      consumed.add(found.storageHash);
      return found.bytes;
    },
    assertComplete(): void {
      if (consumed.size !== manifestRecord.references.length) {
        throw new CorruptDurableStoreError(`${context} physical chunk closure is not exact`);
      }
    },
  });
}

function decodeInstanceCatalogRecordWith(
  read: DurableContentReader,
  storageHash: Hash,
  context: string,
): InstanceCatalogV1 {
  const record = read(storageHash);
  if (!record || record.kind !== INSTANCE_CATALOG_KIND) {
    throw new CorruptDurableStoreError(`${context} manifest kind or content is missing`);
  }
  try {
    const chunks = linkedChunkReader<InstanceCatalogPublicationChunkRefV1>(
      read,
      record,
      INSTANCE_CATALOG_CHUNK_KIND,
      context,
    );
    const catalog = decodeInstanceCatalogV1(record.bytes, chunks.readChunk);
    chunks.assertComplete();
    return catalog;
  } catch (error) {
    if (error instanceof CorruptDurableStoreError) throw error;
    throw new CorruptDurableStoreError(
      `${context} validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function decodeNominationClosureRecordWith(
  read: DurableContentReader,
  storageHash: Hash,
  context: string,
): Readonly<{
  closure: NominationClosureV1;
  dependencyReferences: readonly Hash[];
}> {
  const record = read(storageHash);
  if (!record || record.kind !== NOMINATION_CLOSURE_KIND) {
    throw new CorruptDurableStoreError(`${context} manifest kind or content is missing`);
  }
  const chunkReferences: Hash[] = [];
  const dependencyReferences: Hash[] = [];
  for (const reference of record.references) {
    const child = read(reference);
    if (!child) throw new CorruptDurableStoreError(`${context} references missing content`);
    if (child.kind === NOMINATION_CLAIM_CHUNK_KIND) chunkReferences.push(reference);
    else dependencyReferences.push(reference);
  }
  try {
    const chunks = linkedChunkReader<NominationClaimChunkRefV1>(
      read,
      Object.freeze({ ...record, references: Object.freeze(chunkReferences) }),
      NOMINATION_CLAIM_CHUNK_KIND,
      context,
    );
    const closure = decodePersistedNominationClosureV1(record.bytes, chunks.readChunk);
    chunks.assertComplete();
    return Object.freeze({
      closure,
      dependencyReferences: Object.freeze([...dependencyReferences].sort(compareText)),
    });
  } catch (error) {
    if (error instanceof CorruptDurableStoreError) throw error;
    throw new CorruptDurableStoreError(
      `${context} validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function decodePersistedGraphRecordWith(
  read: DurableContentReader,
  storageHash: Hash,
  catalog: InstanceCatalogV1,
  context: string,
): PersistedGraphV1 {
  const record = read(storageHash);
  if (!record || record.kind !== GRAPH_KIND) {
    throw new CorruptDurableStoreError(`${context} manifest kind or content is missing`);
  }
  try {
    const chunks = linkedChunkReader<PersistedGraphEdgeChunkRefV1>(
      read,
      record,
      GRAPH_CHUNK_KIND,
      context,
    );
    const graph = decodePersistedGraphV1(record.bytes, chunks.readChunk, catalog);
    chunks.assertComplete();
    return graph;
  } catch (error) {
    if (error instanceof CorruptDurableStoreError) throw error;
    throw new CorruptDurableStoreError(
      `${context} validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function graphEdgesByPublication(
  graph: PersistedGraphV1,
): ReadonlyMap<Hash, readonly PersistedGraphV1["edges"][number][]> {
  const mutable = new Map<Hash, PersistedGraphV1["edges"][number][]>();
  for (const edge of graph.edges) {
    const edges = mutable.get(edge.instancePublicationHash);
    if (edges === undefined) mutable.set(edge.instancePublicationHash, [edge]);
    else edges.push(edge);
  }
  return new Map([...mutable].map(([publicationHash, edges]) => [publicationHash, Object.freeze(edges)]));
}

function validateRawLocatorReferences(
  read: (hash: Hash) => DurableContentRecord | null,
  physicalReferences: readonly Hash[],
  expectedSemanticHashes: readonly Hash[],
  context: string,
): ReadonlyMap<Hash, Hash> {
  const bySemanticHash = new Map<Hash, Hash>();
  for (const physicalHash of physicalReferences) {
    const record = read(physicalHash);
    if (!record || record.kind !== RAW_EVIDENCE_LOCATOR_KIND) {
      throw new CorruptDurableStoreError(`${context} raw locator is missing`);
    }
    if (record.references.length !== 0) {
      throw new CorruptDurableStoreError(`${context} raw locator has physical references`);
    }
    if (bySemanticHash.has(record.payloadHash)) {
      throw new CorruptDurableStoreError(`${context} raw locator payload is duplicated`);
    }
    bySemanticHash.set(record.payloadHash, physicalHash);
  }
  const expected = [...new Set(expectedSemanticHashes)].sort(compareText);
  const observed = [...bySemanticHash.keys()].sort(compareText);
  if (encodeCanonicalJson(observed) !== encodeCanonicalJson(expected)) {
    throw new CorruptDurableStoreError(`${context} raw locator semantic set mismatch`);
  }
  return bySemanticHash;
}

function validateSourceExecutionSetRecord(
  read: (hash: Hash) => DurableContentRecord | null,
  storageHash: Hash,
  coverage: SourceCoverageCertificateV1 | null,
  seen = new Set<Hash>(),
): { readonly set: PersistedSourcePlanExecutionSetV1; readonly rawStorageBySemanticHash: ReadonlyMap<Hash, Hash> } {
  if (seen.has(storageHash)) throw new CorruptDurableStoreError("source execution predecessor cycle");
  seen.add(storageHash);
  const record = read(storageHash);
  if (!record || record.kind !== SOURCE_EXECUTION_SET_KIND) {
    throw new CorruptDurableStoreError("source execution set is missing");
  }
  const set = decodePersistedSourcePlanExecutionSet(decodeCanonicalJson(record.bytes), "durable source execution set");
  if (coverage !== null) validatePersistedExecutionCoverage(set, coverage);
  const rawReferences: Hash[] = [];
  const predecessorReferences: Hash[] = [];
  for (const reference of record.references) {
    const child = read(reference);
    if (child?.kind === RAW_EVIDENCE_LOCATOR_KIND) rawReferences.push(reference);
    else if (child?.kind === SOURCE_EXECUTION_SET_KIND) predecessorReferences.push(reference);
    else throw new CorruptDurableStoreError("source execution set has a foreign physical reference");
  }
  const rawStorageBySemanticHash = validateRawLocatorReferences(
    read,
    rawReferences,
    set.executions.flatMap(value => value.execution.rawLocatorHashes),
    "source execution set",
  );
  const predecessorRoots = set.executions
    .map(value => value.previousExecutionRoot)
    .filter((value): value is Hash => value !== null);
  if (predecessorRoots.length === 0) {
    if (predecessorReferences.length !== 0) throw new CorruptDurableStoreError("first source execution set has a predecessor reference");
    return { set, rawStorageBySemanticHash };
  }
  if (predecessorReferences.length !== 1) throw new CorruptDurableStoreError("source execution predecessor reference is not exact");
  const prior = validateSourceExecutionSetRecord(read, predecessorReferences[0]!, null, seen).set;
  const priorByRoot = new Map(prior.executions.map(value => [value.persistedExecutionRoot, value]));
  for (const current of set.executions) {
    if (current.previousExecutionRoot === null) continue;
    const predecessor = priorByRoot.get(current.previousExecutionRoot);
    if (
      predecessor === undefined
      || sourcePlanIdentity(predecessor.execution.plan) !== sourcePlanIdentity(current.execution.plan)
      || predecessor.sourcePlanLeafDigest !== current.sourcePlanLeafDigest
      || predecessor.sourcePlanSchemaHash !== current.sourcePlanSchemaHash
      || predecessor.sourcePlanClosureRoot !== current.sourcePlanClosureRoot
      || predecessor.sourceAuthorityRoot !== current.sourceAuthorityRoot
      || predecessor.execution.cutoff.chainId !== current.execution.cutoff.chainId
      || predecessor.execution.through !== prior.cutoff.number
      || current.execution.previousAppliedThrough !== predecessor.execution.through
      || BigInt(current.execution.from) !== BigInt(predecessor.execution.through) + 1n
      || BigInt(current.execution.cutoff.number) <= BigInt(predecessor.execution.cutoff.number)
    ) throw new CorruptDurableStoreError("source execution predecessor splice/gap mismatch");
  }
  return { set, rawStorageBySemanticHash };
}

function validateNominationClosureAgainstRun(input: {
  readonly closure: NominationClosureV1;
  readonly cutoff: BeginRunInputV1["cutoff"];
  readonly recentObservation: RecentObservationReceiptV1;
  readonly sourceCoverage: SourceCoverageCertificateV1;
  readonly sourceExecutionSet: PersistedSourcePlanExecutionSetV1;
  readonly candidates: readonly CandidateRecordV1[];
  readonly candidatePartitionRoot: Hash;
}): NominationClosureV1 {
  const closure = decodeNominationClosureV1(input.closure);
  if (!sameCutoff(closure.cutoff, input.cutoff)
    || closure.recentObservationRoot !== input.recentObservation.observationRoot
    || closure.sourceCoverageRoot !== input.sourceCoverage.sourceCoverageRoot
    || closure.sourceExecutionSetRoot !== input.sourceExecutionSet.executionSetRoot
    || closure.candidatePartitionRoot !== input.candidatePartitionRoot
    || closure.candidateCount !== String(input.candidates.length)) {
    throw new CheckpointRunStateError("nomination closure run binding mismatch");
  }
  const executions = new Map(input.sourceExecutionSet.executions.map(execution => [
    sourcePlanIdentity(execution.execution.plan),
    execution,
  ]));
  const coverageIdentities = input.sourceCoverage.entries.map(sourcePlanIdentity).sort(compareText);
  const executionIdentities = [...executions.keys()].sort(compareText);
  if (executions.size !== input.sourceExecutionSet.executions.length
    || encodeCanonicalJson(coverageIdentities) !== encodeCanonicalJson(executionIdentities)
    || encodeCanonicalJson(executionIdentities) !== encodeCanonicalJson(closure.sourcePlanIdentities)) {
    throw new CheckpointRunStateError("nomination closure source-plan denominator mismatch");
  }
  const evidenceByHash = new Map<Hash, CandidateRecordV1["evidence"][number]>();
  const sealedEvidence = new Set([
    ...input.recentObservation.evidence,
    ...input.sourceExecutionSet.executions.flatMap(value => value.execution.sourceEvidenceRefs),
  ].map(value => encodeCanonicalJson(value)));
  for (const candidate of input.candidates) {
    for (const evidence of candidate.evidence) {
      if (!sealedEvidence.has(encodeCanonicalJson(evidence))) {
        throw new CheckpointRunStateError("candidate evidence is outside the exact observation/source-plan execution evidence");
      }
      const evidenceHash = nominationEvidenceRefHash(evidence);
      const existing = evidenceByHash.get(evidenceHash);
      if (existing !== undefined && encodeCanonicalJson(existing) !== encodeCanonicalJson(evidence)) {
        throw new CheckpointRunStateError("candidate evidence hash aliases different evidence");
      }
      evidenceByHash.set(evidenceHash, evidence);
    }
  }
  const recentEvidenceHashes = new Set(input.recentObservation.evidence.map(nominationEvidenceRefHash));
  for (const receipt of closure.receipts) {
    const execution = executions.get(receipt.sourcePlanIdentity);
    if (execution === undefined
      || execution.sourcePlanLeafDigest !== receipt.sourcePlanLeafDigest
      || execution.execution.plan.familyDefinitionHash !== receipt.familyDefinitionHash) {
      throw new CheckpointRunStateError("nomination receipt source-plan qualification mismatch");
    }
    const plan = execution.execution.plan;
    if (receipt.denominator.kind === "complete-source-result") {
      if ((plan.completeness !== "complete-snapshot" && plan.completeness !== "contiguous-history")
        || receipt.denominator.persistedExecutionRoot !== execution.persistedExecutionRoot
        || receipt.denominator.resultPartitionRoot !== execution.execution.resultPartitionRoot) {
        throw new CheckpointRunStateError("complete nomination denominator mismatch");
      }
    } else if (receipt.denominator.kind === "point-lookup") {
      if (plan.completeness !== "point-lookup"
        || receipt.denominator.persistedExecutionRoot !== execution.persistedExecutionRoot
        || receipt.denominator.resultPartitionRoot !== execution.execution.resultPartitionRoot) {
        throw new CheckpointRunStateError("point-lookup nomination denominator mismatch");
      }
    } else if (receipt.denominator.kind === "rolling-observation") {
      if (plan.completeness !== "rolling-observation"
        || receipt.denominator.persistedExecutionRoot !== execution.persistedExecutionRoot
        || receipt.denominator.resultPartitionRoot !== execution.execution.resultPartitionRoot) {
        throw new CheckpointRunStateError("rolling observation nomination denominator mismatch");
      }
    } else {
      if (plan.completeness !== "nomination-only"
        || receipt.denominator.recentObservationRoot !== input.recentObservation.observationRoot
        || receipt.denominator.relevantEvidenceRefHashes.some(hash => !recentEvidenceHashes.has(hash))) {
        throw new CheckpointRunStateError("recent nomination denominator mismatch");
      }
    }
    for (const claim of receipt.claims) {
      const evidence = evidenceByHash.get(claim.evidenceRefHash);
      if (evidence === undefined) throw new CheckpointRunStateError("nomination claim evidence is absent");
      if (receipt.denominator.kind === "recent-observation") {
        if (evidence.kind !== "recent-log") throw new CheckpointRunStateError("recent nomination claim uses source-plan evidence");
      } else if (evidence.kind !== "source-plan"
        || evidence.ownerRef !== plan.ownerRef
        || evidence.sourcePlanRef !== plan.sourcePlanRef) {
        throw new CheckpointRunStateError("source nomination claim evidence plan mismatch");
      }
    }
  }
  const rebuilt = sealNominationClosureV1({
    cutoff: closure.cutoff,
    recentObservationRoot: closure.recentObservationRoot,
    sourceExecutionSetRoot: closure.sourceExecutionSetRoot,
    sourceCoverageRoot: closure.sourceCoverageRoot,
    sourcePlanIdentities: closure.sourcePlanIdentities,
    receipts: closure.receipts,
    candidates: input.candidates,
    candidatePartitionRoot: input.candidatePartitionRoot,
  });
  if (rebuilt.root !== closure.root) {
    throw new CheckpointRunStateError("nomination closure recomputation mismatch");
  }
  return closure;
}

/** Decode the raw byte strings carried by an issuer-owned rejection bundle. */
function rejectionBytes(value: unknown, context: string, allowEmpty = false): Uint8Array {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new CorruptDurableStoreError(`${context} is not lowercase even-length bytes`);
  }
  if (!allowEmpty && value === "0x") {
    throw new CorruptDurableStoreError(`${context} must not be empty`);
  }
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

interface RejectionChildExpectationV1 {
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly label: string;
}

function rejectionChildExpectations(
  evidence: RejectionEvidenceBundleV2,
): readonly RejectionChildExpectationV1[] {
  const requestBytes = rejectionBytes(evidence.request.canonicalBytesHex, "rejectionEvidence.request.canonicalBytesHex");
  const transport = evidence.transportFacts.map((fact, index) => ({
    kind: REJECTION_TRANSPORT_RAW_KIND,
    bytes: rejectionBytes(fact.canonicalBytesHex, `rejectionEvidence.transportFacts[${index}].canonicalBytesHex`),
    label: `transport[${index}]`,
  }));
  const effects = evidence.effectObservations.map((effect, index) => ({
    kind: REJECTION_EFFECT_RAW_KIND,
    bytes: rejectionBytes(effect.canonicalBytesHex, `rejectionEvidence.effectObservations[${index}].canonicalBytesHex`),
    label: `effect[${index}]`,
  }));
  // The byte buffers are deliberately kept outside canonical/deepFreeze: they
  // are raw durable payloads, not JSON values.  They are freshly decoded from
  // the issuer bundle and never exposed beyond this closure.
  return Object.freeze([
    { kind: REJECTION_REQUEST_RAW_KIND, bytes: requestBytes, label: "request" },
    ...transport,
    ...effects,
    { kind: REJECTION_DECISION_RAW_KIND, bytes: rejectionBytes(evidence.decisionBytesHex, "rejectionEvidence.decisionBytesHex"), label: "decision" },
  ]);
}

function validatedRejectionEvidence(
  value: unknown,
  context: string,
): RejectionEvidenceBundleV2 {
  try {
    const decoded = value instanceof Uint8Array ? decodeCanonicalJson(value) : value;
    return validateRejectionEvidenceBundle(decoded);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new CorruptDurableStoreError(`${context} is invalid${detail}`);
  }
}

/**
 * A terminal outcome is not self-authenticating.  Its issuer bundle and all
 * raw bytes are therefore persisted as a single physical closure.  This
 * function is deliberately used on every read path as well as on writes;
 * merely recomputing the semantic outcome root is insufficient because a
 * caller could otherwise splice facts from another request.
 */
function validateRejectionBundlePhysicalWith(
  read: DurableContentReader,
  bundleStorageHash: Hash,
  evidence: RejectionEvidenceBundleV2,
  context: string,
): void {
  const bundleRecord = read(bundleStorageHash);
  if (!bundleRecord || bundleRecord.kind !== REJECTION_BUNDLE_KIND) {
    throw new CorruptDurableStoreError(`${context} bundle is missing or has the wrong kind`);
  }
  const decoded = validatedRejectionEvidence(bundleRecord.bytes, `${context} bundle`);
  if (encodeCanonicalJson(decoded) !== encodeCanonicalJson(evidence)) {
    throw new CorruptDurableStoreError(`${context} bundle payload does not match outcome evidence`);
  }
  const expected = rejectionChildExpectations(decoded);
  const expectedReferences: Hash[] = [];
  for (const child of expected) {
    const matching = bundleRecord.references.filter(reference => {
      const record = read(reference);
      return record !== null
        && record.kind === child.kind
        && record.references.length === 0
        && sameBytes(record.bytes, child.bytes)
        && record.payloadHash === sha256Hex(child.bytes);
    });
    if (matching.length !== 1) {
      throw new CorruptDurableStoreError(`${context} ${child.label} raw child is missing, duplicated, or spliced`);
    }
    expectedReferences.push(matching[0]!);
  }
  const normalizedExpected = [...new Set(expectedReferences)].sort(compareText);
  const normalizedObserved = [...bundleRecord.references].sort(compareText);
  if (encodeCanonicalJson(normalizedObserved) !== encodeCanonicalJson(normalizedExpected)) {
    throw new CorruptDurableStoreError(`${context} bundle physical references are not all-and-only`);
  }
}

function putRejectionBundle(
  tx: DurableTransaction,
  evidence: RejectionEvidenceBundleV2,
): Hash {
  const validated = validatedRejectionEvidence(evidence, "rejection evidence");
  const children = rejectionChildExpectations(validated);
  const references = children.map(child => tx.putImmutable(child.kind, child.bytes));
  return tx.putImmutable(REJECTION_BUNDLE_KIND, encodeCanonicalBytes(validated), references);
}

function putPartition(
  tx: DurableTransaction,
  runId: string,
  partitionKind: PartitionKindV1,
  entries: readonly PartitionEntryV1[],
): Hash {
  const sorted = [...entries].sort((left, right) => compareText(left.key, right.key));
  if (new Set(sorted.map(entry => entry.key)).size !== sorted.length) throw new CheckpointRunStateError("duplicate partition key");
  const pageStorageHashes: Hash[] = [];
  for (let offset = 0; offset < sorted.length; offset += PARTITION_PAGE_SIZE) {
    const pageEntries = sorted.slice(offset, offset + PARTITION_PAGE_SIZE);
    const pageStorageHash = tx.putImmutable(
      PARTITION_PAGE_KIND,
      encodeCanonicalBytes({ runId, partitionKind, pageIndex: String(pageStorageHashes.length), entries: pageEntries }),
      pageEntries.map(entry => entry.storageHash),
    );
    pageStorageHashes.push(pageStorageHash);
  }
  const manifest: PartitionManifestV1 = deepFreeze({
    runId,
    partitionKind,
    count: String(sorted.length),
    pageStorageHashes,
  });
  return tx.putImmutable(PARTITION_MANIFEST_KIND, encodeCanonicalBytes(manifest), pageStorageHashes);
}

function loadPartition(
  read: (hash: Hash, kind: string, context: string) => Uint8Array,
  manifestHash: Hash,
  runId: string,
  partitionKind: PartitionKindV1,
): readonly PartitionEntryV1[] {
  const manifestValue = exactObject(decodeCanonicalJson(read(manifestHash, PARTITION_MANIFEST_KIND, `${partitionKind} manifest`)), PARTITION_MANIFEST_FIELDS, `${partitionKind}Manifest`);
  if (manifestValue.runId !== runId || manifestValue.partitionKind !== partitionKind || !Array.isArray(manifestValue.pageStorageHashes)) {
    throw new CorruptDurableStoreError(`${partitionKind} manifest binding mismatch`);
  }
  const entries: PartitionEntryV1[] = [];
  for (const [pageIndex, rawHash] of manifestValue.pageStorageHashes.entries()) {
    const pageHash = assertHash(rawHash, `${partitionKind}Manifest.pageStorageHashes[${pageIndex}]`);
    const page = exactObject(decodeCanonicalJson(read(pageHash, PARTITION_PAGE_KIND, `${partitionKind} page`)), PARTITION_PAGE_FIELDS, `${partitionKind}Page`);
    if (page.runId !== runId || page.partitionKind !== partitionKind || page.pageIndex !== String(pageIndex) || !Array.isArray(page.entries)) {
      throw new CorruptDurableStoreError(`${partitionKind} page binding mismatch`);
    }
    for (const [index, raw] of page.entries.entries()) {
      const entry = exactObject(raw, ["key", "storageHash"], `${partitionKind}Page.entries[${index}]`);
      entries.push(deepFreeze({
        key: assertNonEmptyString(entry.key, `${partitionKind} entry key`),
        storageHash: assertHash(entry.storageHash, `${partitionKind} entry storage hash`),
      }));
    }
  }
  if (decimal(manifestValue.count, `${partitionKind}Manifest.count`) !== String(entries.length)) {
    throw new CorruptDurableStoreError(`${partitionKind} partition count mismatch`);
  }
  const sorted = [...entries].sort((left, right) => compareText(left.key, right.key));
  if (entries.some((entry, index) => entry.key !== sorted[index]?.key) || new Set(entries.map(entry => entry.key)).size !== entries.length) {
    throw new CorruptDurableStoreError(`${partitionKind} partition order mismatch`);
  }
  return deepFreeze(entries);
}

function outcomeAccounting(candidateCount: number, outcomes: readonly CandidateFinalOutcomeV1[]): RunAccountingV1 {
  return deepFreeze({
    pending: String(candidateCount - outcomes.length),
    verified: String(outcomes.filter(value => value.kind === "verified").length),
    chainProvenRejected: String(outcomes.filter(value => value.kind === "chainProvenRejected").length),
    retryable: String(outcomes.filter(value => value.kind === "retryable").length),
    invalidProgram: String(outcomes.filter(value => value.kind === "invalidProgram").length),
  });
}

function outcomePartitionRoot(runId: string, outcomes: readonly CandidateFinalOutcomeV1[]): Hash {
  return hashDomain("aloha/checkpoint-outcome-partition/v1", {
    runId,
    outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
  });
}

function attestationPartitionManifestBytes(partition: AttestationPartitionV1): Uint8Array {
  return encodeCanonicalBytes(deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.attestation-partition-manifest-v1" as const,
    runId: partition.runId,
    cutoff: partition.cutoff,
    candidatePartitionRoot: partition.candidatePartitionRoot,
    outcomeCount: String(partition.outcomes.length),
    runtimeAuthority: partition.runtimeAuthority,
    attestationAuthorityRoot: partition.attestationAuthorityRoot,
    frameworkAuthorityRoot: partition.frameworkAuthorityRoot,
    executorAuthorityRoot: partition.executorAuthorityRoot,
    accounting: partition.accounting,
    exactOutcomePartitionRoot: partition.exactOutcomePartitionRoot,
  }));
}

function decodeAttestationPartitionRecordWith(
  read: DurableContentReader,
  storageHash: Hash,
  outcomePartitionStorageHash: Hash,
  runId: string,
  context: string,
): AttestationPartitionV1 {
  const record = read(storageHash);
  if (!record || record.kind !== ATTESTATION_PARTITION_KIND) {
    throw new CorruptDurableStoreError(`${context} is missing or has the wrong kind`);
  }
  if (record.references.length !== 1 || record.references[0] !== outcomePartitionStorageHash) {
    throw new CorruptDurableStoreError(`${context} outcome partition reference is not exact`);
  }
  const readBytes = (hash: Hash, kind: string, childContext: string): Uint8Array => {
    const child = read(hash);
    if (!child) throw new CorruptDurableStoreError(`${childContext} is missing ${hash}`);
    if (child.kind !== kind) throw new CorruptDurableStoreError(`${childContext} kind mismatch`);
    return child.bytes;
  };
  const outcomes = loadPartition(
    readBytes,
    outcomePartitionStorageHash,
    runId,
    "outcome",
  ).map(entry => {
    const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(readBytes(
      entry.storageHash,
      OUTCOME_KIND,
      `${context} outcome`,
    )));
    if (outcome.familyCandidateKey !== entry.key) {
      throw new CorruptDurableStoreError(`${context} outcome key mismatch`);
    }
    return outcome;
  });
  let manifest: AttestationPartitionManifestV1;
  try {
    manifest = decodeExactObject(decodeCanonicalJson(record.bytes), {
      schemaVersion: field => {
        if (field !== 1) throw new TypeError("attestation partition manifest schema version mismatch");
        return 1 as const;
      },
      kind: field => {
        if (field !== "aloha.attestation-partition-manifest-v1") throw new TypeError("attestation partition manifest kind mismatch");
        return "aloha.attestation-partition-manifest-v1" as const;
      },
      runId: (field, path) => assertNonEmptyString(field, path),
      cutoff: (field, path) => decodeCanonicalCutoff(field, path),
      candidatePartitionRoot: (field, path) => assertHash(field, path),
      outcomeCount: (field, path) => assertDecimalString(field, path),
      runtimeAuthority: field => decodeRuntimeAuthorityProjectionV1(field),
      attestationAuthorityRoot: (field, path) => assertHash(field, path),
      frameworkAuthorityRoot: (field, path) => assertHash(field, path),
      executorAuthorityRoot: (field, path) => assertHash(field, path),
      accounting: (field, path) => decodeExactObject(field, {
        pending: (value, valuePath) => assertDecimalString(value, valuePath),
        verified: (value, valuePath) => assertDecimalString(value, valuePath),
        chainProvenRejected: (value, valuePath) => assertDecimalString(value, valuePath),
        retryable: (value, valuePath) => assertDecimalString(value, valuePath),
        invalidProgram: (value, valuePath) => assertDecimalString(value, valuePath),
      }, path),
      exactOutcomePartitionRoot: (field, path) => assertHash(field, path),
    }, context);
  } catch (error) {
    throw new CorruptDurableStoreError(
      `${context} manifest validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const exactOutcomePartitionRoot = hashDomain("aloha/exact-outcome-partition/v1", {
    runId: manifest.runId,
    cutoff: manifest.cutoff,
    candidatePartitionRoot: manifest.candidatePartitionRoot,
    runtimeAuthority: manifest.runtimeAuthority,
    attestationAuthorityRoot: manifest.attestationAuthorityRoot,
    frameworkAuthorityRoot: manifest.frameworkAuthorityRoot,
    executorAuthorityRoot: manifest.executorAuthorityRoot,
    outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
  });
  const expectedFinalAccounting = outcomeAccounting(outcomes.length, outcomes);
  if (manifest.runId !== runId
    || manifest.outcomeCount !== String(outcomes.length)
    || manifest.exactOutcomePartitionRoot !== exactOutcomePartitionRoot
    || manifest.accounting.pending !== "0"
    || manifest.accounting.verified !== expectedFinalAccounting.verified
    || manifest.accounting.chainProvenRejected !== expectedFinalAccounting.chainProvenRejected
    || manifest.accounting.retryable !== expectedFinalAccounting.retryable
    || manifest.accounting.invalidProgram !== expectedFinalAccounting.invalidProgram) {
    throw new CorruptDurableStoreError(`${context} manifest binding mismatch`);
  }
  return deepFreeze({
    runId: manifest.runId,
    cutoff: manifest.cutoff,
    candidatePartitionRoot: manifest.candidatePartitionRoot,
    outcomes,
    runtimeAuthority: manifest.runtimeAuthority,
    attestationAuthorityRoot: manifest.attestationAuthorityRoot,
    frameworkAuthorityRoot: manifest.frameworkAuthorityRoot,
    executorAuthorityRoot: manifest.executorAuthorityRoot,
    accounting: manifest.accounting,
    exactOutcomePartitionRoot: manifest.exactOutcomePartitionRoot,
  });
}

function verifiedMemoSet(value: readonly InstancePublicationV1[], locatorHashes: readonly Hash[]): VerifiedMemoSetV1 {
  if (!Array.isArray(value)) throw new TypeError("verified memo set memos must be an array");
  const memos = Object.freeze(value.map((memo) => {
    validateInstancePublication(memo);
    return memo;
  }).sort((left, right) => compareText(left.instancePublicationHash, right.instancePublicationHash)));
  if (new Set(memos.map(memo => memo.instancePublicationHash)).size !== memos.length) {
    throw new TypeError("duplicate verified memo publication");
  }
  const retainedRawLocatorHashes = deepFreeze([...new Set(locatorHashes.map((hash, index) =>
    assertHash(hash, `verifiedMemoSet.retainedRawLocatorHashes[${index}]`)))].sort(compareText));
  const memoCatalogRoot = memos.length === 0
    ? null
    : sealInstanceCatalog(memos[0]!.cutoff, memos).instanceCatalogRoot;
  const retainedRawLocatorSequenceRoot = hashCanonicalPartition(
    "aloha/verified-memo-raw-locator-sequence/v1",
    retainedRawLocatorHashes,
  );
  return Object.freeze({
    memos,
    retainedRawLocatorHashes,
    verifiedMemoSetRoot: hashDomain("aloha/verified-memo-set/v3", {
      memoCount: String(memos.length),
      memoCatalogRoot,
      retainedRawLocatorCount: String(retainedRawLocatorHashes.length),
      retainedRawLocatorSequenceRoot,
    }),
  });
}

function verifiedMemoManifest(
  memo: VerifiedMemoSetV1,
  memoCatalogRoot: Hash | null,
): VerifiedMemoSetManifestV1 {
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.verified-memo-set-manifest-v1" as const,
    memoCount: String(memo.memos.length),
    memoCatalogRoot,
    retainedRawLocatorCount: String(memo.retainedRawLocatorHashes.length),
    retainedRawLocatorSequenceRoot: hashCanonicalPartition(
      "aloha/verified-memo-raw-locator-sequence/v1",
      memo.retainedRawLocatorHashes,
    ),
    verifiedMemoSetRoot: memo.verifiedMemoSetRoot,
  });
}

function putVerifiedMemoSet(
  tx: DurableTransaction,
  memo: VerifiedMemoSetV1,
  rawLocatorStorageHashes: readonly Hash[],
): Hash {
  let memoCatalogRoot: Hash | null = null;
  let catalogStorageHash: Hash | null = null;
  let catalogChunkStorageHashes: readonly Hash[] = [];
  if (memo.memos.length !== 0) {
    const catalog = sealInstanceCatalog(memo.memos[0]!.cutoff, memo.memos);
    const encoded = encodeInstanceCatalogV1(catalog);
    catalogChunkStorageHashes = encoded.chunks.map(chunk => tx.putImmutable(
      INSTANCE_CATALOG_CHUNK_KIND,
      chunk.bytes,
    ));
    catalogStorageHash = tx.putImmutable(
      INSTANCE_CATALOG_KIND,
      encoded.manifestBytes,
      catalogChunkStorageHashes,
    );
    memoCatalogRoot = catalog.instanceCatalogRoot;
  }
  const manifest = verifiedMemoManifest(memo, memoCatalogRoot);
  return tx.putImmutable(
    VERIFIED_MEMO_SET_KIND,
    encodeCanonicalBytes(manifest),
    [
      ...(catalogStorageHash === null ? [] : [catalogStorageHash]),
      ...rawLocatorStorageHashes,
    ],
  );
}

function decodeMemoSetRecordWith(
  read: DurableContentReader,
  storageHash: Hash,
  context: string,
): VerifiedMemoSetV1 {
  const record = read(storageHash);
  if (!record || record.kind !== VERIFIED_MEMO_SET_KIND) {
    throw new CorruptDurableStoreError(`${context} is missing or has the wrong kind`);
  }
  const catalogHashes: Hash[] = [];
  const rawLocatorStorageHashes: Hash[] = [];
  for (const reference of record.references) {
    const child = read(reference);
    if (!child) throw new CorruptDurableStoreError(`${context} reference is missing`);
    if (child.kind === INSTANCE_CATALOG_KIND) catalogHashes.push(reference);
    else if (child.kind === RAW_EVIDENCE_LOCATOR_KIND) rawLocatorStorageHashes.push(reference);
    else throw new CorruptDurableStoreError(`${context} has an unexpected reference kind`);
  }
  let manifest: VerifiedMemoSetManifestV1;
  try {
    manifest = decodeExactObject(decodeCanonicalJson(record.bytes), {
      schemaVersion: field => {
        if (field !== 1) throw new TypeError("verified memo manifest schema version mismatch");
        return 1 as const;
      },
      kind: field => {
        if (field !== "aloha.verified-memo-set-manifest-v1") throw new TypeError("verified memo manifest kind mismatch");
        return "aloha.verified-memo-set-manifest-v1" as const;
      },
      memoCount: (field, path) => assertDecimalString(field, path),
      memoCatalogRoot: (field, path) => field === null ? null : assertHash(field, path),
      retainedRawLocatorCount: (field, path) => assertDecimalString(field, path),
      retainedRawLocatorSequenceRoot: (field, path) => assertHash(field, path),
      verifiedMemoSetRoot: (field, path) => assertHash(field, path),
    }, context);
  } catch (error) {
    throw new CorruptDurableStoreError(
      `${context} manifest validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let memos: readonly InstancePublicationV1[] = [];
  if (manifest.memoCount === "0") {
    if (manifest.memoCatalogRoot !== null || catalogHashes.length !== 0) {
      throw new CorruptDurableStoreError(`${context} empty memo catalog closure mismatch`);
    }
  } else {
    if (manifest.memoCatalogRoot === null || catalogHashes.length !== 1) {
      throw new CorruptDurableStoreError(`${context} memo catalog closure mismatch`);
    }
    const catalog = decodeInstanceCatalogRecordWith(read, catalogHashes[0]!, `${context} catalog`);
    if (catalog.instanceCatalogRoot !== manifest.memoCatalogRoot
      || catalog.instanceCount !== manifest.memoCount) {
      throw new CorruptDurableStoreError(`${context} memo catalog root mismatch`);
    }
    memos = catalog.publications;
  }
  const locatorHashes = rawLocatorStorageHashes.map((hash, index) => {
    const raw = read(hash)!;
    if (raw.references.length !== 0) {
      throw new CorruptDurableStoreError(`${context} raw locator ${index} has references`);
    }
    return sha256Hex(raw.bytes);
  }).sort(compareText);
  validateRawLocatorReferences(read, rawLocatorStorageHashes, locatorHashes, context);
  const memo = verifiedMemoSet(memos, locatorHashes);
  if (manifest.memoCount !== String(memo.memos.length)
    || manifest.retainedRawLocatorCount !== String(memo.retainedRawLocatorHashes.length)
    || manifest.retainedRawLocatorSequenceRoot !== hashCanonicalPartition(
      "aloha/verified-memo-raw-locator-sequence/v1",
      memo.retainedRawLocatorHashes,
    )
    || manifest.verifiedMemoSetRoot !== memo.verifiedMemoSetRoot) {
    throw new CorruptDurableStoreError(`${context} verified memo root mismatch`);
  }
  return memo;
}

function rootFromRecord(record: DurableRootRecord): CheckpointRootV1 {
  const root = decodeRoot(record.envelopeBytes);
  if (root.revision !== record.revision) throw new CorruptDurableStoreError("checkpoint root revision mismatch");
  return root;
}

function decodeCandidatePartitionCommitment(bytes: Uint8Array): CandidatePartitionCommitmentV1 {
  const value = exactObject(
    decodeCanonicalJson(bytes),
    CANDIDATE_PARTITION_COMMITMENT_FIELDS,
    "candidatePartitionCommitment",
  );
  const cutoff = exactObject(value.cutoff, ["chainId", "number", "hash", "stateRoot"], "candidatePartitionCommitment.cutoff");
  return deepFreeze({
    readyRecordHash: assertHash(value.readyRecordHash, "candidatePartitionCommitment.readyRecordHash"),
    runId: assertNonEmptyString(value.runId, "candidatePartitionCommitment.runId"),
    cutoff: {
      chainId: assertNonEmptyString(cutoff.chainId, "candidatePartitionCommitment.cutoff.chainId"),
      number: decimal(cutoff.number, "candidatePartitionCommitment.cutoff.number"),
      hash: assertHash(cutoff.hash, "candidatePartitionCommitment.cutoff.hash"),
      stateRoot: assertHash(cutoff.stateRoot, "candidatePartitionCommitment.cutoff.stateRoot"),
    },
    candidatePartitionRoot: assertHash(value.candidatePartitionRoot, "candidatePartitionCommitment.candidatePartitionRoot"),
    candidatePartitionStorageHash: assertHash(value.candidatePartitionStorageHash, "candidatePartitionCommitment.candidatePartitionStorageHash"),
    nominationClosureRoot: assertHash(value.nominationClosureRoot, "candidatePartitionCommitment.nominationClosureRoot"),
    nominationClosureStorageHash: assertHash(value.nominationClosureStorageHash, "candidatePartitionCommitment.nominationClosureStorageHash"),
    candidateRecordCount: decimal(value.candidateRecordCount, "candidatePartitionCommitment.candidateRecordCount"),
    candidateKeysRoot: assertHash(value.candidateKeysRoot, "candidatePartitionCommitment.candidateKeysRoot"),
    recentObservationRoot: assertHash(value.recentObservationRoot, "candidatePartitionCommitment.recentObservationRoot"),
    sourceCoverageRoot: assertHash(value.sourceCoverageRoot, "candidatePartitionCommitment.sourceCoverageRoot"),
    checkpointRevision: decimal(value.checkpointRevision, "candidatePartitionCommitment.checkpointRevision"),
    candidatePartitionCommitmentStorageHash: assertHash(value.candidatePartitionCommitmentStorageHash, "candidatePartitionCommitment.candidatePartitionCommitmentStorageHash"),
    exactOutcomePartitionRoot: assertHash(value.exactOutcomePartitionRoot, "candidatePartitionCommitment.exactOutcomePartitionRoot"),
    sealedRevision: decimal(value.sealedRevision, "candidatePartitionCommitment.sealedRevision"),
    stageRevision: decimal(value.stageRevision, "candidatePartitionCommitment.stageRevision"),
    stageRecordHash: assertHash(value.stageRecordHash, "candidatePartitionCommitment.stageRecordHash"),
    readyBaseHash: assertHash(value.readyBaseHash, "candidatePartitionCommitment.readyBaseHash"),
  });
}

function decodeReadyClosure(bytes: Uint8Array): ReadyClosureV1 {
  const value = exactObject(decodeCanonicalJson(bytes), READY_CLOSURE_FIELDS, "readyClosure");
  const ready = cloneCanonical<ReadyGenerationV1>(value.ready);
  validateReadyGeneration(ready);
  return deepFreeze({
    ready,
    candidatePartitionStorageHash: assertHash(value.candidatePartitionStorageHash, "readyClosure.candidatePartitionStorageHash"),
    outcomePartitionStorageHash: assertHash(value.outcomePartitionStorageHash, "readyClosure.outcomePartitionStorageHash"),
    attestationPartitionStorageHash: assertHash(value.attestationPartitionStorageHash, "readyClosure.attestationPartitionStorageHash"),
    nominationClosureRoot: assertHash(value.nominationClosureRoot, "readyClosure.nominationClosureRoot"),
    nominationClosureStorageHash: assertHash(value.nominationClosureStorageHash, "readyClosure.nominationClosureStorageHash"),
    candidateRecordCount: decimal(value.candidateRecordCount, "readyClosure.candidateRecordCount"),
    candidateKeysRoot: assertHash(value.candidateKeysRoot, "readyClosure.candidateKeysRoot"),
    recentObservationRoot: assertHash(value.recentObservationRoot, "readyClosure.recentObservationRoot"),
    sourceCoverageRoot: assertHash(value.sourceCoverageRoot, "readyClosure.sourceCoverageRoot"),
    candidatePartitionRevision: decimal(value.candidatePartitionRevision, "readyClosure.candidatePartitionRevision"),
    sourceCoverageStorageHash: assertHash(value.sourceCoverageStorageHash, "readyClosure.sourceCoverageStorageHash"),
    sourceExecutionSetRoot: assertHash(value.sourceExecutionSetRoot, "readyClosure.sourceExecutionSetRoot"),
    sourceExecutionSetStorageHash: assertHash(value.sourceExecutionSetStorageHash, "readyClosure.sourceExecutionSetStorageHash"),
    sourcePlanEvidenceStorageHash: assertHash(value.sourcePlanEvidenceStorageHash, "readyClosure.sourcePlanEvidenceStorageHash"),
    candidatePartitionReadyCommitmentStorageHash: assertHash(value.candidatePartitionReadyCommitmentStorageHash, "readyClosure.candidatePartitionReadyCommitmentStorageHash"),
    candidatePartitionCommitmentStorageHash: assertHash(value.candidatePartitionCommitmentStorageHash, "readyClosure.candidatePartitionCommitmentStorageHash"),
    verifiedMemoSetStorageHash: assertHash(value.verifiedMemoSetStorageHash, "readyClosure.verifiedMemoSetStorageHash"),
    instanceCatalogStorageHash: assertHash(value.instanceCatalogStorageHash, "readyClosure.instanceCatalogStorageHash"),
    graphStorageHash: assertHash(value.graphStorageHash, "readyClosure.graphStorageHash"),
  });
}

function readyStagePayload(stage: Omit<ReadyStageV1, "stageRecordHash">): object {
  return {
    stageRevision: stage.stageRevision,
    expectedRevision: stage.expectedRevision,
    runId: stage.runId,
    readyBase: stage.readyBase,
    readyBaseHash: stage.readyBaseHash,
    sourceCoverageStorageHash: stage.sourceCoverageStorageHash,
    sourceExecutionSetRoot: stage.sourceExecutionSetRoot,
    sourceExecutionSetStorageHash: stage.sourceExecutionSetStorageHash,
    sourcePlanEvidenceStorageHash: stage.sourcePlanEvidenceStorageHash,
    nominationClosureRoot: stage.nominationClosureRoot,
    nominationClosureStorageHash: stage.nominationClosureStorageHash,
    verifiedMemoSetStorageHash: stage.verifiedMemoSetStorageHash,
    instanceCatalogStorageHash: stage.instanceCatalogStorageHash,
    graphStorageHash: stage.graphStorageHash,
    sealedRevision: stage.sealedRevision,
  };
}

function decodeReadyStage(bytes: Uint8Array): ReadyStageV1 {
  const value = exactObject(decodeCanonicalJson(bytes), READY_STAGE_FIELDS, "readyStage");
  const readyBase = cloneCanonical<ReadyGenerationBaseV1>(value.readyBase);
  validateReadyGenerationBase(readyBase);
  const stage = deepFreeze({
    stageRevision: decimal(value.stageRevision, "readyStage.stageRevision"),
    stageRecordHash: assertHash(value.stageRecordHash, "readyStage.stageRecordHash"),
    expectedRevision: decimal(value.expectedRevision, "readyStage.expectedRevision"),
    runId: assertNonEmptyString(value.runId, "readyStage.runId"),
    readyBase,
    readyBaseHash: assertHash(value.readyBaseHash, "readyStage.readyBaseHash"),
    sourceCoverageStorageHash: assertHash(value.sourceCoverageStorageHash, "readyStage.sourceCoverageStorageHash"),
    sourceExecutionSetRoot: assertHash(value.sourceExecutionSetRoot, "readyStage.sourceExecutionSetRoot"),
    sourceExecutionSetStorageHash: assertHash(value.sourceExecutionSetStorageHash, "readyStage.sourceExecutionSetStorageHash"),
    sourcePlanEvidenceStorageHash: assertHash(value.sourcePlanEvidenceStorageHash, "readyStage.sourcePlanEvidenceStorageHash"),
    nominationClosureRoot: assertHash(value.nominationClosureRoot, "readyStage.nominationClosureRoot"),
    nominationClosureStorageHash: assertHash(value.nominationClosureStorageHash, "readyStage.nominationClosureStorageHash"),
    verifiedMemoSetStorageHash: assertHash(value.verifiedMemoSetStorageHash, "readyStage.verifiedMemoSetStorageHash"),
    instanceCatalogStorageHash: assertHash(value.instanceCatalogStorageHash, "readyStage.instanceCatalogStorageHash"),
    graphStorageHash: assertHash(value.graphStorageHash, "readyStage.graphStorageHash"),
    sealedRevision: decimal(value.sealedRevision, "readyStage.sealedRevision"),
  });
  if (hashDomain("aloha/ready-stage/v1", readyStagePayload(stage)) !== stage.stageRecordHash) {
    throw new CorruptDurableStoreError("ready stage record hash mismatch");
  }
  if (readyGenerationBaseHash(readyBase) !== stage.readyBaseHash) {
    throw new CorruptDurableStoreError("ready stage base hash mismatch");
  }
  if (BigInt(stage.stageRevision) !== BigInt(stage.expectedRevision) + 1n) {
    throw new CorruptDurableStoreError("ready stage revision lineage mismatch");
  }
  if (BigInt(stage.sealedRevision) > BigInt(stage.expectedRevision)) {
    throw new CorruptDurableStoreError("ready stage sealed revision is ahead of stage input");
  }
  return stage;
}

interface MemoSeedReceiptV1 {
  readonly runId: string;
  readonly cutoff: BeginRunInputV1["cutoff"];
  readonly reason: "cutoff-too-old-for-serving";
  readonly sealedRevision: string;
  readonly definitionCatalogRoot: Hash;
  readonly checkpointSchemaHash: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly exactOutcomePartitionRoot: Hash;
  readonly verifiedMemoRoot: Hash;
  readonly canonicalJournalEpoch: string;
  readonly canonicalJournalRoot: Hash;
  readonly sequence: string;
  readonly priorReceiptHash: Hash | null;
  readonly priorLineageRoot: Hash;
  readonly receiptLineageRoot: Hash;
}

function memoSeedLineageRoot(
  input: Omit<MemoSeedReceiptV1, "receiptLineageRoot">,
): Hash {
  return hashDomain("aloha/memo-seed-lineage-transition/v1", input);
}

function decodeMemoSeedReceipt(bytes: Uint8Array): MemoSeedReceiptV1 {
  const value = exactObject(decodeCanonicalJson(bytes), MEMO_SEED_RECEIPT_FIELDS, "memoSeedReceipt");
  const cutoff = exactObject(value.cutoff, ["chainId", "number", "hash", "stateRoot"], "memoSeedReceipt.cutoff");
  if (value.reason !== "cutoff-too-old-for-serving") {
    throw new CorruptDurableStoreError("memo seed receipt reason is invalid");
  }
  const payload = deepFreeze({
    runId: assertNonEmptyString(value.runId, "memoSeedReceipt.runId"),
    cutoff: {
      chainId: assertNonEmptyString(cutoff.chainId, "memoSeedReceipt.cutoff.chainId"),
      number: decimal(cutoff.number, "memoSeedReceipt.cutoff.number"),
      hash: assertHash(cutoff.hash, "memoSeedReceipt.cutoff.hash"),
      stateRoot: assertHash(cutoff.stateRoot, "memoSeedReceipt.cutoff.stateRoot"),
    },
    reason: "cutoff-too-old-for-serving" as const,
    sealedRevision: decimal(value.sealedRevision, "memoSeedReceipt.sealedRevision"),
    definitionCatalogRoot: assertHash(value.definitionCatalogRoot, "memoSeedReceipt.definitionCatalogRoot"),
    checkpointSchemaHash: assertHash(value.checkpointSchemaHash, "memoSeedReceipt.checkpointSchemaHash"),
    candidatePartitionRoot: assertHash(value.candidatePartitionRoot, "memoSeedReceipt.candidatePartitionRoot"),
    sourceCoverageRoot: assertHash(value.sourceCoverageRoot, "memoSeedReceipt.sourceCoverageRoot"),
    exactOutcomePartitionRoot: assertHash(value.exactOutcomePartitionRoot, "memoSeedReceipt.exactOutcomePartitionRoot"),
    verifiedMemoRoot: assertHash(value.verifiedMemoRoot, "memoSeedReceipt.verifiedMemoRoot"),
    canonicalJournalEpoch: decimal(value.canonicalJournalEpoch, "memoSeedReceipt.canonicalJournalEpoch"),
    canonicalJournalRoot: assertHash(value.canonicalJournalRoot, "memoSeedReceipt.canonicalJournalRoot"),
    sequence: decimal(value.sequence, "memoSeedReceipt.sequence"),
    priorReceiptHash: nullableHash(value.priorReceiptHash, "memoSeedReceipt.priorReceiptHash"),
    priorLineageRoot: assertHash(value.priorLineageRoot, "memoSeedReceipt.priorLineageRoot"),
  });
  const receiptLineageRoot = assertHash(value.receiptLineageRoot, "memoSeedReceipt.receiptLineageRoot");
  if (memoSeedLineageRoot(payload) !== receiptLineageRoot) {
    throw new CorruptDurableStoreError("memo seed receipt lineage root mismatch");
  }
  return deepFreeze({ ...payload, receiptLineageRoot });
}

/** Single executable codec authority for every checkpoint-owned durable wire object. */
export const CHECKPOINT_SCHEMA_AUTHORITY = Object.freeze({
  manifest: CHECKPOINT_SCHEMA_MANIFEST,
  schemaHash: CHECKPOINT_SCHEMA_HASH,
  decodeRoot,
  decodeRun,
  decodeCandidatePartitionCommitment,
  decodeMemoSetRecordWith,
  decodeReadyClosure,
  decodeReadyStage,
  decodeMemoSeedReceipt,
  validateRawLocatorReferences,
  loadPartition,
});

export class CheckpointStore implements BuilderCheckpointPort, ReadyStorePort {
  readonly #durable: SQLiteDurableStore;
  readonly #canonical: CanonicalSource;
  readonly #probeCaller: object;
  readonly #promotionAuthority: ReadyPromotionAuthorityGuardPort;
  readonly #attestationAuthority: AttestationValidationAuthorityV1;
  readonly #candidatePartitionCapabilities: CandidatePartitionCapabilityRegistryV1;
  readonly #candidatePartitionReader: CandidatePartitionReaderPortV1;
  readonly #sixStepArtifacts: CheckpointSixStepArtifactPortV1;
  readonly #validatedRunStorageHashes = new Set<Hash>();
  readonly #validatedReadyStageStorageHashes = new Set<Hash>();
  readonly #validatedReadyClosureStorageHashes = new Set<Hash>();
  /** One durable partial can mint at most one process-local resume handle. */
  readonly #issuedResumeClaims = new Set<string>();
  /** One durable final can mint at most one process-local resume handle. */
  readonly #issuedOutcomeResumeClaims = new Set<string>();
  /** One root-reachable prior publication can be considered once per exact
   * current run candidate. */
  readonly #issuedMemoReuseClaims = new Set<string>();
  readonly #pendingResumeClaimKeys = new Set<string>();
  readonly #probeStates = new WeakMap<object, RetryableProbeCapabilityStateV1>();
  readonly #issuedProbeClaims = new Set<string>();
  readonly #sealedRuns = new SealedRunCapabilityRegistryV1();
  readonly #readyStage12EvidenceStates = new WeakMap<object, ReadyStage12EvidenceCapabilityStateV1>();
  readonly #readyStage12EvidenceByReady = new Map<Hash, ReadyStage12EvidenceCapabilityV1>();
  readonly #readyStage12ArtifactsByReady = new Map<Hash, ReadyStage12ArtifactAuthorityV1>();
  readonly #readyStage12EvidenceReader: ReadyStage12EvidenceReaderPortV1;
  readonly #readyFullFamilyEvidenceReader: ReadyFullFamilyEvidenceReaderPortV1;

  constructor(
    durable: SQLiteDurableStore,
    canonical: CanonicalSource,
    probeCaller: object,
    promotionAuthority: ReadyPromotionAuthorityGuardPort,
    attestationAuthority: AttestationValidationAuthorityV1,
    sixStepArtifacts: CheckpointSixStepArtifactPortV1,
    candidatePartitionBootstrap: CandidatePartitionBootstrapV1 = createCandidatePartitionBootstrap(),
  ) {
    checkpointStoreInstances.add(this);
    this.#durable = durable;
    this.#canonical = canonical;
    this.#probeCaller = probeCaller;
    try {
      this.#attestationAuthority = assertAttestationValidationAuthority(attestationAuthority);
    } catch (error) {
      throw new CheckpointError(
        "attestation-authority-invalid",
        error instanceof Error ? error.message : "attestation validation authority is not issued",
      );
    }
    bindCheckpointDurableAuthorityLayoutV1(durable, this.#captureAuthorityFence().runtimeAuthority);
    this.#candidatePartitionCapabilities = consumeCandidatePartitionBootstrap(candidatePartitionBootstrap);
    this.#candidatePartitionReader = this.#candidatePartitionCapabilities.reader;
    assertCheckpointSixStepArtifactPortV1(sixStepArtifacts);
    this.#sixStepArtifacts = sixStepArtifacts;
    this.#promotionAuthority = assertIssuedReadyPromotionAuthorityPort(promotionAuthority);
    this.#readyStage12EvidenceReader = Object.freeze({
      binding: (capability: ReadyStage12EvidenceCapabilityV1) => this.#readyStage12EvidenceBinding(capability),
      read: (capability: ReadyStage12EvidenceCapabilityV1) => this.#readReadyStage12Evidence(capability),
      verify: async (capability: ReadyStage12EvidenceCapabilityV1, snapshot: ReadyStage12EvidenceSnapshotV1) => {
        const authoritative = await this.#readReadyStage12Evidence(capability);
        if (encodeCanonicalJson(authoritative) !== encodeCanonicalJson(snapshot)) {
          throw new CorruptDurableStoreError("ready stage1/2 evidence snapshot does not match checkpoint authority");
        }
        return authoritative;
      },
      routeParents: (capability: ReadyStage12EvidenceCapabilityV1, orderedEdgeIds: readonly Hash[]) => {
        const state = this.#readyStage12EvidenceStates.get(capability);
        if (!state) throw new TypeError("ready stage1/2 evidence capability is not checkpoint-issued");
        const stage1 = orderedEdgeIds.map(edgeId => {
          const parent = state.artifacts.stage1ByEdgeId.get(assertHash(edgeId, "readyStage12.routeEdgeId"));
          if (parent === undefined) throw new TypeError("ready Stage 1 route parent is unavailable");
          return parent;
        });
        const stage2 = orderedEdgeIds.map(edgeId => {
          const parent = state.artifacts.stage2ByEdgeId.get(assertHash(edgeId, "readyStage12.routeEdgeId"));
          if (parent === undefined) throw new TypeError("ready Stage 2 route parent is unavailable");
          return parent;
        });
        return Object.freeze({ stage1: Object.freeze(stage1), stage2: Object.freeze(stage2) });
      },
    });
    registerCheckpointReadyStage12EvidenceReader(this.#readyStage12EvidenceReader);
    this.#readyFullFamilyEvidenceReader = Object.freeze({
      read: (capability: ReadyStage12EvidenceCapabilityV1) => this.#readReadyFullFamilyEvidence(capability),
    });
    registerCheckpointReadyFullFamilyEvidenceReader(this.#readyFullFamilyEvidenceReader);
  }

  /** Constructor-bound reader used by Attestation; it accepts only handles
   * issued by this checkpoint instance and never exposes a raw partition. */
  get candidatePartitionReader(): CandidatePartitionReaderPortV1 {
    return this.#candidatePartitionReader;
  }

  /** Checkpoint-issued, read-only composition port for ReadyGeneration. */
  get sealedRunReader(): SealedRunReaderPortV1 {
    return this.#sealedRuns.reader;
  }

  /** Read-only owner port. It can inspect exact checkpoint-issued handles but
   * has no method that mints or replaces Stage 1/2 facts. */
  get readyStage12EvidenceReader(): ReadyStage12EvidenceReaderPortV1 {
    return this.#readyStage12EvidenceReader;
  }

  /** Full-Family durable facts over the same checkpoint-issued Stage 1/2 handle. */
  get readyFullFamilyEvidenceReader(): ReadyFullFamilyEvidenceReaderPortV1 {
    return this.#readyFullFamilyEvidenceReader;
  }

  /**
   * Checkpoint's public authority methods own their runtime-authority fence. The
   * bootstrap facade is only an outer convenience guard; it must not be the
   * sole protection against a runtime-authority rotation during an async read.
   */
  #captureAuthorityFence(): AttestationEvidenceAuthoritySnapshotV1 {
    const snapshot = this.#attestationAuthority.readEvidenceAuthority();
    return deepFreeze(structuredClone(snapshot));
  }

  #assertAuthorityFenceUnchanged(
    before: AttestationEvidenceAuthoritySnapshotV1,
  ): void {
    const after = this.#captureAuthorityFence();
    if (encodeCanonicalJson(after) !== encodeCanonicalJson(before)) {
      throw new CheckpointRunStateError("checkpoint runtime authority changed during public authority read");
    }
  }

  async loadAndValidateRoot(): Promise<BuilderCheckpointRootV1> {
    const root = this.#loadOrCreateRoot();
    this.#validateRootClosure(root);
    return deepFreeze({
      revision: root.revision,
      inProgressRunId: root.inProgressRunId,
      stagedReadyStorageHash: root.stagedReadyStorageHash,
      readyGenerationId: root.readyGenerationId,
      readyGenerationRecordHash: root.readyGenerationRecordHash,
    });
  }

  async loadRun(runId: string): Promise<InProgressBuilderRunV1> {
    const loaded = this.#loadActiveRun(runId);
    return publicBuilderRun(loaded.builderRun);
  }

  async loadSourcePlanPredecessor(parentGenerationId: string | null): Promise<SourcePlanPredecessorClosureV1 | null> {
    if (parentGenerationId === null) return null;
    const record = this.#durable.readRoot();
    if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(record);
    this.#validateRootReferenceSet(record, root);
    if (root.readyGenerationId !== parentGenerationId || root.readyGenerationRecordHash === null) return null;
    const closure = this.#findReadyClosureRecord(record.references, root.readyGenerationRecordHash).closure;
    const sourceCoverage = cloneCanonical<SourceCoverageCertificateV1>(decodeCanonicalJson(
      readContentStore(this.#durable, closure.sourceCoverageStorageHash, SOURCE_COVERAGE_KIND, "predecessor source coverage"),
    ));
    if (sourceCoverage.sourceCoverageRoot !== closure.sourceCoverageRoot) {
      throw new CorruptDurableStoreError("predecessor source coverage root mismatch");
    }
    const validated = validateSourceExecutionSetRecord(
      hash => this.#durable.readContent(hash),
      closure.sourceExecutionSetStorageHash,
      sourceCoverage,
    );
    if (validated.set.executionSetRoot !== closure.sourceExecutionSetRoot) {
      throw new CorruptDurableStoreError("predecessor source execution set root mismatch");
    }
    const rawEvidenceLocators = [...validated.rawStorageBySemanticHash.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([rawLocatorHash, storageHash]) => {
        const raw = this.#durable.readContent(storageHash);
        if (!raw || raw.kind !== RAW_EVIDENCE_LOCATOR_KIND || raw.payloadHash !== rawLocatorHash) {
          throw new CorruptDurableStoreError("predecessor raw locator is missing");
        }
        return Object.freeze({
          kind: "raw-evidence-locator" as const,
          version: 1 as const,
          rawLocatorHash,
          bytes: new Uint8Array(raw.bytes),
        });
      });
    return Object.freeze({
      sourceCoverage,
      sourceExecutionSet: validated.set,
      rawEvidenceLocators: Object.freeze(rawEvidenceLocators),
    });
  }

  /**
   * Read the latest committed single-target probe exclusively from the
   * root-reachable durable lineage.  Callers cannot provide the receipt,
   * candidate, or either side of the outcome transition.
   */
  loadLatestProbeEvidence(): CheckpointProbeEvidenceV1 | null {
    const authorityFence = this.#captureAuthorityFence();
    const record = this.#durable.readRoot();
    if (!record) return null;
    const root = rootFromRecord(record);
    this.#validateRootReferenceSet(record, root);
    if (root.latestProbeReceiptHash === null) return null;
    const evidence = this.#validateProbeReceiptChainWith(
      hash => this.#durable.readContent(hash),
      root.latestProbeReceiptHash,
    );
    const finalRecord = this.#durable.readRoot();
    if (!finalRecord) throw new CorruptDurableStoreError("checkpoint root missing after probe evidence load");
    const finalRoot = rootFromRecord(finalRecord);
    if (
      finalRecord.envelopeHash !== record.envelopeHash
      || finalRoot.revision !== root.revision
      || finalRoot.latestProbeReceiptHash !== root.latestProbeReceiptHash
      || finalRoot.probeReceiptLineageRoot !== root.probeReceiptLineageRoot
    ) throw new CheckpointRunStateError("probe evidence changed during durable load");
    this.#assertAuthorityFenceUnchanged(authorityFence);
    return evidence;
  }

  /** Physical SQLite identity observed by the checkpoint owner itself.  It
   * binds restart evidence to one durable file, not merely to a copied set of
   * self-consistent root bytes. */
  loadRuntimeStoreAnchor(): CheckpointRuntimeStoreAnchorV1 {
    const path = realpathSync(this.#durable.filename);
    if (!lstatSync(path).isFile()) throw new CheckpointRunStateError("checkpoint runtime store is not a physical file");
    const before = statSync(path, { bigint: true });
    const after = statSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new CheckpointRunStateError("checkpoint runtime store identity changed during observation");
    }
    return deepFreeze({ path, device: String(after.dev), inode: String(after.ino) });
  }

  /**
   * Observe the exact active run without consuming any resume capability.
   * This is intentionally narrower than loadAttestationResumeCapabilities:
   * it cannot claim, reissue, persist, or promote anything.  The returned
   * storage hashes let an external observer independently re-read the raw
   * SQLite closure instead of trusting this semantic projection by itself.
   */
  async loadRuntimeRestartSnapshot(): Promise<CheckpointRuntimeRestartSnapshotV1> {
    const authorityFence = this.#captureAuthorityFence();
    const rootRecord = this.#durable.readRoot();
    if (!rootRecord) throw new CheckpointRunStateError("runtime restart snapshot requires a checkpoint root");
    const root = rootFromRecord(rootRecord);
    this.#validateRootReferenceSet(rootRecord, root);
    if (root.inProgressRunId === null) {
      throw new CheckpointRunStateError("runtime restart snapshot requires an active run");
    }
    const loaded = this.#loadActiveRun(root.inProgressRunId);
    const partials = this.#loadPartialOutcomesStore(loaded.envelope);
    const outcomes = this.#loadOutcomesStore(loaded.envelope);
    const probeEvidence = root.latestProbeReceiptHash === null
      ? null
      : this.#validateProbeReceiptChainWith(
          hash => this.#durable.readContent(hash),
          root.latestProbeReceiptHash,
        );
    await this.#canonical.assertStillCanonical(loaded.envelope.cutoff);
    const finalRecord = this.#durable.readRoot();
    if (!finalRecord) throw new CheckpointRunStateError("runtime restart checkpoint root disappeared");
    const finalRoot = rootFromRecord(finalRecord);
    if (finalRecord.envelopeHash !== rootRecord.envelopeHash
      || finalRoot.revision !== root.revision
      || finalRoot.inProgressRunId !== root.inProgressRunId
      || finalRoot.latestProbeReceiptHash !== root.latestProbeReceiptHash) {
      throw new CheckpointRunStateError("runtime restart snapshot changed during durable load");
    }
    this.#assertAuthorityFenceUnchanged(authorityFence);
    return deepFreeze({
      checkpointStore: this.loadRuntimeStoreAnchor(),
      checkpointRevision: root.revision,
      checkpointRootEnvelopeHash: rootRecord.envelopeHash,
      runEnvelopeStorageHash: loaded.storageHash,
      runId: loaded.envelope.runId,
      cutoff: loaded.envelope.cutoff,
      candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
      outcomePartitionRoot: loaded.envelope.outcomePartitionRoot,
      candidates: loaded.builderRun.candidates,
      partials,
      outcomes,
      probeEvidence,
    });
  }

  /**
   * Read the active ready record from the checkpoint root, never from a
   * caller-provided object. The closure decoder and root-reference validator
   * prove the durable identity; the canonical and runtime-authority fences prove that
   * the record is still eligible to be considered by ReadyGeneration.
   */
  async loadActiveReady(): Promise<ReadyGenerationV1 | null> {
    const authorityFence = this.#captureAuthorityFence();
    const record = this.#durable.readRoot();
    if (!record) return null;
    const root = rootFromRecord(record);
    this.#validateRootReferenceSet(record, root);
    if (root.readyGenerationRecordHash === null || root.readyGenerationId === null) return null;
    const found = this.#findReadyClosure(record.references, root.readyGenerationRecordHash);
    const ready = found.ready;
    if (ready.generationId !== root.readyGenerationId || ready.readyRecordHash !== root.readyGenerationRecordHash) {
      throw new CorruptDurableStoreError("active ready generation pointer mismatch");
    }
    await this.#canonical.assertStillCanonical(ready.cutoff);
    const finalRecord = this.#durable.readRoot();
    if (!finalRecord) throw new CorruptDurableStoreError("checkpoint root missing after active ready load");
    const finalRoot = rootFromRecord(finalRecord);
    if (
      finalRecord.envelopeHash !== record.envelopeHash
      || finalRoot.revision !== root.revision
      || finalRoot.readyGenerationId !== root.readyGenerationId
      || finalRoot.readyGenerationRecordHash !== root.readyGenerationRecordHash
    ) throw new CheckpointRunStateError("active ready generation changed during active ready load");
    // Fence the asynchronous durable read against canonical drift as well as
    // runtime-authority rotation. Authority mismatch is deliberately returned to
    // ReadyGeneration, which classifies it as non-reusable under the current
    // the runtime owner instead of hiding the exact stale binding here.
    await this.#canonical.assertStillCanonical(ready.cutoff);
    this.#assertAuthorityFenceUnchanged(authorityFence);
    return ready;
  }

  /**
   * Rehydrate the exact active-run difference in one claim boundary. Final
   * outcomes are included as well as identity partials, so a restarted owner
   * can skip already-completed candidates without asking a Family program to
   * recreate a result. All records are validated before either claim set is
   * marked consumed.
   */
  async loadAttestationResumeCapabilities(runId: string): Promise<AttestationResumeCapabilitiesV1> {
    const loaded = this.#loadActiveRun(runId);
    const partials = this.#loadPartialOutcomesStore(loaded.envelope);
    const outcomes = this.#loadOutcomesStore(loaded.envelope);
    const candidates = new Map(loaded.builderRun.candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
    const identityClaims: string[] = [];
    const finalClaims: string[] = [];
    const identityCapabilities: AttestationIdentityResumeCapabilityV1[] = [];
    const finalCapabilities: AttestationOutcomeResumeCapabilityV1[] = [];
    const memoReuseCapabilities: AttestationVerifiedMemoReuseCapabilityV1[] = [];
    const retryable: Hash[] = [];
    const identityKeys = new Set<string>();
    const finalKeys = new Set<string>();
    const memoClaims: string[] = [];
    for (const partial of partials) {
      if (partial.identity === null) throw new CorruptDurableStoreError("partial identity is missing its identity record");
      const candidate = candidates.get(partial.familyCandidateKey);
      if (!candidate) throw new CorruptDurableStoreError("partial identity candidate is absent");
      const commitmentHash = partial.identity.identityCommitment.commitmentHash;
      const claimKey = `${loaded.envelope.runId}:${partial.familyCandidateKey}:${commitmentHash}`;
      if (this.#issuedResumeClaims.has(claimKey) || this.#pendingResumeClaimKeys.has(claimKey)) {
        throw new CheckpointRunStateError("durable partial resume capability already claimed");
      }
      if (identityKeys.has(partial.familyCandidateKey) || finalKeys.has(partial.familyCandidateKey)) {
        throw new CorruptDurableStoreError("durable resume closure contains duplicate candidate");
      }
      identityCapabilities.push(rehydrateIdentityResumeCapabilityForCheckpoint(this.#attestationAuthority, {
        runId: loaded.envelope.runId,
        cutoff: loaded.envelope.cutoff,
        candidatePartition: loaded.builderRun.candidatePartition,
        candidatePartitionReader: this.#candidatePartitionReader,
        familyCandidateKey: partial.familyCandidateKey,
        identity: partial.identity,
        outcomeHash: partial.outcomeHash,
        runtimeAuthority: partial.runtimeAuthority,
        attestationAuthorityRoot: partial.attestationAuthorityRoot,
        frameworkAuthorityRoot: partial.frameworkAuthorityRoot,
        executorAuthorityRoot: partial.executorAuthorityRoot,
      }));
      identityClaims.push(claimKey);
      identityKeys.add(partial.familyCandidateKey);
    }
    for (const outcome of outcomes) {
      const candidate = candidates.get(outcome.familyCandidateKey);
      if (!candidate) throw new CorruptDurableStoreError("final outcome candidate is absent");
      if (identityKeys.has(outcome.familyCandidateKey) || finalKeys.has(outcome.familyCandidateKey)) {
        throw new CorruptDurableStoreError("durable resume closure contains both partial and final outcome");
      }
      if (outcome.kind === "retryable") {
        this.#attestationAuthority.validateDurableOutcome(outcome, {
          runId: loaded.envelope.runId,
          cutoff: loaded.envelope.cutoff,
          candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
          candidate,
        });
        retryable.push(outcome.familyCandidateKey);
        continue;
      }
      const outcomeHash = candidateFinalOutcomeHash(outcome);
      const claimKey = `${loaded.envelope.runId}:${outcome.familyCandidateKey}:${outcomeHash}`;
      if (this.#issuedOutcomeResumeClaims.has(claimKey) || this.#pendingResumeClaimKeys.has(claimKey)) {
        throw new CheckpointRunStateError("durable final outcome resume capability already claimed");
      }
      finalCapabilities.push(rehydrateOutcomeResumeCapabilityForCheckpoint(this.#attestationAuthority, {
        runId: loaded.envelope.runId,
        cutoff: loaded.envelope.cutoff,
        candidatePartition: loaded.builderRun.candidatePartition,
        candidatePartitionReader: this.#candidatePartitionReader,
        familyCandidateKey: outcome.familyCandidateKey,
        candidate,
        outcome,
        outcomeHash,
        runtimeAuthority: outcome.runtimeAuthority,
        attestationAuthorityRoot: outcome.attestationAuthorityRoot,
        frameworkAuthorityRoot: outcome.frameworkAuthorityRoot,
        executorAuthorityRoot: outcome.executorAuthorityRoot,
      }));
      finalClaims.push(claimKey);
      finalKeys.add(outcome.familyCandidateKey);
    }
    const memoRecord = this.#durable.readContent(loaded.envelope.verifiedMemoSetStorageHash);
    if (!memoRecord || memoRecord.kind !== VERIFIED_MEMO_SET_KIND) {
      throw new CorruptDurableStoreError("active run prior verified memo set is missing");
    }
    const memoSet = decodeMemoSetRecordWith(
      hash => this.#durable.readContent(hash),
      loaded.envelope.verifiedMemoSetStorageHash,
      "active run prior verified memo set",
    );
    if (memoSet.verifiedMemoSetRoot !== loaded.envelope.verifiedMemoSetRoot) {
      throw new CorruptDurableStoreError("active run prior verified memo root mismatch");
    }
    const publicationsByInstance = new Map<string, InstancePublicationV1>();
    for (const publication of memoSet.memos) {
      const instance = `${publication.familyId}\u0000${publication.instanceKey}`;
      if (publicationsByInstance.has(instance)) throw new CorruptDurableStoreError("verified memo set contains duplicate Family instance");
      publicationsByInstance.set(instance, publication);
    }
    for (const candidate of loaded.builderRun.candidates) {
      if (identityKeys.has(candidate.familyCandidateKey) || finalKeys.has(candidate.familyCandidateKey) || retryable.includes(candidate.familyCandidateKey)) continue;
      const publication = publicationsByInstance.get(`${candidate.familyId}\u0000${candidate.instanceNominationKey}`);
      if (!publication) continue;
      const claimKey = `${loaded.envelope.runId}:${candidate.familyCandidateKey}:${publication.instancePublicationHash}:${memoSet.verifiedMemoSetRoot}`;
      if (this.#issuedMemoReuseClaims.has(claimKey) || this.#pendingResumeClaimKeys.has(claimKey)) {
        throw new CheckpointRunStateError("verified memo reuse capability already claimed");
      }
      memoReuseCapabilities.push(rehydrateVerifiedMemoReuseCapabilityForCheckpoint(this.#attestationAuthority, {
        runId: loaded.envelope.runId,
        cutoff: loaded.envelope.cutoff,
        candidatePartition: loaded.builderRun.candidatePartition,
        candidatePartitionReader: this.#candidatePartitionReader,
        familyCandidateKey: candidate.familyCandidateKey,
        publication,
        verifiedMemoSetRoot: memoSet.verifiedMemoSetRoot,
      }));
      memoClaims.push(claimKey);
    }
    const allClaimKeys = [...identityClaims, ...finalClaims, ...memoClaims];
    for (const claimKey of allClaimKeys) this.#pendingResumeClaimKeys.add(claimKey);
    let claimState: "pending" | "committed" | "aborted" = "pending";
    const claim = Object.freeze({
      commit: (): void => {
        if (claimState !== "pending") throw new CheckpointRunStateError("attestation resume claim already closed");
        for (const claimKey of identityClaims) {
          if (this.#issuedResumeClaims.has(claimKey)) {
            claimState = "aborted";
            for (const key of allClaimKeys) this.#pendingResumeClaimKeys.delete(key);
            throw new CheckpointRunStateError("durable partial resume capability was claimed concurrently");
          }
        }
        for (const claimKey of finalClaims) {
          if (this.#issuedOutcomeResumeClaims.has(claimKey)) {
            claimState = "aborted";
            for (const key of allClaimKeys) this.#pendingResumeClaimKeys.delete(key);
            throw new CheckpointRunStateError("durable final outcome resume capability was claimed concurrently");
          }
        }
        for (const claimKey of memoClaims) {
          if (this.#issuedMemoReuseClaims.has(claimKey)) {
            claimState = "aborted";
            for (const key of allClaimKeys) this.#pendingResumeClaimKeys.delete(key);
            throw new CheckpointRunStateError("verified memo reuse capability was claimed concurrently");
          }
        }
        for (const claimKey of identityClaims) this.#issuedResumeClaims.add(claimKey);
        for (const claimKey of finalClaims) this.#issuedOutcomeResumeClaims.add(claimKey);
        for (const claimKey of memoClaims) this.#issuedMemoReuseClaims.add(claimKey);
        for (const key of allClaimKeys) this.#pendingResumeClaimKeys.delete(key);
        claimState = "committed";
      },
      abort: (): void => {
        if (claimState !== "pending") throw new CheckpointRunStateError("attestation resume claim already closed");
        for (const key of allClaimKeys) this.#pendingResumeClaimKeys.delete(key);
        claimState = "aborted";
      },
    }) satisfies AttestationResumeClaimV1;
    return deepFreeze({
      identity: deepFreeze(identityCapabilities),
      final: deepFreeze(finalCapabilities),
      retryable: deepFreeze(retryable.sort(compareText)),
      memoReuse: deepFreeze(memoReuseCapabilities),
      claim,
    });
  }

  /**
   * Rehydrates a durable stage after a crash.  It does not issue freshness or
   * serving authority; the caller must feed the returned sealed run back into
   * the promotion service, which will only perform the minimal activation CAS
   * after a new provider observation.
   */
  async loadStagedPromotion(): Promise<{ readonly sealedRun: SealedRunCapabilityV1; readonly sealedRunBinding: import("../../sealed-run-runtime/src/contract.ts").SealedRunBindingV1; readonly instanceCatalog: InstanceCatalogV1; readonly stage: ReadyStageIdentityV1 } | null> {
    const record = this.#durable.readRoot();
    if (!record) return null;
    const root = rootFromRecord(record);
    this.#validateRootReferenceSet(record, root);
    if (root.stagedReadyStorageHash === null) return null;
    if (root.inProgressRunId === null) throw new CorruptDurableStoreError("staged ready has no active run");
    const stage = this.#findReadyStageRecord(record.references, root.stagedReadyStorageHash);
    const loaded = this.#loadActiveRunRead(record, root, stage.runId);
    if (!loaded.envelope.attestationPartitionStorageHash) throw new CorruptDurableStoreError("staged run is not sealed");
    const partition = decodeAttestationPartitionRecordWith(
      hash => this.#durable.readContent(hash),
      loaded.envelope.attestationPartitionStorageHash,
      loaded.envelope.outcomePartitionStorageHash,
      loaded.envelope.runId,
      "staged attestation partition",
    );
    this.#attestationAuthority.validateDurablePartition(partition, loaded.builderRun.candidates);
    assertPromotablePartition(partition, loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey));
    const instanceCatalog = decodeInstanceCatalogRecordWith(
      hash => this.#durable.readContent(hash),
      stage.instanceCatalogStorageHash,
      "staged instance catalog",
    );
    const memo = decodeMemoSetRecordWith(
      hash => this.#durable.readContent(hash),
      stage.verifiedMemoSetStorageHash,
      "staged verified memo set",
    );
    assertVerifiedPublicationCatalog(memo.memos, instanceCatalog);
    const sealedRunSnapshot = this.#sealedRunSnapshot(loaded.envelope, loaded.builderRun.candidates, partition, loaded.sourceCoverage);
    const sealedRun = this.#issueSealedRun(loaded.envelope.runId);
    if (
      sealedRunSnapshot.checkpointRevision !== stage.expectedRevision
      || sealedRunSnapshot.runId !== stage.runId
      || sealedRunSnapshot.verifiedMemoSetRoot !== stage.readyBase.verifiedMemoSetRoot
      || sealedRunSnapshot.partition.exactOutcomePartitionRoot !== stage.readyBase.exactOutcomePartitionRoot
      || sealedRunSnapshot.candidatePartitionCommitmentStorageHash !== stage.readyBase.candidatePartitionCommitmentStorageHash
    ) throw new CorruptDurableStoreError("staged promotion lineage mismatch");
    return deepFreeze({
      sealedRun,
      sealedRunBinding: this.#sealedRuns.binding(sealedRun),
      instanceCatalog,
      stage: this.#readyStageIdentity(stage, root.stagedReadyStorageHash),
    });
  }

  async resolveStagedPromotion(stage: ReadyStageIdentityV1): Promise<ReadyPromotionDurableStateV1> {
    validateReadyStageIdentity(stage);
    const record = this.#durable.readRoot();
    if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(record);
    this.#validateRootReferenceSet(record, root);
    return this.#resolvePromotionStateWith(
      hash => this.#durable.readContent(hash),
      record,
      root,
      stage,
    );
  }

  async beginNewRunAndPersistPartition(input: BeginRunInputV1): Promise<InProgressBuilderRunV1> {
    const cutoff = cloneCanonical<BeginRunInputV1["cutoff"]>(input.cutoff);
    if (!sameCutoff(input.sourceCoverage.cutoff, cutoff)) throw new CheckpointRunStateError("coverage cutoff mismatch");
    validateSourceCoverageCertificate(input.sourceCoverage, input.sourceCoverage.entries.map(entry => ({
      ownerRef: entry.ownerRef,
      sourcePlanRef: entry.sourcePlanRef,
      familyDefinitionHash: entry.familyDefinitionHash,
      completeness: entry.completeness,
      historyStartBlock: entry.historyStartBlock,
    })));
    const sourceExecutionSet = decodePersistedSourcePlanExecutionSet(input.sourceExecutionSet, "beginRun.sourceExecutionSet");
    validatePersistedExecutionCoverage(sourceExecutionSet, input.sourceCoverage);
    validateRecentObservationReceipt(input.recentObservation, this.#canonical.recentObservationRange(cutoff));
    if (!sameCutoff(input.recentObservation.cutoff, cutoff)) throw new CheckpointRunStateError("observation cutoff mismatch");
    const sourcePlanEvidence = decodeSourcePlanEvidenceSet(
      encodeCanonicalBytes(input.sourcePlanEvidence),
      "beginRun.sourcePlanEvidence",
    );
    validateSourcePlanEvidenceReceipts(
      sourcePlanEvidence,
      cutoff,
      sourcePlanRefsFromCoverage(input.sourceCoverage),
    );
    validateSourcePlanEvidenceExecutionJoin(sourcePlanEvidence, sourceExecutionSet);
    const computedCandidatePartitionRoot = candidatePartitionRoot(input.candidates);
    const nominationClosure = validateNominationClosureAgainstRun({
      closure: input.nominationClosure,
      cutoff,
      recentObservation: input.recentObservation,
      sourceCoverage: input.sourceCoverage,
      sourceExecutionSet,
      candidates: input.candidates,
      candidatePartitionRoot: computedCandidatePartitionRoot,
    });
    const rawLocators = mergedRawEvidenceLocatorContents(
      input.recentRawEvidenceLocators,
      input.sourcePlanRawEvidenceLocators,
    );
    const expectedLocatorHashes = deepFreeze([
      ...new Set([
        ...input.recentObservation.evidence.map(value => value.rawLocatorHash),
        ...sourcePlanEvidence.flatMap(value => value.rawLocatorHashes),
      ]),
    ].sort(compareText));
    if (
      rawLocators.length !== expectedLocatorHashes.length
      || rawLocators.some((value, index) => value.rawLocatorHash !== expectedLocatorHashes[index])
    ) throw new CheckpointRunStateError("raw evidence locator partition mismatch");
    const sealedEvidence = new Set([
      ...input.recentObservation.evidence,
      ...sourcePlanEvidence.flatMap(value => value.refs),
    ].map(value => encodeCanonicalJson(value)));
    for (const candidate of input.candidates) {
      for (const evidence of candidate.evidence) {
        if (!sealedEvidence.has(encodeCanonicalJson(evidence))) {
          throw new CheckpointRunStateError("candidate evidence is not in the sealed observation/source-plan evidence");
        }
      }
    }
    const runId = randomUUID();
    const authorityFence = this.#captureAuthorityFence();
    const owner = `checkpoint-begin/${runId}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      return this.#durable.transaction(lease, tx => {
        const currentRecord = tx.readRoot();
        if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing after initialization");
        const root = rootFromRecord(currentRecord);
        this.#validateRootReferenceSetTx(tx, currentRecord, root);
        if (root.revision !== input.expectedRootRevision) throw new CASConflictError(input.expectedRootRevision, root.revision);
        if (root.inProgressRunId !== null) throw new CheckpointRunStateError("an in-progress run already exists");
        if (root.readyGenerationId !== input.parentGenerationId) throw new CheckpointRunStateError("parent generation mismatch");

        const rawStorageBySemanticHash = new Map<Hash, Hash>();
        for (const locator of rawLocators) {
          const stored = tx.putImmutable(RAW_EVIDENCE_LOCATOR_KIND, locator.bytes);
          const storedRecord = tx.readContent(stored);
          if (!storedRecord || storedRecord.payloadHash !== locator.rawLocatorHash) {
            throw new CorruptDurableStoreError("raw locator payload hash mismatch");
          }
          rawStorageBySemanticHash.set(locator.rawLocatorHash, stored);
        }
        const recentStorageHash = tx.putImmutable(
          RECENT_OBSERVATION_KIND,
          encodeCanonicalBytes(input.recentObservation),
          input.recentObservation.evidence.map(value => rawStorageBySemanticHash.get(value.rawLocatorHash)!),
        );
        const coverageStorageHash = tx.putImmutable(SOURCE_COVERAGE_KIND, encodeCanonicalBytes(input.sourceCoverage));
        const sourcePlanRawLocatorHashes = [...new Set(sourcePlanEvidence.flatMap(value => value.rawLocatorHashes))].sort(compareText);
        const sourcePlanRawStorageHashes = sourcePlanRawLocatorHashes.map(hash => {
          const storageHash = rawStorageBySemanticHash.get(hash);
          if (storageHash === undefined) throw new CheckpointRunStateError(`source-plan raw locator ${hash} is not durable`);
          return storageHash;
        });
        const sourcePlanEvidenceStorageHash = tx.putImmutable(
          SOURCE_PLAN_EVIDENCE_KIND,
          encodeCanonicalBytes(sourcePlanEvidence),
          sourcePlanRawStorageHashes,
        );
        const predecessorRoots = sourceExecutionSet.executions
          .map(value => value.previousExecutionRoot)
          .filter((value): value is Hash => value !== null);
        let predecessorExecutionSetStorageHash: Hash | null = null;
        if (predecessorRoots.length > 0) {
          if (root.readyGenerationRecordHash === null || root.readyGenerationId !== input.parentGenerationId) {
            throw new CheckpointRunStateError("source execution predecessor has no active parent ready closure");
          }
          const priorReady = this.#findReadyClosureRecordWith(
            hash => tx.readContent(hash),
            currentRecord.references,
            root.readyGenerationRecordHash,
            false,
          ).closure;
          const priorRecord = tx.readContent(priorReady.sourceExecutionSetStorageHash);
          if (!priorRecord || priorRecord.kind !== SOURCE_EXECUTION_SET_KIND) {
            throw new CorruptDurableStoreError("parent source execution set is missing");
          }
          const priorSet = decodePersistedSourcePlanExecutionSet(decodeCanonicalJson(priorRecord.bytes), "parent source execution set");
          if (priorSet.executionSetRoot !== priorReady.sourceExecutionSetRoot) {
            throw new CorruptDurableStoreError("parent source execution set root mismatch");
          }
          const priorByRoot = new Map(priorSet.executions.map(value => [value.persistedExecutionRoot, value]));
          for (const current of sourceExecutionSet.executions) {
            if (current.previousExecutionRoot === null) continue;
            const prior = priorByRoot.get(current.previousExecutionRoot);
            if (
              prior === undefined
              || sourcePlanIdentity(prior.execution.plan) !== sourcePlanIdentity(current.execution.plan)
              || prior.sourcePlanLeafDigest !== current.sourcePlanLeafDigest
              || prior.sourcePlanSchemaHash !== current.sourcePlanSchemaHash
              || prior.sourcePlanClosureRoot !== current.sourcePlanClosureRoot
              || prior.sourceAuthorityRoot !== current.sourceAuthorityRoot
              || prior.execution.cutoff.chainId !== current.execution.cutoff.chainId
              || prior.execution.through !== priorSet.cutoff.number
              || current.execution.previousAppliedThrough !== prior.execution.through
              || BigInt(current.execution.from) !== BigInt(prior.execution.through) + 1n
              || BigInt(current.execution.cutoff.number) <= BigInt(prior.execution.cutoff.number)
            ) throw new CheckpointRunStateError("source execution predecessor lineage mismatch");
          }
          predecessorExecutionSetStorageHash = priorReady.sourceExecutionSetStorageHash;
        }
        const sourceExecutionSetStorageHash = tx.putImmutable(
          SOURCE_EXECUTION_SET_KIND,
          encodeCanonicalBytes(sourceExecutionSet),
          [...sourcePlanRawStorageHashes, ...(predecessorExecutionSetStorageHash === null ? [] : [predecessorExecutionSetStorageHash])],
        );
        const candidateEntries: PartitionEntryV1[] = [];
        for (const candidate of input.candidates) {
          const storageHash = tx.putImmutable(
            CANDIDATE_KIND,
            encodeCanonicalBytes(candidate),
            candidate.evidence.map(value => rawStorageBySemanticHash.get(value.rawLocatorHash)!),
          );
          tx.setIndex(`candidate/${runId}`, candidate.familyCandidateKey, storageHash);
          candidateEntries.push({ key: candidate.familyCandidateKey, storageHash });
        }
        const candidateManifestHash = putPartition(tx, runId, "candidate", candidateEntries);
        const encodedNominationClosure = encodePersistedNominationClosureV1(nominationClosure);
        const nominationClaimChunkStorageHashes = encodedNominationClosure.chunks.map(chunk => tx.putImmutable(
          NOMINATION_CLAIM_CHUNK_KIND,
          chunk.bytes,
        ));
        const nominationClosureStorageHash = tx.putImmutable(
          NOMINATION_CLOSURE_KIND,
          encodedNominationClosure.manifestBytes,
          [
            recentStorageHash,
            coverageStorageHash,
            sourceExecutionSetStorageHash,
            sourcePlanEvidenceStorageHash,
            candidateManifestHash,
            ...nominationClaimChunkStorageHashes,
          ],
        );
        const outcomeManifestHash = putPartition(tx, runId, "outcome", []);
        const memoStorageHash = this.#findMemoStorageHash(tx, currentRecord.references, root.verifiedMemoRoot);
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const commitment = createCandidatePartitionCommitmentV1({
          kind: "aloha.candidate-partition-commitment",
          version: "1",
          runtimeAuthority: authorityFence.runtimeAuthority,
          runId,
          cutoff,
          candidatePartitionRoot: computedCandidatePartitionRoot,
          candidatePartitionStorageHash: candidateManifestHash,
          nominationClosureRoot: nominationClosure.root,
          nominationClosureStorageHash,
          recordCount: String(input.candidates.length),
          candidateKeysRoot: candidatePartitionKeysRoot(
            input.candidates.map(candidate => candidate.familyCandidateKey),
          ),
          recentObservationRoot: input.recentObservation.observationRoot,
          sourceCoverageRoot: input.sourceCoverage.sourceCoverageRoot,
          checkpointRevision: nextRevision,
        });
        const commitmentStorageHash = tx.putImmutable(
          CANDIDATE_PARTITION_AUTHORITY_KIND,
          encodeCanonicalBytes(commitment),
        );
        const run: StoredRunEnvelopeV2 = deepFreeze({
          runId,
          parentGenerationId: input.parentGenerationId,
          checkpointRevision: nextRevision,
          candidatePartitionRevision: nextRevision,
          cutoff,
          recentObservationRoot: input.recentObservation.observationRoot,
          recentObservationStorageHash: recentStorageHash,
          definitionCatalogRoot: input.definitionCatalogRoot,
          sourceCoverageRoot: input.sourceCoverage.sourceCoverageRoot,
          sourceCoverageStorageHash: coverageStorageHash,
          sourceExecutionSetRoot: sourceExecutionSet.executionSetRoot,
          sourceExecutionSetStorageHash,
          sourcePlanEvidenceStorageHash,
          nominationClosureRoot: nominationClosure.root,
          nominationClosureStorageHash,
          candidatePartitionRoot: computedCandidatePartitionRoot,
          candidatePartitionStorageHash: candidateManifestHash,
          candidatePartitionCommitmentStorageHash: commitmentStorageHash,
          candidateRecordCount: String(input.candidates.length),
          outcomePartitionRoot: outcomePartitionRoot(runId, []),
          outcomePartitionStorageHash: outcomeManifestHash,
          partialOutcomePartitionStorageHash: null,
          attestationPartitionStorageHash: null,
          verifiedMemoSetRoot: root.verifiedMemoRoot,
          verifiedMemoSetStorageHash: memoStorageHash,
          accounting: outcomeAccounting(input.candidates.length, []),
        });
        const runStorageHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(run), runContentReferences(run));
        const nextRoot = deepFreeze({ ...root, revision: nextRevision, inProgressRunId: runId });
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          this.#rootReferencesFor(
            hash => tx.readContent(hash),
            [...currentRecord.references, runStorageHash],
            nextRoot,
            false,
          ),
        );
        return publicBuilderRun(this.#hydrateRun(tx, nextRoot, run, runStorageHash).builderRun);
      });
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
  }

  async sealRunAndClearInProgressCAS(
    run: InProgressBuilderRunV1,
    reason: "stale-cutoff" | "definition-root-changed" | "run-corrupt",
  ): Promise<void> {
    this.#clearRun(run.runId, run.checkpointRevision, reason, null);
  }

  async abandonStagedPromotionCAS(
    stageIdentity: ReadyStageIdentityV1,
    authorization: ReadyPromotionAbandonAuthorizationV1,
  ): Promise<ReadyPromotionAbandonResultV1> {
    validateReadyStageIdentity(stageIdentity);
    assertReadyPromotionAbandonAuthorization(authorization, stageIdentity);
    const owner = `checkpoint-abandon-stage/${stageIdentity.runId}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      try {
        return this.#durable.transaction(lease, tx => {
        const record = tx.readRoot();
        if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(record);
        this.#validateRootReferenceSetTx(tx, record, root);
        const state = this.#resolvePromotionStateWith(tx.readContent.bind(tx), record, root, stageIdentity);
        if (state.kind === "committed") return state;
        if (state.kind !== "staged") {
          throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
        }
        if (root.revision !== stageIdentity.stageRevision) {
          throw new ReadyPromotionRetryError();
        }
        if (root.inProgressRunId !== stageIdentity.runId) {
          throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
        }
        const stage = this.#findReadyStageRecordWith(tx.readContent.bind(tx), record.references, root.stagedReadyStorageHash!);
        const nextRoot: CheckpointRootV1 = deepFreeze({
          ...root,
          revision: (BigInt(root.revision) + 1n).toString(),
          inProgressRunId: null,
          stagedReadyStorageHash: null,
        });
        for (const entry of tx.listIndex(`candidate/${stage.runId}`)) tx.deleteIndex(`candidate/${stage.runId}`, entry.key);
        for (const entry of tx.listIndex(`outcome/${stage.runId}`)) tx.deleteIndex(`outcome/${stage.runId}`, entry.key);
        for (const entry of tx.listIndex(`partial-outcome/${stage.runId}`)) tx.deleteIndex(`partial-outcome/${stage.runId}`, entry.key);
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          this.#rootReferencesFor(tx.readContent.bind(tx), [...record.references], nextRoot, false),
        );
        return deepFreeze({ kind: "abandoned", stage: stageIdentity });
        });
      } catch (error) {
        if (!(error instanceof CASConflictError)) throw error;
        const state = await this.resolveStagedPromotion(stageIdentity);
        if (state.kind === "committed") return state;
        if (state.kind === "staged") throw new ReadyPromotionRetryError();
        throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
      }
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
  }

  async sealCompletedRunAsMemoSeedAndClearCAS(run: SealedRunCapabilityV1): Promise<void> {
    const snapshot = this.#sealedRuns.read(run);
    assertPromotablePartition(snapshot.partition, snapshot.candidateKeys);
    await this.#canonical.withCanonicalFence(snapshot.cutoff, async fence => {
      this.#clearRun(snapshot.runId, snapshot.checkpointRevision, "cutoff-too-old-for-serving", snapshot, fence);
    });
  }

  createOutcomeWriter(runId: string, options: OutcomeWriterOptions): DurableOutcomeWriterActor {
    this.#loadActiveRun(runId);
    return new DurableOutcomeWriterActor(this, runId, options);
  }

  async sealAttestationPartition(
    runId: string,
    partition: AttestationPartitionCapabilityV1,
  ): Promise<SealedRunCapabilityV1> {
    const owner = `checkpoint-seal-attestation/${runId}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    let sealedRunId: string;
    try {
      sealedRunId = this.#durable.transaction(lease, tx => {
        const currentRecord = tx.readRoot();
        if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(currentRecord);
        const loaded = this.#loadActiveRunTx(tx, currentRecord, root, runId, true);
        if (loaded.envelope.attestationPartitionStorageHash !== null) {
          throw new CheckpointRunStateError("run is already sealed");
        }
        this.#attestationAuthority.validatePartitionCapability(partition, loaded.builderRun.candidates);
        assertPromotablePartition(partition, loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey));
        const persisted = this.#loadOutcomes(tx, loaded.envelope);
        if (loaded.envelope.partialOutcomePartitionStorageHash !== null || tx.listIndex(`partial-outcome/${runId}`).length !== 0) {
          throw new CheckpointRunStateError("cannot seal while partial identity outcomes remain");
        }
        const persistedHashes = persisted.map(candidateFinalOutcomeHash);
        const partitionHashes = partition.outcomes.map(candidateFinalOutcomeHash);
        if (
          persistedHashes.length !== partitionHashes.length
          || persistedHashes.some((outcomeHash, index) => outcomeHash !== partitionHashes[index])
        ) throw new CheckpointRunStateError("persisted outcomes do not match sealed partition");
        const verifiedOutcomes = partition.outcomes.filter(value => value.kind === "verified");
        const verifiedCandidateKeys = new Set(verifiedOutcomes.map(value => value.familyCandidateKey));
        const retainedRawLocatorHashes = loaded.builderRun.candidates
          .filter(value => verifiedCandidateKeys.has(value.familyCandidateKey))
          .flatMap(value => value.evidence.map(evidence => evidence.rawLocatorHash));
        const memoSet = verifiedMemoSet(
          verifiedOutcomes.map(outcome => outcome.publication),
          retainedRawLocatorHashes,
        );
        const recentRecord = tx.readContent(loaded.envelope.recentObservationStorageHash);
        if (!recentRecord || recentRecord.kind !== RECENT_OBSERVATION_KIND) {
          throw new CorruptDurableStoreError("recent observation is missing while sealing memos");
        }
        const allRecentLocatorHashes = loaded.builderRun.recentObservation.evidence.map(value => value.rawLocatorHash);
        const rawStorageBySemanticHash = validateRawLocatorReferences(
          hash => tx.readContent(hash),
          recentRecord.references,
          allRecentLocatorHashes,
          "recent observation",
        );
        const sourcePlanRecord = tx.readContent(loaded.envelope.sourcePlanEvidenceStorageHash);
        if (!sourcePlanRecord || sourcePlanRecord.kind !== SOURCE_PLAN_EVIDENCE_KIND) {
          throw new CorruptDurableStoreError("source-plan evidence is missing while sealing memos");
        }
        const sourcePlanEvidence = decodeSourcePlanEvidenceSet(sourcePlanRecord.bytes, "source-plan evidence");
        const sourcePlanStorageBySemanticHash = validateRawLocatorReferences(
          hash => tx.readContent(hash),
          sourcePlanRecord.references,
          sourcePlanEvidence.flatMap(value => value.rawLocatorHashes),
          "source-plan evidence",
        );
        const retainedRawStorageHashes = memoSet.retainedRawLocatorHashes.map(hash => {
          const storageHash = rawStorageBySemanticHash.get(hash) ?? sourcePlanStorageBySemanticHash.get(hash);
          if (!storageHash) throw new CorruptDurableStoreError("verified memo raw locator is absent");
          return storageHash;
        });
        const memoStorageHash = putVerifiedMemoSet(tx, memoSet, retainedRawStorageHashes);
        const partitionStorageHash = tx.putImmutable(
          ATTESTATION_PARTITION_KIND,
          attestationPartitionManifestBytes(partition),
          [loaded.envelope.outcomePartitionStorageHash],
        );
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const nextRun: StoredRunEnvelopeV2 = deepFreeze({
          ...loaded.envelope,
          checkpointRevision: nextRevision,
          attestationPartitionStorageHash: partitionStorageHash,
          verifiedMemoSetRoot: memoSet.verifiedMemoSetRoot,
          verifiedMemoSetStorageHash: memoStorageHash,
        });
        const nextRunHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(nextRun), runContentReferences(nextRun));
        const nextRoot = deepFreeze({ ...root, revision: nextRevision });
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          this.#rootReferencesFor(
            hash => tx.readContent(hash),
            [...currentRecord.references, nextRunHash],
            nextRoot,
            false,
          ),
        );
        return nextRun.runId;
      });
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
    // Hydration validates the complete sealed closure and can be expensive;
    // it is read-only and must not extend the SQLite writer transaction.
    return this.#issueSealedRun(sealedRunId);
  }

  bindProbeStore(caller: object): ProbeStorePort {
    if (caller !== this.#probeCaller) throw new CheckpointError("probe-caller-unauthorized", "probe store caller is not authorized");
    return deepFreeze({
      loadRetryable: (runId: string, familyCandidateKey: Hash) => this.#loadRetryable(runId, familyCandidateKey),
      listRetryableCandidateKeys: (runId: string, failureCode: string) => this.#listRetryable(runId, failureCode),
      replaceRetryableCAS: (
        probeCapability: RetryableProbeCapabilityV1,
        writerCapability: AttestationWriterCapabilityV1,
        persistenceCapability: AttestationPersistenceCapabilityV1,
      ) => this.#replaceRetryable(probeCapability, writerCapability, persistenceCapability),
    });
  }

  /**
   * Internal runtime-owner retry edge. It is deliberately not part of the
   * public ProbeStorePort: the owner re-executes a durable retryable outcome
   * and then performs the same checkpoint CAS/receipt transition. If the
   * transaction fails before commit, the one-shot probe claim is released so
   * a same-process retry is possible; a post-commit fence failure leaves the
   * changed durable outcome authoritative.
   */
  async _replaceRetryableOutcomeForOwner(
    runId: string,
    familyCandidateKey: Hash,
    writerCapability: AttestationWriterCapabilityV1,
    persistenceCapability: AttestationPersistenceCapabilityV1,
  ): Promise<void> {
    const probe = await this.#loadRetryable(runId, familyCandidateKey);
    if (probe.beforeOutcomeHash === persistenceCapability.outcomeHash) {
      const claim = this.#attestationAuthority.claimWriterCapabilities(writerCapability, [persistenceCapability]);
      try {
        const persisted = claim.entries[0];
        if (
          !persisted
          || persisted.kind !== "final"
          || persisted.identity !== null
          || persisted.outcome === null
          || persisted.runId !== runId
          || persisted.familyCandidateKey !== familyCandidateKey
          || persisted.outcomeHash !== probe.beforeOutcomeHash
        ) throw new OutcomeStateConflictError("retryable owner no-op persistence lineage mismatch");
      } catch (error) {
        claim.abort();
        throw error;
      }
      // The exact durable hash is already present, so consuming this
      // session capability is the no-op CAS result that lets sealExactPartition
      // account for the candidate without writing a duplicate record.
      claim.commit();
      const claimKey = `${runId}:${familyCandidateKey}:${probe.beforeOutcomeHash}:${probe.checkpointRevision}`;
      this.#issuedProbeClaims.delete(claimKey);
      return;
    }
    try {
      await this.#replaceRetryable(probe.probeCapability, writerCapability, persistenceCapability);
    } catch (error) {
      try {
        const current = await this.#loadActiveRun(runId);
        const currentHash = this.#durable.readIndex(`outcome/${runId}`, familyCandidateKey);
        const currentRecord = currentHash === null ? null : this.#durable.readContent(currentHash);
        const currentOutcome = currentRecord?.kind === OUTCOME_KIND
          ? cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(currentRecord.bytes))
          : null;
        if (
          current.envelope.checkpointRevision === probe.checkpointRevision
          && currentOutcome !== null
          && currentOutcome.kind === "retryable"
          && candidateFinalOutcomeHash(currentOutcome) === probe.beforeOutcomeHash
        ) {
          const claimKey = `${runId}:${familyCandidateKey}:${probe.beforeOutcomeHash}:${probe.checkpointRevision}`;
          this.#issuedProbeClaims.delete(claimKey);
        }
      } catch {
        // Preserve the original CAS/fence error; a fresh CheckpointStore will
        // revalidate the durable root before issuing another retry edge.
      }
      throw error;
    }
  }

  async putContentAndFsync(kind: "instance-catalog" | "persisted-graph", value: object): Promise<Hash> {
    const owner = `checkpoint-content/${kind}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      if (kind === "instance-catalog") {
        const catalog = value as InstanceCatalogV1;
        const encoded = encodeInstanceCatalogV1(catalog);
        this.#durable.transaction(lease, tx => {
          const chunkHashes = encoded.chunks.map(chunk => tx.putImmutable(
            INSTANCE_CATALOG_CHUNK_KIND,
            chunk.bytes,
          ));
          const storageHash = tx.putImmutable(INSTANCE_CATALOG_KIND, encoded.manifestBytes, chunkHashes);
          const previous = tx.getIndex("semantic/instance-catalog", catalog.instanceCatalogRoot);
          if (previous !== null && previous !== storageHash) {
            throw new CorruptDurableStoreError("instance-catalog semantic root aliases different manifest bytes");
          }
          tx.setIndex("semantic/instance-catalog", catalog.instanceCatalogRoot, storageHash);
        });
        return catalog.instanceCatalogRoot;
      }
      const graph = value as PersistedGraphV1;
      const encoded = encodePersistedGraphV1(graph);
      this.#durable.transaction(lease, tx => {
        const chunkHashes = encoded.chunks.map(chunk => tx.putImmutable(GRAPH_CHUNK_KIND, chunk.bytes));
        const storageHash = tx.putImmutable(GRAPH_KIND, encoded.manifestBytes, chunkHashes);
        const previous = tx.getIndex("semantic/persisted-graph", graph.graphRoot);
        if (previous !== null && previous !== storageHash) {
          throw new CorruptDurableStoreError("persisted-graph semantic root aliases different manifest bytes");
        }
        tx.setIndex("semantic/persisted-graph", graph.graphRoot, storageHash);
      });
      return graph.graphRoot;
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
  }

  async stageReadyCAS(input: ReadyStageInputV1): Promise<ReadyStageResultV1> {
    const policyHash = generationRefreshPolicyHash(input.policy);
    const assertPromotionAuthority = (): void => {
      const binding = this.#promotionAuthority.assertActive(input.authority);
      if (
        binding.expectedRevision !== input.expectedRevision
        || binding.expectedInProgressRunId !== input.expectedInProgressRunId
        || !sameCutoff(binding.cutoff, input.fence.cutoff)
        || binding.definitionCatalogRoot !== input.ready.definitionCatalogRoot
        || binding.instanceCatalogRoot !== input.instanceCatalog.instanceCatalogRoot
        || binding.graphRoot !== input.graph.graphRoot
        || binding.generationRefreshPolicyHash !== policyHash
        || encodeCanonicalJson(binding.runtimeAuthority) !== encodeCanonicalJson(input.ready.runtimeAuthority)
        || binding.candidatePartitionCommitmentStorageHash !== input.ready.candidatePartitionCommitmentStorageHash
        || binding.nominationClosureRoot !== input.ready.nominationClosureRoot
        || binding.nominationClosureStorageHash !== input.ready.nominationClosureStorageHash
      ) throw new CheckpointRunStateError("ready promotion authority binding mismatch");
    };
    assertPromotionAuthority();
    this.#canonical.assertActiveFence(input.fence);
    validateInstanceCatalog(input.instanceCatalog);
    validateReadyGenerationBase(input.ready);
    try {
      validatePersistedGraphForCatalog(input.graph, input.instanceCatalog);
    } catch {
      throw new CheckpointError("graph-closure-mismatch", "ready graph is not derived from the instance catalog");
    }

    // Validate the immutable run/catalog/graph closure before taking the
    // writer lease. Large production partitions make this walk expensive,
    // but the root revision below still fences the short publishing CAS.
    const previewRecord = this.#durable.readRoot();
    if (!previewRecord) throw new CorruptDurableStoreError("checkpoint root missing");
    const previewRoot = rootFromRecord(previewRecord);
    if (previewRoot.stagedReadyStorageHash !== null) {
      if (previewRoot.inProgressRunId !== input.expectedInProgressRunId) {
        throw new CheckpointRunStateError("staged ready run is not active");
      }
      this.#validateRootReferenceSet(previewRecord, previewRoot);
      this.#validatedReadyStageStorageHashes.add(previewRoot.stagedReadyStorageHash);
      const existing = this.#findReadyStageRecordWith(
        hash => this.#durable.readContent(hash),
        previewRecord.references,
        previewRoot.stagedReadyStorageHash,
        true,
      );
      if (
        existing.readyBase.definitionCatalogRoot !== input.ready.definitionCatalogRoot
        || existing.readyBase.generationRefreshPolicyHash !== policyHash
        || encodeCanonicalJson(existing.readyBase.runtimeAuthority) !== encodeCanonicalJson(input.ready.runtimeAuthority)
      ) {
        this.#promotionAuthority.assertConfiguration({
          definitionCatalogRoot: existing.readyBase.definitionCatalogRoot,
          generationRefreshPolicyHash: existing.readyBase.generationRefreshPolicyHash,
          runtimeAuthority: existing.readyBase.runtimeAuthority,
        });
        throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
      }
      if (
        existing.expectedRevision !== input.expectedRevision
        || existing.runId !== input.expectedInProgressRunId
        || existing.readyBaseHash !== readyGenerationBaseHash(input.ready)
        || encodeCanonicalJson(existing.readyBase) !== encodeCanonicalJson(input.ready)
      ) throw new CheckpointRunStateError("staged ready input mismatch");
      assertPromotionAuthority();
      this.#canonical.assertActiveFence(input.fence);
      return deepFreeze({
        stage: this.#readyStageIdentity(existing, previewRoot.stagedReadyStorageHash),
        stageRevision: existing.stageRevision,
        stageRecordHash: existing.stageRecordHash,
      });
    }
    if (previewRoot.revision !== input.expectedRevision) {
      throw new CASConflictError(input.expectedRevision, previewRoot.revision);
    }
    if (previewRoot.inProgressRunId !== input.expectedInProgressRunId) {
      throw new CheckpointRunStateError("ready stage run is not active");
    }

    const loaded = this.#loadActiveRun(input.expectedInProgressRunId);
    if (!loaded.envelope.attestationPartitionStorageHash) {
      throw new CheckpointRunStateError("run is not sealed for promotion");
    }
    const read = (hash: Hash) => this.#durable.readContent(hash);
    const partition = decodeAttestationPartitionRecordWith(
      read,
      loaded.envelope.attestationPartitionStorageHash,
      loaded.envelope.outcomePartitionStorageHash,
      loaded.envelope.runId,
      "attestation partition",
    );
    this.#attestationAuthority.validateDurablePartition(partition, loaded.builderRun.candidates);
    assertPromotablePartition(partition, loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey));
    const memo = decodeMemoSetRecordWith(
      read,
      loaded.envelope.verifiedMemoSetStorageHash,
      "verified memo set",
    );
    assertVerifiedPublicationCatalog(memo.memos, input.instanceCatalog);
    const ready = input.ready;
    if (
      !sameCutoff(ready.cutoff, loaded.envelope.cutoff)
      || !sameCutoff(input.fence.cutoff, loaded.envelope.cutoff)
      || ready.parentGenerationId !== loaded.envelope.parentGenerationId
      || ready.recentObservationRange.from !== loaded.builderRun.recentObservation.range.from
      || ready.recentObservationRange.to !== loaded.builderRun.recentObservation.range.to
      || ready.definitionCatalogRoot !== loaded.envelope.definitionCatalogRoot
      || ready.sourceCoverageRoot !== loaded.envelope.sourceCoverageRoot
      || ready.candidatePartitionRoot !== loaded.envelope.candidatePartitionRoot
      || ready.nominationClosureRoot !== loaded.envelope.nominationClosureRoot
      || ready.nominationClosureStorageHash !== loaded.envelope.nominationClosureStorageHash
      || ready.exactOutcomePartitionRoot !== partition.exactOutcomePartitionRoot
      || ready.verifiedMemoSetRoot !== memo.verifiedMemoSetRoot
      || ready.instanceCatalogRoot !== input.instanceCatalog.instanceCatalogRoot
      || ready.graphRoot !== input.graph.graphRoot
      || ready.edgeCount !== input.graph.edgeCount
      || ready.instanceCount !== input.instanceCatalog.instanceCount
      || ready.generationRefreshPolicyHash !== policyHash
    ) throw new CheckpointRunStateError("ready payload does not match the sealed run closure");

    const semanticStorageHash = (namespace: string, key: string): Hash | null => (
      this.#durable.listIndex(namespace).find(entry => entry.key === key)?.contentHash ?? null
    );
    const catalogStorageHash = semanticStorageHash("semantic/instance-catalog", input.instanceCatalog.instanceCatalogRoot);
    const graphStorageHash = semanticStorageHash("semantic/persisted-graph", input.graph.graphRoot);
    if (!catalogStorageHash || !graphStorageHash) {
      throw new CorruptDurableStoreError("ready content was not fsynced before stage CAS");
    }
    const storedCatalog = decodeInstanceCatalogRecordWith(read, catalogStorageHash, "instance catalog");
    if (storedCatalog.instanceCatalogRoot !== input.instanceCatalog.instanceCatalogRoot
      || storedCatalog.instanceCount !== input.instanceCatalog.instanceCount
      || !sameCutoff(storedCatalog.cutoff, input.instanceCatalog.cutoff)) {
      throw new CorruptDurableStoreError("instance catalog bytes mismatch");
    }
    const storedGraph = decodePersistedGraphRecordWith(read, graphStorageHash, storedCatalog, "graph");
    if (storedGraph.graphRoot !== input.graph.graphRoot
      || storedGraph.edgeCount !== input.graph.edgeCount
      || !sameCutoff(storedGraph.cutoff, input.graph.cutoff)) {
      throw new CorruptDurableStoreError("graph bytes mismatch");
    }
    const stageRevision = (BigInt(previewRoot.revision) + 1n).toString();
    const stageWithoutHash: Omit<ReadyStageV1, "stageRecordHash"> = deepFreeze({
      stageRevision,
      expectedRevision: input.expectedRevision,
      runId: loaded.envelope.runId,
      readyBase: ready,
      readyBaseHash: readyGenerationBaseHash(ready),
      sourceCoverageStorageHash: loaded.envelope.sourceCoverageStorageHash,
      sourceExecutionSetRoot: loaded.envelope.sourceExecutionSetRoot,
      sourceExecutionSetStorageHash: loaded.envelope.sourceExecutionSetStorageHash,
      sourcePlanEvidenceStorageHash: loaded.envelope.sourcePlanEvidenceStorageHash,
      nominationClosureRoot: loaded.envelope.nominationClosureRoot,
      nominationClosureStorageHash: loaded.envelope.nominationClosureStorageHash,
      verifiedMemoSetStorageHash: loaded.envelope.verifiedMemoSetStorageHash,
      instanceCatalogStorageHash: catalogStorageHash,
      graphStorageHash,
      sealedRevision: loaded.envelope.checkpointRevision,
    });
    const stage: ReadyStageV1 = deepFreeze({
      ...stageWithoutHash,
      stageRecordHash: hashDomain("aloha/ready-stage/v1", readyStagePayload(stageWithoutHash)),
    });
    const stageReferences = [
      stage.sourceCoverageStorageHash,
      stage.sourceExecutionSetStorageHash,
      stage.sourcePlanEvidenceStorageHash,
      stage.nominationClosureStorageHash,
      stage.verifiedMemoSetStorageHash,
      stage.instanceCatalogStorageHash,
      stage.graphStorageHash,
    ];
    const stageStorageHash = this.#durable.putImmutableContent(
      READY_STAGE_KIND,
      encodeCanonicalBytes(stage),
      stageReferences,
    );
    this.#validatedReadyStageStorageHashes.add(stageStorageHash);
    const nextRoot: CheckpointRootV1 = deepFreeze({
      ...previewRoot,
      revision: stageRevision,
      stagedReadyStorageHash: stageStorageHash,
    });
    const nextReferences = this.#rootReferencesFor(
      read,
      [...previewRecord.references, stageStorageHash],
      nextRoot,
      true,
    );

    const owner = `checkpoint-stage/${input.expectedInProgressRunId}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      const result = this.#durable.transaction(lease, tx => {
        tx.addBeforeCommitGuard(() => {
          assertPromotionAuthority();
          this.#canonical.assertActiveFence(input.fence);
        });
        assertPromotionAuthority();
        this.#canonical.assertActiveFence(input.fence);
        const currentRecord = tx.readRoot();
        if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(currentRecord);
        if (root.revision !== input.expectedRevision) throw new CASConflictError(input.expectedRevision, root.revision);
        if (root.inProgressRunId !== input.expectedInProgressRunId) throw new CheckpointRunStateError("ready stage run is not active");
        if (root.stagedReadyStorageHash !== null
          || currentRecord.envelopeHash !== previewRecord.envelopeHash
          || encodeCanonicalJson(currentRecord.references) !== encodeCanonicalJson(previewRecord.references)
          || tx.getIndex("semantic/instance-catalog", input.instanceCatalog.instanceCatalogRoot) !== catalogStorageHash
          || tx.getIndex("semantic/persisted-graph", input.graph.graphRoot) !== graphStorageHash) {
          throw new CASConflictError(input.expectedRevision, root.revision);
        }
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          nextReferences,
        );
        return deepFreeze({
          stage: this.#readyStageIdentity(stage, stageStorageHash),
          stageRevision,
          stageRecordHash: stage.stageRecordHash,
        });
      });
      this.#validatedReadyStageStorageHashes.add(result.stage.stageStorageHash);
      return result;
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
  }

  async activateReadyCAS(input: ReadyActivationInputV1): Promise<ReadyCommitResultV1> {
    validateReadyStageIdentity(input.stage);
    const policyHash = generationRefreshPolicyHash(input.policy);
    const assertPromotionAuthority = (stage?: ReadyStageV1): void => {
      const binding = this.#promotionAuthority.assertActive(input.authority);
      if (
        binding.expectedRevision !== input.expectedRevision
        || binding.expectedInProgressRunId !== input.expectedInProgressRunId
        || !sameCutoff(binding.cutoff, input.fence.cutoff)
        || binding.generationRefreshPolicyHash !== policyHash
        || encodeCanonicalJson(binding.runtimeAuthority) !== encodeCanonicalJson(input.stage.runtimeAuthority)
        || binding.candidatePartitionCommitmentStorageHash !== input.stage.candidatePartitionCommitmentStorageHash
        || binding.nominationClosureRoot !== input.stage.nominationClosureRoot
        || binding.nominationClosureStorageHash !== input.stage.nominationClosureStorageHash
      ) throw new CheckpointRunStateError("ready activation authority binding mismatch");
      if (stage !== undefined && (
        binding.definitionCatalogRoot !== stage.readyBase.definitionCatalogRoot
        || binding.instanceCatalogRoot !== stage.readyBase.instanceCatalogRoot
        || binding.graphRoot !== stage.readyBase.graphRoot
        || encodeCanonicalJson(binding.runtimeAuthority) !== encodeCanonicalJson(stage.readyBase.runtimeAuthority)
        || binding.candidatePartitionCommitmentStorageHash !== stage.readyBase.candidatePartitionCommitmentStorageHash
        || binding.nominationClosureRoot !== stage.readyBase.nominationClosureRoot
        || binding.nominationClosureStorageHash !== stage.readyBase.nominationClosureStorageHash
      )) throw new CheckpointRunStateError("ready activation authority closure mismatch");
    };
    assertPromotionAuthority();
    this.#canonical.assertActiveFence(input.fence);
    this.#canonical.assertPromotionFreshness(input.fence, input.freshness);
    decimal(input.promotedAtMonotonicNs, "promotedAtMonotonicNs");
    await this.#emitReadyStage12BeforeActivation(input);
    // Stage 1/2 already validates this immutable sealed run. Rehydrate it
    // outside the writer transaction; the staged root revision and hashes
    // below fence the compact activation CAS against concurrent replacement.
    const preparedLoaded = this.#loadActiveRun(input.stage.runId);
    const owner = `checkpoint-activate/${input.expectedInProgressRunId}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      try {
        return this.#durable.transaction(lease, tx => {
        assertPromotionAuthority();
        this.#canonical.assertActiveFence(input.fence);
        this.#canonical.assertPromotionFreshness(input.fence, input.freshness);
        const currentRecord = tx.readRoot();
        if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(currentRecord);
        if (root.revision !== input.stage.stageRevision) throw new CASConflictError(input.stage.stageRevision, root.revision);
        if (root.stagedReadyStorageHash === null) throw new CheckpointRunStateError("staged ready is absent");
        if (root.inProgressRunId !== input.expectedInProgressRunId) throw new CheckpointRunStateError("ready activation run is not active");
        this.#validateRootReferenceSetTx(tx, currentRecord, root, true);
        const stage = this.#findReadyStageRecordWith(
          tx.readContent.bind(tx),
          currentRecord.references,
          root.stagedReadyStorageHash,
          true,
        );
        assertPromotionAuthority(stage);
        if (
          root.stagedReadyStorageHash !== input.stage.stageStorageHash
          || stage.stageRevision !== input.stage.stageRevision
          || stage.stageRecordHash !== input.stage.stageRecordHash
          || stage.expectedRevision !== input.stage.expectedRevision
          || stage.sealedRevision !== input.stage.sealedRevision
          || stage.runId !== input.stage.runId
          || stage.readyBaseHash !== input.stage.readyBaseHash
          || !sameCutoff(stage.readyBase.cutoff, input.stage.cutoff)
          || stage.readyBase.generationRefreshPolicyHash !== input.stage.generationRefreshPolicyHash
          || stage.readyBase.definitionCatalogRoot !== input.stage.definitionCatalogRoot
          || encodeCanonicalJson(stage.readyBase.runtimeAuthority) !== encodeCanonicalJson(input.stage.runtimeAuthority)
          || stage.readyBase.candidatePartitionCommitmentStorageHash !== input.stage.candidatePartitionCommitmentStorageHash
          || stage.readyBase.nominationClosureRoot !== input.stage.nominationClosureRoot
          || stage.readyBase.nominationClosureStorageHash !== input.stage.nominationClosureStorageHash
        ) throw new CheckpointRunStateError("ready activation stage binding mismatch");
        if (stage.readyBase.generationRefreshPolicyHash !== policyHash) throw new CheckpointRunStateError("ready activation policy mismatch");
        const maxPromotionAgeBlocks = (
          BigInt(decimal(input.policy.maxServingAgeBlocks, "readyPolicy.maxServingAgeBlocks"))
          - BigInt(decimal(input.policy.minPromotionMarginBlocks, "readyPolicy.minPromotionMarginBlocks"))
        ).toString();
        if (
          !sameCutoff(input.fence.cutoff, stage.readyBase.cutoff)
          || !sameCutoff(input.freshness.receipt.cutoff, stage.readyBase.cutoff)
          || input.freshness.receipt.generationRefreshPolicyHash !== policyHash
          || input.freshness.receipt.maxPromotionAgeBlocks !== maxPromotionAgeBlocks
        ) throw new CheckpointRunStateError("ready activation freshness binding mismatch");
        const loaded = preparedLoaded;
        // The transaction's own root CAS is the durable state guard.  Capture
        // the already validated immutable stage here and recheck only the
        // process-local authorities at the last synchronous point before
        // COMMIT.  Re-reading the root in this guard would observe this
        // transaction's new ACTIVE root (where the stage is intentionally
        // absent) and reject every successful activation.
        tx.addBeforeCommitGuard(() => {
          assertPromotionAuthority(stage);
          this.#canonical.assertActiveFence(input.fence);
          this.#canonical.assertPromotionFreshness(input.fence, input.freshness);
        });
        const promotionRevision = (BigInt(root.revision) + 1n).toString();
        const readyPayload = deepFreeze({
          ...stage.readyBase,
          promotionFreshness: input.freshness.receipt,
          promotedAtMonotonicNs: input.promotedAtMonotonicNs,
          promotionRevision,
        });
        const readyRecordHash = hashDomain("aloha/ready-generation/v1", readyPayload);
        const fullReady: ReadyGenerationV1 = deepFreeze({ ...readyPayload, readyRecordHash });
        const candidatePartitionCommitment: CandidatePartitionCommitmentV1 = deepFreeze({
          readyRecordHash,
          runId: stage.runId,
          cutoff: stage.readyBase.cutoff,
          candidatePartitionRoot: stage.readyBase.candidatePartitionRoot,
          candidatePartitionStorageHash: loaded.envelope.candidatePartitionStorageHash,
          nominationClosureRoot: stage.readyBase.nominationClosureRoot,
          nominationClosureStorageHash: stage.readyBase.nominationClosureStorageHash,
          candidateRecordCount: loaded.envelope.candidateRecordCount,
          candidateKeysRoot: candidatePartitionKeysRoot(loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey)),
          recentObservationRoot: loaded.envelope.recentObservationRoot,
          sourceCoverageRoot: loaded.envelope.sourceCoverageRoot,
          checkpointRevision: loaded.envelope.candidatePartitionRevision,
          candidatePartitionCommitmentStorageHash: stage.readyBase.candidatePartitionCommitmentStorageHash,
          exactOutcomePartitionRoot: stage.readyBase.exactOutcomePartitionRoot,
          sealedRevision: stage.sealedRevision,
          stageRevision: stage.stageRevision,
          stageRecordHash: stage.stageRecordHash,
          readyBaseHash: stage.readyBaseHash,
        });
        const candidatePartitionReadyCommitmentStorageHash = tx.putImmutable(
          CANDIDATE_PARTITION_COMMITMENT_KIND,
          encodeCanonicalBytes(candidatePartitionCommitment),
          [
            candidatePartitionCommitment.candidatePartitionCommitmentStorageHash,
            candidatePartitionCommitment.candidatePartitionStorageHash,
            candidatePartitionCommitment.nominationClosureStorageHash,
          ],
        );
        const closure: ReadyClosureV1 = deepFreeze({
          ready: fullReady,
          candidatePartitionStorageHash: candidatePartitionCommitment.candidatePartitionStorageHash,
          outcomePartitionStorageHash: loaded.envelope.outcomePartitionStorageHash,
          attestationPartitionStorageHash: loaded.envelope.attestationPartitionStorageHash!,
          nominationClosureRoot: candidatePartitionCommitment.nominationClosureRoot,
          nominationClosureStorageHash: candidatePartitionCommitment.nominationClosureStorageHash,
          candidateRecordCount: candidatePartitionCommitment.candidateRecordCount,
          candidateKeysRoot: candidatePartitionCommitment.candidateKeysRoot,
          recentObservationRoot: candidatePartitionCommitment.recentObservationRoot,
          sourceCoverageRoot: candidatePartitionCommitment.sourceCoverageRoot,
          candidatePartitionRevision: candidatePartitionCommitment.checkpointRevision,
          sourceCoverageStorageHash: stage.sourceCoverageStorageHash,
          sourceExecutionSetRoot: stage.sourceExecutionSetRoot,
          sourceExecutionSetStorageHash: stage.sourceExecutionSetStorageHash,
          sourcePlanEvidenceStorageHash: stage.sourcePlanEvidenceStorageHash,
          candidatePartitionReadyCommitmentStorageHash,
          candidatePartitionCommitmentStorageHash: stage.readyBase.candidatePartitionCommitmentStorageHash,
          verifiedMemoSetStorageHash: stage.verifiedMemoSetStorageHash,
          instanceCatalogStorageHash: stage.instanceCatalogStorageHash,
          graphStorageHash: stage.graphStorageHash,
        });
        const closureStorageHash = tx.putImmutable(READY_CLOSURE_KIND, encodeCanonicalBytes(closure), [
          closure.sourceCoverageStorageHash,
          closure.sourceExecutionSetStorageHash,
          closure.sourcePlanEvidenceStorageHash,
          closure.nominationClosureStorageHash,
          closure.candidatePartitionStorageHash,
          closure.outcomePartitionStorageHash,
          closure.attestationPartitionStorageHash,
          closure.candidatePartitionReadyCommitmentStorageHash,
          closure.candidatePartitionCommitmentStorageHash,
          closure.verifiedMemoSetStorageHash,
          closure.instanceCatalogStorageHash,
          closure.graphStorageHash,
        ]);
        const memo = decodeMemoSetRecordWith(
          tx.readContent.bind(tx),
          stage.verifiedMemoSetStorageHash,
          "verified memo set",
        );
        const nextRoot: CheckpointRootV1 = deepFreeze({
          ...root,
          revision: promotionRevision,
          verifiedMemoRoot: memo.verifiedMemoSetRoot,
          inProgressRunId: null,
          stagedReadyStorageHash: null,
          readyGenerationId: fullReady.generationId,
          readyGenerationRecordHash: readyRecordHash,
        });
        for (const entry of tx.listIndex(`candidate/${stage.runId}`)) tx.deleteIndex(`candidate/${stage.runId}`, entry.key);
        for (const entry of tx.listIndex(`outcome/${stage.runId}`)) tx.deleteIndex(`outcome/${stage.runId}`, entry.key);
        for (const entry of tx.listIndex(`partial-outcome/${stage.runId}`)) tx.deleteIndex(`partial-outcome/${stage.runId}`, entry.key);
        // The stage already performed the full closure validation.  Mark the
        // immutable ready closure as validated only after it is fully built;
        // activation must not repeat that expensive walk after freshness.
        this.#validatedReadyClosureStorageHashes.add(closureStorageHash);
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          this.#rootReferencesFor(
            tx.readContent.bind(tx),
            [
              ...currentRecord.references,
              stage.verifiedMemoSetStorageHash,
              closureStorageHash,
            ],
            nextRoot,
            true,
          ),
        );
        return deepFreeze({ promotionRevision, readyRecordHash });
        });
      } catch (error) {
        if (!(error instanceof CASConflictError)) throw error;
        const state = await this.resolveStagedPromotion(input.stage);
        if (state.kind === "committed") {
          return deepFreeze({
            promotionRevision: state.ready.promotionRevision,
            readyRecordHash: state.ready.readyRecordHash,
          });
        }
        if (state.kind === "staged") throw new ReadyPromotionRetryError();
        throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
      }
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
  }

  async #emitReadyStage12BeforeActivation(input: ReadyActivationInputV1): Promise<void> {
    const currentRecord = this.#durable.readRoot();
    if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(currentRecord);
    if (root.revision !== input.stage.stageRevision
      || root.stagedReadyStorageHash === null
      || root.inProgressRunId !== input.expectedInProgressRunId) {
      const state = await this.resolveStagedPromotion(input.stage);
      if (state.kind === "committed") return;
      if (state.kind === "staged") throw new ReadyPromotionRetryError();
      throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
    }
    this.#validateRootReferenceSet(currentRecord, root);
    const stage = this.#findReadyStageRecordWith(
      hash => this.#durable.readContent(hash),
      currentRecord.references,
      root.stagedReadyStorageHash,
      true,
    );
    if (stage.stageRecordHash !== input.stage.stageRecordHash
      || stage.readyBaseHash !== input.stage.readyBaseHash
      || stage.runId !== input.stage.runId) {
      throw new CheckpointRunStateError("ready Stage 1/2 preview stage binding mismatch");
    }
    const loaded = this.#loadActiveRun(stage.runId);
    const promotionRevision = (BigInt(root.revision) + 1n).toString();
    const readyPayload = deepFreeze({
      ...stage.readyBase,
      promotionFreshness: input.freshness.receipt,
      promotedAtMonotonicNs: input.promotedAtMonotonicNs,
      promotionRevision,
    });
    const ready: ReadyGenerationV1 = deepFreeze({
      ...readyPayload,
      readyRecordHash: hashDomain("aloha/ready-generation/v1", readyPayload),
    });
    const instanceCatalog = decodeInstanceCatalogRecordWith(
      hash => this.#durable.readContent(hash),
      stage.instanceCatalogStorageHash,
      "ready Stage 1/2 instance catalog",
    );
    const graph = decodePersistedGraphRecordWith(
      hash => this.#durable.readContent(hash),
      stage.graphStorageHash,
      instanceCatalog,
      "ready Stage 1/2 graph",
    );
    const candidates = new Map(loaded.builderRun.candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
    const publications = new Map(instanceCatalog.publications.map(publication => [publication.instancePublicationHash, publication]));
    const edgesByPublication = graphEdgesByPublication(graph);
    const stage1ByEdgeId = new Map<Hash, CheckpointSixStepArtifactCapabilityV1>();
    const stage2ByEdgeId = new Map<Hash, CheckpointSixStepArtifactCapabilityV1>();
    for (const outcome of this.#loadOutcomesStore(loaded.envelope)) {
      if (outcome.kind !== "verified") continue;
      const candidate = candidates.get(outcome.familyCandidateKey);
      const publication = publications.get(outcome.publication.instancePublicationHash);
      if (candidate === undefined || publication === undefined
        || encodeCanonicalJson(publication) !== encodeCanonicalJson(outcome.publication)) {
        throw new CorruptDurableStoreError("ready Stage 1/2 verified instance binding mismatch");
      }
      const parent = await this.#sixStepArtifacts.emitVerifiedOutcome({
        runId: stage.runId,
        cutoff: loaded.envelope.cutoff,
        candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
        candidate,
        outcome,
        sourceCoverage: loaded.sourceCoverage,
      });
      const edges = edgesByPublication.get(publication.instancePublicationHash) ?? [];
      if (edges.length !== publication.transitions.length) {
        throw new CorruptDurableStoreError("ready Stage 1/2 edge denominator mismatch");
      }
      for (const edge of edges) {
        const stage2 = await this.#sixStepArtifacts.emitReadyEdge({
          parent,
          ready,
          candidate,
          outcome,
          publication,
          edge,
          sourceCoverage: loaded.sourceCoverage,
        });
        if (stage1ByEdgeId.has(edge.edgeId) || stage2ByEdgeId.has(edge.edgeId)) {
          throw new CorruptDurableStoreError("ready Stage 1/2 edge identity is duplicated");
        }
        stage1ByEdgeId.set(edge.edgeId, parent);
        stage2ByEdgeId.set(edge.edgeId, stage2);
      }
    }
    this.#readyStage12ArtifactsByReady.set(ready.readyRecordHash, Object.freeze({ stage1ByEdgeId, stage2ByEdgeId }));
  }

  async loadReadyClosure(ready: ReadyGenerationV1): Promise<{
    readonly sourceCoverage: SourceCoverageCertificateV1;
    readonly nominationClosure: NominationClosureV1;
    readonly instanceCatalog: InstanceCatalogV1;
    readonly graph: PersistedGraphV1;
    readonly stage12EvidenceCapability: ReadyStage12EvidenceCapabilityV1;
  }> {
    const authorityFence = this.#captureAuthorityFence();
    await this.#canonical.assertStillCanonical(ready.cutoff);
    const rootRecord = this.#durable.readRoot();
    if (!rootRecord) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(rootRecord);
    this.#validateRootReferenceSet(rootRecord, root);
    if (root.readyGenerationId !== ready.generationId || root.readyGenerationRecordHash !== ready.readyRecordHash) {
      throw new CheckpointRunStateError("requested ready generation is not active");
    }
    const closure = this.#findReadyClosure(rootRecord.references, ready.readyRecordHash);
    if (encodeCanonicalJson(closure.ready) !== encodeCanonicalJson(ready)) throw new CorruptDurableStoreError("ready closure record mismatch");
    const sourceCoverage = cloneCanonical<SourceCoverageCertificateV1>(decodeCanonicalJson(readContentStore(this.#durable, closure.sourceCoverageStorageHash, SOURCE_COVERAGE_KIND, "source coverage")));
    const nominationClosure = decodeNominationClosureRecordWith(
      hash => this.#durable.readContent(hash),
      closure.nominationClosureStorageHash,
      "nomination closure",
    ).closure;
    if (
      nominationClosure.root !== closure.nominationClosureRoot
      || nominationClosure.root !== ready.nominationClosureRoot
      || nominationClosure.candidatePartitionRoot !== ready.candidatePartitionRoot
      || nominationClosure.sourceCoverageRoot !== ready.sourceCoverageRoot
      || !sameCutoff(nominationClosure.cutoff, ready.cutoff)
    ) throw new CorruptDurableStoreError("ready nomination closure mismatch");
    const instanceCatalog = decodeInstanceCatalogRecordWith(
      hash => this.#durable.readContent(hash),
      closure.instanceCatalogStorageHash,
      "instance catalog",
    );
    const graph = decodePersistedGraphRecordWith(
      hash => this.#durable.readContent(hash),
      closure.graphStorageHash,
      instanceCatalog,
      "persisted graph",
    );
    await this.#canonical.assertStillCanonical(ready.cutoff);
    const finalRootRecord = this.#durable.readRoot();
    if (!finalRootRecord) throw new CorruptDurableStoreError("checkpoint root missing after ready closure load");
    const finalRoot = rootFromRecord(finalRootRecord);
    if (
      finalRootRecord.envelopeHash !== rootRecord.envelopeHash
      || finalRoot.revision !== root.revision
      || finalRoot.readyGenerationId !== ready.generationId
      || finalRoot.readyGenerationRecordHash !== ready.readyRecordHash
    ) throw new CheckpointRunStateError("active ready generation changed during closure loading");
    this.#assertAuthorityFenceUnchanged(authorityFence);
    await this.#reopenReadyStage12Artifacts(closure, sourceCoverage, instanceCatalog, graph);
    const stage12EvidenceCapability = this.#issueReadyStage12Evidence(closure.ready);
    return deepFreeze({ sourceCoverage, nominationClosure, instanceCatalog, graph, stage12EvidenceCapability });
  }

  async #reopenReadyStage12Artifacts(
    closure: ReadyClosureV1,
    sourceCoverage: SourceCoverageCertificateV1,
    instanceCatalog: InstanceCatalogV1,
    graph: PersistedGraphV1,
  ): Promise<void> {
    if (this.#readyStage12ArtifactsByReady.has(closure.ready.readyRecordHash)) return;
    const commitment = decodeCandidatePartitionCommitment(readContentStore(
      this.#durable,
      closure.candidatePartitionReadyCommitmentStorageHash,
      CANDIDATE_PARTITION_COMMITMENT_KIND,
      "ready Stage 1/2 candidate partition commitment",
    ));
    const candidates = new Map(loadPartition(
      (hash, kind, context) => readContentStore(this.#durable, hash, kind, context),
      closure.candidatePartitionStorageHash,
      commitment.runId,
      "candidate",
    ).map(entry => {
      const candidate = cloneCanonical<CandidateRecordV1>(decodeCanonicalJson(readContentStore(
        this.#durable,
        entry.storageHash,
        CANDIDATE_KIND,
        "ready Stage 1/2 candidate",
      )));
      if (candidate.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("ready Stage 1/2 candidate key mismatch");
      return [candidate.familyCandidateKey, candidate] as const;
    }));
    const outcomes = loadPartition(
      (hash, kind, context) => readContentStore(this.#durable, hash, kind, context),
      closure.outcomePartitionStorageHash,
      commitment.runId,
      "outcome",
    ).map(entry => cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(readContentStore(
      this.#durable,
      entry.storageHash,
      OUTCOME_KIND,
      "ready Stage 1/2 outcome",
    ))));
    const publications = new Map(instanceCatalog.publications.map(publication => [publication.instancePublicationHash, publication]));
    const edgesByPublication = graphEdgesByPublication(graph);
    const stage1ByEdgeId = new Map<Hash, CheckpointSixStepArtifactCapabilityV1>();
    const stage2ByEdgeId = new Map<Hash, CheckpointSixStepArtifactCapabilityV1>();
    for (const outcome of outcomes) {
      if (outcome.kind !== "verified") continue;
      const candidate = candidates.get(outcome.familyCandidateKey);
      const publication = publications.get(outcome.publication.instancePublicationHash);
      if (candidate === undefined || publication === undefined
        || encodeCanonicalJson(publication) !== encodeCanonicalJson(outcome.publication)) {
        throw new CorruptDurableStoreError("ready Stage 1/2 restart publication mismatch");
      }
      const stage1 = await this.#sixStepArtifacts.emitVerifiedOutcome({
        runId: commitment.runId,
        cutoff: closure.ready.cutoff,
        candidatePartitionRoot: closure.ready.candidatePartitionRoot,
        candidate,
        outcome,
        sourceCoverage,
      });
      const edges = edgesByPublication.get(publication.instancePublicationHash) ?? [];
      if (edges.length !== publication.transitions.length) throw new CorruptDurableStoreError("ready Stage 1/2 restart edge denominator mismatch");
      for (const edge of edges) {
        const stage2 = await this.#sixStepArtifacts.emitReadyEdge({
          parent: stage1,
          ready: closure.ready,
          candidate,
          outcome,
          publication,
          edge,
          sourceCoverage,
        });
        if (stage2ByEdgeId.has(edge.edgeId)) throw new CorruptDurableStoreError("ready Stage 1/2 restart edge identity duplicated");
        stage1ByEdgeId.set(edge.edgeId, stage1);
        stage2ByEdgeId.set(edge.edgeId, stage2);
      }
    }
    this.#readyStage12ArtifactsByReady.set(closure.ready.readyRecordHash, Object.freeze({ stage1ByEdgeId, stage2ByEdgeId }));
  }

  #readyStage12BindingFor(ready: ReadyGenerationV1): ReadyStage12EvidenceBindingV1 {
    validateReadyGeneration(ready);
    return deepFreeze({
      readyRecordHash: ready.readyRecordHash,
      generationId: ready.generationId,
      cutoff: deepFreeze({ ...ready.cutoff }),
      definitionCatalogRoot: ready.definitionCatalogRoot,
      sourceCoverageRoot: ready.sourceCoverageRoot,
      candidatePartitionRoot: ready.candidatePartitionRoot,
      exactOutcomePartitionRoot: ready.exactOutcomePartitionRoot,
      verifiedMemoSetRoot: ready.verifiedMemoSetRoot,
      instanceCatalogRoot: ready.instanceCatalogRoot,
      graphRoot: ready.graphRoot,
      promotionRevision: ready.promotionRevision,
    });
  }

  #issueReadyStage12Evidence(ready: ReadyGenerationV1): ReadyStage12EvidenceCapabilityV1 {
    const binding = this.#readyStage12BindingFor(ready);
    const artifacts = this.#readyStage12ArtifactsByReady.get(binding.readyRecordHash);
    if (artifacts === undefined) throw new CheckpointRunStateError("ready Stage 1/2 artifacts were not reopened");
    const existing = this.#readyStage12EvidenceByReady.get(binding.readyRecordHash);
    if (existing !== undefined) {
      const state = this.#readyStage12EvidenceStates.get(existing);
      if (!state || encodeCanonicalJson(state.binding) !== encodeCanonicalJson(binding)) {
        throw new CheckpointRunStateError("ready stage1/2 capability binding changed");
      }
      return existing;
    }
    const capability = Object.freeze(Object.create(null)) as ReadyStage12EvidenceCapabilityV1;
    this.#readyStage12EvidenceStates.set(capability, Object.freeze({ binding, ready, artifacts }));
    this.#readyStage12EvidenceByReady.set(binding.readyRecordHash, capability);
    return capability;
  }

  #readyStage12EvidenceBinding(
    capability: ReadyStage12EvidenceCapabilityV1,
  ): ReadyStage12EvidenceBindingV1 {
    if (capability === null || typeof capability !== "object") {
      throw new TypeError("ready stage1/2 evidence capability is invalid");
    }
    const state = this.#readyStage12EvidenceStates.get(capability);
    if (!state) throw new TypeError("ready stage1/2 evidence capability is not checkpoint-issued");
    return state.binding;
  }

  async #readReadyStage12Evidence(
    capability: ReadyStage12EvidenceCapabilityV1,
  ): Promise<ReadyStage12EvidenceSnapshotV1> {
    const state = this.#readyStage12EvidenceStates.get(capability);
    if (!state) throw new TypeError("ready stage1/2 evidence capability is not checkpoint-issued");
    const authorityFence = this.#captureAuthorityFence();
    const closureView = await this.loadReadyClosure(state.ready);
    if (closureView.stage12EvidenceCapability !== capability) {
      throw new CheckpointRunStateError("ready stage1/2 evidence capability was reissued");
    }
    const rootRecord = this.#durable.readRoot();
    if (!rootRecord) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(rootRecord);
    this.#validateRootReferenceSet(rootRecord, root);
    if (
      root.readyGenerationId !== state.binding.generationId
      || root.readyGenerationRecordHash !== state.binding.readyRecordHash
    ) throw new CheckpointRunStateError("ready stage1/2 evidence generation is not active");
    const closure = this.#findReadyClosure(rootRecord.references, state.binding.readyRecordHash);
    if (encodeCanonicalJson(this.#readyStage12BindingFor(closure.ready)) !== encodeCanonicalJson(state.binding)) {
      throw new CorruptDurableStoreError("ready stage1/2 evidence binding mismatch");
    }
    const commitment = decodeCandidatePartitionCommitment(readContentStore(
      this.#durable,
      closure.candidatePartitionReadyCommitmentStorageHash,
      CANDIDATE_PARTITION_COMMITMENT_KIND,
      "ready stage1/2 candidate partition commitment",
    ));
    const candidateEntries = loadPartition(
      (hash, kind, context) => readContentStore(this.#durable, hash, kind, context),
      closure.candidatePartitionStorageHash,
      commitment.runId,
      "candidate",
    );
    const candidates = candidateEntries.map(entry => {
      const candidate = cloneCanonical<CandidateRecordV1>(decodeCanonicalJson(readContentStore(
        this.#durable,
        entry.storageHash,
        CANDIDATE_KIND,
        "ready stage1/2 candidate",
      )));
      if (candidate.familyCandidateKey !== entry.key) {
        throw new CorruptDurableStoreError("ready stage1/2 candidate key mismatch");
      }
      return candidate;
    });
    const candidatesByKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
    const outcomeEntries = loadPartition(
      (hash, kind, context) => readContentStore(this.#durable, hash, kind, context),
      closure.outcomePartitionStorageHash,
      commitment.runId,
      "outcome",
    );
    const outcomes = outcomeEntries.map(entry => {
      const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(readContentStore(
        this.#durable,
        entry.storageHash,
        OUTCOME_KIND,
        "ready stage1/2 outcome",
      )));
      const outcomeKey = assertHash(entry.key, "readyStage12.outcome.key");
      const candidate = candidatesByKey.get(outcomeKey);
      if (!candidate || outcome.familyCandidateKey !== outcomeKey) {
        throw new CorruptDurableStoreError("ready stage1/2 outcome candidate mismatch");
      }
      this.#attestationAuthority.validateDurableOutcome(outcome, {
        runId: commitment.runId,
        cutoff: closure.ready.cutoff,
        candidatePartitionRoot: closure.ready.candidatePartitionRoot,
        candidate,
      });
      return outcome;
    });
    const partition = decodeAttestationPartitionRecordWith(
      hash => this.#durable.readContent(hash),
      closure.attestationPartitionStorageHash,
      closure.outcomePartitionStorageHash,
      commitment.runId,
      "ready stage1/2 attestation partition",
    );
    this.#attestationAuthority.validateDurablePartition(partition, candidates);
    if (
      partition.runId !== commitment.runId
      || partition.exactOutcomePartitionRoot !== state.binding.exactOutcomePartitionRoot
      || partition.outcomes.length !== outcomes.length
      || partition.outcomes.some((outcome, index) => (
        candidateFinalOutcomeHash(outcome) !== candidateFinalOutcomeHash(outcomes[index]!)
      ))
    ) throw new CorruptDurableStoreError("ready stage1/2 outcome partition mismatch");
    const candidatePartitionCommitment = decodeCandidatePartitionCommitmentBytesV1(readContentStore(
      this.#durable,
      closure.candidatePartitionCommitmentStorageHash,
      CANDIDATE_PARTITION_AUTHORITY_KIND,
      "ready stage1/2 candidate partition commitment",
    ));
    if (encodeCanonicalJson(candidatePartitionCommitment.runtimeAuthority)
      !== encodeCanonicalJson(authorityFence.runtimeAuthority)) {
      throw new CorruptDurableStoreError("ready stage1/2 candidate partition runtime authority mismatch");
    }
    const verifiedOutcomes = outcomes.filter(
      (outcome): outcome is Extract<CandidateFinalOutcomeV1, { readonly kind: "verified" }> => outcome.kind === "verified",
    );
    assertVerifiedPublicationCatalog(
      verifiedOutcomes.map(outcome => outcome.publication),
      closureView.instanceCatalog,
    );
    const publicationsByHash = new Map(
      closureView.instanceCatalog.publications.map(publication => [publication.instancePublicationHash, publication]),
    );
    const edgesByPublication = graphEdgesByPublication(closureView.graph);
    const verifiedInstances = verifiedOutcomes.map(outcome => {
      const candidate = candidatesByKey.get(outcome.familyCandidateKey);
      const publication = publicationsByHash.get(outcome.publication.instancePublicationHash);
      if (
        !candidate
        || !publication
        || encodeCanonicalJson(publication) !== encodeCanonicalJson(outcome.publication)
        || publication.familyCandidateKey !== candidate.familyCandidateKey
      ) throw new CorruptDurableStoreError("ready stage1/2 verified publication binding mismatch");
      const edges = edgesByPublication.get(publication.instancePublicationHash) ?? [];
      if (edges.length !== publication.transitions.length) {
        throw new CorruptDurableStoreError("ready stage1/2 graph edge membership mismatch");
      }
      return deepFreeze({
        candidate,
        outcome,
        publication,
        identityCommitment: outcome.identityCommitment,
        attestationOrigin: outcome.identityCommitment.identityOrigin,
        edges: deepFreeze([...edges]),
      });
    });
    const finalRootRecord = this.#durable.readRoot();
    if (!finalRootRecord || finalRootRecord.envelopeHash !== rootRecord.envelopeHash) {
      throw new CheckpointRunStateError("ready stage1/2 evidence root changed during read");
    }
    await this.#canonical.assertStillCanonical(state.binding.cutoff);
    const postCanonicalRoot = this.#durable.readRoot();
    if (!postCanonicalRoot || postCanonicalRoot.envelopeHash !== rootRecord.envelopeHash) {
      throw new CheckpointRunStateError("ready stage1/2 evidence root changed during canonical fence");
    }
    this.#assertAuthorityFenceUnchanged(authorityFence);
    return deepFreeze({
      binding: state.binding,
      runId: commitment.runId,
      candidates: deepFreeze(candidates),
      outcomes: deepFreeze(outcomes),
      candidatePartitionCommitment,
      sourceCoverage: closureView.sourceCoverage,
      verifiedInstances: deepFreeze(verifiedInstances),
      instanceCatalog: closureView.instanceCatalog,
      graph: closureView.graph,
      promotionLineage: deepFreeze({
        candidatePartitionRevision: closure.candidatePartitionRevision,
        sealedRevision: commitment.sealedRevision,
        stageRevision: commitment.stageRevision,
        stageRecordHash: commitment.stageRecordHash,
        readyBaseHash: commitment.readyBaseHash,
        promotionRevision: closure.ready.promotionRevision,
        promotionFreshness: closure.ready.promotionFreshness,
        promotedAtMonotonicNs: closure.ready.promotedAtMonotonicNs,
      }),
    });
  }

  async #readReadyFullFamilyEvidence(
    capability: ReadyStage12EvidenceCapabilityV1,
  ): Promise<ReadyFullFamilyEvidenceSnapshotV1> {
    const state = this.#readyStage12EvidenceStates.get(capability);
    if (!state) throw new TypeError("ready stage1/2 evidence capability is not checkpoint-issued");

    const authorityFence = this.#captureAuthorityFence();
    await this.#canonical.assertStillCanonical(state.binding.cutoff);

    const rootRecord = this.#durable.readRoot();
    if (!rootRecord) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(rootRecord);
    this.#validateRootReferenceSet(rootRecord, root);
    if (
      root.readyGenerationId !== state.binding.generationId
      || root.readyGenerationRecordHash !== state.binding.readyRecordHash
    ) throw new CheckpointRunStateError("ready full-Family evidence generation is not active");

    const read: DurableContentReader = hash => this.#durable.readContent(hash);
    const closure = this.#findReadyClosureRecordWith(
      read,
      rootRecord.references,
      state.binding.readyRecordHash,
      false,
    ).closure;
    if (
      encodeCanonicalJson(this.#readyStage12BindingFor(closure.ready)) !== encodeCanonicalJson(state.binding)
      || encodeCanonicalJson(closure.ready) !== encodeCanonicalJson(state.ready)
    ) throw new CorruptDurableStoreError("ready full-Family evidence binding mismatch");

    const sourceCoverageRecord = read(closure.sourceCoverageStorageHash);
    if (!sourceCoverageRecord || sourceCoverageRecord.kind !== SOURCE_COVERAGE_KIND) {
      throw new CorruptDurableStoreError("ready full-Family source coverage is missing");
    }
    const sourceCoverage = cloneCanonical<SourceCoverageCertificateV1>(
      decodeCanonicalJson(sourceCoverageRecord.bytes),
    );
    const sourceExecutions = validateSourceExecutionSetRecord(
      read,
      closure.sourceExecutionSetStorageHash,
      sourceCoverage,
    );
    if (sourceExecutions.set.executionSetRoot !== closure.sourceExecutionSetRoot) {
      throw new CorruptDurableStoreError("ready full-Family source execution root mismatch");
    }

    const sourcePlanEvidenceRecord = read(closure.sourcePlanEvidenceStorageHash);
    if (!sourcePlanEvidenceRecord || sourcePlanEvidenceRecord.kind !== SOURCE_PLAN_EVIDENCE_KIND) {
      throw new CorruptDurableStoreError("ready full-Family source-plan evidence is missing");
    }
    const sourcePlanEvidenceReceipts = decodeSourcePlanEvidenceSet(
      sourcePlanEvidenceRecord.bytes,
      "ready full-Family source-plan evidence",
    );
    validateSourcePlanEvidenceReceipts(
      sourcePlanEvidenceReceipts,
      closure.ready.cutoff,
      sourcePlanRefsFromCoverage(sourceCoverage),
    );
    validateSourcePlanEvidenceExecutionJoin(sourcePlanEvidenceReceipts, sourceExecutions.set);
    const sourcePlanRawStorage = validateRawLocatorReferences(
      read,
      sourcePlanEvidenceRecord.references,
      sourcePlanEvidenceReceipts.flatMap(value => value.rawLocatorHashes),
      "ready full-Family source-plan evidence",
    );

    const nominationRecord = read(closure.nominationClosureStorageHash);
    if (!nominationRecord || nominationRecord.kind !== NOMINATION_CLOSURE_KIND) {
      throw new CorruptDurableStoreError("ready full-Family nomination closure is missing");
    }
    const decodedNomination = decodeNominationClosureRecordWith(
      read,
      closure.nominationClosureStorageHash,
      "ready full-Family nomination closure",
    );
    const nominationClosure = decodedNomination.closure;
    const recentReferences = decodedNomination.dependencyReferences.filter(reference => (
      read(reference)?.kind === RECENT_OBSERVATION_KIND
    ));
    if (recentReferences.length !== 1) {
      throw new CorruptDurableStoreError("ready full-Family recent observation reference is not exact");
    }
    const recentRecord = read(recentReferences[0]!);
    if (!recentRecord || recentRecord.kind !== RECENT_OBSERVATION_KIND) {
      throw new CorruptDurableStoreError("ready full-Family recent observation is missing");
    }
    const recentObservation = cloneCanonical<RecentObservationReceiptV1>(
      decodeCanonicalJson(recentRecord.bytes),
    );
    validateRecentObservationReceipt(
      recentObservation,
      this.#canonical.recentObservationRange(closure.ready.cutoff),
    );
    const recentRawStorage = validateRawLocatorReferences(
      read,
      recentRecord.references,
      recentObservation.evidence.map(value => value.rawLocatorHash),
      "ready full-Family recent observation",
    );

    const rawStorageBySemanticHash = new Map<Hash, Hash>();
    for (const entries of [
      sourceExecutions.rawStorageBySemanticHash,
      sourcePlanRawStorage,
      recentRawStorage,
    ]) {
      for (const [rawLocatorHash, storageHash] of entries) {
        const previous = rawStorageBySemanticHash.get(rawLocatorHash);
        if (previous !== undefined && previous !== storageHash) {
          throw new CorruptDurableStoreError("ready full-Family raw locator storage binding conflicts");
        }
        rawStorageBySemanticHash.set(rawLocatorHash, storageHash);
      }
    }
    const rawEvidenceLocatorContents = [...rawStorageBySemanticHash.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([rawLocatorHash, storageHash]) => {
        const record = read(storageHash);
        if (
          !record
          || record.kind !== RAW_EVIDENCE_LOCATOR_KIND
          || record.payloadHash !== rawLocatorHash
          || record.references.length !== 0
        ) throw new CorruptDurableStoreError("ready full-Family raw locator is invalid");
        return Object.freeze({
          kind: "raw-evidence-locator" as const,
          version: 1 as const,
          rawLocatorHash,
          bytes: new Uint8Array(record.bytes),
        });
      });

    const stage12 = await this.#readReadyStage12Evidence(capability);

    const finalRootRecord = this.#durable.readRoot();
    if (!finalRootRecord) {
      throw new CorruptDurableStoreError("checkpoint root missing after ready full-Family evidence read");
    }
    const finalRoot = rootFromRecord(finalRootRecord);
    if (
      finalRootRecord.envelopeHash !== rootRecord.envelopeHash
      || finalRoot.revision !== root.revision
      || finalRoot.readyGenerationId !== root.readyGenerationId
      || finalRoot.readyGenerationRecordHash !== root.readyGenerationRecordHash
    ) throw new CheckpointRunStateError("ready full-Family evidence root changed during read");
    await this.#canonical.assertStillCanonical(state.binding.cutoff);
    const postCanonicalRoot = this.#durable.readRoot();
    if (!postCanonicalRoot || postCanonicalRoot.envelopeHash !== rootRecord.envelopeHash) {
      throw new CheckpointRunStateError("ready full-Family evidence root changed during canonical fence");
    }
    this.#assertAuthorityFenceUnchanged(authorityFence);

    // Raw locator bytes are defensive copies of durable content. Typed arrays
    // are deliberately outside canonical JSON and cannot be deepFreeze'd;
    // freezing the envelope/array is sufficient because a later read always
    // reconstructs fresh bytes from the root-reachable store.
    return Object.freeze({
      ready: closure.ready,
      stage12,
      nominationClosure,
      sourceExecutionSet: sourceExecutions.set,
      sourcePlanEvidenceReceipts,
      rawEvidenceLocatorContents: Object.freeze(rawEvidenceLocatorContents),
      sourceCoverageStorageHash: closure.sourceCoverageStorageHash,
      sourceExecutionSetStorageHash: closure.sourceExecutionSetStorageHash,
      sourcePlanEvidenceStorageHash: closure.sourcePlanEvidenceStorageHash,
      nominationClosureStorageHash: closure.nominationClosureStorageHash,
      candidatePartitionStorageHash: closure.candidatePartitionStorageHash,
      candidatePartitionCommitmentStorageHash: closure.candidatePartitionCommitmentStorageHash,
    });
  }

  assertReadyAuthorityActive(rawBinding: ActiveReadyAuthorityBindingV1): void {
    const authorityFence = this.#captureAuthorityFence();
    assertPlainObject(rawBinding, "activeReadyBinding");
    assertExactKeys(
      rawBinding,
      [
        "generationId",
        "readyRecordHash",
        "generationRefreshPolicyHash",
        "cutoff",
        "definitionCatalogRoot",
        "instanceCatalogRoot",
        "graphRoot",
        "runtimeAuthority",
        "candidatePartitionCommitmentStorageHash",
        "nominationClosureRoot",
        "nominationClosureStorageHash",
      ],
      "activeReadyBinding",
    );
    const generationId = assertNonEmptyString(
      readOwnEnumerableDataProperty(rawBinding, "generationId", "activeReadyBinding"),
      "activeReadyBinding.generationId",
    );
    const readyRecordHash = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "readyRecordHash", "activeReadyBinding"),
      "activeReadyBinding.readyRecordHash",
    );
    const graphRoot = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "graphRoot", "activeReadyBinding"),
      "activeReadyBinding.graphRoot",
    );
    const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(
      readOwnEnumerableDataProperty(rawBinding, "runtimeAuthority", "activeReadyBinding"),
    );
    const candidatePartitionCommitmentStorageHash = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "candidatePartitionCommitmentStorageHash", "activeReadyBinding"),
      "activeReadyBinding.candidatePartitionCommitmentStorageHash",
    );
    const nominationClosureRoot = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "nominationClosureRoot", "activeReadyBinding"),
      "activeReadyBinding.nominationClosureRoot",
    );
    const nominationClosureStorageHash = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "nominationClosureStorageHash", "activeReadyBinding"),
      "activeReadyBinding.nominationClosureStorageHash",
    );
    const generationRefreshPolicyHash = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "generationRefreshPolicyHash", "activeReadyBinding"),
      "activeReadyBinding.generationRefreshPolicyHash",
    );
    const definitionCatalogRoot = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "definitionCatalogRoot", "activeReadyBinding"),
      "activeReadyBinding.definitionCatalogRoot",
    );
    const instanceCatalogRoot = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "instanceCatalogRoot", "activeReadyBinding"),
      "activeReadyBinding.instanceCatalogRoot",
    );
    const cutoff = cloneCanonical<BeginRunInputV1["cutoff"]>(
      readOwnEnumerableDataProperty(rawBinding, "cutoff", "activeReadyBinding"),
    );
    const record = this.#durable.readRoot();
    if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(record);
    this.#validateRootReferenceSet(record, root);
    if (
      root.readyGenerationId !== generationId
      || root.readyGenerationRecordHash !== readyRecordHash
    ) throw new CheckpointRunStateError("ready authority is not active");
    const closure = this.#findReadyClosure(record.references, readyRecordHash);
    if (
      encodeCanonicalJson(authorityFence.runtimeAuthority) !== encodeCanonicalJson(closure.ready.runtimeAuthority)
      || closure.ready.generationId !== generationId
      || closure.ready.readyRecordHash !== readyRecordHash
      || closure.ready.generationRefreshPolicyHash !== generationRefreshPolicyHash
      || closure.ready.definitionCatalogRoot !== definitionCatalogRoot
      || closure.ready.instanceCatalogRoot !== instanceCatalogRoot
      || closure.ready.graphRoot !== graphRoot
      || encodeCanonicalJson(closure.ready.runtimeAuthority) !== encodeCanonicalJson(runtimeAuthority)
      || closure.ready.candidatePartitionCommitmentStorageHash !== candidatePartitionCommitmentStorageHash
      || closure.ready.nominationClosureRoot !== nominationClosureRoot
      || closure.ready.nominationClosureStorageHash !== nominationClosureStorageHash
      || !sameCutoff(closure.ready.cutoff, cutoff)
    ) throw new CheckpointRunStateError("ready authority binding mismatch");
    const finalRecord = this.#durable.readRoot();
    if (!finalRecord) throw new CorruptDurableStoreError("checkpoint root missing after active ready validation");
    const finalRoot = rootFromRecord(finalRecord);
    if (
      finalRecord.envelopeHash !== record.envelopeHash
      || finalRoot.revision !== root.revision
      || finalRoot.readyGenerationId !== generationId
      || finalRoot.readyGenerationRecordHash !== readyRecordHash
    ) throw new CheckpointRunStateError("active ready generation changed during authority validation");
    this.#assertAuthorityFenceUnchanged(authorityFence);
  }

  async assertContentRoot(kind: "candidate-partition" | "verified-memo-set", root: Hash): Promise<void> {
    const authorityFence = this.#captureAuthorityFence();
    const record = this.#durable.readRoot();
    if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
    const checkpointRoot = rootFromRecord(record);
    this.#validateRootReferenceSet(record, checkpointRoot);
    if (kind === "verified-memo-set" && checkpointRoot.verifiedMemoRoot !== root) throw new CorruptDurableStoreError("verified memo root is not active");
    if (!checkpointRoot.readyGenerationRecordHash) throw new CorruptDurableStoreError("ready generation is absent");
    const closure = this.#findReadyClosure(record.references, checkpointRoot.readyGenerationRecordHash);
    if (encodeCanonicalJson(authorityFence.runtimeAuthority) !== encodeCanonicalJson(closure.ready.runtimeAuthority)) {
      throw new CheckpointRunStateError("active ready runtime authority is stale");
    }
    await this.#canonical.assertStillCanonical(closure.ready.cutoff);
    if (kind === "candidate-partition") {
      const record = this.#durable.readContent(closure.candidatePartitionReadyCommitmentStorageHash);
      if (!record || record.kind !== CANDIDATE_PARTITION_COMMITMENT_KIND) {
        throw new CorruptDurableStoreError("candidate partition commitment is missing or has references");
      }
      const commitment = decodeCandidatePartitionCommitment(record.bytes);
      if (
        encodeCanonicalJson(record.references) !== encodeCanonicalJson([
          closure.candidatePartitionCommitmentStorageHash,
          closure.candidatePartitionStorageHash,
          closure.nominationClosureStorageHash,
        ].sort(compareText))
        || commitment.candidatePartitionCommitmentStorageHash !== closure.candidatePartitionCommitmentStorageHash
        || commitment.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
        || commitment.nominationClosureRoot !== closure.nominationClosureRoot
        || commitment.nominationClosureStorageHash !== closure.nominationClosureStorageHash
        || commitment.candidatePartitionRoot !== root
        || commitment.readyRecordHash !== closure.ready.readyRecordHash
      ) {
        throw new CorruptDurableStoreError("candidate partition commitment root mismatch");
      }
    } else {
      const memo = decodeMemoSetRecordWith(
        hash => this.#durable.readContent(hash),
        closure.verifiedMemoSetStorageHash,
        "verified memo set",
      );
      if (memo.verifiedMemoSetRoot !== root) throw new CorruptDurableStoreError("verified memo root mismatch");
    }
    await this.#canonical.assertStillCanonical(closure.ready.cutoff);
    const finalRecord = this.#durable.readRoot();
    if (!finalRecord) throw new CorruptDurableStoreError("checkpoint root missing after content-root validation");
    const finalRoot = rootFromRecord(finalRecord);
    if (
      finalRecord.envelopeHash !== record.envelopeHash
      || finalRoot.revision !== checkpointRoot.revision
      || finalRoot.readyGenerationId !== checkpointRoot.readyGenerationId
      || finalRoot.readyGenerationRecordHash !== checkpointRoot.readyGenerationRecordHash
    ) throw new CheckpointRunStateError("active ready generation changed during content-root validation");
    this.#assertAuthorityFenceUnchanged(authorityFence);
  }

  async _flushOutcomeBatch(
    runId: string,
    writerCapability: AttestationWriterCapabilityV1,
    batch: readonly AttestationPersistenceCapabilityV1[],
    writerId: string,
  ): Promise<void> {
    let claim: AttestationPersistenceBatchClaimV1 | undefined;
    let lease: WriterLease | undefined;
    const authorityFence = this.#captureAuthorityFence();
    try {
      const preview = this.#loadActiveRun(runId);
      const previewCandidates = new Map(preview.builderRun.candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
      const claimed = this.#attestationAuthority.claimWriterCapabilities(writerCapability, batch);
      claim = claimed;
      for (const persisted of claimed.entries) {
        const record = exactObject(
          persisted,
          ["runId", "candidatePartitionRoot", "familyCandidateKey", "outcomeHash", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "kind", "identity", "outcome"],
          "attestation persisted outcome preview",
        ) as unknown as AttestationPersistedOutcomeV1;
        if (record.kind !== "final" || record.outcome === null) continue;
        const candidate = previewCandidates.get(assertHash(record.familyCandidateKey, "attestation persisted outcome preview.familyCandidateKey"));
        if (candidate === undefined
          || assertNonEmptyString(record.runId, "attestation persisted outcome preview.runId") !== runId
          || assertHash(record.candidatePartitionRoot, "attestation persisted outcome preview.candidatePartitionRoot") !== preview.envelope.candidatePartitionRoot) {
          throw new CheckpointRunStateError("attestation persisted outcome preview binding mismatch");
        }
        this.#attestationAuthority.validateOutcomeCapability(record.outcome, {
          runId,
          cutoff: preview.envelope.cutoff,
          candidatePartitionRoot: preview.envelope.candidatePartitionRoot,
          candidate,
        });
        const outcome = cloneCanonical<CandidateFinalOutcomeV1>(record.outcome);
        if (candidateFinalOutcomeHash(outcome) !== assertHash(record.outcomeHash, "attestation persisted outcome preview.outcomeHash")
          || encodeCanonicalJson(outcome.runtimeAuthority) !== encodeCanonicalJson(decodeRuntimeAuthorityProjectionV1(record.runtimeAuthority))
          || outcome.attestationAuthorityRoot !== assertHash(record.attestationAuthorityRoot, "attestation persisted outcome preview.attestationAuthorityRoot")
          || outcome.frameworkAuthorityRoot !== assertHash(record.frameworkAuthorityRoot, "attestation persisted outcome preview.frameworkAuthorityRoot")
          || outcome.executorAuthorityRoot !== assertHash(record.executorAuthorityRoot, "attestation persisted outcome preview.executorAuthorityRoot")) {
          throw new CheckpointRunStateError("attestation persisted outcome preview authority mismatch");
        }
        if (outcome.kind === "verified") {
          await this.#sixStepArtifacts.emitVerifiedOutcome({
            runId,
            cutoff: preview.envelope.cutoff,
            candidatePartitionRoot: preview.envelope.candidatePartitionRoot,
            candidate,
            outcome,
            sourceCoverage: preview.sourceCoverage,
          });
        }
      }
      // The validation and artifact work above can legitimately take longer
      // than one SQLite lease TTL. Acquire the lease only for the synchronous
      // atomic commit it authorizes.
      lease = this.#durable.acquireWriterLease(writerId);
      const nextRunStorageHash = this.#durable.transaction(lease, tx => {
      const currentRecord = tx.readRoot();
      if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
      const root = rootFromRecord(currentRecord);
      const loaded = this.#loadActiveRunTx(tx, currentRecord, root, runId, true);
      const candidates = new Map(loaded.builderRun.candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
      const existing = new Map(this.#loadOutcomes(tx, loaded.envelope).map(outcome => [outcome.familyCandidateKey, outcome]));
      const partials = new Map(this.#loadPartialOutcomes(tx, loaded.envelope).map(partial => [partial.familyCandidateKey, partial]));
      for (const persisted of claimed.entries) {
        const persistedObject = exactObject(
          persisted,
          ["runId", "candidatePartitionRoot", "familyCandidateKey", "outcomeHash", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "kind", "identity", "outcome"],
          "attestation persisted outcome",
        ) as unknown as AttestationPersistedOutcomeV1;
        const persistedRunId = assertNonEmptyString(persistedObject.runId, "attestation persisted outcome.runId");
        const persistedCandidatePartitionRoot = assertHash(persistedObject.candidatePartitionRoot, "attestation persisted outcome.candidatePartitionRoot");
        const persistedCandidateKey = assertHash(persistedObject.familyCandidateKey, "attestation persisted outcome.familyCandidateKey");
        const persistedOutcomeHash = assertHash(persistedObject.outcomeHash, "attestation persisted outcome.outcomeHash");
        const persistedRuntimeAuthority = decodeRuntimeAuthorityProjectionV1(persistedObject.runtimeAuthority);
        const persistedAttestationAuthorityRoot = assertHash(persistedObject.attestationAuthorityRoot, "attestation persisted outcome.attestationAuthorityRoot");
        const persistedFrameworkAuthorityRoot = assertHash(persistedObject.frameworkAuthorityRoot, "attestation persisted outcome.frameworkAuthorityRoot");
        const persistedExecutorAuthorityRoot = assertHash(persistedObject.executorAuthorityRoot, "attestation persisted outcome.executorAuthorityRoot");
        if (
          persistedRunId !== runId
          || persistedCandidatePartitionRoot !== loaded.envelope.candidatePartitionRoot
          || !candidates.has(persistedCandidateKey)
        ) throw new CheckpointRunStateError("attestation persisted outcome binding mismatch");
        const candidate = candidates.get(persistedCandidateKey)!;
        if (persistedObject.kind === "partial-identity") {
          if (persistedObject.identity === null || persistedObject.outcome !== null) {
            throw new CheckpointRunStateError("partial identity persisted outcome shape mismatch");
          }
          const partial = decodePartialOutcome(encodeCanonicalBytes(persistedObject), "attestation persisted partial outcome");
          if (
            encodeCanonicalJson(persistedRuntimeAuthority) !== encodeCanonicalJson(authorityFence.runtimeAuthority)
            || persistedAttestationAuthorityRoot !== authorityFence.attestationAuthorityRoot
            || persistedFrameworkAuthorityRoot !== authorityFence.frameworkAuthorityRoot
            || persistedExecutorAuthorityRoot !== authorityFence.executorAuthorityRoot
          ) throw new CheckpointRunStateError("partial identity authority binding mismatch");
          if (partial.identity === null) throw new CheckpointRunStateError("partial identity is missing its identity record");
          const expectedPartialHash = attestationPartialIdentitySemanticHash({
            runId,
            cutoff: loaded.envelope.cutoff,
            candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
            candidate,
            identity: partial.identity,
            runtimeAuthority: persistedRuntimeAuthority,
            attestationAuthorityRoot: persistedAttestationAuthorityRoot,
            frameworkAuthorityRoot: persistedFrameworkAuthorityRoot,
            executorAuthorityRoot: persistedExecutorAuthorityRoot,
          });
          if (partial.outcomeHash !== expectedPartialHash || persistedOutcomeHash !== expectedPartialHash) throw new CheckpointRunStateError("partial identity outcome hash mismatch");
          if (existing.has(candidate.familyCandidateKey)) throw new OutcomeStateConflictError("partial identity cannot follow a final outcome");
          const previousPartial = partials.get(candidate.familyCandidateKey);
          if (previousPartial && previousPartial.outcomeHash !== partial.outcomeHash) {
            throw new OutcomeStateConflictError("conflicting partial identity outcomes");
          }
          const storageHash = tx.putImmutable(PARTIAL_OUTCOME_KIND, encodeCanonicalBytes(partial));
          tx.setIndex(`partial-outcome/${runId}`, candidate.familyCandidateKey, storageHash);
          partials.set(candidate.familyCandidateKey, partial);
          continue;
        }
        if (persistedObject.kind !== "final" || persistedObject.identity !== null || persistedObject.outcome === null) {
          throw new CheckpointRunStateError("final persisted outcome shape mismatch");
        }
        this.#attestationAuthority.validateOutcomeCapability(persistedObject.outcome, {
          runId,
          cutoff: loaded.envelope.cutoff,
          candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
          candidate,
        });
        const outcome = cloneCanonical<CandidateFinalOutcomeV1>(persistedObject.outcome);
        if (
          encodeCanonicalJson(persistedRuntimeAuthority) !== encodeCanonicalJson(outcome.runtimeAuthority)
          || persistedAttestationAuthorityRoot !== outcome.attestationAuthorityRoot
          || persistedFrameworkAuthorityRoot !== outcome.frameworkAuthorityRoot
          || persistedExecutorAuthorityRoot !== outcome.executorAuthorityRoot
        ) throw new CheckpointRunStateError("final persisted outcome authority binding mismatch");
        if (candidateFinalOutcomeHash(outcome) !== persistedOutcomeHash) {
          throw new CheckpointRunStateError("final persisted outcome hash mismatch");
        }
        const previous = existing.get(outcome.familyCandidateKey);
        if (previous && encodeCanonicalJson(previous) !== encodeCanonicalJson(outcome)) {
          throw new OutcomeStateConflictError("a candidate final outcome cannot be replaced by the startup writer");
        }
        const outcomeReferences = outcome.kind === "chainProvenRejected"
          ? [putRejectionBundle(tx, outcome.rejectionEvidence)]
          : [];
        const storageHash = tx.putImmutable(OUTCOME_KIND, encodeCanonicalBytes(outcome), outcomeReferences);
        tx.setIndex(`outcome/${runId}`, outcome.familyCandidateKey, storageHash);
        existing.set(outcome.familyCandidateKey, outcome);
        if (partials.delete(outcome.familyCandidateKey)) {
          tx.deleteIndex(`partial-outcome/${runId}`, outcome.familyCandidateKey);
        }
      }
      const outcomes = [...existing.values()].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
      const outcomeEntries = tx.listIndex(`outcome/${runId}`).map(entry => ({ key: entry.key, storageHash: entry.contentHash }));
      const manifestHash = putPartition(tx, runId, "outcome", outcomeEntries);
      const partialEntries = tx.listIndex(`partial-outcome/${runId}`).map(entry => ({ key: entry.key, storageHash: entry.contentHash }));
      const partialManifestHash = partialEntries.length === 0
        ? null
        : putPartition(tx, runId, "partial-outcome", partialEntries);
      const nextRevision = (BigInt(root.revision) + 1n).toString();
      const nextRun: StoredRunEnvelopeV2 = deepFreeze({
        ...loaded.envelope,
        checkpointRevision: nextRevision,
        outcomePartitionRoot: outcomePartitionRoot(runId, outcomes),
        outcomePartitionStorageHash: manifestHash,
        partialOutcomePartitionStorageHash: partialManifestHash,
        accounting: outcomeAccounting(loaded.builderRun.candidates.length, outcomes),
      });
      const nextRunHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(nextRun), runContentReferences(nextRun));
      const nextRoot = deepFreeze({ ...root, revision: nextRevision });
      tx.compareAndSwapRoot(
        root.revision,
        encodeCanonicalBytes(nextRoot),
        this.#rootReferencesFor(
          hash => tx.readContent(hash),
          [...currentRecord.references, nextRunHash],
          nextRoot,
          false,
        ),
      );
      return nextRunHash;
      });
      this.#assertAuthorityFenceUnchanged(authorityFence);
      this.#validatedRunStorageHashes.add(nextRunStorageHash);
    } catch (error) {
      (claim as AttestationPersistenceBatchClaimV1 | undefined)?.abort();
      claim = undefined;
      throw error;
    } finally {
      if (lease !== undefined) this.#durable.releaseWriterLease(lease);
    }
    (claim as AttestationPersistenceBatchClaimV1 | undefined)?.commit();
  }

  #loadOrCreateRoot(): CheckpointRootV1 {
    const existing = this.#durable.readRoot();
    if (existing) return rootFromRecord(existing);
    const owner = `checkpoint-init/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      return this.#durable.transaction(lease, tx => {
        const raced = tx.readRoot();
        if (raced) return rootFromRecord(raced);
        const memo = emptyMemoSet();
        const memoStorageHash = putVerifiedMemoSet(tx, memo, []);
        const root: CheckpointRootV1 = deepFreeze({
          revision: "1",
          verifiedMemoRoot: memo.verifiedMemoSetRoot,
          inProgressRunId: null,
          stagedReadyStorageHash: null,
          latestMemoSeedReceiptHash: null,
          memoSeedSequence: "0",
          memoSeedLineageRoot: EMPTY_MEMO_SEED_LINEAGE_ROOT,
          latestProbeReceiptHash: null,
          probeReceiptSequence: "0",
          probeReceiptLineageRoot: EMPTY_PROBE_RECEIPT_LINEAGE_ROOT,
          readyGenerationId: null,
          readyGenerationRecordHash: null,
          schemaHash: CHECKPOINT_SCHEMA_HASH,
        });
        return rootFromRecord(tx.compareAndSwapRoot("0", encodeCanonicalBytes(root), [memoStorageHash]));
      });
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
  }

  #validateRootClosure(root: CheckpointRootV1): void {
    const record = this.#durable.readRoot();
    if (!record || record.revision !== root.revision) throw new CorruptDurableStoreError("checkpoint root changed during validation");
    this.#validateRootReferenceSet(record, root);
    if (root.inProgressRunId) this.#loadActiveRun(root.inProgressRunId);
  }

  #validateRootReferenceSet(record: DurableRootRecord, root: CheckpointRootV1): void {
    this.#validateRootReferenceSetWith(
      hash => this.#durable.readContent(hash),
      record,
      root,
      true,
    );
    this.#validateIndexNamespaces(this.#durable.listIndexNamespaces(), root);
  }

  #validateRootReferenceSetTx(
    tx: DurableTransaction,
    record: DurableRootRecord,
    root: CheckpointRootV1,
    allowValidatedReadyCache = false,
  ): void {
    this.#validateRootReferenceSetWith(hash => tx.readContent(hash), record, root, allowValidatedReadyCache);
    this.#validateIndexNamespaces(tx.listIndexNamespaces(), root);
  }

  #validateIndexNamespaces(namespaces: readonly string[], root: CheckpointRootV1): void {
    const allowed = new Set([
      "semantic/instance-catalog",
      "semantic/persisted-graph",
      ...(root.inProgressRunId === null
        ? []
        : [`candidate/${root.inProgressRunId}`, `outcome/${root.inProgressRunId}`, `partial-outcome/${root.inProgressRunId}`]),
    ]);
    const unexpected = namespaces.filter(namespace => !allowed.has(namespace));
    if (unexpected.length > 0) {
      throw new CorruptDurableStoreError(`unexpected durable index namespace ${unexpected.join(",")}`);
    }
  }

  #validateRootReferenceSetWith(
    read: DurableContentReader,
    record: DurableRootRecord,
    root: CheckpointRootV1,
    allowValidatedReadyCache: boolean,
  ): void {
    const expectedReferences = this.#rootReferencesFor(
      read,
      record.references,
      root,
      allowValidatedReadyCache,
    );
    if (encodeCanonicalJson([...record.references].sort(compareText)) !== encodeCanonicalJson(expectedReferences)) {
      throw new CorruptDurableStoreError("checkpoint root physical references mismatch");
    }
  }

  #rootReferencesFor(
    read: DurableContentReader,
    availableReferences: readonly Hash[],
    root: CheckpointRootV1,
    allowValidatedReadyCache: boolean,
  ): readonly Hash[] {
    const available = deepFreeze([...new Set(availableReferences)].sort(compareText));
    const expectedReferences: Hash[] = [
      this.#findMemoStorageHashWith(read, available, root.verifiedMemoRoot),
    ];
    if (root.inProgressRunId) {
      expectedReferences.push(this.#findActiveRunRecordWith(
        read,
        available,
        root,
        root.inProgressRunId,
        allowValidatedReadyCache,
      ).storageHash);
    }
    if (root.stagedReadyStorageHash !== null) {
      if (root.inProgressRunId === null) {
        throw new CorruptDurableStoreError("staged ready exists without an active run");
      }
      const stage = this.#findReadyStageRecordWith(
        read,
        available,
        root.stagedReadyStorageHash,
        allowValidatedReadyCache,
      );
      if (
        stage.stageRevision !== root.revision
        || stage.runId !== root.inProgressRunId
      ) throw new CorruptDurableStoreError("staged ready root binding mismatch");
      expectedReferences.push(root.stagedReadyStorageHash);
    }
    if ((root.readyGenerationId === null) !== (root.readyGenerationRecordHash === null)) {
      throw new CorruptDurableStoreError("ready generation id/hash presence mismatch");
    }
    if (root.readyGenerationRecordHash) {
      const found = this.#findReadyClosureRecordWith(
        read,
        available,
        root.readyGenerationRecordHash,
        allowValidatedReadyCache,
      );
      const closure = found.closure;
      if (closure.ready.generationId !== root.readyGenerationId) throw new CorruptDurableStoreError("ready generation pointer mismatch");
      expectedReferences.push(found.storageHash);
    }
    if (root.latestMemoSeedReceiptHash === null) {
      if (root.memoSeedSequence !== "0" || root.memoSeedLineageRoot !== EMPTY_MEMO_SEED_LINEAGE_ROOT) {
        throw new CorruptDurableStoreError("empty memo seed lineage mismatch");
      }
    } else {
      if (!available.includes(root.latestMemoSeedReceiptHash)) throw new CorruptDurableStoreError("memo seed receipt is not root-reachable");
      const receipt = this.#validateMemoSeedReceiptChainWith(read, root.latestMemoSeedReceiptHash);
      if (
        receipt.verifiedMemoRoot !== root.verifiedMemoRoot
        || receipt.checkpointSchemaHash !== root.schemaHash
        || receipt.sequence !== root.memoSeedSequence
        || receipt.receiptLineageRoot !== root.memoSeedLineageRoot
        || BigInt(receipt.sealedRevision) > BigInt(root.revision)
      ) {
        throw new CorruptDurableStoreError("memo seed receipt lineage mismatch");
      }
      expectedReferences.push(root.latestMemoSeedReceiptHash);
    }
    if (root.latestProbeReceiptHash === null) {
      if (
        root.probeReceiptSequence !== "0"
        || root.probeReceiptLineageRoot !== EMPTY_PROBE_RECEIPT_LINEAGE_ROOT
      ) throw new CorruptDurableStoreError("empty probe receipt lineage mismatch");
    } else {
      if (!available.includes(root.latestProbeReceiptHash)) {
        throw new CorruptDurableStoreError("probe receipt is not root-reachable");
      }
      const receipt = this.#validateProbeReceiptChainWith(read, root.latestProbeReceiptHash).receipt;
      if (
        receipt.sequence !== root.probeReceiptSequence
        || receipt.receiptLineageRoot !== root.probeReceiptLineageRoot
        || BigInt(receipt.checkpointRevision) > BigInt(root.revision)
      ) throw new CorruptDurableStoreError("probe receipt root lineage mismatch");
      expectedReferences.push(root.latestProbeReceiptHash);
    }
    return deepFreeze([...new Set(expectedReferences)].sort(compareText));
  }

  #validateMemoSeedReceiptChainWith(
    read: DurableContentReader,
    latestHash: Hash,
  ): MemoSeedReceiptV1 {
    let currentHash: Hash | null = latestHash;
    let child: MemoSeedReceiptV1 | null = null;
    let latest: MemoSeedReceiptV1 | null = null;
    while (currentHash !== null) {
      const record = read(currentHash);
      if (!record || record.kind !== DIAGNOSTIC_KIND) {
        throw new CorruptDurableStoreError("memo seed receipt kind mismatch");
      }
      const receipt = decodeMemoSeedReceipt(record.bytes);
      latest ??= receipt;
      const sequence = BigInt(receipt.sequence);
      if (sequence < 1n) throw new CorruptDurableStoreError("memo seed receipt sequence is invalid");
      if (child !== null) {
        if (
          BigInt(child.sequence) !== sequence + 1n
          || child.priorReceiptHash !== currentHash
          || child.priorLineageRoot !== receipt.receiptLineageRoot
        ) throw new CorruptDurableStoreError("memo seed receipt predecessor mismatch");
      }
      const expectedReferences = receipt.priorReceiptHash === null ? [] : [receipt.priorReceiptHash];
      if (encodeCanonicalJson(record.references) !== encodeCanonicalJson(expectedReferences)) {
        throw new CorruptDurableStoreError("memo seed receipt physical predecessor mismatch");
      }
      if (sequence === 1n) {
        if (
          receipt.priorReceiptHash !== null
          || receipt.priorLineageRoot !== EMPTY_MEMO_SEED_LINEAGE_ROOT
        ) throw new CorruptDurableStoreError("memo seed receipt origin mismatch");
      } else if (
        receipt.priorReceiptHash === null
        || receipt.priorLineageRoot === EMPTY_MEMO_SEED_LINEAGE_ROOT
      ) {
        throw new CorruptDurableStoreError("memo seed receipt predecessor is absent");
      }
      child = receipt;
      currentHash = receipt.priorReceiptHash;
    }
    if (latest === null || child === null || child.sequence !== "1") {
      throw new CorruptDurableStoreError("memo seed receipt lineage is incomplete");
    }
    return latest;
  }

  #validateProbeReceiptChainWith(
    read: DurableContentReader,
    latestHash: Hash,
  ): CheckpointProbeEvidenceV1 {
    let currentHash: Hash | null = latestHash;
    let child: ProbeReceiptV1 | null = null;
    let latest: CheckpointProbeEvidenceV1 | null = null;
    while (currentHash !== null) {
      const record = read(currentHash);
      if (!record || record.kind !== PROBE_RECEIPT_KIND) {
        throw new CorruptDurableStoreError("probe receipt kind mismatch");
      }
      const envelope = decodeStoredProbeReceiptEnvelope(record.bytes);
      const receipt = envelope.receipt;
      const evidence = this.#validateProbeEvidenceEnvelopeWith(read, envelope);
      latest ??= evidence;
      const sequence = BigInt(receipt.sequence);
      if (sequence < 1n) throw new CorruptDurableStoreError("probe receipt sequence is invalid");
      if (child !== null) {
        if (
          BigInt(child.sequence) !== sequence + 1n
          || child.priorReceiptHash !== currentHash
          || child.priorLineageRoot !== receipt.receiptLineageRoot
        ) throw new CorruptDurableStoreError("probe receipt predecessor mismatch");
      }
      const expectedReferences = [
        ...(receipt.priorReceiptHash === null ? [] : [receipt.priorReceiptHash]),
        envelope.candidatePartitionStorageHash,
        envelope.priorOutcomePartitionStorageHash,
        envelope.activeOutcomePartitionStorageHash,
      ];
      if (
        encodeCanonicalJson(record.references)
        !== encodeCanonicalJson([...new Set(expectedReferences)].sort(compareText))
      ) {
        throw new CorruptDurableStoreError("probe receipt physical predecessor mismatch");
      }
      if (sequence === 1n) {
        if (
          receipt.priorReceiptHash !== null
          || receipt.priorLineageRoot !== EMPTY_PROBE_RECEIPT_LINEAGE_ROOT
        ) throw new CorruptDurableStoreError("probe receipt origin mismatch");
      } else if (
        receipt.priorReceiptHash === null
        || receipt.priorLineageRoot === EMPTY_PROBE_RECEIPT_LINEAGE_ROOT
      ) {
        throw new CorruptDurableStoreError("probe receipt predecessor is absent");
      }
      child = receipt;
      currentHash = receipt.priorReceiptHash;
    }
    if (latest === null || child === null || child.sequence !== "1") {
      throw new CorruptDurableStoreError("probe receipt lineage is incomplete");
    }
    return latest;
  }

  #validateProbeEvidenceEnvelopeWith(
    read: DurableContentReader,
    envelope: StoredProbeReceiptEnvelopeV1,
  ): CheckpointProbeEvidenceV1 {
    const receipt = envelope.receipt;
    const readBytes = (hash: Hash, kind: string, context: string): Uint8Array => {
      const record = read(hash);
      if (!record || record.kind !== kind) {
        throw new CorruptDurableStoreError(`${context} kind or content is missing`);
      }
      return record.bytes;
    };

    this.#validatePartitionPhysicalWith(
      read,
      envelope.candidatePartitionStorageHash,
      receipt.runId,
      "candidate",
    );
    this.#validatePartitionPhysicalWith(
      read,
      envelope.priorOutcomePartitionStorageHash,
      receipt.runId,
      "outcome",
    );
    this.#validatePartitionPhysicalWith(
      read,
      envelope.activeOutcomePartitionStorageHash,
      receipt.runId,
      "outcome",
    );

    const candidateEntries = loadPartition(
      readBytes,
      envelope.candidatePartitionStorageHash,
      receipt.runId,
      "candidate",
    );
    const candidates = candidateEntries.map(entry => {
      const candidate = cloneCanonical<CandidateRecordV1>(decodeCanonicalJson(
        readBytes(entry.storageHash, CANDIDATE_KIND, "probe candidate"),
      ));
      if (candidate.familyCandidateKey !== entry.key) {
        throw new CorruptDurableStoreError("probe candidate physical key mismatch");
      }
      return candidate;
    });
    const partitionRoot = candidatePartitionRoot(candidates);
    const candidateByKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
    const targetCandidate = candidateByKey.get(receipt.familyCandidateKey);
    if (!targetCandidate || targetCandidate.candidateSubjectHash !== receipt.candidateSubjectHash) {
      throw new CorruptDurableStoreError("probe target candidate binding mismatch");
    }

    const loadOutcomes = (manifestHash: Hash, context: string) => {
      const entries = loadPartition(readBytes, manifestHash, receipt.runId, "outcome");
      const outcomes = entries.map(entry => {
        const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(
          readBytes(entry.storageHash, OUTCOME_KIND, `${context} outcome`),
        ));
        if (outcome.familyCandidateKey !== entry.key) {
          throw new CorruptDurableStoreError(`${context} outcome physical key mismatch`);
        }
        const candidate = candidateByKey.get(entry.key);
        if (!candidate) throw new CorruptDurableStoreError(`${context} outcome candidate is absent`);
        this.#attestationAuthority.validateDurableOutcome(outcome, {
          runId: receipt.runId,
          cutoff: receipt.cutoff,
          candidatePartitionRoot: partitionRoot,
          candidate,
        });
        return outcome;
      });
      return { entries, outcomes: deepFreeze(outcomes) };
    };

    const before = loadOutcomes(envelope.priorOutcomePartitionStorageHash, "probe prior");
    const after = loadOutcomes(envelope.activeOutcomePartitionStorageHash, "probe active");
    if (
      outcomePartitionRoot(receipt.runId, before.outcomes) !== receipt.priorOutcomePartitionRoot
      || outcomePartitionRoot(receipt.runId, after.outcomes) !== receipt.activeOutcomePartitionRoot
    ) throw new CorruptDurableStoreError("probe outcome partition semantic root mismatch");
    if (before.entries.length !== after.entries.length) {
      throw new CorruptDurableStoreError("probe changed the outcome partition denominator");
    }

    const beforeByKey = new Map(before.outcomes.map(outcome => [outcome.familyCandidateKey, outcome]));
    const afterByKey = new Map(after.outcomes.map(outcome => [outcome.familyCandidateKey, outcome]));
    let changed = 0;
    for (const [index, priorEntry] of before.entries.entries()) {
      const activeEntry = after.entries[index];
      if (!activeEntry || priorEntry.key !== activeEntry.key) {
        throw new CorruptDurableStoreError("probe changed the outcome partition key set");
      }
      if (priorEntry.storageHash !== activeEntry.storageHash) {
        if (priorEntry.key !== receipt.familyCandidateKey) {
          throw new CorruptDurableStoreError("probe changed a non-target outcome");
        }
        changed += 1;
      }
    }
    if (changed !== 1) throw new CorruptDurableStoreError("probe did not change exactly one target outcome");

    const beforeTarget = beforeByKey.get(receipt.familyCandidateKey);
    const afterTarget = afterByKey.get(receipt.familyCandidateKey);
    if (
      !beforeTarget
      || !afterTarget
      || beforeTarget.kind !== receipt.beforeKind
      || afterTarget.kind !== receipt.afterKind
      || candidateFinalOutcomeHash(beforeTarget) !== receipt.beforeOutcomeHash
      || candidateFinalOutcomeHash(afterTarget) !== receipt.afterOutcomeHash
    ) throw new CorruptDurableStoreError("probe target outcome transition mismatch");

    const evidenceRoot = hashDomain("aloha/checkpoint-probe-evidence/v1", {
      envelope,
      candidatePartitionRoot: partitionRoot,
      candidateEntries,
      priorOutcomeEntries: before.entries,
      activeOutcomeEntries: after.entries,
    });
    return deepFreeze({
      receipt,
      beforeOutcomes: before.outcomes,
      afterOutcomes: after.outcomes,
      candidatePartitionStorageHash: envelope.candidatePartitionStorageHash,
      priorOutcomePartitionStorageHash: envelope.priorOutcomePartitionStorageHash,
      activeOutcomePartitionStorageHash: envelope.activeOutcomePartitionStorageHash,
      evidenceRoot,
    });
  }

  #loadActiveRun(runId: string): { readonly envelope: StoredRunEnvelopeV2; readonly storageHash: Hash; readonly builderRun: InternalBuilderRunV1; readonly sourceCoverage: SourceCoverageCertificateV1 } {
    const record = this.#durable.readRoot();
    if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
    const loaded = this.#loadActiveRunRead(record, rootFromRecord(record), runId);
    this.#assertRunIndexesWith(
      namespace => this.#durable.listIndex(namespace),
      (hash, kind, context) => readContentStore(this.#durable, hash, kind, context),
      loaded.envelope,
    );
    if (!this.#validatedRunStorageHashes.has(loaded.storageHash)) {
      this.#validateRunPhysicalReferences(loaded);
      this.#validatedRunStorageHashes.add(loaded.storageHash);
    }
    return loaded;
  }

  #loadActiveRunRead(record: DurableRootRecord, root: CheckpointRootV1, runId: string) {
    const found = this.#findActiveRunRecord(record, root, runId);
    return this.#hydrateRunStore(root, found.envelope, found.storageHash);
  }

  #findActiveRunRecord(record: DurableRootRecord, root: CheckpointRootV1, runId: string) {
    return this.#findActiveRunRecordWith(
      hash => this.#durable.readContent(hash),
      record.references,
      root,
      runId,
    );
  }

  #findActiveRunRecordWith(
    read: DurableContentReader,
    references: readonly Hash[],
    root: CheckpointRootV1,
    runId: string,
    allowValidatedReadyCache = false,
  ) {
    if (root.inProgressRunId !== runId) throw new CheckpointRunStateError(`run ${runId} is not active`);
    const expectedRunRevision = root.stagedReadyStorageHash === null
      ? root.revision
      : this.#findReadyStageRecordWith(
        read,
        references,
        root.stagedReadyStorageHash,
        allowValidatedReadyCache,
      ).expectedRevision;
    let found: { readonly envelope: StoredRunEnvelopeV2; readonly storageHash: Hash } | null = null;
    for (const hash of references) {
      const content = read(hash);
      if (content?.kind !== RUN_KIND) continue;
      const envelope = decodeRun(content.bytes);
      if (envelope.runId !== runId || envelope.checkpointRevision !== expectedRunRevision) continue;
      if (found !== null) throw new CorruptDurableStoreError(`active run ${runId} has multiple root records`);
      found = deepFreeze({ envelope, storageHash: hash });
    }
    if (found !== null) return found;
    throw new CorruptDurableStoreError(`active run ${runId} is not root-reachable`);
  }

  #loadActiveRunTx(
    tx: DurableTransaction,
    record: DurableRootRecord,
    root: CheckpointRootV1,
    runId: string,
    allowValidatedReadyCache = false,
  ) {
    this.#validateRootReferenceSetTx(tx, record, root, allowValidatedReadyCache);
    const found = this.#findActiveRunRecordWith(
      hash => tx.readContent(hash),
      record.references,
      root,
      runId,
      allowValidatedReadyCache,
    );
    const loaded = this.#hydrateRun(tx, root, found.envelope, found.storageHash);
    this.#assertRunIndexesWith(
      namespace => tx.listIndex(namespace),
      (hash, kind, context) => readContent(tx, hash, kind, context),
      loaded.envelope,
    );
    if (!allowValidatedReadyCache || !this.#validatedRunStorageHashes.has(loaded.storageHash)) {
      this.#validateRunPhysicalReferencesWith(hash => tx.readContent(hash), loaded);
      this.#validatedRunStorageHashes.add(loaded.storageHash);
    }
    return loaded;
  }

  #assertRunIndexesWith(
    list: (namespace: string) => readonly { readonly key: string; readonly contentHash: Hash }[],
    read: (hash: Hash, kind: string, context: string) => Uint8Array,
    run: StoredRunEnvelopeV2,
  ): void {
    for (const [partitionKind, manifestHash] of [
      ["candidate", run.candidatePartitionStorageHash],
      ["outcome", run.outcomePartitionStorageHash],
      ["partial-outcome", run.partialOutcomePartitionStorageHash],
    ] as const) {
      if (manifestHash === null) {
        if (list(`${partitionKind}/${run.runId}`).length !== 0) {
          throw new CorruptDurableStoreError(`${partitionKind} mutable index exists without an active manifest`);
        }
        continue;
      }
      const manifestEntries = loadPartition(read, manifestHash, run.runId, partitionKind)
        .map(entry => ({ key: entry.key, contentHash: entry.storageHash }));
      const indexEntries = list(`${partitionKind}/${run.runId}`);
      if (encodeCanonicalJson(indexEntries) !== encodeCanonicalJson(manifestEntries)) {
        throw new CorruptDurableStoreError(`${partitionKind} mutable index does not match the active manifest`);
      }
    }
  }

  #hydrateRun(tx: DurableTransaction, root: CheckpointRootV1, envelope: StoredRunEnvelopeV2, storageHash: Hash) {
    return this.#hydrateRunCommon(
      root,
      envelope,
      storageHash,
      hash => tx.readContent(hash),
    );
  }

  #hydrateRunStore(root: CheckpointRootV1, envelope: StoredRunEnvelopeV2, storageHash: Hash) {
    return this.#hydrateRunCommon(
      root,
      envelope,
      storageHash,
      hash => this.#durable.readContent(hash),
    );
  }

  #hydrateRunCommon(root: CheckpointRootV1, envelope: StoredRunEnvelopeV2, storageHash: Hash, readRecord: DurableContentReader) {
    const read = (hash: Hash, kind: string, context: string): Uint8Array => {
      const record = readRecord(hash);
      if (!record || record.kind !== kind) throw new CorruptDurableStoreError(`${context} is missing or has the wrong kind`);
      return record.bytes;
    };
    const expectedRunRevision = root.stagedReadyStorageHash === null
      ? root.revision
      : decodeReadyStage(read(root.stagedReadyStorageHash, READY_STAGE_KIND, "ready stage")).expectedRevision;
    if (envelope.checkpointRevision !== expectedRunRevision) throw new CorruptDurableStoreError("run revision does not match active root/stage");
    const recentObservation = cloneCanonical<RecentObservationReceiptV1>(decodeCanonicalJson(read(envelope.recentObservationStorageHash, RECENT_OBSERVATION_KIND, "recent observation")));
    validateRecentObservationReceipt(recentObservation, this.#canonical.recentObservationRange(envelope.cutoff));
    if (recentObservation.observationRoot !== envelope.recentObservationRoot || !sameCutoff(recentObservation.cutoff, envelope.cutoff)) throw new CorruptDurableStoreError("recent observation lineage mismatch");
    const sourceCoverage = cloneCanonical<SourceCoverageCertificateV1>(decodeCanonicalJson(read(envelope.sourceCoverageStorageHash, SOURCE_COVERAGE_KIND, "source coverage")));
    if (sourceCoverage.sourceCoverageRoot !== envelope.sourceCoverageRoot || !sameCutoff(sourceCoverage.cutoff, envelope.cutoff)) throw new CorruptDurableStoreError("source coverage lineage mismatch");
    validateSourceCoverageCertificate(sourceCoverage, sourceCoverage.entries.map(entry => ({
      ownerRef: entry.ownerRef,
      sourcePlanRef: entry.sourcePlanRef,
      familyDefinitionHash: entry.familyDefinitionHash,
      completeness: entry.completeness,
      historyStartBlock: entry.historyStartBlock,
    })));
    const sourceExecutionSet = decodePersistedSourcePlanExecutionSet(
      decodeCanonicalJson(read(envelope.sourceExecutionSetStorageHash, SOURCE_EXECUTION_SET_KIND, "source execution set")),
      "source execution set",
    );
    if (sourceExecutionSet.executionSetRoot !== envelope.sourceExecutionSetRoot) {
      throw new CorruptDurableStoreError("source execution set root mismatch");
    }
    validatePersistedExecutionCoverage(sourceExecutionSet, sourceCoverage);
    const sourcePlanEvidence = decodeSourcePlanEvidenceSet(
      read(envelope.sourcePlanEvidenceStorageHash, SOURCE_PLAN_EVIDENCE_KIND, "source-plan evidence"),
      "source-plan evidence",
    );
    try {
      validateSourcePlanEvidenceReceipts(
        sourcePlanEvidence,
        envelope.cutoff,
        sourcePlanRefsFromCoverage(sourceCoverage),
      );
      validateSourcePlanEvidenceExecutionJoin(sourcePlanEvidence, sourceExecutionSet);
    } catch (error) {
      throw new CorruptDurableStoreError(`source-plan evidence validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const candidateEntries = loadPartition(read, envelope.candidatePartitionStorageHash, envelope.runId, "candidate");
    const candidateRawStorageByKey = new Map<Hash, ReadonlyMap<Hash, Hash>>();
    const candidates = candidateEntries.map(entry => {
      const candidateRecord = readRecord(entry.storageHash);
      if (!candidateRecord || candidateRecord.kind !== CANDIDATE_KIND) {
        throw new CorruptDurableStoreError("candidate record is missing or has the wrong kind");
      }
      const candidate = cloneCanonical<CandidateRecordV1>(decodeCanonicalJson(candidateRecord.bytes));
      if (candidate.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("candidate partition key mismatch");
      validateRawLocatorReferences(
        readRecord,
        candidateRecord.references,
        candidate.evidence.map(value => value.rawLocatorHash),
        "candidate record",
      );
      const rawStorageByHash = new Map<Hash, Hash>();
      for (const reference of candidateRecord.references) {
        const rawRecord = readRecord(reference);
        if (
          !rawRecord
          || rawRecord.kind !== RAW_EVIDENCE_LOCATOR_KIND
          || rawRecord.references.length !== 0
          || rawStorageByHash.has(rawRecord.payloadHash)
        ) throw new CorruptDurableStoreError("candidate raw evidence reference is invalid");
        rawStorageByHash.set(rawRecord.payloadHash, reference);
      }
      candidateRawStorageByKey.set(candidate.familyCandidateKey, rawStorageByHash);
      return candidate;
    });
    if (String(candidates.length) !== envelope.candidateRecordCount || candidatePartitionRoot(candidates) !== envelope.candidatePartitionRoot) throw new CorruptDurableStoreError("candidate partition root mismatch");
    const nominationRecord = readRecord(envelope.nominationClosureStorageHash);
    if (!nominationRecord || nominationRecord.kind !== NOMINATION_CLOSURE_KIND) {
      throw new CorruptDurableStoreError("nomination closure is missing or has the wrong kind");
    }
    const expectedNominationReferences = [
      envelope.recentObservationStorageHash,
      envelope.sourceCoverageStorageHash,
      envelope.sourceExecutionSetStorageHash,
      envelope.sourcePlanEvidenceStorageHash,
      envelope.candidatePartitionStorageHash,
    ].sort(compareText);
    const decodedNomination = decodeNominationClosureRecordWith(
      readRecord,
      envelope.nominationClosureStorageHash,
      "nomination closure",
    );
    if (encodeCanonicalJson(decodedNomination.dependencyReferences) !== encodeCanonicalJson(expectedNominationReferences)) {
      throw new CorruptDurableStoreError("nomination closure physical reference set mismatch");
    }
    const nominationClosure = validateNominationClosureAgainstRun({
      closure: decodedNomination.closure,
      cutoff: envelope.cutoff,
      recentObservation,
      sourceCoverage,
      sourceExecutionSet,
      candidates,
      candidatePartitionRoot: envelope.candidatePartitionRoot,
    });
    if (nominationClosure.root !== envelope.nominationClosureRoot) {
      throw new CorruptDurableStoreError("nomination closure root mismatch");
    }
    const candidatesByKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
    const partials = envelope.partialOutcomePartitionStorageHash === null
      ? []
      : loadPartition(read, envelope.partialOutcomePartitionStorageHash, envelope.runId, "partial-outcome").map(entry => {
        const partial = decodePartialOutcome(read(entry.storageHash, PARTIAL_OUTCOME_KIND, "partial identity outcome"), "partial identity outcome");
        if (
          partial.familyCandidateKey !== entry.key
          || partial.runId !== envelope.runId
          || partial.candidatePartitionRoot !== envelope.candidatePartitionRoot
        ) throw new CorruptDurableStoreError("partial outcome lineage mismatch");
        const candidate = candidatesByKey.get(partial.familyCandidateKey);
        if (!candidate) throw new CorruptDurableStoreError("partial outcome refers to an absent candidate");
        if (partial.identity === null) throw new CorruptDurableStoreError("partial outcome identity is missing");
        const expectedPartialHash = attestationPartialIdentitySemanticHash({
          runId: envelope.runId,
          cutoff: envelope.cutoff,
          candidatePartitionRoot: envelope.candidatePartitionRoot,
          candidate,
          identity: partial.identity,
          runtimeAuthority: partial.runtimeAuthority,
          attestationAuthorityRoot: partial.attestationAuthorityRoot,
          frameworkAuthorityRoot: partial.frameworkAuthorityRoot,
          executorAuthorityRoot: partial.executorAuthorityRoot,
        });
        if (partial.outcomeHash !== expectedPartialHash) throw new CorruptDurableStoreError("partial outcome hash mismatch");
        return partial;
      });
    const outcomeEntries = loadPartition(read, envelope.outcomePartitionStorageHash, envelope.runId, "outcome");
    const outcomes = outcomeEntries.map(entry => {
      const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(read(entry.storageHash, OUTCOME_KIND, "candidate outcome")));
      if (outcome.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("outcome partition key mismatch");
      const candidate = candidatesByKey.get(entry.key);
      if (!candidate) throw new CorruptDurableStoreError("outcome refers to an absent candidate");
      this.#attestationAuthority.validateDurableOutcome(outcome, {
        runId: envelope.runId,
        cutoff: envelope.cutoff,
        candidatePartitionRoot: envelope.candidatePartitionRoot,
        candidate,
      });
      if (outcome.kind === "chainProvenRejected") {
        const outcomeRecord = readRecord(entry.storageHash);
        if (!outcomeRecord || outcomeRecord.kind !== OUTCOME_KIND) {
          throw new CorruptDurableStoreError("candidate outcome is missing or has the wrong kind");
        }
        if (outcomeRecord.references.length !== 1) {
          throw new CorruptDurableStoreError("chain rejection outcome must reference exactly one bundle");
        }
        validateRejectionBundlePhysicalWith(
          readRecord,
          outcomeRecord.references[0]!,
          outcome.rejectionEvidence,
          "candidate rejection outcome",
        );
      }
      return outcome;
    });
    if (
      outcomePartitionRoot(envelope.runId, outcomes) !== envelope.outcomePartitionRoot
      || encodeCanonicalJson(outcomeAccounting(candidates.length, outcomes)) !== encodeCanonicalJson(envelope.accounting)
    ) throw new CorruptDurableStoreError("outcome partition or accounting mismatch");
    const finalKeys = new Set(outcomes.map(outcome => outcome.familyCandidateKey));
    if (partials.some(partial => finalKeys.has(partial.familyCandidateKey))) {
      throw new CorruptDurableStoreError("partial outcome overlaps a final outcome");
    }
    if (envelope.attestationPartitionStorageHash !== null) {
      if (partials.length !== 0) throw new CorruptDurableStoreError("sealed run still has partial identity outcomes");
      const partition = decodeAttestationPartitionRecordWith(
        readRecord,
        envelope.attestationPartitionStorageHash,
        envelope.outcomePartitionStorageHash,
        envelope.runId,
        "attestation partition",
      );
      this.#attestationAuthority.validateDurablePartition(partition, candidates);
      if (
        partition.runId !== envelope.runId
        || !sameCutoff(partition.cutoff, envelope.cutoff)
        || partition.candidatePartitionRoot !== envelope.candidatePartitionRoot
        || partition.exactOutcomePartitionRoot !== hashDomain("aloha/exact-outcome-partition/v1", {
          runId: envelope.runId,
          cutoff: envelope.cutoff,
          candidatePartitionRoot: partition.candidatePartitionRoot,
          runtimeAuthority: partition.runtimeAuthority,
          attestationAuthorityRoot: partition.attestationAuthorityRoot,
          frameworkAuthorityRoot: partition.frameworkAuthorityRoot,
          executorAuthorityRoot: partition.executorAuthorityRoot,
          outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
        })
        || partition.outcomes.length !== outcomes.length
        || partition.outcomes.some((outcome, index) => (
          candidateFinalOutcomeHash(outcome) !== candidateFinalOutcomeHash(outcomes[index]!)
        ))
      ) throw new CorruptDurableStoreError("sealed attestation partition does not match durable outcomes");
    }
    const commitmentBytes = read(
      envelope.candidatePartitionCommitmentStorageHash,
      CANDIDATE_PARTITION_AUTHORITY_KIND,
      "candidate partition commitment",
    );
    const commitment = decodeCandidatePartitionCommitmentBytesV1(commitmentBytes);
    const authority = this.#captureAuthorityFence();
    if (
      encodeCanonicalJson(commitment.runtimeAuthority) !== encodeCanonicalJson(authority.runtimeAuthority)
      || commitment.runId !== envelope.runId
      || !sameCutoff(commitment.cutoff, envelope.cutoff)
      || commitment.candidatePartitionRoot !== envelope.candidatePartitionRoot
      || commitment.candidatePartitionStorageHash !== envelope.candidatePartitionStorageHash
      || commitment.nominationClosureRoot !== envelope.nominationClosureRoot
      || commitment.nominationClosureStorageHash !== envelope.nominationClosureStorageHash
      || commitment.recordCount !== envelope.candidateRecordCount
      || commitment.candidateKeysRoot !== candidatePartitionKeysRoot(candidates.map(candidate => candidate.familyCandidateKey))
      || commitment.recentObservationRoot !== envelope.recentObservationRoot
      || commitment.sourceCoverageRoot !== envelope.sourceCoverageRoot
      || commitment.checkpointRevision !== envelope.candidatePartitionRevision
    ) throw new CorruptDurableStoreError("candidate partition commitment does not bind the active run");
    const durable = this.#durable;
    const candidatePartition = this.#candidatePartitionCapabilities.registerVerifiedCommitment(
      commitment,
      candidates,
      Object.freeze({
        read(familyCandidateKey: Hash, rawLocatorHash: Hash): Uint8Array {
          const storageHash = candidateRawStorageByKey.get(familyCandidateKey)?.get(rawLocatorHash);
          if (storageHash === undefined) {
            throw new TypeError("candidate raw evidence locator is outside the durable candidate closure");
          }
          const record = durable.readContent(storageHash);
          if (
            !record
            || record.kind !== RAW_EVIDENCE_LOCATOR_KIND
            || record.payloadHash !== rawLocatorHash
            || record.references.length !== 0
          ) throw new CorruptDurableStoreError("candidate raw evidence is unavailable or corrupt");
          return new Uint8Array(record.bytes);
        },
      }),
    );
    const memo = decodeMemoSetRecordWith(
      readRecord,
      envelope.verifiedMemoSetStorageHash,
      "verified memo set",
    );
    if (memo.verifiedMemoSetRoot !== envelope.verifiedMemoSetRoot) throw new CorruptDurableStoreError("run verified memo root mismatch");
    const builderRun: InternalBuilderRunV1 = deepFreeze({
      runId: envelope.runId,
      parentGenerationId: envelope.parentGenerationId,
      checkpointRevision: envelope.checkpointRevision,
      cutoff: envelope.cutoff,
      recentObservation,
      sourcePlanEvidence,
      definitionCatalogRoot: envelope.definitionCatalogRoot,
      sourceCoverage,
      sourceExecutionSet,
      nominationClosure,
      sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
      candidatePartition: candidatePartition,
      candidatePartitionBinding: commitment,
      candidates,
    });
    return deepFreeze({ envelope, storageHash, builderRun, sourceCoverage });
  }

  #loadOutcomes(tx: DurableTransaction, run: StoredRunEnvelopeV2): readonly CandidateFinalOutcomeV1[] {
    const entries = loadPartition((hash, kind, context) => readContent(tx, hash, kind, context), run.outcomePartitionStorageHash, run.runId, "outcome");
    const outcomes = entries.map(entry => {
      const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(readContent(tx, entry.storageHash, OUTCOME_KIND, "candidate outcome")));
      if (outcome.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("outcome partition key mismatch");
      const outcomeRecord = tx.readContent(entry.storageHash);
      if (!outcomeRecord || outcomeRecord.kind !== OUTCOME_KIND) throw new CorruptDurableStoreError("outcome record is missing");
      if (outcome.kind === "chainProvenRejected") {
        if (outcomeRecord.references.length !== 1) throw new CorruptDurableStoreError("chain rejection outcome must reference exactly one bundle");
        validateRejectionBundlePhysicalWith(
          hash => tx.readContent(hash),
          outcomeRecord.references[0]!,
          outcome.rejectionEvidence,
          "outcome partition rejection",
        );
      } else if (outcomeRecord.references.length !== 0) {
        throw new CorruptDurableStoreError("non-rejection outcome must not reference a rejection bundle");
      }
      return outcome;
    });
    if (outcomePartitionRoot(run.runId, outcomes) !== run.outcomePartitionRoot) throw new CorruptDurableStoreError("outcome partition root mismatch");
    return deepFreeze(outcomes);
  }

  #loadOutcomesStore(run: StoredRunEnvelopeV2): readonly CandidateFinalOutcomeV1[] {
    const entries = loadPartition(
      (hash, kind, context) => readContentStore(this.#durable, hash, kind, context),
      run.outcomePartitionStorageHash,
      run.runId,
      "outcome",
    );
    const outcomes = entries.map(entry => {
      const outcome = cloneCanonical<CandidateFinalOutcomeV1>(
        decodeCanonicalJson(readContentStore(this.#durable, entry.storageHash, OUTCOME_KIND, "candidate outcome")),
      );
      if (outcome.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("outcome partition key mismatch");
      const record = this.#durable.readContent(entry.storageHash);
      if (!record || record.kind !== OUTCOME_KIND) throw new CorruptDurableStoreError("outcome record is missing");
      if (outcome.kind === "chainProvenRejected") {
        if (record.references.length !== 1) throw new CorruptDurableStoreError("chain rejection outcome must reference exactly one bundle");
        validateRejectionBundlePhysicalWith(
          hash => this.#durable.readContent(hash),
          record.references[0]!,
          outcome.rejectionEvidence,
          "outcome partition rejection",
        );
      } else if (record.references.length !== 0) {
        throw new CorruptDurableStoreError("non-rejection outcome must not reference a rejection bundle");
      }
      return outcome;
    });
    if (outcomePartitionRoot(run.runId, outcomes) !== run.outcomePartitionRoot) {
      throw new CorruptDurableStoreError("outcome partition root mismatch");
    }
    return deepFreeze(outcomes);
  }

  #loadPartialOutcomes(tx: DurableTransaction, run: StoredRunEnvelopeV2): readonly AttestationPersistedOutcomeV1[] {
    if (run.partialOutcomePartitionStorageHash === null) return deepFreeze([]);
    const entries = loadPartition(
      (hash, kind, context) => readContent(tx, hash, kind, context),
      run.partialOutcomePartitionStorageHash,
      run.runId,
      "partial-outcome",
    );
    const partials = entries.map(entry => {
      const partial = decodePartialOutcome(
        readContent(tx, entry.storageHash, PARTIAL_OUTCOME_KIND, "partial identity outcome"),
        "partial identity outcome",
      );
      if (partial.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("partial outcome partition key mismatch");
      if (partial.runId !== run.runId || partial.candidatePartitionRoot !== run.candidatePartitionRoot) {
        throw new CorruptDurableStoreError("partial outcome partition lineage mismatch");
      }
      return partial;
    });
    return deepFreeze(partials);
  }

  #loadPartialOutcomesStore(run: StoredRunEnvelopeV2): readonly AttestationPersistedOutcomeV1[] {
    if (run.partialOutcomePartitionStorageHash === null) return deepFreeze([]);
    const entries = loadPartition(
      (hash, kind, context) => readContentStore(this.#durable, hash, kind, context),
      run.partialOutcomePartitionStorageHash,
      run.runId,
      "partial-outcome",
    );
    const partials = entries.map(entry => {
      const partial = decodePartialOutcome(
        readContentStore(this.#durable, entry.storageHash, PARTIAL_OUTCOME_KIND, "partial identity outcome"),
        "partial identity outcome",
      );
      if (partial.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("partial outcome partition key mismatch");
      if (partial.runId !== run.runId || partial.candidatePartitionRoot !== run.candidatePartitionRoot) {
        throw new CorruptDurableStoreError("partial outcome partition lineage mismatch");
      }
      return partial;
    });
    return deepFreeze(partials);
  }

  #sealedRunSnapshot(run: StoredRunEnvelopeV2, candidates: readonly CandidateRecordV1[], partition: AttestationPartitionV1, sourceCoverage: SourceCoverageCertificateV1): SealedRunSnapshotV1 {
    return deepFreeze({
      runId: run.runId,
      parentGenerationId: run.parentGenerationId,
      cutoff: run.cutoff,
      recentObservationRange: this.#canonical.recentObservationRange(run.cutoff),
      definitionCatalogRoot: run.definitionCatalogRoot,
      sourceCoverage,
      sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
      candidatePartitionRoot: run.candidatePartitionRoot,
      candidatePartitionStorageHash: run.candidatePartitionStorageHash,
      candidatePartitionCommitmentStorageHash: run.candidatePartitionCommitmentStorageHash,
      nominationClosureRoot: run.nominationClosureRoot,
      nominationClosureStorageHash: run.nominationClosureStorageHash,
      candidateKeys: candidates.map(candidate => candidate.familyCandidateKey).sort(compareText),
      verifiedMemoSetRoot: run.verifiedMemoSetRoot,
      exactOutcomePartitionRoot: partition.exactOutcomePartitionRoot,
      checkpointRevision: run.checkpointRevision,
      partition,
      runtimeAuthority: partition.runtimeAuthority,
      attestationAuthorityRoot: partition.attestationAuthorityRoot,
      frameworkAuthorityRoot: partition.frameworkAuthorityRoot,
      executorAuthorityRoot: partition.executorAuthorityRoot,
    });
  }

  #issueSealedRun(runId: string): SealedRunCapabilityV1 {
    const snapshot = this.#readSealedRunSnapshot(runId);
    return this.#sealedRuns.issue(sealedRunBinding(snapshot), () => this.#readSealedRunSnapshot(runId));
  }

  #readSealedRunSnapshot(runId: string): SealedRunSnapshotV1 {
    const loaded = this.#loadActiveRun(runId);
    if (loaded.envelope.attestationPartitionStorageHash === null) {
      throw new CheckpointRunStateError("sealed run has no durable attestation partition");
    }
    const partition = decodeAttestationPartitionRecordWith(
      hash => this.#durable.readContent(hash),
      loaded.envelope.attestationPartitionStorageHash,
      loaded.envelope.outcomePartitionStorageHash,
      loaded.envelope.runId,
      "sealed attestation partition",
    );
    this.#attestationAuthority.validateDurablePartition(partition, loaded.builderRun.candidates);
    return this.#sealedRunSnapshot(loaded.envelope, loaded.builderRun.candidates, partition, loaded.sourceCoverage);
  }

  #findMemoStorageHash(tx: DurableTransaction, references: readonly Hash[], semanticRoot: Hash): Hash {
    return this.#findMemoStorageHashWith(hash => tx.readContent(hash), references, semanticRoot);
  }

  #findMemoStorageHashStore(references: readonly Hash[], semanticRoot: Hash): Hash {
    return this.#findMemoStorageHashWith(
      hash => this.#durable.readContent(hash),
      references,
      semanticRoot,
    );
  }

  #findMemoStorageHashWith(
    read: DurableContentReader,
    references: readonly Hash[],
    semanticRoot: Hash,
  ): Hash {
    let found: Hash | null = null;
    for (const hash of references) {
      const content = read(hash);
      if (content?.kind !== VERIFIED_MEMO_SET_KIND) continue;
      const memo = decodeMemoSetRecordWith(read, hash, "verified memo set");
      if (memo.verifiedMemoSetRoot !== semanticRoot) continue;
      if (found !== null) throw new CorruptDurableStoreError("verified memo set has multiple root records");
      found = hash;
    }
    if (found !== null) return found;
    throw new CorruptDurableStoreError("verified memo set is not root-reachable");
  }

  #assertRecordReferences(hash: Hash, kind: string, expected: readonly Hash[], context: string): void {
    this.#assertRecordReferencesWith(
      value => this.#durable.readContent(value),
      hash,
      kind,
      expected,
      context,
    );
  }

  #assertRecordReferencesWith(
    read: DurableContentReader,
    hash: Hash,
    kind: string,
    expected: readonly Hash[],
    context: string,
  ): void {
    const record = read(hash);
    if (!record || record.kind !== kind) throw new CorruptDurableStoreError(`${context} kind or content is missing`);
    const normalized = [...new Set(expected)].sort(compareText);
    if (encodeCanonicalJson(record.references) !== encodeCanonicalJson(normalized)) {
      throw new CorruptDurableStoreError(`${context} physical references mismatch`);
    }
  }

  #validatePartitionPhysical(manifestHash: Hash, runId: string, partitionKind: PartitionKindV1): void {
    this.#validatePartitionPhysicalWith(
      hash => this.#durable.readContent(hash),
      manifestHash,
      runId,
      partitionKind,
    );
  }

  #validatePartitionPhysicalWith(
    read: DurableContentReader,
    manifestHash: Hash,
    runId: string,
    partitionKind: PartitionKindV1,
  ): void {
    const manifestRecord = read(manifestHash);
    if (!manifestRecord || manifestRecord.kind !== PARTITION_MANIFEST_KIND) throw new CorruptDurableStoreError(`${partitionKind} manifest is missing`);
    const manifest = exactObject(decodeCanonicalJson(manifestRecord.bytes), PARTITION_MANIFEST_FIELDS, `${partitionKind}Manifest`);
    if (manifest.runId !== runId || manifest.partitionKind !== partitionKind || !Array.isArray(manifest.pageStorageHashes)) {
      throw new CorruptDurableStoreError(`${partitionKind} manifest binding mismatch`);
    }
    const pageHashes = manifest.pageStorageHashes.map((value, index) => assertHash(value, `${partitionKind}Manifest.pageStorageHashes[${index}]`));
    this.#assertRecordReferencesWith(read, manifestHash, PARTITION_MANIFEST_KIND, pageHashes, `${partitionKind} manifest`);
    for (const [pageIndex, pageHash] of pageHashes.entries()) {
      const pageRecord = read(pageHash);
      if (!pageRecord || pageRecord.kind !== PARTITION_PAGE_KIND) throw new CorruptDurableStoreError(`${partitionKind} page is missing`);
      const page = exactObject(decodeCanonicalJson(pageRecord.bytes), PARTITION_PAGE_FIELDS, `${partitionKind}Page`);
      if (page.runId !== runId || page.partitionKind !== partitionKind || page.pageIndex !== String(pageIndex) || !Array.isArray(page.entries)) {
        throw new CorruptDurableStoreError(`${partitionKind} page binding mismatch`);
      }
      const entries = page.entries.map((raw, index) => {
        const entry = exactObject(raw, ["key", "storageHash"], `${partitionKind}Page.entries[${index}]`);
        return {
          key: assertNonEmptyString(entry.key, `${partitionKind}Page.entries[${index}].key`),
          storageHash: assertHash(entry.storageHash, `${partitionKind}Page.entries[${index}].storageHash`),
        };
      });
      this.#assertRecordReferencesWith(read, pageHash, PARTITION_PAGE_KIND, entries.map(value => value.storageHash), `${partitionKind} page`);
      for (const entry of entries) {
        const record = read(entry.storageHash);
        const expectedKind = partitionKind === "candidate"
          ? CANDIDATE_KIND
          : partitionKind === "outcome" ? OUTCOME_KIND : PARTIAL_OUTCOME_KIND;
        if (!record || record.kind !== expectedKind) throw new CorruptDurableStoreError(`${partitionKind} record is missing`);
        if (partitionKind === "candidate") {
          const candidate = cloneCanonical<CandidateRecordV1>(decodeCanonicalJson(record.bytes));
          if (candidate.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("candidate physical key mismatch");
          const rawHashes = candidate.evidence.map(value => value.rawLocatorHash);
          validateRawLocatorReferences(
            read,
            record.references,
            rawHashes,
            "candidate record",
          );
        } else if (partitionKind === "outcome") {
          const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(record.bytes));
          if (outcome.kind === "chainProvenRejected") {
            if (record.references.length !== 1) {
              throw new CorruptDurableStoreError("chain rejection outcome must reference exactly one bundle");
            }
            validateRejectionBundlePhysicalWith(
              read,
              record.references[0]!,
              outcome.rejectionEvidence,
              "outcome record",
            );
          } else {
            this.#assertRecordReferencesWith(read, entry.storageHash, OUTCOME_KIND, [], "outcome record");
          }
        } else {
          decodePartialOutcome(record.bytes, "partial identity outcome");
          this.#assertRecordReferencesWith(read, entry.storageHash, PARTIAL_OUTCOME_KIND, [], "partial identity outcome");
        }
      }
    }
  }

  #validateRunPhysicalReferences(loaded: { readonly envelope: StoredRunEnvelopeV2; readonly storageHash: Hash; readonly builderRun: InternalBuilderRunV1 }): void {
    this.#validateRunPhysicalReferencesWith(hash => this.#durable.readContent(hash), loaded);
  }

  #validateRunPhysicalReferencesWith(
    read: DurableContentReader,
    loaded: { readonly envelope: StoredRunEnvelopeV2; readonly storageHash: Hash; readonly builderRun: InternalBuilderRunV1 },
  ): void {
    const runReferences = runContentReferences(loaded.envelope);
    this.#assertRecordReferencesWith(read, loaded.storageHash, RUN_KIND, runReferences, "active run");
    const commitmentRecord = read(loaded.envelope.candidatePartitionCommitmentStorageHash);
    if (!commitmentRecord || commitmentRecord.kind !== CANDIDATE_PARTITION_AUTHORITY_KIND) {
      throw new CorruptDurableStoreError("candidate partition commitment is missing");
    }
    const candidatePartitionCommitment = decodeCandidatePartitionCommitmentBytesV1(commitmentRecord.bytes);
    if (encodeCanonicalJson(candidatePartitionCommitment.runtimeAuthority)
      !== encodeCanonicalJson(this.#captureAuthorityFence().runtimeAuthority)) {
      throw new CorruptDurableStoreError("candidate partition commitment runtime authority mismatch");
    }
    this.#assertRecordReferencesWith(read, loaded.envelope.candidatePartitionCommitmentStorageHash, CANDIDATE_PARTITION_AUTHORITY_KIND, [], "candidate partition commitment");
    const nominationRecord = read(loaded.envelope.nominationClosureStorageHash);
    if (!nominationRecord || nominationRecord.kind !== NOMINATION_CLOSURE_KIND) {
      throw new CorruptDurableStoreError("nomination closure is missing");
    }
    const decodedNomination = decodeNominationClosureRecordWith(
      read,
      loaded.envelope.nominationClosureStorageHash,
      "nomination closure",
    );
    const nominationClosure = decodedNomination.closure;
    if (nominationClosure.root !== loaded.envelope.nominationClosureRoot) {
      throw new CorruptDurableStoreError("nomination closure root mismatch");
    }
    if (encodeCanonicalJson(decodedNomination.dependencyReferences) !== encodeCanonicalJson([
        loaded.envelope.recentObservationStorageHash,
        loaded.envelope.sourceCoverageStorageHash,
        loaded.envelope.sourceExecutionSetStorageHash,
        loaded.envelope.sourcePlanEvidenceStorageHash,
        loaded.envelope.candidatePartitionStorageHash,
      ].sort(compareText))) throw new CorruptDurableStoreError("nomination closure physical references mismatch");
    const recentLocators = loaded.builderRun.recentObservation.evidence.map(value => value.rawLocatorHash);
    const recentRecord = read(loaded.envelope.recentObservationStorageHash);
    if (!recentRecord || recentRecord.kind !== RECENT_OBSERVATION_KIND) {
      throw new CorruptDurableStoreError("recent observation is missing");
    }
    validateRawLocatorReferences(
      read,
      recentRecord.references,
      recentLocators,
      "recent observation",
    );
    const sourcePlanRecord = read(loaded.envelope.sourcePlanEvidenceStorageHash);
    if (!sourcePlanRecord || sourcePlanRecord.kind !== SOURCE_PLAN_EVIDENCE_KIND) {
      throw new CorruptDurableStoreError("source-plan evidence is missing");
    }
    const sourcePlanEvidence = decodeSourcePlanEvidenceSet(sourcePlanRecord.bytes, "source-plan evidence");
    const sourcePlanLocatorHashes = [...new Set(sourcePlanEvidence.flatMap(value => value.rawLocatorHashes))].sort(compareText);
    validateRawLocatorReferences(
      read,
      sourcePlanRecord.references,
      sourcePlanLocatorHashes,
      "source-plan evidence",
    );
    const durableExecutions = validateSourceExecutionSetRecord(
      read,
      loaded.envelope.sourceExecutionSetStorageHash,
      loaded.builderRun.sourceCoverage,
    );
    if (durableExecutions.set.executionSetRoot !== loaded.envelope.sourceExecutionSetRoot) {
      throw new CorruptDurableStoreError("active run source execution set root mismatch");
    }
    this.#assertRecordReferencesWith(
      read,
      loaded.envelope.sourcePlanEvidenceStorageHash,
      SOURCE_PLAN_EVIDENCE_KIND,
      sourcePlanRecord.references,
      "source-plan evidence",
    );
    this.#validatePartitionPhysicalWith(read, loaded.envelope.candidatePartitionStorageHash, loaded.envelope.runId, "candidate");
    this.#validatePartitionPhysicalWith(read, loaded.envelope.outcomePartitionStorageHash, loaded.envelope.runId, "outcome");
    if (loaded.envelope.partialOutcomePartitionStorageHash !== null) {
      this.#validatePartitionPhysicalWith(read, loaded.envelope.partialOutcomePartitionStorageHash, loaded.envelope.runId, "partial-outcome");
    }
    const memoRecord = read(loaded.envelope.verifiedMemoSetStorageHash);
    if (!memoRecord || memoRecord.kind !== VERIFIED_MEMO_SET_KIND) throw new CorruptDurableStoreError("run memo set is missing");
    decodeMemoSetRecordWith(read, loaded.envelope.verifiedMemoSetStorageHash, "run memo set");
    if (loaded.envelope.attestationPartitionStorageHash !== null) {
      const partition = decodeAttestationPartitionRecordWith(
        read,
        loaded.envelope.attestationPartitionStorageHash,
        loaded.envelope.outcomePartitionStorageHash,
        loaded.envelope.runId,
        "attestation partition",
      );
      this.#attestationAuthority.validateDurablePartition(partition, loaded.builderRun.candidates);
    }
  }

  #clearRun(
    runId: string,
    expectedRevision: string,
    reason: "stale-cutoff" | "definition-root-changed" | "run-corrupt" | "cutoff-too-old-for-serving",
    memoSeed: SealedRunSnapshotV1 | null,
    canonicalFence: CanonicalFenceV1 | null = null,
  ): void {
    if ((memoSeed === null) !== (canonicalFence === null)) {
      throw new CheckpointRunStateError("memo seed canonical fence binding mismatch");
    }
    const owner = `checkpoint-clear/${runId}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      this.#durable.transaction(lease, tx => {
        if (canonicalFence !== null) {
          tx.addBeforeCommitGuard(() => this.#canonical.assertActiveFence(canonicalFence));
          this.#canonical.assertActiveFence(canonicalFence);
        }
        const record = tx.readRoot();
        if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(record);
        if (root.revision !== expectedRevision) throw new CASConflictError(expectedRevision, root.revision);
        const loaded = this.#loadActiveRunTx(tx, record, root, runId);
        const previousMemoStorageHash = this.#findMemoStorageHash(tx, record.references, root.verifiedMemoRoot);
        let memoStorageHash = previousMemoStorageHash;
        let verifiedMemoRoot = root.verifiedMemoRoot;
        if (memoSeed !== null) {
          if (loaded.envelope.attestationPartitionStorageHash === null) {
            throw new CheckpointRunStateError("memo seed run has no durable attestation partition");
          }
          if (
            reason !== "cutoff-too-old-for-serving"
            || memoSeed.runId !== loaded.envelope.runId
            || memoSeed.checkpointRevision !== loaded.envelope.checkpointRevision
            || !sameCutoff(memoSeed.cutoff, loaded.envelope.cutoff)
            || memoSeed.definitionCatalogRoot !== loaded.envelope.definitionCatalogRoot
            || memoSeed.sourceCoverage.sourceCoverageRoot !== loaded.envelope.sourceCoverageRoot
            || memoSeed.candidatePartitionRoot !== loaded.envelope.candidatePartitionRoot
            || memoSeed.verifiedMemoSetRoot !== loaded.envelope.verifiedMemoSetRoot
          ) throw new CheckpointRunStateError("memo seed run closure mismatch");
          this.#attestationAuthority.validateDurablePartition(memoSeed.partition, loaded.builderRun.candidates);
          assertPromotablePartition(memoSeed.partition, memoSeed.candidateKeys);
          const durablePartition = decodeAttestationPartitionRecordWith(
            tx.readContent.bind(tx),
            loaded.envelope.attestationPartitionStorageHash,
            loaded.envelope.outcomePartitionStorageHash,
            loaded.envelope.runId,
            "memo seed attestation partition",
          );
          this.#attestationAuthority.validateDurablePartition(durablePartition, loaded.builderRun.candidates);
          if (durablePartition.exactOutcomePartitionRoot !== memoSeed.partition.exactOutcomePartitionRoot
            || encodeCanonicalJson(durablePartition.runtimeAuthority) !== encodeCanonicalJson(memoSeed.partition.runtimeAuthority)
            || durablePartition.attestationAuthorityRoot !== memoSeed.partition.attestationAuthorityRoot
            || durablePartition.frameworkAuthorityRoot !== memoSeed.partition.frameworkAuthorityRoot
            || durablePartition.executorAuthorityRoot !== memoSeed.partition.executorAuthorityRoot
            || encodeCanonicalJson(durablePartition.accounting) !== encodeCanonicalJson(memoSeed.partition.accounting)) {
            throw new CheckpointRunStateError("memo seed attestation authority mismatch");
          }
          memoStorageHash = loaded.envelope.verifiedMemoSetStorageHash;
          decodeMemoSetRecordWith(tx.readContent.bind(tx), memoStorageHash, "memo seed");
          verifiedMemoRoot = memoSeed.verifiedMemoSetRoot;
        }
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const receiptPayload: Omit<MemoSeedReceiptV1, "receiptLineageRoot"> | null = memoSeed === null
          ? null
          : deepFreeze({
            runId,
            cutoff: loaded.envelope.cutoff,
            reason: "cutoff-too-old-for-serving" as const,
            sealedRevision: nextRevision,
            definitionCatalogRoot: loaded.envelope.definitionCatalogRoot,
            checkpointSchemaHash: root.schemaHash,
            candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
            sourceCoverageRoot: loaded.envelope.sourceCoverageRoot,
            exactOutcomePartitionRoot: memoSeed.partition.exactOutcomePartitionRoot,
            verifiedMemoRoot,
            canonicalJournalEpoch: canonicalFence!.journalEpoch,
            canonicalJournalRoot: canonicalFence!.canonicalJournalRoot,
            sequence: (BigInt(root.memoSeedSequence) + 1n).toString(),
            priorReceiptHash: root.latestMemoSeedReceiptHash,
            priorLineageRoot: root.memoSeedLineageRoot,
          });
        const receipt = receiptPayload === null
          ? null
          : deepFreeze({ ...receiptPayload, receiptLineageRoot: memoSeedLineageRoot(receiptPayload) });
        const receiptStorageHash = receipt === null
          ? null
          : tx.putImmutable(
            DIAGNOSTIC_KIND,
            encodeCanonicalBytes(receipt),
            receipt.priorReceiptHash === null ? [] : [receipt.priorReceiptHash],
          );
        const nextRoot: CheckpointRootV1 = deepFreeze({
          ...root,
          revision: nextRevision,
          verifiedMemoRoot,
          inProgressRunId: null,
          latestMemoSeedReceiptHash: receiptStorageHash ?? root.latestMemoSeedReceiptHash,
          memoSeedSequence: receipt?.sequence ?? root.memoSeedSequence,
          memoSeedLineageRoot: receipt?.receiptLineageRoot ?? root.memoSeedLineageRoot,
        });
        for (const entry of tx.listIndex(`candidate/${runId}`)) tx.deleteIndex(`candidate/${runId}`, entry.key);
        for (const entry of tx.listIndex(`outcome/${runId}`)) tx.deleteIndex(`outcome/${runId}`, entry.key);
        for (const entry of tx.listIndex(`partial-outcome/${runId}`)) tx.deleteIndex(`partial-outcome/${runId}`, entry.key);
        if (canonicalFence !== null) this.#canonical.assertActiveFence(canonicalFence);
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          this.#rootReferencesFor(
            hash => tx.readContent(hash),
            [...record.references, memoStorageHash, ...(receiptStorageHash === null ? [] : [receiptStorageHash])],
            nextRoot,
            false,
          ),
        );
      });
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
  }

  #findReadyClosureRecord(
    references: readonly Hash[],
    readyRecordHash: Hash,
  ): { readonly storageHash: Hash; readonly closure: ReadyClosureV1 } {
    return this.#findReadyClosureRecordWith(
      hash => this.#durable.readContent(hash),
      references,
      readyRecordHash,
      true,
    );
  }

  #findReadyStageRecordWith(
    read: DurableContentReader,
    references: readonly Hash[],
    stageStorageHash: Hash,
    allowValidatedCache = false,
  ): ReadyStageV1 {
    if (!references.includes(stageStorageHash)) {
      throw new CorruptDurableStoreError("staged ready is not root-reachable");
    }
    const content = read(stageStorageHash);
    if (!content || content.kind !== READY_STAGE_KIND) {
      throw new CorruptDurableStoreError("staged ready record is missing");
    }
    const stage = decodeReadyStage(content.bytes);
    const expectedReferences = [
      stage.sourceCoverageStorageHash,
      stage.sourceExecutionSetStorageHash,
      stage.sourcePlanEvidenceStorageHash,
      stage.nominationClosureStorageHash,
      stage.verifiedMemoSetStorageHash,
      stage.instanceCatalogStorageHash,
      stage.graphStorageHash,
    ].sort(compareText);
    if (encodeCanonicalJson(content.references) !== encodeCanonicalJson(expectedReferences)) {
      throw new CorruptDurableStoreError("staged ready physical references mismatch");
    }
    if (allowValidatedCache && this.#validatedReadyStageStorageHashes.has(stageStorageHash)) {
      return stage;
    }
    const sourceExecutionRecord = read(stage.sourceExecutionSetStorageHash);
    if (!sourceExecutionRecord || sourceExecutionRecord.kind !== SOURCE_EXECUTION_SET_KIND) {
      throw new CorruptDurableStoreError("staged source execution set is missing");
    }
    const sourceExecutionSet = decodePersistedSourcePlanExecutionSet(
      decodeCanonicalJson(sourceExecutionRecord.bytes),
      "staged source execution set",
    );
    if (sourceExecutionSet.executionSetRoot !== stage.sourceExecutionSetRoot) {
      throw new CorruptDurableStoreError("staged source execution set root mismatch");
    }
    const sourceCoverageRecord = read(stage.sourceCoverageStorageHash);
    if (!sourceCoverageRecord || sourceCoverageRecord.kind !== SOURCE_COVERAGE_KIND) {
      throw new CorruptDurableStoreError("staged source coverage is missing");
    }
    const sourceCoverage = cloneCanonical<SourceCoverageCertificateV1>(decodeCanonicalJson(sourceCoverageRecord.bytes));
    validatePersistedExecutionCoverage(sourceExecutionSet, sourceCoverage);
    const sourcePlanEvidenceRecord = read(stage.sourcePlanEvidenceStorageHash);
    if (!sourcePlanEvidenceRecord || sourcePlanEvidenceRecord.kind !== SOURCE_PLAN_EVIDENCE_KIND) {
      throw new CorruptDurableStoreError("staged source-plan evidence is missing");
    }
    const sourcePlanEvidence = decodeSourcePlanEvidenceSet(
      sourcePlanEvidenceRecord.bytes,
      "staged source-plan evidence",
    );
    validateSourcePlanEvidenceReceipts(
      sourcePlanEvidence,
      stage.readyBase.cutoff,
      sourcePlanRefsFromCoverage(sourceCoverage),
    );
    validateSourcePlanEvidenceExecutionJoin(sourcePlanEvidence, sourceExecutionSet);
    validateRawLocatorReferences(
      read,
      sourcePlanEvidenceRecord.references,
      sourcePlanEvidence.flatMap(value => value.rawLocatorHashes),
      "staged source-plan evidence",
    );
    const catalog = decodeInstanceCatalogRecordWith(
      read,
      stage.instanceCatalogStorageHash,
      "staged instance catalog",
    );
    const graph = decodePersistedGraphRecordWith(
      read,
      stage.graphStorageHash,
      catalog,
      "staged graph",
    );
    if (catalog.instanceCatalogRoot !== stage.readyBase.instanceCatalogRoot
      || catalog.instanceCount !== stage.readyBase.instanceCount
      || graph.graphRoot !== stage.readyBase.graphRoot
      || graph.edgeCount !== stage.readyBase.edgeCount
      || !sameCutoff(catalog.cutoff, stage.readyBase.cutoff)
      || !sameCutoff(graph.cutoff, stage.readyBase.cutoff)) {
      throw new CorruptDurableStoreError("staged catalog/graph lineage mismatch");
    }
    return stage;
  }

  #readyStageIdentity(stage: ReadyStageV1, stageStorageHash: Hash): ReadyStageIdentityV1 {
    return deepFreeze({
      stageStorageHash,
      runId: stage.runId,
      expectedRevision: stage.expectedRevision,
      sealedRevision: stage.sealedRevision,
      stageRevision: stage.stageRevision,
      stageRecordHash: stage.stageRecordHash,
      readyBaseHash: stage.readyBaseHash,
      cutoff: stage.readyBase.cutoff,
      generationRefreshPolicyHash: stage.readyBase.generationRefreshPolicyHash,
      definitionCatalogRoot: stage.readyBase.definitionCatalogRoot,
      runtimeAuthority: stage.readyBase.runtimeAuthority,
      candidatePartitionCommitmentStorageHash: stage.readyBase.candidatePartitionCommitmentStorageHash,
      nominationClosureRoot: stage.readyBase.nominationClosureRoot,
      nominationClosureStorageHash: stage.readyBase.nominationClosureStorageHash,
    });
  }

  #resolvePromotionStateWith(
    read: DurableContentReader,
    record: DurableRootRecord,
    root: CheckpointRootV1,
    expected: ReadyStageIdentityV1,
  ): ReadyPromotionDurableStateV1 {
    let activeReady: ReadyGenerationV1 | null = null;
    if (root.readyGenerationRecordHash !== null) {
      const found = this.#findReadyClosureRecordWith(
        read,
        record.references,
        root.readyGenerationRecordHash,
        true,
      );
      activeReady = found.closure.ready;
      const commitmentRecord = read(found.closure.candidatePartitionReadyCommitmentStorageHash);
      if (!commitmentRecord || commitmentRecord.kind !== CANDIDATE_PARTITION_COMMITMENT_KIND) {
        throw new CorruptDurableStoreError("candidate partition commitment is missing");
      }
      const commitment = decodeCandidatePartitionCommitment(commitmentRecord.bytes);
      if (
        commitment.readyRecordHash === activeReady.readyRecordHash
        && commitment.runId === expected.runId
        && commitment.sealedRevision === expected.sealedRevision
        && commitment.stageRevision === expected.stageRevision
        && commitment.stageRecordHash === expected.stageRecordHash
        && commitment.readyBaseHash === expected.readyBaseHash
        && commitment.nominationClosureRoot === expected.nominationClosureRoot
        && commitment.nominationClosureStorageHash === expected.nominationClosureStorageHash
        && sameCutoff(commitment.cutoff, expected.cutoff)
      ) {
        return deepFreeze({ kind: "committed", stage: expected, ready: activeReady });
      }
    }
    if (root.stagedReadyStorageHash !== null) {
      const stage = this.#findReadyStageRecordWith(read, record.references, root.stagedReadyStorageHash);
      const identity = this.#readyStageIdentity(stage, root.stagedReadyStorageHash);
      if (encodeCanonicalJson(identity) !== encodeCanonicalJson(expected)) {
        throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
      }
      return deepFreeze({ kind: "staged", stage: identity });
    }
    return deepFreeze({ kind: "absent", stage: expected, activeReady });
  }

  #findReadyStageRecord(
    references: readonly Hash[],
    stageStorageHash: Hash,
  ): ReadyStageV1 {
    return this.#findReadyStageRecordWith(
      hash => this.#durable.readContent(hash),
      references,
      stageStorageHash,
    );
  }

  #findReadyClosureRecordWith(
    read: DurableContentReader,
    references: readonly Hash[],
    readyRecordHash: Hash,
    allowValidatedCache: boolean,
  ): { readonly storageHash: Hash; readonly closure: ReadyClosureV1 } {
    for (const hash of references) {
      const content = read(hash);
      if (content?.kind !== READY_CLOSURE_KIND) continue;
      const closure = decodeReadyClosure(content.bytes);
      const expectedReferences = [
        closure.sourceCoverageStorageHash,
        closure.sourceExecutionSetStorageHash,
        closure.sourcePlanEvidenceStorageHash,
        closure.nominationClosureStorageHash,
        closure.candidatePartitionStorageHash,
        closure.outcomePartitionStorageHash,
        closure.attestationPartitionStorageHash,
        closure.candidatePartitionReadyCommitmentStorageHash,
        closure.candidatePartitionCommitmentStorageHash,
        closure.verifiedMemoSetStorageHash,
        closure.instanceCatalogStorageHash,
        closure.graphStorageHash,
      ].sort(compareText);
      if (encodeCanonicalJson(content.references) !== encodeCanonicalJson(expectedReferences)) {
        throw new CorruptDurableStoreError("ready closure physical references mismatch");
      }
      if (closure.ready.readyRecordHash === readyRecordHash) {
        if (!allowValidatedCache || !this.#validatedReadyClosureStorageHashes.has(hash)) {
          const commitmentRecord = read(closure.candidatePartitionReadyCommitmentStorageHash);
          if (!commitmentRecord || commitmentRecord.kind !== CANDIDATE_PARTITION_COMMITMENT_KIND) {
            throw new CorruptDurableStoreError("candidate partition commitment is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.candidatePartitionReadyCommitmentStorageHash,
            CANDIDATE_PARTITION_COMMITMENT_KIND,
            [
              closure.candidatePartitionCommitmentStorageHash,
              closure.candidatePartitionStorageHash,
              closure.nominationClosureStorageHash,
            ],
            "candidate partition commitment",
          );
          const commitment = decodeCandidatePartitionCommitment(commitmentRecord.bytes);
          if (
            commitment.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
            || commitment.nominationClosureRoot !== closure.nominationClosureRoot
            || commitment.nominationClosureStorageHash !== closure.nominationClosureStorageHash
            || commitment.candidateRecordCount !== closure.candidateRecordCount
            || commitment.candidateKeysRoot !== closure.candidateKeysRoot
            || commitment.recentObservationRoot !== closure.recentObservationRoot
            || commitment.sourceCoverageRoot !== closure.sourceCoverageRoot
            || commitment.checkpointRevision !== closure.candidatePartitionRevision
          ) throw new CorruptDurableStoreError("ready candidate partition closure metadata mismatch");
          this.#validatePartitionPhysicalWith(
            read,
            closure.candidatePartitionStorageHash,
            commitment.runId,
            "candidate",
          );
          const candidateEntries = loadPartition(
            (candidateHash, kind, context) => {
              const candidateRecord = read(candidateHash);
              if (!candidateRecord || candidateRecord.kind !== kind) {
                throw new CorruptDurableStoreError(`${context} is missing or has the wrong kind`);
              }
              return candidateRecord.bytes;
            },
            closure.candidatePartitionStorageHash,
            commitment.runId,
            "candidate",
          );
          const candidates = candidateEntries.map(entry => {
            const candidateRecord = read(entry.storageHash);
            if (!candidateRecord || candidateRecord.kind !== CANDIDATE_KIND) {
              throw new CorruptDurableStoreError("ready candidate record is missing");
            }
            const candidate = cloneCanonical<CandidateRecordV1>(decodeCanonicalJson(candidateRecord.bytes));
            if (candidate.familyCandidateKey !== entry.key) {
              throw new CorruptDurableStoreError("ready candidate partition key mismatch");
            }
            validateRawLocatorReferences(
              read,
              candidateRecord.references,
              candidate.evidence.map(value => value.rawLocatorHash),
              "ready candidate record",
            );
            return candidate;
          });
          const candidateKeys = candidates.map(candidate => candidate.familyCandidateKey);
          if (
            String(candidates.length) !== closure.candidateRecordCount
            || String(candidates.length) !== commitment.candidateRecordCount
            || candidatePartitionRoot(candidates) !== closure.ready.candidatePartitionRoot
            || candidatePartitionRoot(candidates) !== commitment.candidatePartitionRoot
            || candidatePartitionKeysRoot(candidateKeys) !== closure.candidateKeysRoot
            || candidatePartitionKeysRoot(candidateKeys) !== commitment.candidateKeysRoot
          ) throw new CorruptDurableStoreError("ready candidate partition semantic closure mismatch");
          this.#validatePartitionPhysicalWith(
            read,
            closure.outcomePartitionStorageHash,
            commitment.runId,
            "outcome",
          );
          const candidatesByKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
          const outcomeEntries = loadPartition(
            (outcomeHash, kind, context) => {
              const outcomeRecord = read(outcomeHash);
              if (!outcomeRecord || outcomeRecord.kind !== kind) {
                throw new CorruptDurableStoreError(`${context} is missing or has the wrong kind`);
              }
              return outcomeRecord.bytes;
            },
            closure.outcomePartitionStorageHash,
            commitment.runId,
            "outcome",
          );
          const outcomes = outcomeEntries.map(entry => {
            const outcomeRecord = read(entry.storageHash);
            if (!outcomeRecord || outcomeRecord.kind !== OUTCOME_KIND) {
              throw new CorruptDurableStoreError("ready candidate outcome is missing");
            }
            const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(outcomeRecord.bytes));
            const outcomeKey = assertHash(entry.key, "readyClosure.outcome.key");
            const candidate = candidatesByKey.get(outcomeKey);
            if (!candidate || outcome.familyCandidateKey !== outcomeKey) {
              throw new CorruptDurableStoreError("ready outcome candidate binding mismatch");
            }
            this.#attestationAuthority.validateDurableOutcome(outcome, {
              runId: commitment.runId,
              cutoff: closure.ready.cutoff,
              candidatePartitionRoot: closure.ready.candidatePartitionRoot,
              candidate,
            });
            if (outcome.kind === "chainProvenRejected") {
              if (outcomeRecord.references.length !== 1) {
                throw new CorruptDurableStoreError("ready chain rejection outcome must reference exactly one bundle");
              }
              validateRejectionBundlePhysicalWith(
                read,
                outcomeRecord.references[0]!,
                outcome.rejectionEvidence,
                "ready candidate rejection outcome",
              );
            } else if (outcomeRecord.references.length !== 0) {
              throw new CorruptDurableStoreError("ready non-rejection outcome has physical references");
            }
            return outcome;
          });
          const partitionRecord = read(closure.attestationPartitionStorageHash);
          if (!partitionRecord || partitionRecord.kind !== ATTESTATION_PARTITION_KIND) {
            throw new CorruptDurableStoreError("ready attestation partition is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.attestationPartitionStorageHash,
            ATTESTATION_PARTITION_KIND,
            [closure.outcomePartitionStorageHash],
            "ready attestation partition",
          );
          const partition = decodeAttestationPartitionRecordWith(
            read,
            closure.attestationPartitionStorageHash,
            closure.outcomePartitionStorageHash,
            commitment.runId,
            "ready attestation partition",
          );
          this.#attestationAuthority.validateDurablePartition(partition, candidates);
          if (
            partition.runId !== commitment.runId
            || !sameCutoff(partition.cutoff, closure.ready.cutoff)
            || partition.candidatePartitionRoot !== closure.ready.candidatePartitionRoot
            || partition.exactOutcomePartitionRoot !== closure.ready.exactOutcomePartitionRoot
            || partition.outcomes.length !== outcomes.length
            || partition.outcomes.some((outcome, index) => (
              candidateFinalOutcomeHash(outcome) !== candidateFinalOutcomeHash(outcomes[index]!)
            ))
          ) throw new CorruptDurableStoreError("ready attestation partition lineage mismatch");
          const authorityCommitmentRecord = read(closure.candidatePartitionCommitmentStorageHash);
          if (!authorityCommitmentRecord || authorityCommitmentRecord.kind !== CANDIDATE_PARTITION_AUTHORITY_KIND) {
            throw new CorruptDurableStoreError("ready candidate partition commitment is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.candidatePartitionCommitmentStorageHash,
            CANDIDATE_PARTITION_AUTHORITY_KIND,
            [],
            "ready candidate partition commitment",
          );
          const candidatePartitionAuthority = decodeCandidatePartitionCommitmentBytesV1(authorityCommitmentRecord.bytes);
          const evidenceAuthority = this.#captureAuthorityFence();
          const expectedGenerationId = hashDomain("aloha/ready-generation-id/v1", {
            parentGenerationId: closure.ready.parentGenerationId,
            runId: commitment.runId,
            cutoff: closure.ready.cutoff,
            definitionCatalogRoot: closure.ready.definitionCatalogRoot,
            instanceCatalogRoot: closure.ready.instanceCatalogRoot,
            graphRoot: closure.ready.graphRoot,
            policyHash: closure.ready.generationRefreshPolicyHash,
            runtimeAuthority: closure.ready.runtimeAuthority,
            candidatePartitionCommitmentStorageHash: closure.ready.candidatePartitionCommitmentStorageHash,
            nominationClosureRoot: closure.ready.nominationClosureRoot,
            nominationClosureStorageHash: closure.ready.nominationClosureStorageHash,
          });
          if (
            commitment.readyRecordHash !== closure.ready.readyRecordHash
            || commitment.candidatePartitionCommitmentStorageHash !== closure.candidatePartitionCommitmentStorageHash
            || closure.ready.candidatePartitionCommitmentStorageHash !== closure.candidatePartitionCommitmentStorageHash
            || encodeCanonicalJson(candidatePartitionAuthority.runtimeAuthority) !== encodeCanonicalJson(evidenceAuthority.runtimeAuthority)
            || candidatePartitionAuthority.runId !== commitment.runId
            || candidatePartitionAuthority.candidatePartitionRoot !== closure.ready.candidatePartitionRoot
            || candidatePartitionAuthority.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
            || candidatePartitionAuthority.nominationClosureRoot !== closure.nominationClosureRoot
            || candidatePartitionAuthority.nominationClosureStorageHash !== closure.nominationClosureStorageHash
            || candidatePartitionAuthority.recordCount !== closure.candidateRecordCount
            || candidatePartitionAuthority.candidateKeysRoot !== closure.candidateKeysRoot
            || candidatePartitionAuthority.recentObservationRoot !== closure.recentObservationRoot
            || candidatePartitionAuthority.sourceCoverageRoot !== closure.sourceCoverageRoot
            || candidatePartitionAuthority.checkpointRevision !== closure.candidatePartitionRevision
            || !sameCutoff(candidatePartitionAuthority.cutoff, closure.ready.cutoff)
            || !sameCutoff(commitment.cutoff, closure.ready.cutoff)
            || commitment.candidatePartitionRoot !== closure.ready.candidatePartitionRoot
            || commitment.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
            || commitment.nominationClosureRoot !== closure.nominationClosureRoot
            || commitment.nominationClosureStorageHash !== closure.nominationClosureStorageHash
            || commitment.candidateRecordCount !== closure.candidateRecordCount
            || commitment.candidateKeysRoot !== closure.candidateKeysRoot
            || commitment.recentObservationRoot !== closure.recentObservationRoot
            || commitment.sourceCoverageRoot !== closure.sourceCoverageRoot
            || commitment.checkpointRevision !== closure.candidatePartitionRevision
            || commitment.exactOutcomePartitionRoot !== closure.ready.exactOutcomePartitionRoot
            || commitment.readyBaseHash !== readyGenerationBaseHash({
              generationId: closure.ready.generationId,
              parentGenerationId: closure.ready.parentGenerationId,
              generationRefreshPolicyHash: closure.ready.generationRefreshPolicyHash,
              cutoff: closure.ready.cutoff,
              recentObservationRange: closure.ready.recentObservationRange,
              definitionCatalogRoot: closure.ready.definitionCatalogRoot,
              sourceCoverageRoot: closure.ready.sourceCoverageRoot,
              candidatePartitionRoot: closure.ready.candidatePartitionRoot,
              nominationClosureRoot: closure.ready.nominationClosureRoot,
              nominationClosureStorageHash: closure.ready.nominationClosureStorageHash,
              exactOutcomePartitionRoot: closure.ready.exactOutcomePartitionRoot,
              verifiedMemoSetRoot: closure.ready.verifiedMemoSetRoot,
              instanceCatalogRoot: closure.ready.instanceCatalogRoot,
              graphRoot: closure.ready.graphRoot,
              edgeCount: closure.ready.edgeCount,
              instanceCount: closure.ready.instanceCount,
              runtimeAuthority: closure.ready.runtimeAuthority,
              candidatePartitionCommitmentStorageHash: closure.ready.candidatePartitionCommitmentStorageHash,
            })
            || BigInt(commitment.sealedRevision) + 1n !== BigInt(commitment.stageRevision)
            || BigInt(commitment.stageRevision) + 1n !== BigInt(closure.ready.promotionRevision)
            || expectedGenerationId !== closure.ready.generationId
          ) throw new CorruptDurableStoreError("candidate partition commitment lineage mismatch");
          const memoRecord = read(closure.verifiedMemoSetStorageHash);
          if (!memoRecord || memoRecord.kind !== VERIFIED_MEMO_SET_KIND) throw new CorruptDurableStoreError("ready memo set is missing");
          const memo = decodeMemoSetRecordWith(read, closure.verifiedMemoSetStorageHash, "ready memo set");
          if (memo.verifiedMemoSetRoot !== closure.ready.verifiedMemoSetRoot) {
            throw new CorruptDurableStoreError("ready memo root mismatch");
          }
          const sourceCoverageRecord = read(closure.sourceCoverageStorageHash);
          if (!sourceCoverageRecord || sourceCoverageRecord.kind !== SOURCE_COVERAGE_KIND) {
            throw new CorruptDurableStoreError("ready source coverage is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.sourceCoverageStorageHash,
            SOURCE_COVERAGE_KIND,
            [],
            "ready source coverage",
          );
          const sourceCoverage = cloneCanonical<SourceCoverageCertificateV1>(
            decodeCanonicalJson(sourceCoverageRecord.bytes),
          );
          validateSourceCoverageCertificate(
            sourceCoverage,
            sourceCoverage.entries.map(entry => ({
              ownerRef: entry.ownerRef,
              sourcePlanRef: entry.sourcePlanRef,
              familyDefinitionHash: entry.familyDefinitionHash,
              completeness: entry.completeness,
              historyStartBlock: entry.historyStartBlock,
            })),
          );
          if (
            sourceCoverage.sourceCoverageRoot !== closure.ready.sourceCoverageRoot
            || sourceCoverage.sourceCoverageRoot !== closure.sourceCoverageRoot
            || sourceCoverage.sourceCoverageRoot !== commitment.sourceCoverageRoot
            || !sameCutoff(sourceCoverage.cutoff, closure.ready.cutoff)
          ) throw new CorruptDurableStoreError("ready source coverage root mismatch");
          const readyExecutions = validateSourceExecutionSetRecord(
            read,
            closure.sourceExecutionSetStorageHash,
            sourceCoverage,
          );
          if (readyExecutions.set.executionSetRoot !== closure.sourceExecutionSetRoot) {
            throw new CorruptDurableStoreError("ready source execution set root mismatch");
          }
          const sourcePlanEvidenceRecord = read(closure.sourcePlanEvidenceStorageHash);
          if (!sourcePlanEvidenceRecord || sourcePlanEvidenceRecord.kind !== SOURCE_PLAN_EVIDENCE_KIND) {
            throw new CorruptDurableStoreError("ready source-plan evidence is missing");
          }
          const sourcePlanEvidence = decodeSourcePlanEvidenceSet(
            sourcePlanEvidenceRecord.bytes,
            "ready source-plan evidence",
          );
          validateSourcePlanEvidenceReceipts(
            sourcePlanEvidence,
            closure.ready.cutoff,
            sourcePlanRefsFromCoverage(sourceCoverage),
          );
          validateSourcePlanEvidenceExecutionJoin(sourcePlanEvidence, readyExecutions.set);
          validateRawLocatorReferences(
            read,
            sourcePlanEvidenceRecord.references,
            sourcePlanEvidence.flatMap(value => value.rawLocatorHashes),
            "ready source-plan evidence",
          );

          const nominationRecord = read(closure.nominationClosureStorageHash);
          if (!nominationRecord || nominationRecord.kind !== NOMINATION_CLOSURE_KIND) {
            throw new CorruptDurableStoreError("ready nomination closure is missing");
          }
          const decodedNomination = decodeNominationClosureRecordWith(
            read,
            closure.nominationClosureStorageHash,
            "ready nomination closure",
          );
          const recentReferences = decodedNomination.dependencyReferences.filter(reference => (
            read(reference)?.kind === RECENT_OBSERVATION_KIND
          ));
          if (recentReferences.length !== 1) {
            throw new CorruptDurableStoreError("ready nomination closure recent observation reference is not exact");
          }
          const expectedNominationReferences = [
            recentReferences[0]!,
            closure.sourceCoverageStorageHash,
            closure.sourceExecutionSetStorageHash,
            closure.sourcePlanEvidenceStorageHash,
            closure.candidatePartitionStorageHash,
          ].sort(compareText);
          if (encodeCanonicalJson(decodedNomination.dependencyReferences) !== encodeCanonicalJson(expectedNominationReferences)) {
            throw new CorruptDurableStoreError("ready nomination closure physical references mismatch");
          }
          const recentRecord = read(recentReferences[0]!);
          if (!recentRecord || recentRecord.kind !== RECENT_OBSERVATION_KIND) {
            throw new CorruptDurableStoreError("ready recent observation is missing");
          }
          const recentObservation = cloneCanonical<RecentObservationReceiptV1>(
            decodeCanonicalJson(recentRecord.bytes),
          );
          validateRecentObservationReceipt(
            recentObservation,
            this.#canonical.recentObservationRange(closure.ready.cutoff),
          );
          validateRawLocatorReferences(
            read,
            recentRecord.references,
            recentObservation.evidence.map(value => value.rawLocatorHash),
            "ready recent observation",
          );
          let nominationClosure: NominationClosureV1;
          try {
            nominationClosure = validateNominationClosureAgainstRun({
              closure: decodedNomination.closure,
              cutoff: closure.ready.cutoff,
              recentObservation,
              sourceCoverage,
              sourceExecutionSet: readyExecutions.set,
              candidates,
              candidatePartitionRoot: closure.ready.candidatePartitionRoot,
            });
          } catch (error) {
            throw new CorruptDurableStoreError(
              `ready nomination closure validation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (
            nominationClosure.root !== closure.nominationClosureRoot
            || nominationClosure.root !== closure.ready.nominationClosureRoot
            || closure.nominationClosureStorageHash !== closure.ready.nominationClosureStorageHash
          ) throw new CorruptDurableStoreError("ready nomination closure lineage mismatch");
          const catalog = decodeInstanceCatalogRecordWith(
            read,
            closure.instanceCatalogStorageHash,
            "ready instance catalog",
          );
          if (
            catalog.instanceCatalogRoot !== closure.ready.instanceCatalogRoot
            || catalog.instanceCount !== closure.ready.instanceCount
            || !sameCutoff(catalog.cutoff, closure.ready.cutoff)
          ) throw new CorruptDurableStoreError("ready instance catalog root mismatch");
          assertVerifiedPublicationCatalog(memo.memos, catalog);

          const graph = decodePersistedGraphRecordWith(
            read,
            closure.graphStorageHash,
            catalog,
            "ready graph",
          );
          if (
            graph.graphRoot !== closure.ready.graphRoot
            || graph.edgeCount !== closure.ready.edgeCount
            || !sameCutoff(graph.cutoff, closure.ready.cutoff)
          ) throw new CorruptDurableStoreError("ready graph root mismatch");
          if (allowValidatedCache) this.#validatedReadyClosureStorageHashes.add(hash);
        }
        return deepFreeze({ storageHash: hash, closure });
      }
    }
    throw new CorruptDurableStoreError("ready closure is not root-reachable");
  }

  #findReadyClosure(references: readonly Hash[], readyRecordHash: Hash): ReadyClosureV1 {
    return this.#findReadyClosureRecord(references, readyRecordHash).closure;
  }

  async #loadRetryable(runId: string, familyCandidateKey: Hash): Promise<StoredRetryableProbeV1> {
    const loaded = this.#loadActiveRun(runId);
    const candidate = loaded.builderRun.candidates.find(value => value.familyCandidateKey === familyCandidateKey);
    if (!candidate) throw new CheckpointRunStateError("probe candidate is absent");
    const hash = this.#durable.readIndex(`outcome/${runId}`, familyCandidateKey);
    if (!hash) throw new CheckpointRunStateError("probe outcome is absent");
    const before = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(readContentStore(this.#durable, hash, OUTCOME_KIND, "probe outcome")));
    this.#attestationAuthority.validateDurableOutcome(before, {
      runId,
      cutoff: loaded.envelope.cutoff,
      candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
      candidate,
    });
    const beforeRecord = this.#durable.readContent(hash);
    if (!beforeRecord || beforeRecord.kind !== OUTCOME_KIND) throw new CorruptDurableStoreError("probe outcome is missing");
    if (before.kind === "chainProvenRejected") {
      if (beforeRecord.references.length !== 1) throw new CorruptDurableStoreError("chain rejection outcome must reference exactly one bundle");
      validateRejectionBundlePhysicalWith(
        value => this.#durable.readContent(value),
        beforeRecord.references[0]!,
        before.rejectionEvidence,
        "probe outcome",
      );
    } else if (beforeRecord.references.length !== 0) {
      throw new CorruptDurableStoreError("non-rejection probe outcome has physical references");
    }
    if (before.kind !== "retryable") throw new OutcomeStateConflictError("probe target is not retryable");
    const candidatePartitionBinding = loaded.builderRun.candidatePartitionBinding;
    const candidateSubjectHash = candidate.candidateSubjectHash;
    const beforeOutcomeHash = candidateFinalOutcomeHash(before);
    const claimKey = `${runId}:${familyCandidateKey}:${beforeOutcomeHash}:${loaded.envelope.checkpointRevision}`;
    if (this.#issuedProbeClaims.has(claimKey)) {
      throw new CheckpointRunStateError("retryable probe capability already claimed");
    }
    const probeCapability = Object.freeze({}) as RetryableProbeCapabilityV1;
    this.#probeStates.set(probeCapability, {
      runId,
      familyCandidateKey,
      expectedOutcomeHash: beforeOutcomeHash,
      checkpointRevision: loaded.envelope.checkpointRevision,
      candidateSubjectHash,
      candidatePartitionBinding,
      candidatePartition: loaded.builderRun.candidatePartition,
      used: false,
    });
    this.#issuedProbeClaims.add(claimKey);
    return deepFreeze({
      runId,
      cutoff: loaded.envelope.cutoff,
      checkpointRevision: loaded.envelope.checkpointRevision,
      probeCapability,
      candidatePartition: loaded.builderRun.candidatePartition,
      candidatePartitionBinding,
      candidateSubjectHash,
      before,
      beforeOutcomeHash,
    });
  }

  async #listRetryable(runId: string, failureCode: string): Promise<readonly Hash[]> {
    const loaded = this.#loadActiveRun(runId);
    const candidates = new Map(loaded.builderRun.candidates.map(value => [value.familyCandidateKey, value]));
    const keys: Hash[] = [];
    for (const entry of this.#durable.listIndex(`outcome/${runId}`)) {
      const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(readContentStore(this.#durable, entry.contentHash, OUTCOME_KIND, "retryable outcome")));
      const candidate = candidates.get(outcome.familyCandidateKey);
      if (!candidate) throw new CorruptDurableStoreError("outcome candidate is absent");
      this.#attestationAuthority.validateDurableOutcome(outcome, {
        runId,
        cutoff: loaded.envelope.cutoff,
        candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
        candidate,
      });
      if (outcome.kind === "retryable" && outcome.failure.failureCode === failureCode) keys.push(outcome.familyCandidateKey);
    }
    return deepFreeze(keys.sort(compareText));
  }

  async #replaceRetryable(
    probeCapability: RetryableProbeCapabilityV1,
    writerCapability: AttestationWriterCapabilityV1,
    persistenceCapability: AttestationPersistenceCapabilityV1,
  ): Promise<ProbeReceiptV1> {
    if (probeCapability === null || typeof probeCapability !== "object") {
      throw new OutcomeStateConflictError("probe capability is invalid");
    }
    const probeState = this.#probeStates.get(probeCapability);
    if (!probeState || probeState.used) {
      throw new OutcomeStateConflictError("probe capability is consumed or not issued");
    }
    const { runId, familyCandidateKey, expectedOutcomeHash } = probeState;
    const initial = this.#loadActiveRun(runId);
    let claim: AttestationPersistenceBatchClaimV1 | undefined;
    let durableCommitted = false;
    try {
      const receipt = await this.#canonical.withCanonicalFence(initial.envelope.cutoff, async fence => {
      const owner = `checkpoint-probe/${runId}/${familyCandidateKey}/${randomUUID()}`;
      const lease = this.#durable.acquireWriterLease(owner);
      try {
        const committedReceipt = this.#durable.transaction(lease, tx => {
        tx.addBeforeCommitGuard(() => this.#canonical.assertActiveFence(fence));
        this.#canonical.assertActiveFence(fence);
        const record = tx.readRoot();
        if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(record);
        if (root.revision !== probeState.checkpointRevision) {
          throw new OutcomeStateConflictError("probe checkpoint revision changed");
        }
        const loaded = this.#loadActiveRunTx(tx, record, root, runId);
        const candidate = loaded.builderRun.candidates.find(value => value.familyCandidateKey === familyCandidateKey);
        if (!candidate) throw new CheckpointRunStateError("probe candidate is absent");
        if (
          loaded.builderRun.candidatePartitionBinding.candidatePartitionRoot !== probeState.candidatePartitionBinding.candidatePartitionRoot
          || loaded.builderRun.candidatePartitionBinding.candidatePartitionStorageHash !== probeState.candidatePartitionBinding.candidatePartitionStorageHash
          || candidate.candidateSubjectHash !== probeState.candidateSubjectHash
        ) throw new OutcomeStateConflictError("probe capability lineage mismatch");
        const previousStorageHash = tx.getIndex(`outcome/${runId}`, familyCandidateKey);
        if (!previousStorageHash) throw new OutcomeStateConflictError("probe outcome is absent");
        const previous = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(readContent(tx, previousStorageHash, OUTCOME_KIND, "probe previous outcome")));
        const previousSemanticHash = candidateFinalOutcomeHash(previous);
        if (previous.kind !== "retryable" || previousSemanticHash !== expectedOutcomeHash) throw new OutcomeStateConflictError("probe CAS mismatch");
        claim = this.#attestationAuthority.claimWriterCapabilities(writerCapability, [persistenceCapability]);
        const persisted = claim.entries[0];
        if (!persisted || persisted.kind !== "final" || persisted.identity !== null || persisted.outcome === null) {
          throw new OutcomeStateConflictError("probe persistence capability is not a final outcome");
        }
        if (
          persisted.runId !== runId
          || persisted.candidatePartitionRoot !== loaded.envelope.candidatePartitionRoot
          || persisted.familyCandidateKey !== familyCandidateKey
        ) throw new OutcomeStateConflictError("probe persistence lineage mismatch");
        const nextRaw = persisted.outcome;
        const nextOutcomeHash = assertHash(persisted.outcomeHash, "probe persisted outcome hash");
        this.#attestationAuthority.validateOutcomeCapability(nextRaw, {
          runId,
          cutoff: loaded.envelope.cutoff,
          candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
          candidate,
        });
        const next = cloneCanonical<CandidateFinalOutcomeV1>(nextRaw);
        if (next.kind === "invalidProgram") throw new OutcomeStateConflictError("invalidProgram is diagnostic-only");
        if (next.familyCandidateKey !== familyCandidateKey || candidateFinalOutcomeHash(next) !== nextOutcomeHash) throw new OutcomeStateConflictError("probe replacement hash mismatch");
        if (nextOutcomeHash === previousSemanticHash) throw new OutcomeStateConflictError("probe no-op transition is forbidden");
        const nextReferences = next.kind === "chainProvenRejected"
          ? [putRejectionBundle(tx, next.rejectionEvidence)]
          : [];
        const storageHash = tx.putImmutable(OUTCOME_KIND, encodeCanonicalBytes(next), nextReferences);
        tx.setIndex(`outcome/${runId}`, familyCandidateKey, storageHash);
        const outcomes = tx.listIndex(`outcome/${runId}`).map(entry => {
          const record = tx.readContent(entry.contentHash);
          if (!record || record.kind !== OUTCOME_KIND) throw new CorruptDurableStoreError("probe outcome partition record is missing");
          const outcome = cloneCanonical<CandidateFinalOutcomeV1>(decodeCanonicalJson(record.bytes));
          if (outcome.kind === "chainProvenRejected") {
            if (record.references.length !== 1) throw new CorruptDurableStoreError("chain rejection outcome must reference exactly one bundle");
            validateRejectionBundlePhysicalWith(
              hash => tx.readContent(hash),
              record.references[0]!,
              outcome.rejectionEvidence,
              "probe outcome partition",
            );
          } else if (record.references.length !== 0) {
            throw new CorruptDurableStoreError("non-rejection outcome must not reference a rejection bundle");
          }
          return outcome;
        }).sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
        const manifest = putPartition(tx, runId, "outcome", tx.listIndex(`outcome/${runId}`).map(entry => ({ key: entry.key, storageHash: entry.contentHash })));
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const activeOutcomePartitionRoot = outcomePartitionRoot(runId, outcomes);
        const nextRun: StoredRunEnvelopeV2 = deepFreeze({ ...loaded.envelope, checkpointRevision: nextRevision, outcomePartitionRoot: activeOutcomePartitionRoot, outcomePartitionStorageHash: manifest, accounting: outcomeAccounting(loaded.builderRun.candidates.length, outcomes) });
        const nextRunStorageHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(nextRun), runContentReferences(nextRun));
        const receipt = sealProbeReceipt({
          runId,
          familyCandidateKey,
          cutoff: loaded.envelope.cutoff,
          beforeOutcomeHash: previousSemanticHash,
          afterOutcomeHash: nextOutcomeHash,
          beforeKind: "retryable",
          afterKind: next.kind,
          candidateSubjectHash: candidate.candidateSubjectHash,
          evidenceRoot: previous.failure.evidenceRoot,
          checkpointRevisionBefore: root.revision,
          checkpointRevision: nextRevision,
          priorOutcomePartitionRoot: loaded.envelope.outcomePartitionRoot,
          activeOutcomePartitionRoot,
          canonicalJournalEpoch: fence.journalEpoch,
          canonicalJournalRoot: fence.canonicalJournalRoot,
          sequence: (BigInt(root.probeReceiptSequence) + 1n).toString(),
          priorReceiptHash: root.latestProbeReceiptHash,
          priorLineageRoot: root.probeReceiptLineageRoot,
        });
        const receiptEnvelope: StoredProbeReceiptEnvelopeV1 = deepFreeze({
          receipt,
          candidatePartitionStorageHash: loaded.envelope.candidatePartitionStorageHash,
          priorOutcomePartitionStorageHash: loaded.envelope.outcomePartitionStorageHash,
          activeOutcomePartitionStorageHash: manifest,
        });
        const receiptStorageHash = tx.putImmutable(
          PROBE_RECEIPT_KIND,
          encodeCanonicalBytes(receiptEnvelope),
          [
            ...(receipt.priorReceiptHash === null ? [] : [receipt.priorReceiptHash]),
            receiptEnvelope.candidatePartitionStorageHash,
            receiptEnvelope.priorOutcomePartitionStorageHash,
            receiptEnvelope.activeOutcomePartitionStorageHash,
          ],
        );
        const nextRoot = deepFreeze({
          ...root,
          revision: nextRevision,
          latestProbeReceiptHash: receiptStorageHash,
          probeReceiptSequence: receipt.sequence,
          probeReceiptLineageRoot: receipt.receiptLineageRoot,
        });
        this.#canonical.assertActiveFence(fence);
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          this.#rootReferencesFor(
            hash => tx.readContent(hash),
            [...record.references, nextRunStorageHash, receiptStorageHash],
            nextRoot,
            false,
          ),
        );
        return receipt;
        });
        // This flag is deliberately set only after the durable transaction
        // returns.  A later fence freshness check may still throw, but it
        // must not abort an already committed capability claim.
        durableCommitted = true;
        probeState.used = true;
        return committedReceipt;
      } finally {
        this.#durable.releaseWriterLease(lease);
      }
      });
      (claim as AttestationPersistenceBatchClaimV1 | undefined)?.commit();
      claim = undefined;
      return receipt;
    } catch (error) {
      const pendingClaim = claim as AttestationPersistenceBatchClaimV1 | undefined;
      if (pendingClaim) {
        if (durableCommitted) pendingClaim.commit();
        else pendingClaim.abort();
      }
      claim = undefined;
      throw error;
    }
  }
}

/** Internal owner seam; callers cannot forge this with a shape-compatible
 * checkpoint facade. The runtime owner narrows the returned instance to the
 * exact methods it needs and keeps the class itself private to the join. */
export function assertIssuedCheckpointStore(value: unknown): CheckpointStore {
  if (value === null || typeof value !== "object" || !checkpointStoreInstances.has(value)) {
    throw new TypeError("checkpoint store is not issued");
  }
  return value as CheckpointStore;
}

export class DurableOutcomeWriterActor {
  readonly #checkpoint: CheckpointStore;
  readonly #runId: string;
  readonly #writerCapability: AttestationWriterCapabilityV1;
  readonly #flushEveryItems: number;
  readonly #flushEveryMs: number;
  readonly #mailboxCapacity: number;
  readonly #writerId: string;
  readonly #queue: AttestationPersistenceCapabilityV1[] = [];
  readonly #pending: AttestationPersistenceCapabilityV1[] = [];
  readonly #waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  readonly #spaceWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  #accepting = true;
  #forceFlush = false;
  #wake: (() => void) | null = null;
  #lastFlush = performance.now();
  readonly #loop: Promise<void>;
  #done = false;
  #failure: unknown = null;

  constructor(checkpoint: CheckpointStore, runId: string, options: OutcomeWriterOptions) {
    this.#checkpoint = checkpoint;
    this.#runId = runId;
    this.#writerCapability = options.writerCapability;
    this.#mailboxCapacity = options.mailboxCapacity ?? 1_024;
    this.#flushEveryItems = options.flushEveryItems ?? this.#mailboxCapacity;
    this.#flushEveryMs = options.flushEveryMs ?? 3_000;
    this.#writerId = options.writerId ?? `checkpoint-writer/${runId}/${randomUUID()}`;
    if (!Number.isSafeInteger(this.#flushEveryItems) || this.#flushEveryItems < 1) throw new RangeError("flushEveryItems must be positive");
    if (!Number.isSafeInteger(this.#flushEveryMs) || this.#flushEveryMs < 2_000 || this.#flushEveryMs > 5_000) throw new RangeError("flushEveryMs must be 2000..5000");
    if (!Number.isSafeInteger(this.#mailboxCapacity) || this.#mailboxCapacity < 1) throw new RangeError("mailboxCapacity must be positive");
    this.#loop = this.#run();
  }

  async enqueue(raw: AttestationPersistenceCapabilityV1): Promise<void> {
    while (this.#queue.length >= this.#mailboxCapacity) {
      if (this.#failure !== null) throw this.#failure;
      if (!this.#accepting) throw new OutcomeWriterClosedError();
      await new Promise<void>((resolve, reject) => this.#spaceWaiters.push({ resolve, reject }));
    }
    if (this.#failure !== null) throw this.#failure;
    if (!this.#accepting) throw new OutcomeWriterClosedError();
    // Keep the issuer object intact until the single writer validates it. A
    // canonical clone would deliberately erase its process-local capability.
    this.#queue.push(raw);
    this.#wake?.();
    this.#wake = null;
  }

  flush(): Promise<void> {
    if (this.#done) return Promise.resolve();
    this.#forceFlush = true;
    this.#wake?.();
    this.#wake = null;
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  async closeAfterAllProducersAndFlush(): Promise<void> {
    this.#accepting = false;
    const closed = new OutcomeWriterClosedError();
    while (this.#spaceWaiters.length > 0) this.#spaceWaiters.shift()!.reject(closed);
    this.#wake?.();
    this.#wake = null;
    await this.#loop;
  }

  async #run(): Promise<void> {
    try {
      while (this.#accepting || this.#queue.length > 0 || this.#pending.length > 0) {
        if (this.#queue.length > 0) {
          const persistenceCapability = this.#queue.shift()!;
          this.#spaceWaiters.shift()?.resolve();
          this.#pending.push(persistenceCapability);
        } else if (this.#accepting && !this.#forceFlush) {
          await this.#wait(Math.max(0, this.#flushEveryMs - (performance.now() - this.#lastFlush)));
        }
        if (this.#pending.length >= this.#flushEveryItems || this.#forceFlush || performance.now() - this.#lastFlush >= this.#flushEveryMs || (!this.#accepting && this.#queue.length === 0)) {
          await this.#flushPending();
          this.#lastFlush = performance.now();
          this.#forceFlush = false;
          this.#resolveWaiters();
        }
      }
      await this.#flushPending();
      this.#resolveWaiters();
    } catch (error) {
      this.#failure = error;
      this.#accepting = false;
      while (this.#waiters.length > 0) this.#waiters.shift()!.reject(error);
      while (this.#spaceWaiters.length > 0) this.#spaceWaiters.shift()!.reject(error);
      throw error;
    } finally {
      this.#done = true;
    }
  }

  async #flushPending(): Promise<void> {
    if (this.#pending.length === 0) return;
    const batch = this.#pending.splice(0, this.#pending.length);
    await this.#checkpoint._flushOutcomeBatch(this.#runId, this.#writerCapability, batch, this.#writerId);
  }

  #wait(timeoutMs: number): Promise<void> {
    if (!this.#accepting || this.#queue.length > 0 || this.#forceFlush) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#wake = null;
        resolve();
      }, timeoutMs);
      this.#wake = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  #resolveWaiters(): void {
    while (this.#waiters.length > 0) this.#waiters.shift()!.resolve();
  }
}

/** Signal hooks only notify the coordinator; the coordinator closes the writer after workers quiesce. */
export function installCheckpointSignalHooks(requestStopAdmission: () => void, hooks: SignalHookPort): () => void {
  const handler = (): void => requestStopAdmission();
  hooks.on("SIGTERM", handler);
  hooks.on("SIGINT", handler);
  return () => {
    hooks.off?.("SIGTERM", handler);
    hooks.off?.("SIGINT", handler);
  };
}

export function createCheckpointStore(
  durable: SQLiteDurableStore,
  canonical: CanonicalSource,
  probeCaller: object,
  promotionAuthority: ReadyPromotionAuthorityGuardPort,
  attestationAuthority: AttestationValidationAuthorityV1,
  sixStepArtifacts: CheckpointSixStepArtifactPortV1,
  candidatePartitionBootstrap?: CandidatePartitionBootstrapV1,
): CheckpointStore {
  return new CheckpointStore(durable, canonical, probeCaller, promotionAuthority, attestationAuthority, sixStepArtifacts, candidatePartitionBootstrap);
}
