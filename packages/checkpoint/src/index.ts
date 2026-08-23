import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
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
  validateIdentityIssuerProof,
  attestationPartialIdentitySemanticHash,
  validateRejectionEvidenceBundle,
  type AttestationOutcomeCapabilityV1,
  type AttestationValidationAuthorityV1,
  type AttestationPartitionCapabilityV1,
  type AttestationWriterCapabilityV1,
  type AttestationPersistenceCapabilityV1,
  type AttestationPersistenceBatchClaimV1,
  type AttestationPersistedOutcomeV1,
  type AttestationIdentityResumeCapabilityV1,
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
import { assertAttestationValidationAuthority as assertIssuedAttestationValidationAuthority } from "../../attestation/src/internal/validation-authority-verifier.ts";
import { rehydrateIdentityResumeCapabilityForCheckpoint } from "../../attestation/src/internal/validation-authority-rehydrator.ts";
import {
  candidatePartitionProofPayloadHash,
  candidatePartitionBindingFromProof,
  candidatePartitionKeysRoot,
  decodeCandidatePartitionProofBytes,
  makeCandidatePartitionProofPayload,
  validateCandidatePartitionProof,
  type CandidatePartitionBindingV1,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionProofIssuerPortV1,
  type CandidatePartitionProofV1,
  type CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import { assertIssuedCandidatePartitionProofIssuer } from "../../../specs/candidate-partition-authority/src/internal/issuer-consumer.ts";
import {
  CandidatePartitionCapabilityRegistryV1,
  consumeCandidatePartitionBootstrap,
  createCandidatePartitionBootstrap,
  type CandidatePartitionBootstrapV1,
} from "./candidate-partition.ts";
import {
  validateInstanceCatalog,
  validateInstancePublication,
  type InstanceCatalogV1,
  type InstancePublicationV1,
} from "../../catalog/src/index.ts";
import { candidatePartitionRoot, validateSourceCoverageCertificate, type CandidateRecordV1, type SourceCoverageCertificateV1 } from "../../discovery/src/index.ts";
import {
  buildPersistedGraph,
  type ActiveReadyAuthorityBindingV1,
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

const CHECKPOINT_ROOT_KIND = "aloha/checkpoint-root/v2";
const RUN_KIND = "aloha/in-progress-run/v2";
const CANDIDATE_KIND = "aloha/candidate-record/v1";
const CANDIDATE_PARTITION_COMMITMENT_KIND = "aloha/candidate-partition-commitment/v1";
const CANDIDATE_PARTITION_PROOF_KIND = "aloha/candidate-partition-proof/v1";
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
const VERIFIED_MEMO_SET_KIND = "aloha/verified-memo-set/v1";
const INSTANCE_CATALOG_KIND = "aloha/instance-catalog/v1";
const GRAPH_KIND = "aloha/persisted-graph/v1";
const READY_CLOSURE_KIND = "aloha/ready-closure/v1";
const READY_STAGE_KIND = "aloha/ready-stage/v1";
const DIAGNOSTIC_KIND = "aloha/checkpoint-diagnostic/v1";
const PROBE_RECEIPT_KIND = "aloha/probe-transition-receipt/v1";
const PARTITION_PAGE_SIZE = 128;
const EMPTY_MEMO_SEED_LINEAGE_ROOT = hashDomain("aloha/memo-seed-lineage-empty/v1", {});

type DurableContentReader = (hash: Hash) => DurableContentRecord | null;

const ROOT_FIELDS = ["revision", "verifiedMemoRoot", "inProgressRunId", "stagedReadyStorageHash", "latestMemoSeedReceiptHash", "memoSeedSequence", "memoSeedLineageRoot", "latestProbeReceiptHash", "probeReceiptSequence", "probeReceiptLineageRoot", "readyGenerationId", "readyGenerationRecordHash", "schemaHash"] as const;
const RUN_FIELDS = ["runId", "parentGenerationId", "checkpointRevision", "candidatePartitionRevision", "cutoff", "recentObservationRoot", "recentObservationStorageHash", "definitionCatalogRoot", "sourceCoverageRoot", "sourceCoverageStorageHash", "candidatePartitionRoot", "candidatePartitionStorageHash", "candidatePartitionProofStorageHash", "candidateRecordCount", "outcomePartitionRoot", "outcomePartitionStorageHash", "partialOutcomePartitionStorageHash", "attestationPartitionStorageHash", "verifiedMemoSetRoot", "verifiedMemoSetStorageHash", "accounting"] as const;
const PARTITION_MANIFEST_FIELDS = ["runId", "partitionKind", "count", "pageStorageHashes"] as const;
const PARTITION_PAGE_FIELDS = ["runId", "partitionKind", "pageIndex", "entries"] as const;
const VERIFIED_MEMO_SET_FIELDS = ["memos", "retainedRawLocatorHashes", "verifiedMemoSetRoot"] as const;
const CANDIDATE_PARTITION_COMMITMENT_FIELDS = ["readyRecordHash", "runId", "cutoff", "candidatePartitionRoot", "candidatePartitionStorageHash", "candidateRecordCount", "candidateKeysRoot", "recentObservationRoot", "sourceCoverageRoot", "checkpointRevision", "candidatePartitionProofStorageHash", "exactOutcomePartitionRoot", "sealedRevision", "stageRevision", "stageRecordHash", "readyBaseHash"] as const;
const READY_CLOSURE_FIELDS = ["ready", "candidatePartitionStorageHash", "candidateRecordCount", "candidateKeysRoot", "recentObservationRoot", "sourceCoverageRoot", "candidatePartitionRevision", "sourceCoverageStorageHash", "candidatePartitionCommitmentStorageHash", "candidatePartitionProofStorageHash", "verifiedMemoSetStorageHash", "instanceCatalogStorageHash", "graphStorageHash"] as const;
const READY_STAGE_FIELDS = ["stageRevision", "stageRecordHash", "expectedRevision", "runId", "readyBase", "readyBaseHash", "sourceCoverageStorageHash", "verifiedMemoSetStorageHash", "instanceCatalogStorageHash", "graphStorageHash", "sealedRevision"] as const;
const MEMO_SEED_RECEIPT_FIELDS = ["runId", "cutoff", "reason", "sealedRevision", "definitionCatalogRoot", "checkpointSchemaHash", "candidatePartitionRoot", "sourceCoverageRoot", "exactOutcomePartitionRoot", "verifiedMemoRoot", "canonicalJournalEpoch", "canonicalJournalRoot", "sequence", "priorReceiptHash", "priorLineageRoot", "receiptLineageRoot"] as const;

export const CHECKPOINT_SCHEMA_MANIFEST = deepFreeze({
  id: "aloha.checkpoint-durable-closure",
  version: "12.0.0",
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
    { kind: RUN_KIND, fields: RUN_FIELDS, codecAuthority: "checkpoint.decodeRun", referenceContract: "exact run closure" },
    { kind: CANDIDATE_KIND, fields: ["familyId", "familyDefinitionHash", "instanceNominationKey", "candidateSnapshotHash", "familyCandidateKey", "evidence"], codecAuthority: "discovery.CandidateRecordV1", referenceContract: "all and only raw locator physical envelopes named by evidence" },
    { kind: CANDIDATE_PARTITION_COMMITMENT_KIND, fields: CANDIDATE_PARTITION_COMMITMENT_FIELDS, codecAuthority: "checkpoint.decodeCandidatePartitionCommitment", referenceContract: "exact signed candidate partition proof + candidate manifest/record closure" },
    { kind: CANDIDATE_PARTITION_PROOF_KIND, codecAuthority: "candidate-partition-authority.decodeCandidatePartitionProofV1", referenceContract: "exact signed candidate partition proof for the active run" },
    { kind: OUTCOME_KIND, variants: {
      verified: ["kind", "runCandidateKey", "familyCandidateKey", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "instanceKey", "publication", "identityProof", "outcomeIssuerProof"],
      chainProvenRejected: ["kind", "runCandidateKey", "familyCandidateKey", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "proof", "rejectionEvidence", "identityProof", "outcomeIssuerProof"],
      retryable: ["kind", "runCandidateKey", "familyCandidateKey", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "failure", "identityProof", "outcomeIssuerProof"],
      invalidProgram: ["kind", "runCandidateKey", "familyCandidateKey", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "failure", "identityProof", "outcomeIssuerProof"],
    }, codecAuthority: "attestation.validateCandidateFinalOutcome", referenceContract: "chainProvenRejected: exactly one rejection evidence bundle; all other variants: no physical references", semanticHashDomain: "aloha/candidate-final-outcome/v1" },
    { kind: PARTIAL_OUTCOME_KIND, fields: ["runId", "candidatePartitionRoot", "familyCandidateKey", "outcomeHash", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "kind", "identity", "outcome"], codecAuthority: "attestation.AttestationPersistedOutcomeV1", referenceContract: "exact partial identity event; no physical references" },
    { kind: REJECTION_BUNDLE_KIND, fields: ["kind", "version", "issuerId", "runId", "chainId", "cutoffNumber", "cutoffHash", "cutoffStateRoot", "stage", "familyDefinitionHash", "familyCandidateKey", "candidateSnapshotHash", "identitySubjectHash", "instanceNominationKey", "executorAuthorityRoot", "workerEpoch", "executorSessionHash", "executionSessionHash", "request", "transportFacts", "effectObservations", "decisionCode", "decisionBytesHex", "requestFingerprint", "orderedTransportFactsRoot", "effectObservationRoot", "decisionBytesHash", "evidenceBundleRoot"], codecAuthority: "attestation.validateRejectionEvidenceBundle", referenceContract: "exactly one request raw + ordered transport raw + ordered effect raw + one decision raw; no extras" },
    { kind: REJECTION_REQUEST_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.request.canonicalBytesHex", referenceContract: "none" },
    { kind: REJECTION_TRANSPORT_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.transportFacts[*].canonicalBytesHex", referenceContract: "none" },
    { kind: REJECTION_EFFECT_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.effectObservations[*].canonicalBytesHex", referenceContract: "none" },
    { kind: REJECTION_DECISION_RAW_KIND, wire: "opaque-bytes", codecAuthority: "attestation RejectionEvidenceBundle.decisionBytesHex", referenceContract: "none" },
    { kind: ATTESTATION_PARTITION_KIND, fields: ["runId", "cutoff", "candidatePartitionRoot", "outcomes", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "accounting", "exactOutcomePartitionRoot"], codecAuthority: "attestation.validateAttestationPartition", referenceContract: "exact outcome partition manifest" },
    { kind: RAW_EVIDENCE_LOCATOR_KIND, wire: "opaque-bytes", codecAuthority: "sha256(raw locator bytes)", referenceContract: "none" },
    { kind: PARTITION_PAGE_KIND, fields: PARTITION_PAGE_FIELDS, codecAuthority: "checkpoint.loadPartition", referenceContract: "exact ordered entry storage envelopes" },
    { kind: PARTITION_MANIFEST_KIND, fields: PARTITION_MANIFEST_FIELDS, codecAuthority: "checkpoint.loadPartition", referenceContract: "exact ordered page storage envelopes" },
    { kind: RECENT_OBSERVATION_KIND, fields: ["cutoff", "range", "orderedHeaders", "evidence", "observationRoot"], codecAuthority: "observation.validateRecentObservationReceipt", referenceContract: "all and only raw locator physical envelopes named by observation evidence" },
    { kind: SOURCE_COVERAGE_KIND, fields: ["cutoff", "entries", "sourceCoverageRoot"], codecAuthority: "discovery.validateSourceCoverageCertificate", referenceContract: "none" },
    { kind: VERIFIED_MEMO_SET_KIND, fields: VERIFIED_MEMO_SET_FIELDS, codecAuthority: "checkpoint.decodeMemoSet+catalog.validateInstancePublication", referenceContract: "all and only raw locator physical envelopes retained by exact verified publications", semanticHashDomain: "aloha/verified-memo-set/v2" },
    { kind: INSTANCE_CATALOG_KIND, fields: ["cutoff", "publications", "instanceCount", "instanceCatalogRoot"], codecAuthority: "catalog.validateInstanceCatalog", referenceContract: "none" },
    { kind: GRAPH_KIND, fields: ["cutoff", "instanceCatalogRoot", "edges", "edgeCount", "graphRoot"], codecAuthority: "graph.buildPersistedGraph", referenceContract: "none", semanticHashDomain: "aloha/persisted-graph/v1" },
    { kind: READY_CLOSURE_KIND, fields: READY_CLOSURE_FIELDS, codecAuthority: "checkpoint.decodeReadyClosure", referenceContract: "exact source coverage + candidate manifest/records + candidate partition commitment + candidate partition proof + verified memo + instance catalog + graph", semanticHashDomain: "aloha/ready-generation/v1" },
    { kind: READY_STAGE_KIND, fields: READY_STAGE_FIELDS, codecAuthority: "checkpoint.decodeReadyStage", referenceContract: "exact source coverage + verified memo + instance catalog + graph; staged is never a serving authority", semanticHashDomain: "aloha/ready-stage/v1" },
    { kind: DIAGNOSTIC_KIND, fields: MEMO_SEED_RECEIPT_FIELDS, codecAuthority: "checkpoint.decodeMemoSeedReceipt", referenceContract: "exact prior memo-seed receipt when sequence is greater than one" },
    { kind: PROBE_RECEIPT_KIND, codecAuthority: "attestation.validateProbeReceipt", referenceContract: "exact prior probe receipt when sequence is greater than one", semanticHashDomain: "aloha/single-instance-probe-receipt/v2" },
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

interface StoredRunEnvelopeV2 {
  readonly runId: string;
  readonly parentGenerationId: string | null;
  readonly checkpointRevision: string;
  /** Immutable revision at which the signed candidate partition was created. */
  readonly candidatePartitionRevision: string;
  readonly cutoff: CandidateRecordV1 extends never ? never : BeginRunInputV1["cutoff"];
  readonly recentObservationRoot: Hash;
  readonly recentObservationStorageHash: Hash;
  readonly definitionCatalogRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  readonly sourceCoverageStorageHash: Hash;
  readonly candidatePartitionRoot: Hash;
  readonly candidatePartitionStorageHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly candidateRecordCount: string;
  readonly outcomePartitionRoot: Hash;
  readonly outcomePartitionStorageHash: Hash;
  readonly partialOutcomePartitionStorageHash: Hash | null;
  readonly attestationPartitionStorageHash: Hash | null;
  readonly verifiedMemoSetRoot: Hash;
  readonly verifiedMemoSetStorageHash: Hash;
  readonly accounting: RunAccountingV1;
}

/** Internal hydration view; raw candidates never cross the checkpoint port. */
type InternalBuilderRunV1 = InProgressBuilderRunV1 & {
  readonly candidates: readonly CandidateRecordV1[];
};

interface RetryableProbeCapabilityStateV1 {
  readonly runId: string;
  readonly familyCandidateKey: Hash;
  readonly expectedOutcomeHash: Hash;
  readonly checkpointRevision: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidatePartitionBinding: CandidatePartitionBindingV1;
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  used: boolean;
}

function publicBuilderRun(run: InternalBuilderRunV1): InProgressBuilderRunV1 {
  return deepFreeze({
    runId: run.runId,
    parentGenerationId: run.parentGenerationId,
    checkpointRevision: run.checkpointRevision,
    cutoff: run.cutoff,
    recentObservation: run.recentObservation,
    definitionCatalogRoot: run.definitionCatalogRoot,
    sourceCoverage: run.sourceCoverage,
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
  readonly candidateRecordCount: string;
  readonly candidateKeysRoot: Hash;
  readonly recentObservationRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  /** The proof's checkpointRevision (equal to the immutable candidatePartitionRevision). */
  readonly candidatePartitionRevision: string;
  readonly sourceCoverageStorageHash: Hash;
  readonly candidatePartitionCommitmentStorageHash: Hash;
  readonly candidatePartitionProofStorageHash: Hash;
  readonly verifiedMemoSetStorageHash: Hash;
  readonly instanceCatalogStorageHash: Hash;
  readonly graphStorageHash: Hash;
}

interface ReadyStageV1 {
  readonly stageRevision: string;
  readonly stageRecordHash: Hash;
  readonly expectedRevision: string;
  readonly runId: string;
  readonly readyBase: ReadyGenerationBaseV1;
  readonly readyBaseHash: Hash;
  readonly sourceCoverageStorageHash: Hash;
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
  readonly candidateRecordCount: string;
  readonly candidateKeysRoot: Hash;
  readonly recentObservationRoot: Hash;
  readonly sourceCoverageRoot: Hash;
  /** The immutable candidate partition revision, named checkpointRevision in the signed proof. */
  readonly checkpointRevision: string;
  readonly candidatePartitionProofStorageHash: Hash;
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

export interface OutcomeWriterOptions {
  readonly writerCapability: AttestationWriterCapabilityV1;
  readonly writerId?: string;
  readonly flushEveryItems?: number;
  readonly flushEveryMs?: number;
  readonly mailboxCapacity?: number;
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
    assertExactKeys(raw, ["rawLocatorHash", "bytes"], `rawEvidenceLocators[${index}]`);
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

function sameCutoff(left: BeginRunInputV1["cutoff"], right: BeginRunInputV1["cutoff"]): boolean {
  return left.chainId === right.chainId && left.number === right.number
    && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function emptyMemoSet(): VerifiedMemoSetV1 {
  const memos: readonly InstancePublicationV1[] = deepFreeze([]);
  const retainedRawLocatorHashes: readonly Hash[] = deepFreeze([]);
  return deepFreeze({
    memos,
    retainedRawLocatorHashes,
    verifiedMemoSetRoot: hashDomain("aloha/verified-memo-set/v2", { memos, retainedRawLocatorHashes }),
  });
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
    candidatePartitionRoot: assertHash(value.candidatePartitionRoot, "storedRun.candidatePartitionRoot"),
    candidatePartitionStorageHash: assertHash(value.candidatePartitionStorageHash, "storedRun.candidatePartitionStorageHash"),
    candidatePartitionProofStorageHash: assertHash(value.candidatePartitionProofStorageHash, "storedRun.candidatePartitionProofStorageHash"),
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
  const raw = exactObject(value, ["kind", "familyInstanceKey", "identityMemoHash", "descriptorHash", "evidenceRoot", "issuerProof"], context);
  if (raw.kind !== "identityVerified") throw new CorruptDurableStoreError(`${context}.kind is invalid`);
  return deepFreeze({
    kind: "identityVerified" as const,
    familyInstanceKey: assertNonEmptyString(raw.familyInstanceKey, `${context}.familyInstanceKey`),
    identityMemoHash: assertHash(raw.identityMemoHash, `${context}.identityMemoHash`),
    descriptorHash: assertHash(raw.descriptorHash, `${context}.descriptorHash`),
    evidenceRoot: assertHash(raw.evidenceRoot, `${context}.evidenceRoot`),
    issuerProof: validateIdentityIssuerProof(raw.issuerProof),
  });
}

function decodePartialOutcome(bytes: Uint8Array, context: string): AttestationPersistedOutcomeV1 {
  const raw = exactObject(
    decodeCanonicalJson(bytes),
    ["runId", "candidatePartitionRoot", "familyCandidateKey", "outcomeHash", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "kind", "identity", "outcome"],
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
    attestationAuthorityRoot: assertHash(raw.attestationAuthorityRoot, `${context}.attestationAuthorityRoot`),
    releaseAuthorityRoot: assertHash(raw.releaseAuthorityRoot, `${context}.releaseAuthorityRoot`),
    releaseProvenanceHash: assertHash(raw.releaseProvenanceHash, `${context}.releaseProvenanceHash`),
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

function verifiedMemoSet(value: readonly InstancePublicationV1[], locatorHashes: readonly Hash[]): VerifiedMemoSetV1 {
  const memos = cloneCanonical<readonly InstancePublicationV1[]>([...value]);
  for (const memo of memos) validateInstancePublication(memo);
  const retainedRawLocatorHashes = deepFreeze([...new Set(locatorHashes.map((hash, index) =>
    assertHash(hash, `verifiedMemoSet.retainedRawLocatorHashes[${index}]`)))].sort(compareText));
  return deepFreeze({
    memos,
    retainedRawLocatorHashes,
    verifiedMemoSetRoot: hashDomain("aloha/verified-memo-set/v2", { memos, retainedRawLocatorHashes }),
  });
}

function decodeMemoSet(bytes: Uint8Array): VerifiedMemoSetV1 {
  const value = exactObject(decodeCanonicalJson(bytes), VERIFIED_MEMO_SET_FIELDS, "verifiedMemoSet");
  if (!Array.isArray(value.memos)) throw new CorruptDurableStoreError("verified memo set is not an array");
  if (!Array.isArray(value.retainedRawLocatorHashes)) throw new CorruptDurableStoreError("verified memo locator set is not an array");
  const memo = verifiedMemoSet(
    cloneCanonical<readonly InstancePublicationV1[]>(value.memos),
    value.retainedRawLocatorHashes as Hash[],
  );
  if (memo.verifiedMemoSetRoot !== value.verifiedMemoSetRoot) throw new CorruptDurableStoreError("verified memo root mismatch");
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
    candidateRecordCount: decimal(value.candidateRecordCount, "candidatePartitionCommitment.candidateRecordCount"),
    candidateKeysRoot: assertHash(value.candidateKeysRoot, "candidatePartitionCommitment.candidateKeysRoot"),
    recentObservationRoot: assertHash(value.recentObservationRoot, "candidatePartitionCommitment.recentObservationRoot"),
    sourceCoverageRoot: assertHash(value.sourceCoverageRoot, "candidatePartitionCommitment.sourceCoverageRoot"),
    checkpointRevision: decimal(value.checkpointRevision, "candidatePartitionCommitment.checkpointRevision"),
    candidatePartitionProofStorageHash: assertHash(value.candidatePartitionProofStorageHash, "candidatePartitionCommitment.candidatePartitionProofStorageHash"),
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
    candidateRecordCount: decimal(value.candidateRecordCount, "readyClosure.candidateRecordCount"),
    candidateKeysRoot: assertHash(value.candidateKeysRoot, "readyClosure.candidateKeysRoot"),
    recentObservationRoot: assertHash(value.recentObservationRoot, "readyClosure.recentObservationRoot"),
    sourceCoverageRoot: assertHash(value.sourceCoverageRoot, "readyClosure.sourceCoverageRoot"),
    candidatePartitionRevision: decimal(value.candidatePartitionRevision, "readyClosure.candidatePartitionRevision"),
    sourceCoverageStorageHash: assertHash(value.sourceCoverageStorageHash, "readyClosure.sourceCoverageStorageHash"),
    candidatePartitionCommitmentStorageHash: assertHash(value.candidatePartitionCommitmentStorageHash, "readyClosure.candidatePartitionCommitmentStorageHash"),
    candidatePartitionProofStorageHash: assertHash(value.candidatePartitionProofStorageHash, "readyClosure.candidatePartitionProofStorageHash"),
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
  decodeMemoSet,
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
  readonly #candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly #candidatePartitionCapabilities: CandidatePartitionCapabilityRegistryV1;
  readonly #candidatePartitionReader: CandidatePartitionReaderPortV1;
  readonly #validatedRunStorageHashes = new Set<Hash>();
  readonly #validatedReadyClosureStorageHashes = new Set<Hash>();
  /** One durable partial can mint at most one process-local resume handle. */
  readonly #issuedResumeClaims = new Set<string>();
  readonly #probeStates = new WeakMap<object, RetryableProbeCapabilityStateV1>();
  readonly #issuedProbeClaims = new Set<string>();
  readonly #sealedRuns = new SealedRunCapabilityRegistryV1();

  constructor(
    durable: SQLiteDurableStore,
    canonical: CanonicalSource,
    probeCaller: object,
    promotionAuthority: ReadyPromotionAuthorityGuardPort,
    attestationAuthority: AttestationValidationAuthorityV1,
    candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1,
    candidatePartitionBootstrap: CandidatePartitionBootstrapV1 = createCandidatePartitionBootstrap(),
  ) {
    durable.bindStoreRole("checkpoint");
    this.#durable = durable;
    this.#canonical = canonical;
    this.#probeCaller = probeCaller;
    try {
      this.#candidatePartitionProofIssuer = assertIssuedCandidatePartitionProofIssuer(candidatePartitionProofIssuer);
    } catch (error) {
      throw new CheckpointError("candidate-partition-proof-issuer-invalid", error instanceof Error ? error.message : "candidate partition proof issuer is required");
    }
    this.#candidatePartitionCapabilities = consumeCandidatePartitionBootstrap(candidatePartitionBootstrap);
    this.#candidatePartitionReader = this.#candidatePartitionCapabilities.reader;
    this.#promotionAuthority = assertIssuedReadyPromotionAuthorityPort(promotionAuthority);
    try {
      this.#attestationAuthority = assertIssuedAttestationValidationAuthority(attestationAuthority);
    } catch (error) {
      throw new CheckpointError(
        "attestation-authority-invalid",
        error instanceof Error ? error.message : "attestation validation authority is not issued",
      );
    }
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

  /**
   * Checkpoint's public authority methods own their release fence.  The
   * bootstrap facade is only an outer convenience guard; it must not be the
   * sole protection against a release rotation during an async read.
   */
  #captureReleaseFence(): ReturnType<CandidatePartitionProofIssuerPortV1["currentRelease"]> {
    return deepFreeze({ ...this.#candidatePartitionProofIssuer.currentRelease() });
  }

  #assertReleaseFenceUnchanged(
    before: ReturnType<CandidatePartitionProofIssuerPortV1["currentRelease"]>,
  ): void {
    const after = this.#candidatePartitionProofIssuer.currentRelease();
    if (encodeCanonicalJson(after) !== encodeCanonicalJson(before)) {
      throw new CheckpointRunStateError("checkpoint release rotated during public authority read");
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

  /**
   * Rehydrates process-local identity resume capabilities from the exact
   * active-run partial records. The returned objects contain no durable data
   * and are accepted only by the attestation authority that issued them.
   */
  async loadIdentityResumeCapabilities(runId: string): Promise<readonly AttestationIdentityResumeCapabilityV1[]> {
    const loaded = this.#loadActiveRun(runId);
    const partials = this.#loadPartialOutcomesStore(loaded.envelope);
    const candidates = new Map(loaded.builderRun.candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
    const claimedKeys: string[] = [];
    const capabilities = partials.map(partial => {
      if (partial.identity === null) throw new CorruptDurableStoreError("partial identity is missing its identity record");
      const candidate = candidates.get(partial.familyCandidateKey);
      if (!candidate) throw new CorruptDurableStoreError("partial identity candidate is absent");
      const proofHash = partial.identity.issuerProof.proofHash;
      const claimKey = `${loaded.envelope.runId}:${partial.familyCandidateKey}:${proofHash}`;
      if (this.#issuedResumeClaims.has(claimKey)) {
        throw new CheckpointRunStateError("durable partial resume capability already claimed");
      }
      const capability = rehydrateIdentityResumeCapabilityForCheckpoint(this.#attestationAuthority, {
        runId: loaded.envelope.runId,
        cutoff: loaded.envelope.cutoff,
        candidatePartition: loaded.builderRun.candidatePartition,
        candidatePartitionReader: this.#candidatePartitionReader,
        familyCandidateKey: partial.familyCandidateKey,
        identity: partial.identity,
        outcomeHash: partial.outcomeHash,
        attestationAuthorityRoot: partial.attestationAuthorityRoot,
        releaseAuthorityRoot: partial.releaseAuthorityRoot,
        releaseProvenanceHash: partial.releaseProvenanceHash,
        executorAuthorityRoot: partial.executorAuthorityRoot,
      });
      claimedKeys.push(claimKey);
      return capability;
    });
    for (const claimKey of claimedKeys) this.#issuedResumeClaims.add(claimKey);
    return deepFreeze(capabilities);
  }

  /**
   * Rehydrates a durable stage after a crash.  It does not issue freshness or
   * serving authority; the caller must feed the returned sealed run back into
   * the promotion service, which will only perform the minimal activation CAS
   * after a new provider observation.
   */
  async loadStagedPromotion(): Promise<{ readonly sealedRun: SealedRunCapabilityV1; readonly sealedRunBinding: import("../../sealed-run-runtime/src/contract.ts").SealedRunBindingV1; readonly instanceCatalog: InstanceCatalogV1; readonly stage: ReadyStageIdentityV1 } | null> {
    const record = this.#durable.readRoot();
    if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
    const root = rootFromRecord(record);
    this.#validateRootReferenceSet(record, root);
    if (root.stagedReadyStorageHash === null) return null;
    if (root.inProgressRunId === null) throw new CorruptDurableStoreError("staged ready has no active run");
    const stage = this.#findReadyStageRecord(record.references, root.stagedReadyStorageHash);
    const loaded = this.#loadActiveRunRead(record, root, stage.runId);
    if (!loaded.envelope.attestationPartitionStorageHash) throw new CorruptDurableStoreError("staged run is not sealed");
    const partition = cloneCanonical<AttestationPartitionV1>(decodeCanonicalJson(readContentStore(this.#durable, loaded.envelope.attestationPartitionStorageHash, ATTESTATION_PARTITION_KIND, "staged attestation partition")));
    this.#attestationAuthority.validateDurablePartition(partition, loaded.builderRun.candidates);
    assertPromotablePartition(partition, loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey));
    const instanceCatalog = cloneCanonical<InstanceCatalogV1>(decodeCanonicalJson(readContentStore(this.#durable, stage.instanceCatalogStorageHash, INSTANCE_CATALOG_KIND, "staged instance catalog")));
    validateInstanceCatalog(instanceCatalog);
    const memo = decodeMemoSet(readContentStore(this.#durable, stage.verifiedMemoSetStorageHash, VERIFIED_MEMO_SET_KIND, "staged verified memo set"));
    assertVerifiedPublicationCatalog(memo.memos, instanceCatalog);
    const sealedRunSnapshot = this.#sealedRunSnapshot(loaded.envelope, loaded.builderRun.candidates, partition, loaded.sourceCoverage);
    const sealedRun = this.#issueSealedRun(loaded.envelope.runId);
    if (
      sealedRunSnapshot.checkpointRevision !== stage.expectedRevision
      || sealedRunSnapshot.runId !== stage.runId
      || sealedRunSnapshot.verifiedMemoSetRoot !== stage.readyBase.verifiedMemoSetRoot
      || sealedRunSnapshot.partition.exactOutcomePartitionRoot !== stage.readyBase.exactOutcomePartitionRoot
      || sealedRunSnapshot.releaseProvenanceHash !== stage.readyBase.releaseProvenanceHash
      || sealedRunSnapshot.candidatePartitionProofStorageHash !== stage.readyBase.candidatePartitionProofStorageHash
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
    validateRecentObservationReceipt(input.recentObservation, this.#canonical.recentObservationRange(cutoff));
    if (!sameCutoff(input.recentObservation.cutoff, cutoff)) throw new CheckpointRunStateError("observation cutoff mismatch");
    const computedCandidatePartitionRoot = candidatePartitionRoot(input.candidates);
    const rawLocators = rawEvidenceLocatorContents(input.rawEvidenceLocators);
    const expectedLocatorHashes = deepFreeze([
      ...new Set(input.recentObservation.evidence.map(value => value.rawLocatorHash)),
    ].sort(compareText));
    if (
      rawLocators.length !== expectedLocatorHashes.length
      || rawLocators.some((value, index) => value.rawLocatorHash !== expectedLocatorHashes[index])
    ) throw new CheckpointRunStateError("raw evidence locator partition mismatch");
    const recentEvidence = new Set(input.recentObservation.evidence.map(value => encodeCanonicalJson(value)));
    for (const candidate of input.candidates) {
      for (const evidence of candidate.evidence) {
        if (!recentEvidence.has(encodeCanonicalJson(evidence))) {
          throw new CheckpointRunStateError("candidate evidence is not in the sealed recent observation");
        }
      }
    }
    const runId = randomUUID();
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
        const rawStorageHashes = expectedLocatorHashes.map(hash => rawStorageBySemanticHash.get(hash)!);
        const recentStorageHash = tx.putImmutable(
          RECENT_OBSERVATION_KIND,
          encodeCanonicalBytes(input.recentObservation),
          rawStorageHashes,
        );
        const coverageStorageHash = tx.putImmutable(SOURCE_COVERAGE_KIND, encodeCanonicalBytes(input.sourceCoverage));
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
        const outcomeManifestHash = putPartition(tx, runId, "outcome", []);
        const memoStorageHash = this.#findMemoStorageHash(tx, currentRecord.references, root.verifiedMemoRoot);
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const release = this.#candidatePartitionProofIssuer.currentRelease();
        const releaseProvenanceHash = release.releaseProvenanceHash;
        const proofPayload = makeCandidatePartitionProofPayload({
          runId,
          cutoff,
          candidatePartitionRoot: computedCandidatePartitionRoot,
          candidatePartitionStorageHash: candidateManifestHash,
          candidates: input.candidates,
          recentObservationRoot: input.recentObservation.observationRoot,
          sourceCoverageRoot: input.sourceCoverage.sourceCoverageRoot,
          checkpointRevision: nextRevision,
          releaseProvenanceHash,
          issuerKeyId: release.candidatePartitionProofIssuerKeyId,
        });
        if (candidatePartitionProofPayloadHash(proofPayload) === `0x${"0".repeat(64)}`) {
          throw new CheckpointRunStateError("candidate partition proof payload is empty");
        }
        const issuedProof = this.#candidatePartitionProofIssuer.issue(proofPayload);
        const proof = this.#candidatePartitionProofIssuer.verify(issuedProof, {
          binding: candidatePartitionBindingFromProof(issuedProof),
          release,
        });
        const proofStorageHash = tx.putImmutable(
          CANDIDATE_PARTITION_PROOF_KIND,
          encodeCanonicalBytes(proof),
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
          candidatePartitionRoot: computedCandidatePartitionRoot,
          candidatePartitionStorageHash: candidateManifestHash,
          candidatePartitionProofStorageHash: proofStorageHash,
          candidateRecordCount: String(input.candidates.length),
          outcomePartitionRoot: outcomePartitionRoot(runId, []),
          outcomePartitionStorageHash: outcomeManifestHash,
          partialOutcomePartitionStorageHash: null,
          attestationPartitionStorageHash: null,
          verifiedMemoSetRoot: root.verifiedMemoRoot,
          verifiedMemoSetStorageHash: memoStorageHash,
          accounting: outcomeAccounting(input.candidates.length, []),
        });
        const runStorageHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(run), [recentStorageHash, coverageStorageHash, candidateManifestHash, proofStorageHash, outcomeManifestHash, memoStorageHash]);
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
    try {
      return this.#durable.transaction(lease, tx => {
        const currentRecord = tx.readRoot();
        if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(currentRecord);
        const loaded = this.#loadActiveRunTx(tx, currentRecord, root, runId);
        if (loaded.envelope.attestationPartitionStorageHash !== null) {
          throw new CheckpointRunStateError("run is already sealed");
        }
        this.#attestationAuthority.validatePartitionCapability(partition, loaded.builderRun.candidates);
        assertPromotablePartition(partition, loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey));
        const persisted = this.#loadOutcomes(tx, loaded.envelope);
        if (loaded.envelope.partialOutcomePartitionStorageHash !== null || tx.listIndex(`partial-outcome/${runId}`).length !== 0) {
          throw new CheckpointRunStateError("cannot seal while partial identity outcomes remain");
        }
        const persistedHashes = persisted.map(candidateFinalOutcomeHash).sort(compareText);
        const partitionHashes = partition.outcomes.map(candidateFinalOutcomeHash).sort(compareText);
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
        const retainedRawStorageHashes = memoSet.retainedRawLocatorHashes.map(hash => {
          const storageHash = rawStorageBySemanticHash.get(hash);
          if (!storageHash) throw new CorruptDurableStoreError("verified memo raw locator is absent");
          return storageHash;
        });
        const memoStorageHash = tx.putImmutable(
          VERIFIED_MEMO_SET_KIND,
          encodeCanonicalBytes(memoSet),
          retainedRawStorageHashes,
        );
        const partitionStorageHash = tx.putImmutable(ATTESTATION_PARTITION_KIND, encodeCanonicalBytes(partition), [loaded.envelope.outcomePartitionStorageHash]);
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        const nextRun: StoredRunEnvelopeV2 = deepFreeze({
          ...loaded.envelope,
          checkpointRevision: nextRevision,
          attestationPartitionStorageHash: partitionStorageHash,
          verifiedMemoSetRoot: memoSet.verifiedMemoSetRoot,
          verifiedMemoSetStorageHash: memoStorageHash,
        });
        const nextRunHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(nextRun), [
          nextRun.recentObservationStorageHash,
          nextRun.sourceCoverageStorageHash,
          nextRun.candidatePartitionStorageHash,
          nextRun.candidatePartitionProofStorageHash,
          nextRun.outcomePartitionStorageHash,
          ...(nextRun.partialOutcomePartitionStorageHash === null ? [] : [nextRun.partialOutcomePartitionStorageHash]),
          partitionStorageHash,
          memoStorageHash,
        ]);
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
        return this.#issueSealedRun(nextRun.runId);
      });
    } finally {
      this.#durable.releaseWriterLease(lease);
    }
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

  async putContentAndFsync(kind: "instance-catalog" | "persisted-graph", value: object): Promise<Hash> {
    let semanticRoot: Hash;
    let storageKind: string;
    if (kind === "instance-catalog") {
      validateInstanceCatalog(value as InstanceCatalogV1);
      semanticRoot = (value as InstanceCatalogV1).instanceCatalogRoot;
      storageKind = INSTANCE_CATALOG_KIND;
    } else {
      const graph = value as PersistedGraphV1;
      const suppliedRoot = hashDomain("aloha/persisted-graph/v1", { cutoff: graph.cutoff, instanceCatalogRoot: graph.instanceCatalogRoot, edges: graph.edges });
      if (suppliedRoot !== graph.graphRoot || graph.edgeCount !== String(graph.edges.length)) throw new CheckpointError("graph-root-mismatch", "persisted graph is not self-validating");
      semanticRoot = graph.graphRoot;
      storageKind = GRAPH_KIND;
    }
    const owner = `checkpoint-content/${kind}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      this.#durable.transaction(lease, tx => {
        const storageHash = tx.putImmutable(storageKind, encodeCanonicalBytes(value));
        const previous = tx.getIndex(`semantic/${kind}`, semanticRoot);
        if (previous !== null && previous !== storageHash) throw new CorruptDurableStoreError(`${kind} semantic root aliases different bytes`);
        tx.setIndex(`semantic/${kind}`, semanticRoot, storageHash);
      });
      return semanticRoot;
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
        || binding.releaseProvenanceHash !== input.ready.releaseProvenanceHash
        || binding.candidatePartitionProofStorageHash !== input.ready.candidatePartitionProofStorageHash
      ) throw new CheckpointRunStateError("ready promotion authority binding mismatch");
    };
    assertPromotionAuthority();
    this.#canonical.assertActiveFence(input.fence);
    validateInstanceCatalog(input.instanceCatalog);
    validateReadyGenerationBase(input.ready);
    const recomputedGraph = buildPersistedGraph(input.instanceCatalog);
    if (recomputedGraph.graphRoot !== input.graph.graphRoot || encodeCanonicalJson(recomputedGraph) !== encodeCanonicalJson(input.graph)) {
      throw new CheckpointError("graph-closure-mismatch", "ready graph is not derived from the instance catalog");
    }
    const owner = `checkpoint-stage/${input.expectedInProgressRunId}/${randomUUID()}`;
    const lease = this.#durable.acquireWriterLease(owner);
    try {
      return this.#durable.transaction(lease, tx => {
        tx.addBeforeCommitGuard(() => {
          assertPromotionAuthority();
          this.#canonical.assertActiveFence(input.fence);
        });
        assertPromotionAuthority();
        this.#canonical.assertActiveFence(input.fence);
        const currentRecord = tx.readRoot();
        if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
        const root = rootFromRecord(currentRecord);
        if (root.stagedReadyStorageHash !== null) {
          if (root.inProgressRunId !== input.expectedInProgressRunId) throw new CheckpointRunStateError("staged ready run is not active");
          this.#validateRootReferenceSetTx(tx, currentRecord, root, true);
          const existing = this.#findReadyStageRecordWith(tx.readContent.bind(tx), currentRecord.references, root.stagedReadyStorageHash);
          if (
            existing.readyBase.definitionCatalogRoot !== input.ready.definitionCatalogRoot
            || existing.readyBase.generationRefreshPolicyHash !== policyHash
          ) {
            // Only the promotion authority may turn an exact configuration
            // change into abandon authority.  Every other stage mismatch is
            // integrity failure and remains fatal below.
            this.#promotionAuthority.assertConfiguration({
              definitionCatalogRoot: existing.readyBase.definitionCatalogRoot,
              generationRefreshPolicyHash: existing.readyBase.generationRefreshPolicyHash,
              releaseProvenanceHash: existing.readyBase.releaseProvenanceHash,
            });
            throw new ReadyPromotionFatalError("ready-promotion-stage-mismatch");
          }
          if (
            existing.expectedRevision !== input.expectedRevision
            || existing.runId !== input.expectedInProgressRunId
            || existing.readyBaseHash !== readyGenerationBaseHash(input.ready)
            || encodeCanonicalJson(existing.readyBase) !== encodeCanonicalJson(input.ready)
          ) throw new CheckpointRunStateError("staged ready input mismatch");
          return deepFreeze({
            stage: this.#readyStageIdentity(existing, root.stagedReadyStorageHash),
            stageRevision: existing.stageRevision,
            stageRecordHash: existing.stageRecordHash,
          });
        }
        if (root.revision !== input.expectedRevision) throw new CASConflictError(input.expectedRevision, root.revision);
        if (root.inProgressRunId !== input.expectedInProgressRunId) throw new CheckpointRunStateError("ready stage run is not active");
        // Promotion is the expensive closure-validation boundary.  Cache the
        // exact immutable active-ready closure here, before freshness is
        // observed, so activation performs only compact root/stage checks.
        const loaded = this.#loadActiveRunTx(
          tx,
          currentRecord,
          root,
          input.expectedInProgressRunId,
          true,
        );
        if (!loaded.envelope.attestationPartitionStorageHash) throw new CheckpointRunStateError("run is not sealed for promotion");
        const partition = cloneCanonical<AttestationPartitionV1>(decodeCanonicalJson(readContent(tx, loaded.envelope.attestationPartitionStorageHash, ATTESTATION_PARTITION_KIND, "attestation partition")));
        this.#attestationAuthority.validateDurablePartition(partition, loaded.builderRun.candidates);
        assertPromotablePartition(partition, loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey));
        const memo = decodeMemoSet(readContent(tx, loaded.envelope.verifiedMemoSetStorageHash, VERIFIED_MEMO_SET_KIND, "verified memo set"));
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
          || ready.exactOutcomePartitionRoot !== partition.exactOutcomePartitionRoot
          || ready.verifiedMemoSetRoot !== memo.verifiedMemoSetRoot
          || ready.instanceCatalogRoot !== input.instanceCatalog.instanceCatalogRoot
          || ready.graphRoot !== input.graph.graphRoot
          || ready.edgeCount !== input.graph.edgeCount
          || ready.instanceCount !== input.instanceCatalog.instanceCount
          || ready.generationRefreshPolicyHash !== policyHash
        ) throw new CheckpointRunStateError("ready payload does not match the sealed run closure");
        const catalogStorageHash = tx.getIndex("semantic/instance-catalog", input.instanceCatalog.instanceCatalogRoot);
        const graphStorageHash = tx.getIndex("semantic/persisted-graph", input.graph.graphRoot);
        if (!catalogStorageHash || !graphStorageHash) throw new CorruptDurableStoreError("ready content was not fsynced before stage CAS");
        if (encodeCanonicalJson(decodeCanonicalJson(readContent(tx, catalogStorageHash, INSTANCE_CATALOG_KIND, "instance catalog"))) !== encodeCanonicalJson(input.instanceCatalog)) throw new CorruptDurableStoreError("instance catalog bytes mismatch");
        if (encodeCanonicalJson(decodeCanonicalJson(readContent(tx, graphStorageHash, GRAPH_KIND, "graph"))) !== encodeCanonicalJson(input.graph)) throw new CorruptDurableStoreError("graph bytes mismatch");
        const stageRevision = (BigInt(root.revision) + 1n).toString();
        const stageWithoutHash: Omit<ReadyStageV1, "stageRecordHash"> = deepFreeze({
          stageRevision,
          expectedRevision: input.expectedRevision,
          runId: loaded.envelope.runId,
          readyBase: ready,
          readyBaseHash: readyGenerationBaseHash(ready),
          sourceCoverageStorageHash: loaded.envelope.sourceCoverageStorageHash,
          verifiedMemoSetStorageHash: loaded.envelope.verifiedMemoSetStorageHash,
          instanceCatalogStorageHash: catalogStorageHash,
          graphStorageHash,
          sealedRevision: loaded.envelope.checkpointRevision,
        });
        const stage: ReadyStageV1 = deepFreeze({
          ...stageWithoutHash,
          stageRecordHash: hashDomain("aloha/ready-stage/v1", readyStagePayload(stageWithoutHash)),
        });
        const stageStorageHash = tx.putImmutable(READY_STAGE_KIND, encodeCanonicalBytes(stage), [
          stage.sourceCoverageStorageHash,
          stage.verifiedMemoSetStorageHash,
          stage.instanceCatalogStorageHash,
          stage.graphStorageHash,
        ]);
        const nextRoot: CheckpointRootV1 = deepFreeze({
          ...root,
          revision: stageRevision,
          stagedReadyStorageHash: stageStorageHash,
        });
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes(nextRoot),
          this.#rootReferencesFor(
            hash => tx.readContent(hash),
            [...currentRecord.references, stageStorageHash],
            nextRoot,
            true,
          ),
        );
        return deepFreeze({
          stage: this.#readyStageIdentity(stage, stageStorageHash),
          stageRevision,
          stageRecordHash: stage.stageRecordHash,
        });
      });
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
        || binding.releaseProvenanceHash !== input.stage.releaseProvenanceHash
        || binding.candidatePartitionProofStorageHash !== input.stage.candidatePartitionProofStorageHash
      ) throw new CheckpointRunStateError("ready activation authority binding mismatch");
      if (stage !== undefined && (
        binding.definitionCatalogRoot !== stage.readyBase.definitionCatalogRoot
        || binding.instanceCatalogRoot !== stage.readyBase.instanceCatalogRoot
        || binding.graphRoot !== stage.readyBase.graphRoot
        || binding.releaseProvenanceHash !== stage.readyBase.releaseProvenanceHash
        || binding.candidatePartitionProofStorageHash !== stage.readyBase.candidatePartitionProofStorageHash
      )) throw new CheckpointRunStateError("ready activation authority closure mismatch");
    };
    assertPromotionAuthority();
    this.#canonical.assertActiveFence(input.fence);
    this.#canonical.assertPromotionFreshness(input.fence, input.freshness);
    decimal(input.promotedAtMonotonicNs, "promotedAtMonotonicNs");
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
        const stage = this.#findReadyStageRecordWith(tx.readContent.bind(tx), currentRecord.references, root.stagedReadyStorageHash);
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
          || stage.readyBase.releaseProvenanceHash !== input.stage.releaseProvenanceHash
          || stage.readyBase.candidatePartitionProofStorageHash !== input.stage.candidatePartitionProofStorageHash
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
        const loaded = this.#loadActiveRunTx(tx, currentRecord, root, stage.runId, true);
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
          candidateRecordCount: loaded.envelope.candidateRecordCount,
          candidateKeysRoot: candidatePartitionKeysRoot(loaded.builderRun.candidates.map(candidate => candidate.familyCandidateKey)),
          recentObservationRoot: loaded.envelope.recentObservationRoot,
          sourceCoverageRoot: loaded.envelope.sourceCoverageRoot,
          checkpointRevision: loaded.envelope.candidatePartitionRevision,
          candidatePartitionProofStorageHash: stage.readyBase.candidatePartitionProofStorageHash,
          exactOutcomePartitionRoot: stage.readyBase.exactOutcomePartitionRoot,
          sealedRevision: stage.sealedRevision,
          stageRevision: stage.stageRevision,
          stageRecordHash: stage.stageRecordHash,
          readyBaseHash: stage.readyBaseHash,
        });
        const candidatePartitionCommitmentStorageHash = tx.putImmutable(
          CANDIDATE_PARTITION_COMMITMENT_KIND,
          encodeCanonicalBytes(candidatePartitionCommitment),
          [candidatePartitionCommitment.candidatePartitionProofStorageHash, candidatePartitionCommitment.candidatePartitionStorageHash],
        );
        const closure: ReadyClosureV1 = deepFreeze({
          ready: fullReady,
          candidatePartitionStorageHash: candidatePartitionCommitment.candidatePartitionStorageHash,
          candidateRecordCount: candidatePartitionCommitment.candidateRecordCount,
          candidateKeysRoot: candidatePartitionCommitment.candidateKeysRoot,
          recentObservationRoot: candidatePartitionCommitment.recentObservationRoot,
          sourceCoverageRoot: candidatePartitionCommitment.sourceCoverageRoot,
          candidatePartitionRevision: candidatePartitionCommitment.checkpointRevision,
          sourceCoverageStorageHash: stage.sourceCoverageStorageHash,
          candidatePartitionCommitmentStorageHash,
          candidatePartitionProofStorageHash: stage.readyBase.candidatePartitionProofStorageHash,
          verifiedMemoSetStorageHash: stage.verifiedMemoSetStorageHash,
          instanceCatalogStorageHash: stage.instanceCatalogStorageHash,
          graphStorageHash: stage.graphStorageHash,
        });
        const closureStorageHash = tx.putImmutable(READY_CLOSURE_KIND, encodeCanonicalBytes(closure), [
          closure.sourceCoverageStorageHash,
          closure.candidatePartitionStorageHash,
          closure.candidatePartitionCommitmentStorageHash,
          closure.candidatePartitionProofStorageHash,
          closure.verifiedMemoSetStorageHash,
          closure.instanceCatalogStorageHash,
          closure.graphStorageHash,
        ]);
        const memo = decodeMemoSet(readContent(tx, stage.verifiedMemoSetStorageHash, VERIFIED_MEMO_SET_KIND, "verified memo set"));
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

  async loadReadyClosure(ready: ReadyGenerationV1): Promise<{ readonly sourceCoverage: SourceCoverageCertificateV1; readonly instanceCatalog: InstanceCatalogV1; readonly graph: PersistedGraphV1 }> {
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
    const instanceCatalog = cloneCanonical<InstanceCatalogV1>(decodeCanonicalJson(readContentStore(this.#durable, closure.instanceCatalogStorageHash, INSTANCE_CATALOG_KIND, "instance catalog")));
    const graph = cloneCanonical<PersistedGraphV1>(decodeCanonicalJson(readContentStore(this.#durable, closure.graphStorageHash, GRAPH_KIND, "persisted graph")));
    validateInstanceCatalog(instanceCatalog);
    const rebuilt = buildPersistedGraph(instanceCatalog);
    if (encodeCanonicalJson(rebuilt) !== encodeCanonicalJson(graph)) throw new CorruptDurableStoreError("ready graph closure mismatch");
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
    return deepFreeze({ sourceCoverage, instanceCatalog, graph });
  }

  assertReadyAuthorityActive(rawBinding: ActiveReadyAuthorityBindingV1): void {
    const releaseFence = this.#captureReleaseFence();
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
        "releaseProvenanceHash",
        "candidatePartitionProofStorageHash",
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
    const releaseProvenanceHash = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "releaseProvenanceHash", "activeReadyBinding"),
      "activeReadyBinding.releaseProvenanceHash",
    );
    const candidatePartitionProofStorageHash = assertHash(
      readOwnEnumerableDataProperty(rawBinding, "candidatePartitionProofStorageHash", "activeReadyBinding"),
      "activeReadyBinding.candidatePartitionProofStorageHash",
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
      releaseFence.releaseProvenanceHash !== closure.ready.releaseProvenanceHash
      ||
      closure.ready.generationId !== generationId
      || closure.ready.readyRecordHash !== readyRecordHash
      || closure.ready.generationRefreshPolicyHash !== generationRefreshPolicyHash
      || closure.ready.definitionCatalogRoot !== definitionCatalogRoot
      || closure.ready.instanceCatalogRoot !== instanceCatalogRoot
      || closure.ready.graphRoot !== graphRoot
      || closure.ready.releaseProvenanceHash !== releaseProvenanceHash
      || closure.ready.candidatePartitionProofStorageHash !== candidatePartitionProofStorageHash
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
    this.#assertReleaseFenceUnchanged(releaseFence);
  }

  async assertContentRoot(kind: "candidate-partition" | "verified-memo-set", root: Hash): Promise<void> {
    const releaseFence = this.#captureReleaseFence();
    const record = this.#durable.readRoot();
    if (!record) throw new CorruptDurableStoreError("checkpoint root missing");
    const checkpointRoot = rootFromRecord(record);
    this.#validateRootReferenceSet(record, checkpointRoot);
    if (kind === "verified-memo-set" && checkpointRoot.verifiedMemoRoot !== root) throw new CorruptDurableStoreError("verified memo root is not active");
    if (!checkpointRoot.readyGenerationRecordHash) throw new CorruptDurableStoreError("ready generation is absent");
    const closure = this.#findReadyClosure(record.references, checkpointRoot.readyGenerationRecordHash);
    if (releaseFence.releaseProvenanceHash !== closure.ready.releaseProvenanceHash) {
      throw new CheckpointRunStateError("active ready release binding is stale");
    }
    await this.#canonical.assertStillCanonical(closure.ready.cutoff);
    if (kind === "candidate-partition") {
      const record = this.#durable.readContent(closure.candidatePartitionCommitmentStorageHash);
      if (!record || record.kind !== CANDIDATE_PARTITION_COMMITMENT_KIND) {
        throw new CorruptDurableStoreError("candidate partition commitment is missing or has references");
      }
      const commitment = decodeCandidatePartitionCommitment(record.bytes);
      if (
        encodeCanonicalJson(record.references) !== encodeCanonicalJson([
          closure.candidatePartitionProofStorageHash,
          closure.candidatePartitionStorageHash,
        ].sort(compareText))
        || commitment.candidatePartitionProofStorageHash !== closure.candidatePartitionProofStorageHash
        || commitment.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
        || commitment.candidatePartitionRoot !== root
        || commitment.readyRecordHash !== closure.ready.readyRecordHash
      ) {
        throw new CorruptDurableStoreError("candidate partition commitment root mismatch");
      }
    } else {
      const memo = decodeMemoSet(readContentStore(this.#durable, closure.verifiedMemoSetStorageHash, VERIFIED_MEMO_SET_KIND, "verified memo set"));
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
    this.#assertReleaseFenceUnchanged(releaseFence);
  }

  _acquireWriterLease(owner: string): WriterLease {
    return this.#durable.acquireWriterLease(owner);
  }

  _renewWriterLease(lease: WriterLease): WriterLease {
    return this.#durable.renewWriterLease(lease);
  }

  _releaseWriterLease(lease: WriterLease): void {
    this.#durable.releaseWriterLease(lease);
  }

  _flushOutcomeBatch(
    runId: string,
    writerCapability: AttestationWriterCapabilityV1,
    batch: readonly AttestationPersistenceCapabilityV1[],
    lease: WriterLease,
  ): void {
    let claim: AttestationPersistenceBatchClaimV1 | undefined;
    try {
      this.#durable.transaction(lease, tx => {
      const currentRecord = tx.readRoot();
      if (!currentRecord) throw new CorruptDurableStoreError("checkpoint root missing");
      const root = rootFromRecord(currentRecord);
      const loaded = this.#loadActiveRunTx(tx, currentRecord, root, runId);
      const candidates = new Map(loaded.builderRun.candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
      const existing = new Map(this.#loadOutcomes(tx, loaded.envelope).map(outcome => [outcome.familyCandidateKey, outcome]));
      const partials = new Map(this.#loadPartialOutcomes(tx, loaded.envelope).map(partial => [partial.familyCandidateKey, partial]));
      claim = this.#attestationAuthority.claimWriterCapabilities(writerCapability, batch);
      for (const persisted of claim.entries) {
        const persistedObject = exactObject(
          persisted,
          ["runId", "candidatePartitionRoot", "familyCandidateKey", "outcomeHash", "attestationAuthorityRoot", "releaseAuthorityRoot", "releaseProvenanceHash", "executorAuthorityRoot", "kind", "identity", "outcome"],
          "attestation persisted outcome",
        ) as unknown as AttestationPersistedOutcomeV1;
        const persistedRunId = assertNonEmptyString(persistedObject.runId, "attestation persisted outcome.runId");
        const persistedCandidatePartitionRoot = assertHash(persistedObject.candidatePartitionRoot, "attestation persisted outcome.candidatePartitionRoot");
        const persistedCandidateKey = assertHash(persistedObject.familyCandidateKey, "attestation persisted outcome.familyCandidateKey");
        const persistedOutcomeHash = assertHash(persistedObject.outcomeHash, "attestation persisted outcome.outcomeHash");
        const persistedAttestationAuthorityRoot = assertHash(persistedObject.attestationAuthorityRoot, "attestation persisted outcome.attestationAuthorityRoot");
        const persistedReleaseAuthorityRoot = assertHash(persistedObject.releaseAuthorityRoot, "attestation persisted outcome.releaseAuthorityRoot");
        const persistedReleaseProvenanceHash = assertHash(persistedObject.releaseProvenanceHash, "attestation persisted outcome.releaseProvenanceHash");
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
            persistedAttestationAuthorityRoot !== this.#attestationAuthority.authorityRoot
            || persistedReleaseAuthorityRoot !== this.#attestationAuthority.releaseAuthorityRoot
            || persistedReleaseProvenanceHash !== this.#attestationAuthority.releaseProvenanceHash
            || persistedExecutorAuthorityRoot !== this.#attestationAuthority.executorAuthorityRoot
          ) throw new CheckpointRunStateError("partial identity authority binding mismatch");
          if (partial.identity === null) throw new CheckpointRunStateError("partial identity is missing its identity record");
          const expectedPartialHash = attestationPartialIdentitySemanticHash({
            runId,
            cutoff: loaded.envelope.cutoff,
            candidatePartitionRoot: loaded.envelope.candidatePartitionRoot,
            candidate,
            identity: partial.identity,
            releaseProvenanceHash: persistedReleaseProvenanceHash,
            attestationAuthorityRoot: persistedAttestationAuthorityRoot,
            releaseAuthorityRoot: persistedReleaseAuthorityRoot,
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
          persistedAttestationAuthorityRoot !== outcome.attestationAuthorityRoot
          || persistedReleaseAuthorityRoot !== outcome.releaseAuthorityRoot
          || persistedReleaseProvenanceHash !== outcome.releaseProvenanceHash
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
      const nextRunHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(nextRun), [
        nextRun.recentObservationStorageHash,
        nextRun.sourceCoverageStorageHash,
        nextRun.candidatePartitionStorageHash,
        nextRun.candidatePartitionProofStorageHash,
        nextRun.outcomePartitionStorageHash,
        ...(nextRun.partialOutcomePartitionStorageHash === null ? [] : [nextRun.partialOutcomePartitionStorageHash]),
        nextRun.verifiedMemoSetStorageHash,
      ]);
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
      });
    } catch (error) {
      (claim as AttestationPersistenceBatchClaimV1 | undefined)?.abort();
      claim = undefined;
      throw error;
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
        const memoStorageHash = tx.putImmutable(VERIFIED_MEMO_SET_KIND, encodeCanonicalBytes(memo));
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
      expectedReferences.push(this.#findActiveRunRecordWith(read, available, root, root.inProgressRunId).storageHash);
    }
    if (root.stagedReadyStorageHash !== null) {
      if (root.inProgressRunId === null) {
        throw new CorruptDurableStoreError("staged ready exists without an active run");
      }
      const stage = this.#findReadyStageRecordWith(read, available, root.stagedReadyStorageHash);
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
      const receipt = this.#validateProbeReceiptChainWith(read, root.latestProbeReceiptHash);
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
  ): ProbeReceiptV1 {
    let currentHash: Hash | null = latestHash;
    let child: ProbeReceiptV1 | null = null;
    let latest: ProbeReceiptV1 | null = null;
    while (currentHash !== null) {
      const record = read(currentHash);
      if (!record || record.kind !== PROBE_RECEIPT_KIND) {
        throw new CorruptDurableStoreError("probe receipt kind mismatch");
      }
      const receipt = validateProbeReceipt(
        cloneCanonical<ProbeReceiptV1>(decodeCanonicalJson(record.bytes)),
      );
      latest ??= receipt;
      const sequence = BigInt(receipt.sequence);
      if (child !== null) {
        if (
          BigInt(child.sequence) !== sequence + 1n
          || child.priorReceiptHash !== currentHash
          || child.priorLineageRoot !== receipt.receiptLineageRoot
        ) throw new CorruptDurableStoreError("probe receipt predecessor mismatch");
      }
      const expectedReferences = receipt.priorReceiptHash === null ? [] : [receipt.priorReceiptHash];
      if (encodeCanonicalJson(record.references) !== encodeCanonicalJson(expectedReferences)) {
        throw new CorruptDurableStoreError("probe receipt physical predecessor mismatch");
      }
      child = receipt;
      currentHash = receipt.priorReceiptHash;
    }
    if (latest === null || child === null || child.sequence !== "1") {
      throw new CorruptDurableStoreError("probe receipt lineage is incomplete");
    }
    return latest;
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
  ) {
    if (root.inProgressRunId !== runId) throw new CheckpointRunStateError(`run ${runId} is not active`);
    const expectedRunRevision = root.stagedReadyStorageHash === null
      ? root.revision
      : this.#findReadyStageRecordWith(read, references, root.stagedReadyStorageHash).expectedRevision;
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
    const found = this.#findActiveRunRecordWith(hash => tx.readContent(hash), record.references, root, runId);
    const loaded = this.#hydrateRun(tx, root, found.envelope, found.storageHash);
    this.#assertRunIndexesWith(
      namespace => tx.listIndex(namespace),
      (hash, kind, context) => readContent(tx, hash, kind, context),
      loaded.envelope,
    );
    this.#validateRunPhysicalReferencesWith(hash => tx.readContent(hash), loaded);
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
    const candidateEntries = loadPartition(read, envelope.candidatePartitionStorageHash, envelope.runId, "candidate");
    const candidates = candidateEntries.map(entry => {
      const candidate = cloneCanonical<CandidateRecordV1>(decodeCanonicalJson(read(entry.storageHash, CANDIDATE_KIND, "candidate record")));
      if (candidate.familyCandidateKey !== entry.key) throw new CorruptDurableStoreError("candidate partition key mismatch");
      return candidate;
    });
    if (String(candidates.length) !== envelope.candidateRecordCount || candidatePartitionRoot(candidates) !== envelope.candidatePartitionRoot) throw new CorruptDurableStoreError("candidate partition root mismatch");
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
          releaseProvenanceHash: partial.releaseProvenanceHash,
          attestationAuthorityRoot: partial.attestationAuthorityRoot,
          releaseAuthorityRoot: partial.releaseAuthorityRoot,
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
      const partition = cloneCanonical<AttestationPartitionV1>(decodeCanonicalJson(read(
        envelope.attestationPartitionStorageHash,
        ATTESTATION_PARTITION_KIND,
        "attestation partition",
      )));
      this.#attestationAuthority.validateDurablePartition(partition, candidates);
      if (
        partition.runId !== envelope.runId
        || !sameCutoff(partition.cutoff, envelope.cutoff)
        || partition.candidatePartitionRoot !== envelope.candidatePartitionRoot
        || partition.exactOutcomePartitionRoot !== hashDomain("aloha/exact-outcome-partition/v1", {
          runId: envelope.runId,
          cutoff: envelope.cutoff,
          candidatePartitionRoot: partition.candidatePartitionRoot,
          attestationAuthorityRoot: partition.attestationAuthorityRoot,
          releaseAuthorityRoot: partition.releaseAuthorityRoot,
          releaseProvenanceHash: partition.releaseProvenanceHash,
          executorAuthorityRoot: partition.executorAuthorityRoot,
          outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
        })
        || encodeCanonicalJson(partition.outcomes) !== encodeCanonicalJson(outcomes)
      ) throw new CorruptDurableStoreError("sealed attestation partition does not match durable outcomes");
    }
    const proofBytes = read(
      envelope.candidatePartitionProofStorageHash,
      CANDIDATE_PARTITION_PROOF_KIND,
      "candidate partition proof",
    );
    const storedProof = decodeCandidatePartitionProofBytes(proofBytes);
    const release = this.#candidatePartitionProofIssuer.currentRelease();
    const verifiedProof = this.#candidatePartitionProofIssuer.verify(storedProof, {
      binding: candidatePartitionBindingFromProof(storedProof),
      release,
    });
    if (encodeCanonicalJson(verifiedProof) !== encodeCanonicalJson(storedProof)) {
      throw new CorruptDurableStoreError("candidate partition proof verifier changed the durable proof");
    }
    const proofBinding = candidatePartitionBindingFromProof(verifiedProof);
    if (
      proofBinding.runId !== envelope.runId
      || !sameCutoff(proofBinding.cutoff, envelope.cutoff)
      || proofBinding.candidatePartitionRoot !== envelope.candidatePartitionRoot
      || proofBinding.candidatePartitionStorageHash !== envelope.candidatePartitionStorageHash
      || proofBinding.recordCount !== envelope.candidateRecordCount
      || proofBinding.recentObservationRoot !== envelope.recentObservationRoot
      || proofBinding.sourceCoverageRoot !== envelope.sourceCoverageRoot
      || proofBinding.checkpointRevision !== envelope.candidatePartitionRevision
    ) throw new CorruptDurableStoreError("candidate partition proof does not bind the active run");
    const candidatePartition = this.#candidatePartitionCapabilities.registerVerifiedProof(verifiedProof, candidates);
    const memo = decodeMemoSet(read(envelope.verifiedMemoSetStorageHash, VERIFIED_MEMO_SET_KIND, "verified memo set"));
    if (memo.verifiedMemoSetRoot !== envelope.verifiedMemoSetRoot) throw new CorruptDurableStoreError("run verified memo root mismatch");
    const builderRun: InternalBuilderRunV1 = deepFreeze({
      runId: envelope.runId,
      parentGenerationId: envelope.parentGenerationId,
      checkpointRevision: envelope.checkpointRevision,
      cutoff: envelope.cutoff,
      recentObservation,
      definitionCatalogRoot: envelope.definitionCatalogRoot,
      sourceCoverage,
      sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
      candidatePartition: candidatePartition,
      candidatePartitionBinding: proofBinding,
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
      candidatePartitionProofStorageHash: run.candidatePartitionProofStorageHash,
      candidateKeys: candidates.map(candidate => candidate.familyCandidateKey).sort(compareText),
      verifiedMemoSetRoot: run.verifiedMemoSetRoot,
      exactOutcomePartitionRoot: partition.exactOutcomePartitionRoot,
      checkpointRevision: run.checkpointRevision,
      partition,
      attestationAuthorityRoot: partition.attestationAuthorityRoot,
      releaseAuthorityRoot: partition.releaseAuthorityRoot,
      releaseProvenanceHash: partition.releaseProvenanceHash,
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
    const partition = cloneCanonical<AttestationPartitionV1>(decodeCanonicalJson(readContentStore(
      this.#durable,
      loaded.envelope.attestationPartitionStorageHash,
      ATTESTATION_PARTITION_KIND,
      "sealed attestation partition",
    )));
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
      const memo = decodeMemoSet(content.bytes);
      validateRawLocatorReferences(read, content.references, memo.retainedRawLocatorHashes, "verified memo set");
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

  #validateRunPhysicalReferences(loaded: { readonly envelope: StoredRunEnvelopeV2; readonly storageHash: Hash; readonly builderRun: InProgressBuilderRunV1 }): void {
    this.#validateRunPhysicalReferencesWith(hash => this.#durable.readContent(hash), loaded);
  }

  #validateRunPhysicalReferencesWith(
    read: DurableContentReader,
    loaded: { readonly envelope: StoredRunEnvelopeV2; readonly storageHash: Hash; readonly builderRun: InProgressBuilderRunV1 },
  ): void {
    const runReferences = [
      loaded.envelope.recentObservationStorageHash,
      loaded.envelope.sourceCoverageStorageHash,
      loaded.envelope.candidatePartitionStorageHash,
      loaded.envelope.candidatePartitionProofStorageHash,
      loaded.envelope.outcomePartitionStorageHash,
      ...(loaded.envelope.partialOutcomePartitionStorageHash === null ? [] : [loaded.envelope.partialOutcomePartitionStorageHash]),
      loaded.envelope.verifiedMemoSetStorageHash,
      ...(loaded.envelope.attestationPartitionStorageHash === null ? [] : [loaded.envelope.attestationPartitionStorageHash]),
    ];
    this.#assertRecordReferencesWith(read, loaded.storageHash, RUN_KIND, runReferences, "active run");
    const proofRecord = read(loaded.envelope.candidatePartitionProofStorageHash);
    if (!proofRecord || proofRecord.kind !== CANDIDATE_PARTITION_PROOF_KIND) {
      throw new CorruptDurableStoreError("candidate partition proof is missing");
    }
    decodeCandidatePartitionProofBytes(proofRecord.bytes);
    this.#assertRecordReferencesWith(read, loaded.envelope.candidatePartitionProofStorageHash, CANDIDATE_PARTITION_PROOF_KIND, [], "candidate partition proof");
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
    this.#validatePartitionPhysicalWith(read, loaded.envelope.candidatePartitionStorageHash, loaded.envelope.runId, "candidate");
    this.#validatePartitionPhysicalWith(read, loaded.envelope.outcomePartitionStorageHash, loaded.envelope.runId, "outcome");
    if (loaded.envelope.partialOutcomePartitionStorageHash !== null) {
      this.#validatePartitionPhysicalWith(read, loaded.envelope.partialOutcomePartitionStorageHash, loaded.envelope.runId, "partial-outcome");
    }
    const memoRecord = read(loaded.envelope.verifiedMemoSetStorageHash);
    if (!memoRecord || memoRecord.kind !== VERIFIED_MEMO_SET_KIND) throw new CorruptDurableStoreError("run memo set is missing");
    const memo = decodeMemoSet(memoRecord.bytes);
    validateRawLocatorReferences(
      read,
      memoRecord.references,
      memo.retainedRawLocatorHashes,
      "run memo set",
    );
    if (loaded.envelope.attestationPartitionStorageHash !== null) {
      this.#assertRecordReferencesWith(
        read,
        loaded.envelope.attestationPartitionStorageHash,
        ATTESTATION_PARTITION_KIND,
        [loaded.envelope.outcomePartitionStorageHash],
        "attestation partition",
      );
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
          const durablePartition = cloneCanonical<AttestationPartitionV1>(decodeCanonicalJson(readContent(
            tx,
            loaded.envelope.attestationPartitionStorageHash,
            ATTESTATION_PARTITION_KIND,
            "memo seed attestation partition",
          )));
          this.#attestationAuthority.validateDurablePartition(durablePartition, loaded.builderRun.candidates);
          if (encodeCanonicalJson(durablePartition) !== encodeCanonicalJson(memoSeed.partition)) {
            throw new CheckpointRunStateError("memo seed attestation authority mismatch");
          }
          memoStorageHash = loaded.envelope.verifiedMemoSetStorageHash;
          decodeMemoSet(readContent(tx, memoStorageHash, VERIFIED_MEMO_SET_KIND, "memo seed"));
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
      stage.verifiedMemoSetStorageHash,
      stage.instanceCatalogStorageHash,
      stage.graphStorageHash,
    ].sort(compareText);
    if (encodeCanonicalJson(content.references) !== encodeCanonicalJson(expectedReferences)) {
      throw new CorruptDurableStoreError("staged ready physical references mismatch");
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
      releaseProvenanceHash: stage.readyBase.releaseProvenanceHash,
      candidatePartitionProofStorageHash: stage.readyBase.candidatePartitionProofStorageHash,
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
      const commitmentRecord = read(found.closure.candidatePartitionCommitmentStorageHash);
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
        closure.candidatePartitionStorageHash,
        closure.candidatePartitionCommitmentStorageHash,
        closure.candidatePartitionProofStorageHash,
        closure.verifiedMemoSetStorageHash,
        closure.instanceCatalogStorageHash,
        closure.graphStorageHash,
      ].sort(compareText);
      if (encodeCanonicalJson(content.references) !== encodeCanonicalJson(expectedReferences)) {
        throw new CorruptDurableStoreError("ready closure physical references mismatch");
      }
      if (closure.ready.readyRecordHash === readyRecordHash) {
        if (!allowValidatedCache || !this.#validatedReadyClosureStorageHashes.has(hash)) {
          const commitmentRecord = read(closure.candidatePartitionCommitmentStorageHash);
          if (!commitmentRecord || commitmentRecord.kind !== CANDIDATE_PARTITION_COMMITMENT_KIND) {
            throw new CorruptDurableStoreError("candidate partition commitment is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.candidatePartitionCommitmentStorageHash,
            CANDIDATE_PARTITION_COMMITMENT_KIND,
            [closure.candidatePartitionProofStorageHash, closure.candidatePartitionStorageHash],
            "candidate partition commitment",
          );
          const commitment = decodeCandidatePartitionCommitment(commitmentRecord.bytes);
          if (
            commitment.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
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
          const proofRecord = read(closure.candidatePartitionProofStorageHash);
          if (!proofRecord || proofRecord.kind !== CANDIDATE_PARTITION_PROOF_KIND) {
            throw new CorruptDurableStoreError("ready candidate partition proof is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.candidatePartitionProofStorageHash,
            CANDIDATE_PARTITION_PROOF_KIND,
            [],
            "ready candidate partition proof",
          );
          const storedProof = decodeCandidatePartitionProofBytes(proofRecord.bytes);
          const verifiedProof = this.#candidatePartitionProofIssuer.verify(storedProof, {
            binding: candidatePartitionBindingFromProof(storedProof),
            release: this.#candidatePartitionProofIssuer.currentRelease(),
          });
          if (encodeCanonicalJson(verifiedProof) !== encodeCanonicalJson(storedProof)) {
            throw new CorruptDurableStoreError("ready candidate partition proof verifier changed durable bytes");
          }
          const expectedGenerationId = hashDomain("aloha/ready-generation-id/v1", {
            parentGenerationId: closure.ready.parentGenerationId,
            runId: commitment.runId,
            cutoff: closure.ready.cutoff,
            definitionCatalogRoot: closure.ready.definitionCatalogRoot,
            instanceCatalogRoot: closure.ready.instanceCatalogRoot,
            graphRoot: closure.ready.graphRoot,
            policyHash: closure.ready.generationRefreshPolicyHash,
            releaseProvenanceHash: closure.ready.releaseProvenanceHash,
            candidatePartitionProofStorageHash: closure.ready.candidatePartitionProofStorageHash,
          });
          if (
            commitment.readyRecordHash !== closure.ready.readyRecordHash
            || commitment.candidatePartitionProofStorageHash !== closure.candidatePartitionProofStorageHash
            || closure.ready.candidatePartitionProofStorageHash !== closure.candidatePartitionProofStorageHash
            || verifiedProof.releaseProvenanceHash !== closure.ready.releaseProvenanceHash
            || verifiedProof.runId !== commitment.runId
            || verifiedProof.candidatePartitionRoot !== closure.ready.candidatePartitionRoot
            || verifiedProof.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
            || verifiedProof.recordCount !== closure.candidateRecordCount
            || verifiedProof.candidateKeysRoot !== closure.candidateKeysRoot
            || verifiedProof.recentObservationRoot !== closure.recentObservationRoot
            || verifiedProof.sourceCoverageRoot !== closure.sourceCoverageRoot
            || verifiedProof.checkpointRevision !== closure.candidatePartitionRevision
            || !sameCutoff(verifiedProof.cutoff, closure.ready.cutoff)
            || !sameCutoff(commitment.cutoff, closure.ready.cutoff)
            || commitment.candidatePartitionRoot !== closure.ready.candidatePartitionRoot
            || commitment.candidatePartitionStorageHash !== closure.candidatePartitionStorageHash
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
              exactOutcomePartitionRoot: closure.ready.exactOutcomePartitionRoot,
              verifiedMemoSetRoot: closure.ready.verifiedMemoSetRoot,
              instanceCatalogRoot: closure.ready.instanceCatalogRoot,
              graphRoot: closure.ready.graphRoot,
              edgeCount: closure.ready.edgeCount,
              instanceCount: closure.ready.instanceCount,
              releaseProvenanceHash: closure.ready.releaseProvenanceHash,
              candidatePartitionProofStorageHash: closure.ready.candidatePartitionProofStorageHash,
            })
            || BigInt(commitment.sealedRevision) + 1n !== BigInt(commitment.stageRevision)
            || BigInt(commitment.stageRevision) + 1n !== BigInt(closure.ready.promotionRevision)
            || expectedGenerationId !== closure.ready.generationId
          ) throw new CorruptDurableStoreError("candidate partition commitment lineage mismatch");
          const memoRecord = read(closure.verifiedMemoSetStorageHash);
          if (!memoRecord || memoRecord.kind !== VERIFIED_MEMO_SET_KIND) throw new CorruptDurableStoreError("ready memo set is missing");
          const memo = decodeMemoSet(memoRecord.bytes);
          validateRawLocatorReferences(
            read,
            memoRecord.references,
            memo.retainedRawLocatorHashes,
            "ready memo set",
          );
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

          const catalogRecord = read(closure.instanceCatalogStorageHash);
          if (!catalogRecord || catalogRecord.kind !== INSTANCE_CATALOG_KIND) {
            throw new CorruptDurableStoreError("ready instance catalog is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.instanceCatalogStorageHash,
            INSTANCE_CATALOG_KIND,
            [],
            "ready instance catalog",
          );
          const catalog = cloneCanonical<InstanceCatalogV1>(decodeCanonicalJson(catalogRecord.bytes));
          validateInstanceCatalog(catalog);
          if (
            catalog.instanceCatalogRoot !== closure.ready.instanceCatalogRoot
            || catalog.instanceCount !== closure.ready.instanceCount
            || !sameCutoff(catalog.cutoff, closure.ready.cutoff)
          ) throw new CorruptDurableStoreError("ready instance catalog root mismatch");
          assertVerifiedPublicationCatalog(memo.memos, catalog);

          const graphRecord = read(closure.graphStorageHash);
          if (!graphRecord || graphRecord.kind !== GRAPH_KIND) {
            throw new CorruptDurableStoreError("ready graph is missing");
          }
          this.#assertRecordReferencesWith(
            read,
            closure.graphStorageHash,
            GRAPH_KIND,
            [],
            "ready graph",
          );
          const graph = cloneCanonical<PersistedGraphV1>(decodeCanonicalJson(graphRecord.bytes));
          const rebuiltGraph = buildPersistedGraph(catalog);
          if (
            encodeCanonicalJson(graph) !== encodeCanonicalJson(rebuiltGraph)
            || graph.graphRoot !== closure.ready.graphRoot
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
    const candidateSnapshotHash = candidate.candidateSnapshotHash;
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
      candidateSnapshotHash,
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
      candidateSnapshotHash,
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
          || candidate.candidateSnapshotHash !== probeState.candidateSnapshotHash
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
        const nextRunStorageHash = tx.putImmutable(RUN_KIND, encodeCanonicalBytes(nextRun), [
          nextRun.recentObservationStorageHash,
          nextRun.sourceCoverageStorageHash,
          nextRun.candidatePartitionStorageHash,
          nextRun.candidatePartitionProofStorageHash,
          nextRun.outcomePartitionStorageHash,
          ...(nextRun.partialOutcomePartitionStorageHash === null ? [] : [nextRun.partialOutcomePartitionStorageHash]),
          nextRun.verifiedMemoSetStorageHash,
        ]);
        const receipt = sealProbeReceipt({
          runId,
          familyCandidateKey,
          cutoff: loaded.envelope.cutoff,
          beforeOutcomeHash: previousSemanticHash,
          afterOutcomeHash: nextOutcomeHash,
          beforeKind: "retryable",
          afterKind: next.kind,
          candidateSnapshotHash: candidate.candidateSnapshotHash,
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
        const receiptStorageHash = tx.putImmutable(
          PROBE_RECEIPT_KIND,
          encodeCanonicalBytes(receipt),
          receipt.priorReceiptHash === null ? [] : [receipt.priorReceiptHash],
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

export class DurableOutcomeWriterActor {
  readonly #checkpoint: CheckpointStore;
  readonly #runId: string;
  readonly #writerCapability: AttestationWriterCapabilityV1;
  readonly #flushEveryItems: number;
  readonly #flushEveryMs: number;
  readonly #mailboxCapacity: number;
  readonly #queue: AttestationPersistenceCapabilityV1[] = [];
  readonly #pending: AttestationPersistenceCapabilityV1[] = [];
  readonly #waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  #accepting = true;
  #forceFlush = false;
  #wake: (() => void) | null = null;
  #lease: WriterLease;
  #lastFlush = performance.now();
  readonly #loop: Promise<void>;
  #done = false;

  constructor(checkpoint: CheckpointStore, runId: string, options: OutcomeWriterOptions) {
    this.#checkpoint = checkpoint;
    this.#runId = runId;
    this.#writerCapability = options.writerCapability;
    this.#flushEveryItems = options.flushEveryItems ?? 25;
    this.#flushEveryMs = options.flushEveryMs ?? 3_000;
    this.#mailboxCapacity = options.mailboxCapacity ?? 1_024;
    if (!Number.isSafeInteger(this.#flushEveryItems) || this.#flushEveryItems < 1) throw new RangeError("flushEveryItems must be positive");
    if (!Number.isSafeInteger(this.#flushEveryMs) || this.#flushEveryMs < 2_000 || this.#flushEveryMs > 5_000) throw new RangeError("flushEveryMs must be 2000..5000");
    if (!Number.isSafeInteger(this.#mailboxCapacity) || this.#mailboxCapacity < 1) throw new RangeError("mailboxCapacity must be positive");
    this.#lease = checkpoint._acquireWriterLease(options.writerId ?? `checkpoint-writer/${runId}/${randomUUID()}`);
    this.#loop = this.#run();
  }

  enqueue(raw: AttestationPersistenceCapabilityV1): Promise<void> {
    if (!this.#accepting) return Promise.reject(new OutcomeWriterClosedError());
    if (this.#queue.length >= this.#mailboxCapacity) return Promise.reject(new CheckpointError("writer-mailbox-full", "checkpoint writer mailbox is full"));
    // Keep the issuer object intact until the single writer validates it. A
    // canonical clone would deliberately erase its process-local capability.
    this.#queue.push(raw);
    this.#wake?.();
    this.#wake = null;
    return Promise.resolve();
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
    this.#wake?.();
    this.#wake = null;
    await this.#loop;
  }

  async #run(): Promise<void> {
    try {
      while (this.#accepting || this.#queue.length > 0 || this.#pending.length > 0) {
        if (this.#queue.length > 0) {
          const persistenceCapability = this.#queue.shift()!;
          this.#pending.push(persistenceCapability);
        } else if (this.#accepting && !this.#forceFlush) {
          await this.#wait(Math.max(0, this.#flushEveryMs - (performance.now() - this.#lastFlush)));
        }
        if (this.#pending.length >= this.#flushEveryItems || this.#forceFlush || performance.now() - this.#lastFlush >= this.#flushEveryMs || (!this.#accepting && this.#queue.length === 0)) {
          this.#flushPending();
          this.#lastFlush = performance.now();
          this.#forceFlush = false;
          this.#resolveWaiters();
        }
      }
      this.#flushPending();
      this.#resolveWaiters();
    } catch (error) {
      while (this.#waiters.length > 0) this.#waiters.shift()!.reject(error);
      throw error;
    } finally {
      this.#done = true;
      this.#checkpoint._releaseWriterLease(this.#lease);
    }
  }

  #flushPending(): void {
    if (this.#pending.length === 0) return;
    this.#lease = this.#checkpoint._renewWriterLease(this.#lease);
    const batch = this.#pending.splice(0, this.#pending.length);
    this.#checkpoint._flushOutcomeBatch(this.#runId, this.#writerCapability, batch, this.#lease);
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
  candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1,
  candidatePartitionBootstrap?: CandidatePartitionBootstrapV1,
): CheckpointStore {
  return new CheckpointStore(durable, canonical, probeCaller, promotionAuthority, attestationAuthority, candidatePartitionProofIssuer, candidatePartitionBootstrap);
}
