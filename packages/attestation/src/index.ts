import {
  assertDecimalString,
  assertExactCanonicalBytes,
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
  hashDomainBytes,
  type CanonicalJson,
  type CanonicalJsonObject,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { validateInstancePublication, type InstancePublicationV1 } from "../../catalog/src/index.ts";
import { candidatePartitionRoot, runCandidateKey, type CandidateRecordV1, type CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import type { FamilyRawEvidenceReadPortV1 } from "../../family-sdk/runtime/index.ts";
import type {
  AttestationIdentityOriginV1,
  AttestationCompositionResolvedV1,
} from "./internal-authority.ts";
import { ATTESTATION_VALIDATION_AUTHORITY_BRAND } from "./authority-brand.ts";
import type {
  CandidatePartitionCapabilityV1,
  CandidatePartitionCommitmentV1,
  CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import type { RuntimeAuthorityProjectionV1 } from "../../runtime-authority/src/index.ts";
import { decodeRuntimeAuthorityProjectionV1 } from "../../runtime-authority/src/index.ts";
import {
  decodeAttestationIdentityCommitmentV1,
  decodeAttestationOutcomeCommitmentV1,
} from "./commitment.ts";

export type {
  AttestationCompositionResolvedV1,
  AttestationIdentityOriginV1,
  VerifiedMemoReuseProofV1,
} from "./internal-authority.ts";
export {
  ATTESTATION_COMMITMENT_DOMAINS_V1,
  createAttestationIdentityCommitmentV1,
  createAttestationOutcomeCommitmentV1,
  decodeAttestationIdentityCommitmentV1,
  decodeAttestationOutcomeCommitmentV1,
  attestationIdentityCommitmentPayloadFromIssueInputV1,
  attestationOutcomeCommitmentPayloadFromIssueInputV1,
  type AttestationIdentityCommitmentPayloadV1,
  type AttestationIdentityCommitmentV1,
  type AttestationOutcomeCommitmentPayloadV1,
  type AttestationOutcomeCommitmentV1,
  type AttestationIdentityCommitmentIssueInputV1,
  type AttestationOutcomeCommitmentIssueInputV1,
} from "./commitment.ts";
import type {
  AttestationIdentityCommitmentV1,
  AttestationOutcomeCommitmentV1,
} from "./commitment.ts";

export const REJECTION_ISSUER_ID = "aloha/attestation-rejection-facts/v2" as const;
export const REJECTION_BUNDLE_KIND = "aloha.rejection-evidence-bundle" as const;
export const REJECTION_BUNDLE_VERSION = "2" as const;
export const FRAMEWORK_ISSUER_ID = "aloha/attestation-framework/v1" as const;
export const FRAMEWORK_FAILURE_CLASSES: readonly FrameworkFailureClassV1[] = [
  "transport", "rpc", "deadline", "resource", "storage", "queue",
];
export const ATTESTATION_STAGES: readonly AttestationStageV1[] = [
  "identity", "materialization", "projection", "framework",
];

export type AttestationStageV1 = "identity" | "materialization" | "projection" | "framework";

export type FrameworkFailureClassV1 = "transport" | "rpc" | "deadline" | "resource" | "storage" | "queue";

export interface FrameworkFailureContextV1 {
  readonly runId: string;
  readonly candidate: CandidateRecordV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly stage: AttestationStageV1;
}

export interface FrameworkFailureIssueV1 {
  readonly context: FrameworkFailureContextV1;
  readonly failureClass: FrameworkFailureClassV1;
  readonly failureCode: string;
  readonly attemptCount: string;
  readonly evidenceRoot: Hash;
}

export interface FrameworkFailureBindingV1 {
  readonly issuerId: "aloha/attestation-framework/v1";
  readonly authorityRoot: Hash;
  readonly runId: string;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly stage: AttestationStageV1;
  readonly failureClass: FrameworkFailureClassV1;
  readonly failureCode: string;
  readonly attemptCount: string;
  readonly evidenceRoot: Hash;
  readonly tokenHash: Hash;
}

export type FrameworkFailureTokenV1 = FrameworkFailureBindingV1;

export interface FrameworkFailureIssuerPort {
  issue(input: FrameworkFailureIssueV1): FrameworkFailureTokenV1;
  validate(value: unknown, context: FrameworkFailureContextV1): FrameworkFailureBindingV1;
}

export interface FrameworkFailureClassifierPort {
  /** Return a framework-issued token or null. It must not parse Error.message. */
  classify(thrown: unknown, context: FrameworkFailureContextV1): unknown;
}

export interface FrameworkFailureRuntimePort {
  readonly issuer: FrameworkFailureIssuerPort;
  readonly classifier: FrameworkFailureClassifierPort;
}

export interface OutcomeFailureV1 {
  readonly stage: AttestationStageV1;
  readonly failureCode: string;
  readonly attemptCount: string;
  readonly candidateSubjectHash: Hash;
  readonly evidenceRoot: Hash;
  /** Null for invalidProgram; mandatory framework binding for retryable. */
  readonly frameworkBinding: FrameworkFailureBindingV1 | null;
}

/**
 * Rejection facts are deliberately opaque to the central planner.  The
 * records are nevertheless structured canonical JSON: the issuer checks that
 * the supplied bytes are the exact encoding of the record before it accepts
 * them.  This prevents a plugin from replacing a real request/result with a
 * hand-written root.
 */
export interface FrozenRequestRecordV1 {
  readonly requestId: Hash;
  readonly record: CanonicalJsonObject;
}

export type TransportFactKindV1 = "returned" | "reverted" | "transportFailure";

export interface OrderedTransportFactRecordV1 {
  readonly ordinal: string;
  readonly requestId: Hash;
  readonly kind: TransportFactKindV1;
  readonly fact: CanonicalJsonObject;
}

export interface EffectObservationRecordV1 {
  readonly ordinal: string;
  readonly requestId: Hash;
  readonly observation: CanonicalJsonObject;
}

export interface RejectionFactContextV1 {
  readonly runId: string;
  readonly candidate: CandidateRecordV1;
  readonly cutoff: CanonicalCutoffV1;
  readonly stage: Exclude<AttestationStageV1, "framework">;
  /** Null only for identity-stage nomination rejection. */
  readonly identitySubjectHash: Hash | null;
}

export type CanonicalBytesHexV1 = `0x${string}`;

export interface PersistedRequestRecordV1 {
  readonly requestId: Hash;
  readonly record: CanonicalJsonObject;
  readonly canonicalBytesHex: CanonicalBytesHexV1;
}

export interface PersistedTransportFactRecordV1 {
  readonly ordinal: string;
  readonly requestId: Hash;
  readonly kind: TransportFactKindV1;
  readonly fact: CanonicalJsonObject;
  readonly canonicalBytesHex: CanonicalBytesHexV1;
}

export interface PersistedEffectObservationRecordV1 {
  readonly ordinal: string;
  readonly requestId: Hash;
  readonly observation: CanonicalJsonObject;
  readonly canonicalBytesHex: CanonicalBytesHexV1;
}

/**
 * All child bytes needed to rehydrate a rejection are retained in this
 * bundle.  Roots alone are intentionally not enough to resume or promote.
 */
export interface RejectionEvidenceBundleV2 {
  readonly kind: "aloha.rejection-evidence-bundle";
  readonly version: "2";
  readonly issuerId: "aloha/attestation-rejection-facts/v2";
  readonly runId: string;
  readonly chainId: string;
  readonly cutoffNumber: string;
  readonly cutoffHash: Hash;
  readonly cutoffStateRoot: Hash;
  readonly stage: Exclude<AttestationStageV1, "framework">;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identitySubjectHash: Hash | null;
  readonly instanceNominationKey: string | null;
  /** The framework executor authority that produced every child fact. */
  readonly executorAuthorityRoot: Hash;
  /** Scheduler worker epoch for the source that produced every child fact. */
  readonly workerEpoch: string;
  /** Process-local execution session established by the scheduler issuer. */
  readonly executorSessionHash: Hash;
  /** Exact execution session for this one frozen program/fact set. */
  readonly executionSessionHash: Hash;
  readonly request: PersistedRequestRecordV1;
  readonly transportFacts: readonly PersistedTransportFactRecordV1[];
  readonly effectObservations: readonly PersistedEffectObservationRecordV1[];
  readonly decisionCode: string;
  readonly decisionBytesHex: CanonicalBytesHexV1;
  readonly requestFingerprint: Hash;
  readonly orderedTransportFactsRoot: Hash;
  readonly effectObservationRoot: Hash;
  readonly decisionBytesHash: Hash;
  readonly evidenceBundleRoot: Hash;
}

export interface RejectionFactTokenV1 {
  readonly tokenHash: Hash;
}

export interface IssuedRejectionFactTokenV1 extends RejectionFactTokenV1 {
  readonly issuerId: "aloha/attestation-rejection-facts/v2";
  readonly programId: Hash;
  readonly runId: string;
  readonly chainId: string;
  readonly cutoffNumber: string;
  readonly cutoffHash: Hash;
  readonly cutoffStateRoot: Hash;
  readonly stage: Exclude<AttestationStageV1, "framework">;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identitySubjectHash: Hash | null;
  readonly instanceNominationKey: string | null;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
  readonly requestFingerprint: Hash;
  readonly orderedTransportFactsRoot: Hash;
  readonly effectObservationRoot: Hash;
}

export interface FrozenProgramCapabilityV1 {
  readonly programId: Hash;
}

export interface FrozenProgramSpecV1 {
  readonly context: RejectionFactContextV1;
  readonly request: FrozenRequestRecordV1;
}

export interface RejectionFactProgramBuilderPort {
  freezeProgram(input: FrozenProgramSpecV1): FrozenProgramCapabilityV1;
}

export interface RawTransportExecutionRecordV1 {
  readonly requestId: Hash;
  readonly kind: TransportFactKindV1;
  readonly data: Uint8Array;
  readonly source: ExecutionSourceAnchorV1;
}

export interface RawEffectObservationV1 {
  readonly requestId: Hash;
  readonly source: ExecutionSourceAnchorV1;
  readonly observation: CanonicalJsonObject;
}

export interface ExecutionSourceAnchorV1 {
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: Hash;
  readonly stateRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

/**
 * A plain executor is deliberately not accepted by createRejectionFactRuntime.
 * The scheduler first issues this opaque, process-local capability.  The
 * capability contains only the authority coordinates; the actual executor is
 * held in a module-private WeakMap and can therefore not be replaced by a
 * structurally identical object or a copied token.
 */
export interface RejectionExecutorCapabilityV1 {
  readonly authorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export interface RejectionExecutorAuthorityIssuerV1 {
  issue(executor: RejectionTransportExecutorV1): RejectionExecutorCapabilityV1;
  /** Revoke every capability issued by this authority lease. */
  revoke(): void;
  /** Rotate epoch/session; all capabilities from the previous lease become stale. */
  rotate(next: { readonly workerEpoch: string; readonly executorSessionHash: Hash }): void;
}

export interface TransportExecutionResultV1 {
  readonly transport: readonly RawTransportExecutionRecordV1[];
  readonly effects: readonly RawEffectObservationV1[];
}

export interface FrozenProgramExecutionViewV1 {
  readonly programId: Hash;
  readonly context: RejectionFactContextV1;
  readonly request: PersistedRequestRecordV1;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export interface RejectionTransportExecutorV1 {
  execute(
    program: FrozenProgramExecutionViewV1,
    signal: AbortSignal,
  ): Promise<TransportExecutionResultV1>;
}

export interface ReadonlyFactSetViewV1 {
  readonly programId: Hash;
  readonly runId: string;
  readonly stage: Exclude<AttestationStageV1, "framework">;
  readonly request: PersistedRequestRecordV1;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
  readonly transportFacts: readonly PersistedTransportFactRecordV1[];
  readonly effectObservations: readonly PersistedEffectObservationRecordV1[];
  readonly requestFingerprint: Hash;
  readonly orderedTransportFactsRoot: Hash;
  readonly effectObservationRoot: Hash;
}

export interface RejectionFactInterpretationResultV1<TDecision> {
  readonly decision: TDecision;
  readonly rejectionEvidence: RejectionEvidenceBundleV2 | null;
}

export interface RejectionFactWorkPlanePort {
  readonly builder: RejectionFactProgramBuilderPort;
  executeAndInterpret<TDecision extends object>(
    program: FrozenProgramCapabilityV1,
    interpret: (facts: ReadonlyFactSetViewV1, token: RejectionFactTokenV1) => Promise<TDecision>,
    signal: AbortSignal,
  ): Promise<RejectionFactInterpretationResultV1<TDecision>>;
}

export interface RejectionFactRuntimePort {
  readonly workPlane: RejectionFactWorkPlanePort;
}

export interface RejectionProofBindingV2 {
  readonly stage: Exclude<AttestationStageV1, "framework">;
  readonly chainId: string;
  readonly cutoffNumber: string;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  /** Exactly one of identitySubjectHash and instanceNominationKey is set. */
  readonly identitySubjectHash: Hash | null;
  readonly instanceNominationKey: string | null;
  readonly executorAuthorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
  readonly executionSessionHash: Hash;
  readonly cutoffHash: Hash;
  readonly cutoffStateRoot: Hash;
  readonly orderedTransportFactsRoot: Hash;
  readonly effectObservationRoot: Hash;
  readonly decisionCode: string;
  readonly decisionBytesHash: Hash;
  readonly requestFingerprint: Hash;
  readonly evidenceBundleRoot: Hash;
  readonly authorityRoot: Hash;
  readonly proofHash: Hash;
}

export interface AttestationOutcomeAuthorityBindingV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface CandidateFinalOutcomeFieldsV1 {
  readonly runCandidateKey: Hash;
  readonly familyCandidateKey: Hash;
}

export type CandidateFinalOutcomeBodyV1 =
  | (CandidateFinalOutcomeFieldsV1 & {
    readonly kind: "verified";
    readonly instanceKey: string;
    readonly publication: InstancePublicationV1;
    readonly identityCommitment: AttestationIdentityCommitmentV1;
  })
  | (CandidateFinalOutcomeFieldsV1 & {
    readonly kind: "chainProvenRejected";
    readonly proof: RejectionProofBindingV2;
    /** Exact child records needed by checkpoint/restart, not only roots. */
    readonly rejectionEvidence: RejectionEvidenceBundleV2;
    readonly identityCommitment: AttestationIdentityCommitmentV1 | null;
  })
  | (CandidateFinalOutcomeFieldsV1 & {
    readonly kind: "retryable";
    readonly failure: OutcomeFailureV1;
    readonly identityCommitment: AttestationIdentityCommitmentV1 | null;
  })
  | (CandidateFinalOutcomeFieldsV1 & {
    readonly kind: "invalidProgram";
    readonly failure: OutcomeFailureV1;
    readonly identityCommitment: AttestationIdentityCommitmentV1 | null;
  });

export type CandidateFinalOutcomeV1 = CandidateFinalOutcomeBodyV1
  & AttestationOutcomeAuthorityBindingV1
  & { readonly outcomeCommitment: AttestationOutcomeCommitmentV1 };

export type AttestationOutcomeCapabilityV1 = CandidateFinalOutcomeV1;

export type AttestationPartitionCapabilityV1 = Omit<AttestationPartitionV1, "outcomes"> & {
  readonly outcomes: readonly AttestationOutcomeCapabilityV1[];
};

/** Family output before the central release-bound issuer proof is attached. */
export interface IdentityVerifiedObservationV1 {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  /** Opaque, Family-owned canonical identity value. Central code only
   * canonicalizes it and commits it to the fixed memo hash domain. */
  readonly identityMemo: CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
}

export interface IdentityVerifiedV1 extends IdentityVerifiedObservationV1 {
  /** Exact content commitment bound to this runtime/candidate identity. */
  readonly identityCommitment: AttestationIdentityCommitmentV1;
}

export interface PluginRetryableDecisionV1 {
  readonly kind: "retryable";
  readonly failure: OutcomeFailureV1;
}

export interface FrameworkRetryableDecisionV1 {
  readonly kind: "retryable";
  readonly failure: OutcomeFailureV1;
  /** The transient issuer object is never persisted in the outcome. */
  readonly frameworkFailureToken: FrameworkFailureTokenV1;
}

export type RetryableDecisionV1 = PluginRetryableDecisionV1 | FrameworkRetryableDecisionV1;

export interface InvalidProgramDecisionV1 {
  readonly kind: "invalidProgram";
  readonly failure: OutcomeFailureV1;
}

export interface ChainProvenRejectedDecisionV1 {
  readonly kind: "chainProvenRejected";
  /** Only a process-local issuer token can enter the terminal path. */
  readonly rejectionFacts: RejectionFactTokenV1;
  /** Must exactly match the decision code in the issuer-owned evidence. */
  readonly decisionCode: string;
  /** Exact interpreter output retained by the framework fact session. */
  readonly decisionBytes: Uint8Array;
}

export type IdentityDecisionV1 =
  | IdentityVerifiedObservationV1
  | ChainProvenRejectedDecisionV1
  | RetryableDecisionV1
  | InvalidProgramDecisionV1;

export type InstanceDecisionV1 =
  | { readonly kind: "verified"; readonly publication: InstancePublicationV1 }
  | ChainProvenRejectedDecisionV1
  | RetryableDecisionV1
  | InvalidProgramDecisionV1;

export interface InstanceLifecycleSingleFlightPort {
  getOrBuild(key: Hash, build: () => Promise<InstanceDecisionV1>): Promise<InstanceDecisionV1>;
}

export interface AttestationProgramPort {
  attestIdentity(candidate: CandidateRecordV1, cutoff: CanonicalCutoffV1, signal: AbortSignal, rawEvidence: FamilyRawEvidenceReadPortV1): Promise<IdentityDecisionV1>;
  reuseVerifiedMemo?(
    candidate: CandidateRecordV1,
    publication: InstancePublicationV1,
    cutoff: CanonicalCutoffV1,
    signal: AbortSignal,
    rawEvidence: FamilyRawEvidenceReadPortV1,
  ): Promise<VerifiedMemoReuseDecisionV1>;
  materializeAndProject(
    candidate: CandidateRecordV1,
    identity: IdentityVerifiedObservationV1,
    cutoff: CanonicalCutoffV1,
    signal: AbortSignal,
    rawEvidence: FamilyRawEvidenceReadPortV1,
  ): Promise<InstanceDecisionV1>;
}

export type VerifiedMemoReuseDecisionV1 =
  | {
    readonly kind: "reusable";
    readonly identity: IdentityVerifiedObservationV1;
    readonly proof: import("./internal-authority.ts").VerifiedMemoReuseProofV1;
  }
  | { readonly kind: "requiresAttestation" };

export interface AttestationRunSessionInputV1 {
  /** Checkpoint-issued opaque capability; all run/cutoff/root/key facts derive from it. */
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  /** Opaque capabilities reissued by the constructor-bound authority from exact durable partials. */
  readonly identityResumeCapabilities?: readonly AttestationIdentityResumeCapabilityV1[];
  /** Opaque capabilities reissued by the constructor-bound authority from exact durable final outcomes. */
  readonly outcomeResumeCapabilities?: readonly AttestationOutcomeResumeCapabilityV1[];
  /** One-shot handles issued from the active run's root-reachable prior
   * VerifiedMemoSet. Callers cannot construct or pass publication DTOs. */
  readonly verifiedMemoReuseCapabilities?: readonly AttestationVerifiedMemoReuseCapabilityV1[];
}

export type AttestationWriterCapabilityV1 = object;

/** Process-local opaque proof that an exact durable partial identity may be reused once. */
export type AttestationIdentityResumeCapabilityV1 = object;

/** Process-local opaque proof that an exact durable final outcome may be reused once. */
export type AttestationOutcomeResumeCapabilityV1 = object;

/** Process-local opaque proof that one root-reachable verified publication
 * may be considered once for one exact current candidate. */
export type AttestationVerifiedMemoReuseCapabilityV1 = object;

/**
 * Session-local proof that an identity result was produced by this session.
 * The object has no public fields; materialization and collision admission
 * must validate its issuer-owned WeakMap entry rather than trust a copied
 * candidate/identity pair.
 */
export type AttestationIdentityContinuationV1 = object;

export interface AttestationIdentityResumeInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  readonly candidatePartitionReader: CandidatePartitionReaderPortV1;
  readonly familyCandidateKey: Hash;
  readonly identity: IdentityVerifiedV1;
  readonly outcomeHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationOutcomeResumeInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  readonly candidatePartitionReader: CandidatePartitionReaderPortV1;
  readonly familyCandidateKey: Hash;
  readonly candidate: CandidateRecordV1;
  readonly outcome: AttestationOutcomeCapabilityV1;
  readonly outcomeHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationVerifiedMemoReuseInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  readonly candidatePartitionReader: CandidatePartitionReaderPortV1;
  readonly familyCandidateKey: Hash;
  readonly publication: InstancePublicationV1;
  readonly verifiedMemoSetRoot: Hash;
}

export interface AttestationOutcomeBindingContextV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
}

export type AttestationPersistenceCapabilityV1 = {
  readonly runId: string;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly outcomeHash: Hash;
  readonly stage: "identity" | "materialization";
};

export interface AttestationPersistedOutcomeV1 {
  readonly runId: string;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly outcomeHash: Hash;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly kind: "partial-identity" | "final";
  readonly identity: IdentityVerifiedV1 | null;
  readonly outcome: AttestationOutcomeCapabilityV1 | null;
}

export function attestationPartialIdentitySemanticHash(
  input: Pick<
    AttestationIdentityResumeInputV1 & {
      readonly candidatePartitionRoot: Hash;
      readonly candidate: CandidateRecordV1;
    },
    | "runId"
    | "cutoff"
    | "candidatePartitionRoot"
    | "candidate"
    | "identity"
    | "runtimeAuthority"
    | "attestationAuthorityRoot"
    | "frameworkAuthorityRoot"
    | "executorAuthorityRoot"
  >,
): Hash {
  return hashDomain("aloha/attestation-partial-identity/v2", {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    candidate: input.candidate,
    identity: input.identity,
    identityCommitmentHash: input.identity.identityCommitment.commitmentHash,
    runtimeAuthority: input.runtimeAuthority,
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    frameworkAuthorityRoot: input.frameworkAuthorityRoot,
    executorAuthorityRoot: input.executorAuthorityRoot,
  });
}

/**
 * A writer batch is claimed atomically before durable I/O.  The claim is
 * process-local and must be committed only after the enclosing durable
 * transaction succeeds; abort releases every capability in the batch.
 */
export interface AttestationPersistenceBatchClaimV1 {
  readonly entries: readonly AttestationPersistedOutcomeV1[];
  commit(): void;
  abort(): void;
}

export type AttestationIdentitySessionResultV1 =
  | {
    readonly kind: "identityVerified";
    /** `durable` means the identity came from a checkpoint-owned partial and
     * must not be enqueued as a new partial again. */
    readonly durability: "new" | "durable";
    readonly candidate: CandidateRecordV1;
    readonly identity: IdentityVerifiedV1;
    readonly continuation: AttestationIdentityContinuationV1;
    readonly persistenceCapability: AttestationPersistenceCapabilityV1;
  }
  | AttestationFinalSessionResultV1;

export interface AttestationFinalSessionResultV1 {
  readonly kind: "final";
  /** `durable` means the final outcome was rehydrated from checkpoint and
   * must not be treated as a newly produced final. */
  readonly durability: "new" | "durable";
  readonly outcome: AttestationOutcomeCapabilityV1;
  readonly persistenceCapability: AttestationPersistenceCapabilityV1;
}

export interface AttestationRunSessionV1 {
  readonly writerCapability: AttestationWriterCapabilityV1;
  /** Resolve the exact constructor-bound candidate denominator. Callers
   * cannot substitute a key list or materialize before this barrier. */
  readonly resolveIdentityDenominator: (
    signal: AbortSignal,
  ) => Promise<readonly AttestationIdentitySessionResultV1[]>;
  readonly resolveIdentityOrReuseProofOnce: (
    familyCandidateKey: Hash,
    signal: AbortSignal,
  ) => Promise<AttestationIdentitySessionResultV1>;
  readonly materializeAndProjectOnce: (
    continuation: AttestationIdentityContinuationV1,
    signal: AbortSignal,
  ) => Promise<AttestationFinalSessionResultV1>;
  readonly issueNominationKeyCollision: (
    group: readonly AttestationIdentityContinuationV1[],
  ) => readonly AttestationFinalSessionResultV1[];
  readonly sealExactPartition: (
    outcomeHashes: readonly Hash[],
  ) => AttestationPartitionCapabilityV1;
}

/**
 * The public attestation entry point.  Terminal rejection validation and the
 * framework failure authority are constructor-bound; callers cannot inject a
 * validator or executor authority for one run.
 */
export interface AttestationServiceV1 {
  readonly validationAuthority: AttestationValidationAuthorityV1;
  readonly openRunSession: (input: AttestationRunSessionInputV1) => AttestationRunSessionV1;
}

export interface AttestationServiceConstructorV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly frameworkRuntime: FrameworkFailureRuntimePort;
  readonly rejectionRuntime: RejectionFactRuntimePort;
  readonly programs: AttestationProgramPort;
  readonly instanceLifecycle: InstanceLifecycleSingleFlightPort;
  /** Constructor-bound checkpoint reader; callers cannot substitute a reader per run. */
  readonly candidatePartitionReader: CandidatePartitionReaderPortV1;
}

export interface AttestationOutcomeValidationContextV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
}

export interface AttestationValidationAuthorityV1 {
  readonly [ATTESTATION_VALIDATION_AUTHORITY_BRAND]: true;
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly authorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readEvidenceAuthority(): AttestationEvidenceAuthoritySnapshotV1;
  claimWriterCapabilities(
    writerCapability: AttestationWriterCapabilityV1,
    persistenceCapabilities: readonly AttestationPersistenceCapabilityV1[],
  ): AttestationPersistenceBatchClaimV1;
  validateOutcomeCapability(
    value: unknown,
    context: AttestationOutcomeValidationContextV1,
  ): CandidateFinalOutcomeV1;
  validatePartitionCapability(
    value: unknown,
    candidates: readonly CandidateRecordV1[],
  ): AttestationPartitionV1;
  validateDurableOutcome(
    value: unknown,
    context: AttestationOutcomeValidationContextV1,
  ): CandidateFinalOutcomeV1;
  validateDurablePartition(
    value: unknown,
    candidates: readonly CandidateRecordV1[],
  ): AttestationPartitionV1;
}

export interface AttestationEvidenceAuthoritySnapshotV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationPartitionV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly outcomes: readonly CandidateFinalOutcomeV1[];
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly accounting: {
    readonly pending: string;
    readonly verified: string;
    readonly chainProvenRejected: string;
    readonly retryable: string;
    readonly invalidProgram: string;
  };
  readonly exactOutcomePartitionRoot: Hash;
}

export interface StoredRetryableProbeV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly checkpointRevision: string;
  readonly probeCapability: RetryableProbeCapabilityV1;
  readonly candidatePartition: CandidatePartitionCapabilityV1;
  readonly candidatePartitionBinding: CandidatePartitionCommitmentV1;
  readonly candidateSubjectHash: Hash;
  readonly before: Extract<CandidateFinalOutcomeV1, { readonly kind: "retryable" }>;
  readonly beforeOutcomeHash: Hash;
}

/** Checkpoint-issued, one-shot authorization for replacing one retryable outcome. */
export type RetryableProbeCapabilityV1 = object;

export interface ProbeStorePort {
  loadRetryable(runId: string, familyCandidateKey: Hash): Promise<StoredRetryableProbeV1>;
  listRetryableCandidateKeys(runId: string, failureCode: string): Promise<readonly Hash[]>;
  replaceRetryableCAS(
    probeCapability: RetryableProbeCapabilityV1,
    writerCapability: AttestationWriterCapabilityV1,
    persistenceCapability: AttestationPersistenceCapabilityV1,
  ): Promise<ProbeReceiptV1>;
}

export interface ProbeReceiptV1 {
  readonly runId: string;
  readonly familyCandidateKey: Hash;
  readonly cutoff: CanonicalCutoffV1;
  readonly beforeOutcomeHash: Hash;
  readonly afterOutcomeHash: Hash;
  readonly beforeKind: "retryable";
  readonly afterKind: CandidateFinalOutcomeV1["kind"];
  readonly candidateSubjectHash: Hash;
  readonly evidenceRoot: Hash;
  readonly checkpointRevisionBefore: string;
  readonly checkpointRevision: string;
  readonly priorOutcomePartitionRoot: Hash;
  readonly activeOutcomePartitionRoot: Hash;
  readonly canonicalJournalEpoch: string;
  readonly canonicalJournalRoot: Hash;
  readonly transitionAuthorityRoot: Hash;
  readonly sequence: string;
  readonly priorReceiptHash: Hash | null;
  readonly priorLineageRoot: Hash;
  readonly receiptLineageRoot: Hash;
  readonly probeReceiptHash: Hash;
}

export type ProbeReceiptInputV1 = Omit<ProbeReceiptV1, "transitionAuthorityRoot" | "receiptLineageRoot" | "probeReceiptHash">;
export const EMPTY_PROBE_RECEIPT_LINEAGE_ROOT = hashDomain("aloha/single-instance-probe-lineage-empty/v1", {});
export function rejectionAuthorityRoot(
  familyDefinitionHash: Hash,
  stage: RejectionProofBindingV2["stage"],
): Hash {
  return hashDomain("aloha/chain-rejection-authority/v2", { familyDefinitionHash, stage });
}

export interface ExecutorAuthoritySnapshotV1 {
  readonly authorityRoot: Hash;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
}

export function sourceMatchesAuthority(
  source: ExecutionSourceAnchorV1,
  authority: ExecutorAuthoritySnapshotV1,
  context: string,
): void {
  if (
    source.executorAuthorityRoot !== authority.authorityRoot
    || source.workerEpoch !== authority.workerEpoch
    || source.executorSessionHash !== authority.executorSessionHash
  ) throw new TypeError(`${context} is not bound to the executor authority/session`);
}

export function rejectionProofHash(input: Omit<RejectionProofBindingV2, "proofHash">): Hash {
  return hashDomain("aloha/chain-rejection-proof/v4", input);
}

export function assertNativeBytes(value: unknown, context: string, allowEmpty = false): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || Object.getPrototypeOf(value) !== Uint8Array.prototype
    || Object.getOwnPropertyDescriptor(value, "length") !== undefined
  ) throw new TypeError(`${context} must be a native Uint8Array`);
  if (!allowEmpty && value.length === 0) throw new TypeError(`${context} must not be empty`);
  return Uint8Array.from(value);
}

export function bytesToHex(value: Uint8Array): CanonicalBytesHexV1 {
  let result = "0x";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result as CanonicalBytesHexV1;
}

export function hexToBytes(value: unknown, context: string, allowEmpty = false): Uint8Array {
  if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value)) {
    throw new TypeError(`${context} must be lowercase even-length bytes`);
  }
  if (!allowEmpty && value === "0x") throw new TypeError(`${context} must not be empty`);
  const result = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return result;
}

export function freezeCanonicalObject(value: unknown, context: string): CanonicalJsonObject {
  assertPlainObject(value, context);
  // Decode the exact canonical bytes to remove prototypes/accessors and to
  // retain only the value that was actually committed by the issuer.
  return decodeCanonicalJson(encodeCanonicalBytes(value)) as CanonicalJsonObject;
}

export function freezeRequestRecord(value: FrozenRequestRecordV1, context: string): PersistedRequestRecordV1 {
  assertPlainObject(value, context);
  assertExactKeys(value, ["requestId", "record"], context);
  const requestId = assertHash(value.requestId, `${context}.requestId`);
  const record = freezeCanonicalObject(value.record, `${context}.record`);
  return deepFreeze({
    requestId,
    record,
    canonicalBytesHex: bytesToHex(encodeCanonicalBytes(record)),
  });
}

export function freezeCandidateRecord(
  value: CandidateRecordV1,
  context: string,
): CandidateRecordV1 {
  const candidate = exactObject(value, [
    "kind",
    "version",
    "familyId",
    "familyDefinitionHash",
    "instanceNominationKey",
    "familyCandidateKey",
    "candidateSubjectHash",
    "candidateEvidenceRoot",
    "evidence",
  ], context);
  if (!Array.isArray(candidate.evidence)) throw new TypeError(`${context}.evidence must be an array`);
  const normalized = decodeCanonicalJson(encodeCanonicalBytes({
    kind: candidate.kind === "aloha.candidate-record" ? candidate.kind : (() => { throw new TypeError(`${context}.kind is invalid`); })(),
    version: candidate.version === "2" ? candidate.version : (() => { throw new TypeError(`${context}.version is invalid`); })(),
    familyId: assertNonEmptyString(candidate.familyId, `${context}.familyId`),
    familyDefinitionHash: assertHash(candidate.familyDefinitionHash, `${context}.familyDefinitionHash`),
    instanceNominationKey: assertNonEmptyString(candidate.instanceNominationKey, `${context}.instanceNominationKey`),
    familyCandidateKey: assertHash(candidate.familyCandidateKey, `${context}.familyCandidateKey`),
    candidateSubjectHash: assertHash(candidate.candidateSubjectHash, `${context}.candidateSubjectHash`),
    candidateEvidenceRoot: assertHash(candidate.candidateEvidenceRoot, `${context}.candidateEvidenceRoot`),
    evidence: candidate.evidence,
  })) as unknown as CandidateRecordV1;
  return deepFreeze(normalized);
}

export function freezeRejectionContext(
  value: RejectionFactContextV1,
  context: string,
): RejectionFactContextV1 {
  const raw = exactObject(value, ["runId", "candidate", "cutoff", "stage", "identitySubjectHash"], context);
  const cutoffRaw = exactObject(raw.cutoff, ["chainId", "number", "hash", "stateRoot"], `${context}.cutoff`);
  const cutoff = deepFreeze({
    chainId: assertNonEmptyString(cutoffRaw.chainId, `${context}.cutoff.chainId`),
    number: assertDecimalString(cutoffRaw.number, `${context}.cutoff.number`),
    hash: assertHash(cutoffRaw.hash, `${context}.cutoff.hash`),
    stateRoot: assertHash(cutoffRaw.stateRoot, `${context}.cutoff.stateRoot`),
  });
  const candidate = freezeCandidateRecord(raw.candidate as unknown as CandidateRecordV1, `${context}.candidate`);
  const stage = raw.stage;
  if (!(stage === "identity" || stage === "materialization" || stage === "projection")) {
    throw new TypeError(`${context}.stage is invalid`);
  }
  const identitySubjectHash = raw.identitySubjectHash === null
    ? null
    : assertHash(raw.identitySubjectHash, `${context}.identitySubjectHash`);
  return deepFreeze({
    runId: assertNonEmptyString(raw.runId, `${context}.runId`),
    candidate,
    cutoff,
    stage,
    identitySubjectHash,
  });
}

export function freezeExecutionSource(
  value: unknown,
  context: string,
  cutoff: CanonicalCutoffV1,
  authority: ExecutorAuthoritySnapshotV1 | null = null,
): ExecutionSourceAnchorV1 {
  const source = exactObject(value, [
    "chainId",
    "blockNumber",
    "blockHash",
    "stateRoot",
    "executorAuthorityRoot",
    "workerEpoch",
    "executorSessionHash",
  ], context);
  const decoded = deepFreeze({
    chainId: assertNonEmptyString(source.chainId, `${context}.chainId`),
    blockNumber: assertDecimalString(source.blockNumber, `${context}.blockNumber`),
    blockHash: assertHash(source.blockHash, `${context}.blockHash`),
    stateRoot: assertHash(source.stateRoot, `${context}.stateRoot`),
    executorAuthorityRoot: assertHash(
      source.executorAuthorityRoot,
      `${context}.executorAuthorityRoot`,
    ),
    workerEpoch: assertNonEmptyString(source.workerEpoch, `${context}.workerEpoch`),
    executorSessionHash: assertHash(
      source.executorSessionHash,
      `${context}.executorSessionHash`,
    ),
  });
  if (
    decoded.chainId !== cutoff.chainId
    || decoded.blockNumber !== cutoff.number
    || decoded.blockHash !== cutoff.hash
    || decoded.stateRoot !== cutoff.stateRoot
  ) throw new TypeError(`${context} is not bound to the attestation cutoff`);
  if (authority) sourceMatchesAuthority(decoded, authority, context);
  return decoded;
}

export function freezeRawTransportRecord(
  value: RawTransportExecutionRecordV1,
  context: string,
  requestId: Hash,
  expectedOrdinal: number,
  cutoff: CanonicalCutoffV1,
  authority: ExecutorAuthoritySnapshotV1,
): PersistedTransportFactRecordV1 {
  assertPlainObject(value, context);
  assertExactKeys(value, ["requestId", "kind", "data", "source"], context);
  if (value.requestId !== requestId) throw new TypeError(`${context}.requestId mismatch`);
  if (!(["returned", "reverted", "transportFailure"] as readonly string[]).includes(value.kind)) {
    throw new TypeError(`${context}.kind is invalid`);
  }
  const data = assertNativeBytes(value.data, `${context}.data`, true);
  const source = freezeExecutionSource(value.source, `${context}.source`, cutoff, authority);
  const fact = freezeCanonicalObject({
    requestId,
    ordinal: String(expectedOrdinal),
    kind: value.kind,
    dataHex: bytesToHex(data),
    source,
  }, `${context}.fact`);
  return deepFreeze({
    ordinal: String(expectedOrdinal),
    requestId,
    kind: value.kind,
    fact,
    canonicalBytesHex: bytesToHex(encodeCanonicalBytes(fact)),
  });
}

export function freezeRawEffectObservation(
  value: RawEffectObservationV1,
  context: string,
  requestId: Hash,
  expectedOrdinal: number,
  cutoff: CanonicalCutoffV1,
  authority: ExecutorAuthoritySnapshotV1,
): PersistedEffectObservationRecordV1 {
  assertPlainObject(value, context);
  assertExactKeys(value, ["requestId", "source", "observation"], context);
  if (value.requestId !== requestId) throw new TypeError(`${context}.requestId mismatch`);
  const source = freezeExecutionSource(value.source, `${context}.source`, cutoff, authority);
  const observation = freezeCanonicalObject({
    requestId,
    ordinal: String(expectedOrdinal),
    source,
    value: value.observation,
  }, `${context}.observation`);
  return deepFreeze({
    ordinal: String(expectedOrdinal),
    requestId,
    observation,
    canonicalBytesHex: bytesToHex(encodeCanonicalBytes(observation)),
  });
}

export function requestFingerprint(request: PersistedRequestRecordV1): Hash {
  return hashDomainBytes("aloha/rejection-request-fingerprint/v1", hexToBytes(request.canonicalBytesHex, "request.canonicalBytesHex"));
}

export function orderedTransportFactsRoot(facts: readonly PersistedTransportFactRecordV1[]): Hash {
  return hashCanonicalPartition(
    "aloha/rejection-ordered-transport-facts/v1",
    facts,
  );
}

export function effectObservationRoot(facts: readonly PersistedEffectObservationRecordV1[]): Hash {
  return hashCanonicalPartition(
    "aloha/rejection-effect-observations/v1",
    facts,
  );
}

export function decisionBytesHash(bytesHex: CanonicalBytesHexV1): Hash {
  return hashDomainBytes("aloha/rejection-decision-bytes/v1", hexToBytes(bytesHex, "decisionBytesHex"));
}

export function evidenceBundleRoot(value: Omit<RejectionEvidenceBundleV2, "evidenceBundleRoot">): Hash {
  return hashDomain("aloha/rejection-evidence-bundle/v2", value);
}

export function rejectionTokenHash(value: Omit<IssuedRejectionFactTokenV1, "tokenHash">): Hash {
  return hashDomain("aloha/rejection-fact-token/v2", value);
}

export function rejectionContextValues(context: RejectionFactContextV1): {
  readonly runId: string;
  readonly chainId: string;
  readonly cutoffNumber: string;
  readonly cutoffHash: Hash;
  readonly cutoffStateRoot: Hash;
  readonly stage: Exclude<AttestationStageV1, "framework">;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identitySubjectHash: Hash | null;
  readonly instanceNominationKey: string | null;
} {
  const candidate = context.candidate;
  const runId = assertNonEmptyString(context.runId, "rejection.context.runId");
  const chainId = assertNonEmptyString(context.cutoff.chainId, "rejection.context.cutoff.chainId");
  const cutoffNumber = assertDecimalString(context.cutoff.number, "rejection.context.cutoff.number");
  const cutoffHash = assertHash(context.cutoff.hash, "rejection.context.cutoff.hash");
  const cutoffStateRoot = assertHash(context.cutoff.stateRoot, "rejection.context.cutoff.stateRoot");
  const familyDefinitionHash = assertHash(candidate.familyDefinitionHash, "rejection.context.familyDefinitionHash");
  const familyCandidateKey = assertHash(candidate.familyCandidateKey, "rejection.context.familyCandidateKey");
  const candidateSubjectHash = assertHash(candidate.candidateSubjectHash, "rejection.context.candidateSubjectHash");
  const identitySubjectHash = context.identitySubjectHash === null
    ? null
    : assertHash(context.identitySubjectHash, "rejection.context.identitySubjectHash");
  if (context.stage === "identity") {
    if (identitySubjectHash !== null) throw new TypeError("identity rejection cannot bind verified identity subject");
  } else if (identitySubjectHash === null) {
    throw new TypeError("post-identity rejection must bind verified identity subject");
  }
  return deepFreeze({
    runId,
    chainId,
    cutoffNumber,
    cutoffHash,
    cutoffStateRoot,
    stage: context.stage,
    familyDefinitionHash,
    familyCandidateKey,
    candidateSubjectHash,
    identitySubjectHash,
    instanceNominationKey: context.stage === "identity" ? assertNonEmptyString(candidate.instanceNominationKey, "rejection.context.instanceNominationKey") : null,
  });
}

export function rejectionProgramId(
  context: RejectionFactContextV1,
  request: PersistedRequestRecordV1,
  authority: ExecutorAuthoritySnapshotV1,
): Hash {
  return hashDomain("aloha/rejection-frozen-program/v2", {
    context: freezeRejectionContext(context, "rejection.programId.context"),
    request,
    executorAuthorityRoot: authority.authorityRoot,
    workerEpoch: authority.workerEpoch,
    executorSessionHash: authority.executorSessionHash,
  });
}

export interface GeneratedFactSetV1 {
  readonly context: RejectionFactContextV1;
  readonly request: PersistedRequestRecordV1;
  readonly authority: ExecutorAuthoritySnapshotV1;
  readonly executionSessionHash: Hash;
  readonly transportFacts: readonly PersistedTransportFactRecordV1[];
  readonly effectObservations: readonly PersistedEffectObservationRecordV1[];
}

export function evidenceBundleWithoutRoot(
  facts: GeneratedFactSetV1,
  decisionCode: string,
  decisionBytes: Uint8Array,
): Omit<RejectionEvidenceBundleV2, "evidenceBundleRoot"> {
  const context = rejectionContextValues(facts.context);
  const request = facts.request;
  const transportFacts = facts.transportFacts;
  if (transportFacts.length === 0) throw new TypeError("rejection.transportFacts must not be empty");
  if (transportFacts.some(fact => fact.kind === "transportFailure")) {
    throw new TypeError("rejection.transportFacts contains transport failure");
  }
  const effectObservations = facts.effectObservations;
  const normalizedDecisionCode = assertNonEmptyString(decisionCode, "rejection.decisionCode");
  const normalizedDecisionBytes = assertNativeBytes(decisionBytes, "rejection.decisionBytes");
  const decisionBytesHex = bytesToHex(normalizedDecisionBytes);
  const requestFingerprintValue = requestFingerprint(request);
  const orderedTransportFactsRootValue = orderedTransportFactsRoot(transportFacts);
  const effectObservationRootValue = effectObservationRoot(effectObservations);
  const decisionBytesHashValue = decisionBytesHash(decisionBytesHex);
  return deepFreeze({
    kind: REJECTION_BUNDLE_KIND,
    version: REJECTION_BUNDLE_VERSION,
    issuerId: REJECTION_ISSUER_ID,
    ...context,
    executorAuthorityRoot: facts.authority.authorityRoot,
    workerEpoch: facts.authority.workerEpoch,
    executorSessionHash: facts.authority.executorSessionHash,
    executionSessionHash: facts.executionSessionHash,
    request,
    transportFacts: deepFreeze(transportFacts),
    effectObservations: deepFreeze(effectObservations),
    decisionCode: normalizedDecisionCode,
    decisionBytesHex,
    requestFingerprint: requestFingerprintValue,
    orderedTransportFactsRoot: orderedTransportFactsRootValue,
    effectObservationRoot: effectObservationRootValue,
    decisionBytesHash: decisionBytesHashValue,
  });
}

export function decodePersistedRequestRecord(value: unknown, context: string): PersistedRequestRecordV1 {
  const record = exactObject(value, ["requestId", "record", "canonicalBytesHex"], context);
  const requestId = assertHash(record.requestId, `${context}.requestId`);
  const canonicalBytesHex = record.canonicalBytesHex as CanonicalBytesHexV1;
  const bytes = hexToBytes(canonicalBytesHex, `${context}.canonicalBytesHex`);
  const normalizedRecord = freezeCanonicalObject(record.record, `${context}.record`);
  assertExactCanonicalBytes(normalizedRecord, bytes);
  return deepFreeze({ requestId, record: normalizedRecord, canonicalBytesHex });
}

export function decodePersistedTransportFactRecord(
  value: unknown,
  context: string,
  requestId: Hash,
  expectedOrdinal: number,
): PersistedTransportFactRecordV1 {
  const record = exactObject(value, ["ordinal", "requestId", "kind", "fact", "canonicalBytesHex"], context);
  if (record.ordinal !== String(expectedOrdinal)) throw new TypeError(`${context}.ordinal is not contiguous`);
  if (record.requestId !== requestId) throw new TypeError(`${context}.requestId mismatch`);
  if (!(["returned", "reverted", "transportFailure"] as readonly string[]).includes(String(record.kind))) {
    throw new TypeError(`${context}.kind is invalid`);
  }
  const canonicalBytesHex = record.canonicalBytesHex as CanonicalBytesHexV1;
  const bytes = hexToBytes(canonicalBytesHex, `${context}.canonicalBytesHex`);
  const fact = freezeCanonicalObject(record.fact, `${context}.fact`);
  assertExactCanonicalBytes(fact, bytes);
  return deepFreeze({
    ordinal: String(record.ordinal),
    requestId,
    kind: record.kind as TransportFactKindV1,
    fact,
    canonicalBytesHex,
  });
}

export function decodePersistedEffectObservationRecord(
  value: unknown,
  context: string,
  requestId: Hash,
  expectedOrdinal: number,
): PersistedEffectObservationRecordV1 {
  const record = exactObject(value, ["ordinal", "requestId", "observation", "canonicalBytesHex"], context);
  if (record.ordinal !== String(expectedOrdinal)) throw new TypeError(`${context}.ordinal is not contiguous`);
  if (record.requestId !== requestId) throw new TypeError(`${context}.requestId mismatch`);
  const canonicalBytesHex = record.canonicalBytesHex as CanonicalBytesHexV1;
  const bytes = hexToBytes(canonicalBytesHex, `${context}.canonicalBytesHex`);
  const observation = freezeCanonicalObject(record.observation, `${context}.observation`);
  assertExactCanonicalBytes(observation, bytes);
  return deepFreeze({
    ordinal: String(record.ordinal),
    requestId,
    observation,
    canonicalBytesHex,
  });
}

export function validateEvidenceBundle(value: unknown, context: string): RejectionEvidenceBundleV2 {
  const raw = exactObject(value, [
    "kind", "version", "issuerId", "runId", "chainId", "cutoffNumber", "cutoffHash", "cutoffStateRoot",
    "stage", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash", "identitySubjectHash",
    "instanceNominationKey", "executorAuthorityRoot", "workerEpoch", "executorSessionHash", "executionSessionHash", "request", "transportFacts", "effectObservations", "decisionCode", "decisionBytesHex",
    "requestFingerprint", "orderedTransportFactsRoot", "effectObservationRoot", "decisionBytesHash", "evidenceBundleRoot",
  ], context);
  if (raw.kind !== REJECTION_BUNDLE_KIND || raw.version !== REJECTION_BUNDLE_VERSION || raw.issuerId !== REJECTION_ISSUER_ID) {
    throw new TypeError(`${context}.issuer/version/kind is invalid`);
  }
  const stage = raw.stage as AttestationStageV1;
  if (!(["identity", "materialization", "projection"] as readonly string[]).includes(stage)) {
    throw new TypeError(`${context}.stage is invalid`);
  }
  const identitySubjectHash = raw.identitySubjectHash === null
    ? null
    : assertHash(raw.identitySubjectHash, `${context}.identitySubjectHash`);
  const instanceNominationKey = raw.instanceNominationKey === null
    ? null
    : assertNonEmptyString(raw.instanceNominationKey, `${context}.instanceNominationKey`);
  if ((stage === "identity") !== (identitySubjectHash === null && instanceNominationKey !== null)) {
    throw new TypeError(`${context}.identity/nomination binding is invalid`);
  }
  if (stage !== "identity" && (identitySubjectHash === null || instanceNominationKey !== null)) {
    throw new TypeError(`${context}.post-identity binding is invalid`);
  }
  const request = decodePersistedRequestRecord(raw.request, `${context}.request`);
  if (!Array.isArray(raw.transportFacts) || raw.transportFacts.length === 0) {
    throw new TypeError(`${context}.transportFacts must not be empty`);
  }
  if (!Array.isArray(raw.effectObservations)) throw new TypeError(`${context}.effectObservations must be an array`);
  const transportFacts = raw.transportFacts.map((fact, index) => decodePersistedTransportFactRecord(
    fact,
    `${context}.transportFacts[${index}]`,
    request.requestId,
    index,
  ));
  if (transportFacts.some(fact => fact.kind === "transportFailure")) {
    throw new TypeError(`${context}.transportFacts contains transport failure`);
  }
  const effectObservations = raw.effectObservations.map((effect, index) => decodePersistedEffectObservationRecord(
    effect,
    `${context}.effectObservations[${index}]`,
    request.requestId,
    index,
  ));
  const decisionBytesHex = raw.decisionBytesHex as CanonicalBytesHexV1;
  hexToBytes(decisionBytesHex, `${context}.decisionBytesHex`);
  const decoded = deepFreeze({
    kind: REJECTION_BUNDLE_KIND,
    version: REJECTION_BUNDLE_VERSION,
    issuerId: REJECTION_ISSUER_ID,
    runId: assertNonEmptyString(raw.runId, `${context}.runId`),
    chainId: assertNonEmptyString(raw.chainId, `${context}.chainId`),
    cutoffNumber: assertDecimalString(raw.cutoffNumber, `${context}.cutoffNumber`),
    cutoffHash: assertHash(raw.cutoffHash, `${context}.cutoffHash`),
    cutoffStateRoot: assertHash(raw.cutoffStateRoot, `${context}.cutoffStateRoot`),
    stage: stage as Exclude<AttestationStageV1, "framework">,
    familyDefinitionHash: assertHash(raw.familyDefinitionHash, `${context}.familyDefinitionHash`),
    familyCandidateKey: assertHash(raw.familyCandidateKey, `${context}.familyCandidateKey`),
    candidateSubjectHash: assertHash(raw.candidateSubjectHash, `${context}.candidateSubjectHash`),
    identitySubjectHash,
    instanceNominationKey,
    executorAuthorityRoot: assertHash(raw.executorAuthorityRoot, `${context}.executorAuthorityRoot`),
    workerEpoch: assertNonEmptyString(raw.workerEpoch, `${context}.workerEpoch`),
    executorSessionHash: assertHash(raw.executorSessionHash, `${context}.executorSessionHash`),
    executionSessionHash: assertHash(raw.executionSessionHash, `${context}.executionSessionHash`),
    request,
    transportFacts: deepFreeze(transportFacts),
    effectObservations: deepFreeze(effectObservations),
    decisionCode: assertNonEmptyString(raw.decisionCode, `${context}.decisionCode`),
    decisionBytesHex,
    requestFingerprint: assertHash(raw.requestFingerprint, `${context}.requestFingerprint`),
    orderedTransportFactsRoot: assertHash(raw.orderedTransportFactsRoot, `${context}.orderedTransportFactsRoot`),
    effectObservationRoot: assertHash(raw.effectObservationRoot, `${context}.effectObservationRoot`),
    decisionBytesHash: assertHash(raw.decisionBytesHash, `${context}.decisionBytesHash`),
    evidenceBundleRoot: assertHash(raw.evidenceBundleRoot, `${context}.evidenceBundleRoot`),
  });
  const { evidenceBundleRoot: _ignoredEvidenceBundleRoot, ...withoutRoot } = decoded;
  const cutoff = deepFreeze({
    chainId: decoded.chainId,
    number: decoded.cutoffNumber,
    hash: decoded.cutoffHash,
    stateRoot: decoded.cutoffStateRoot,
  });
  for (const [index, transport] of decoded.transportFacts.entries()) {
    const fact = exactObject(
      transport.fact,
      ["requestId", "ordinal", "kind", "dataHex", "source"],
      `${context}.transportFacts[${index}].fact`,
    );
    if (
      fact.requestId !== decoded.request.requestId
      || fact.ordinal !== String(index)
      || fact.kind !== transport.kind
    ) throw new TypeError(`${context}.transportFacts[${index}] lineage mismatch`);
    hexToBytes(fact.dataHex, `${context}.transportFacts[${index}].fact.dataHex`, true);
    const source = freezeExecutionSource(
      fact.source,
      `${context}.transportFacts[${index}].fact.source`,
      cutoff,
      {
        authorityRoot: decoded.executorAuthorityRoot,
        workerEpoch: decoded.workerEpoch,
        executorSessionHash: decoded.executorSessionHash,
      },
    );
    if (
      encodeCanonicalJson(source) !== encodeCanonicalJson(fact.source)
    ) throw new TypeError(`${context}.transportFacts[${index}].fact.source is not normalized`);
  }
  for (const [index, effect] of decoded.effectObservations.entries()) {
    const observation = exactObject(
      effect.observation,
      ["requestId", "ordinal", "source", "value"],
      `${context}.effectObservations[${index}].observation`,
    );
    if (
      observation.requestId !== decoded.request.requestId
      || observation.ordinal !== String(index)
    ) throw new TypeError(`${context}.effectObservations[${index}] lineage mismatch`);
    const source = freezeExecutionSource(
      observation.source,
      `${context}.effectObservations[${index}].observation.source`,
      cutoff,
      {
        authorityRoot: decoded.executorAuthorityRoot,
        workerEpoch: decoded.workerEpoch,
        executorSessionHash: decoded.executorSessionHash,
      },
    );
    if (encodeCanonicalJson(source) !== encodeCanonicalJson(observation.source)) {
      throw new TypeError(`${context}.effectObservations[${index}].observation.source is not normalized`);
    }
    freezeCanonicalObject(
      observation.value,
      `${context}.effectObservations[${index}].observation.value`,
    );
  }
  const expectedRequest = requestFingerprint(decoded.request);
  const expectedTransport = orderedTransportFactsRoot(decoded.transportFacts);
  const expectedEffect = effectObservationRoot(decoded.effectObservations);
  const expectedDecision = decisionBytesHash(decoded.decisionBytesHex);
  if (
    decoded.requestFingerprint !== expectedRequest
    || decoded.orderedTransportFactsRoot !== expectedTransport
    || decoded.effectObservationRoot !== expectedEffect
    || decoded.decisionBytesHash !== expectedDecision
    || decoded.evidenceBundleRoot !== evidenceBundleRoot(withoutRoot)
  ) throw new TypeError(`${context} content root mismatch`);
  return decoded;
}

export function contextMatchesEvidence(bundle: RejectionEvidenceBundleV2, context: RejectionFactContextV1): void {
  const expected = rejectionContextValues(context);
  for (const field of [
    "runId", "chainId", "cutoffNumber", "cutoffHash", "cutoffStateRoot", "stage", "familyDefinitionHash",
    "familyCandidateKey", "candidateSubjectHash", "identitySubjectHash", "instanceNominationKey",
  ] as const) {
    if (bundle[field] !== expected[field]) throw new TypeError("rejection-fact-context-mismatch");
  }
}

export function rejectionProofFromEvidence(
  evidence: RejectionEvidenceBundleV2,
): RejectionProofBindingV2 {
  const input = {
    stage: evidence.stage,
    chainId: evidence.chainId,
    cutoffNumber: evidence.cutoffNumber,
    familyDefinitionHash: evidence.familyDefinitionHash,
    familyCandidateKey: evidence.familyCandidateKey,
    candidateSubjectHash: evidence.candidateSubjectHash,
    identitySubjectHash: evidence.identitySubjectHash,
    instanceNominationKey: evidence.instanceNominationKey,
    executorAuthorityRoot: evidence.executorAuthorityRoot,
    workerEpoch: evidence.workerEpoch,
    executorSessionHash: evidence.executorSessionHash,
    executionSessionHash: evidence.executionSessionHash,
    cutoffHash: evidence.cutoffHash,
    cutoffStateRoot: evidence.cutoffStateRoot,
    orderedTransportFactsRoot: evidence.orderedTransportFactsRoot,
    effectObservationRoot: evidence.effectObservationRoot,
    decisionCode: evidence.decisionCode,
    decisionBytesHash: evidence.decisionBytesHash,
    requestFingerprint: evidence.requestFingerprint,
    evidenceBundleRoot: evidence.evidenceBundleRoot,
    authorityRoot: rejectionAuthorityRoot(evidence.familyDefinitionHash, evidence.stage),
  };
  return deepFreeze({ ...input, proofHash: rejectionProofHash(input) });
}

/**
 * Validate a durable bundle after token loss during restart. This proves the
 * bundle's canonical self-consistency and that all children share its source
 * authority/session coordinates; cross-process authenticity still requires a
 * scheduler/boundary certificate and is intentionally outside this function.
 */
export function validateRejectionEvidenceBundle(value: unknown): RejectionEvidenceBundleV2 {
  return validateEvidenceBundle(value, "rejectionEvidence");
}
export const frameworkFailureTokenHash = (
  input: Omit<FrameworkFailureBindingV1, "tokenHash">,
): Hash => hashDomain("aloha/framework-failure-token/v1", input);

export const decodeFrameworkFailureBinding = (
  value: unknown,
  context: string,
): FrameworkFailureBindingV1 => {
  const binding = exactObject(value, [
    "issuerId",
    "authorityRoot",
    "runId",
    "familyCandidateKey",
    "candidateSubjectHash",
    "stage",
    "failureClass",
    "failureCode",
    "attemptCount",
    "evidenceRoot",
    "tokenHash",
  ], context);
  if (binding.issuerId !== FRAMEWORK_ISSUER_ID) throw new TypeError(`${context}.issuerId is invalid`);
  if (!ATTESTATION_STAGES.includes(binding.stage as AttestationStageV1)) {
    throw new TypeError(`${context}.stage is invalid`);
  }
  if (!FRAMEWORK_FAILURE_CLASSES.includes(binding.failureClass as FrameworkFailureClassV1)) {
    throw new TypeError(`${context}.failureClass is invalid`);
  }
  const decoded = deepFreeze({
    issuerId: FRAMEWORK_ISSUER_ID,
    authorityRoot: assertHash(binding.authorityRoot, `${context}.authorityRoot`),
    runId: assertNonEmptyString(binding.runId, `${context}.runId`),
    familyCandidateKey: assertHash(binding.familyCandidateKey, `${context}.familyCandidateKey`),
    candidateSubjectHash: assertHash(binding.candidateSubjectHash, `${context}.candidateSubjectHash`),
    stage: binding.stage as AttestationStageV1,
    failureClass: binding.failureClass as FrameworkFailureClassV1,
    failureCode: assertNonEmptyString(binding.failureCode, `${context}.failureCode`),
    attemptCount: assertDecimalString(binding.attemptCount, `${context}.attemptCount`),
    evidenceRoot: assertHash(binding.evidenceRoot, `${context}.evidenceRoot`),
    tokenHash: assertHash(binding.tokenHash, `${context}.tokenHash`),
  });
  if (decoded.attemptCount === "0") throw new TypeError(`${context}.attemptCount must be positive`);
  const { tokenHash, ...tokenInput } = decoded;
  if (tokenHash !== frameworkFailureTokenHash(tokenInput)) {
    throw new TypeError(`${context}.tokenHash mismatch`);
  }
  return decoded;
};

export function frameworkContextMatches(
  binding: FrameworkFailureBindingV1,
  context: FrameworkFailureContextV1,
): void {
  if (
    binding.runId !== context.runId
    || binding.familyCandidateKey !== context.candidate.familyCandidateKey
    || binding.candidateSubjectHash !== context.candidate.candidateSubjectHash
    || binding.stage !== context.stage
  ) throw new TypeError("framework-failure-context-mismatch");
}

const probeTransitionAuthorityRoot = (input: ProbeReceiptInputV1): Hash => hashDomain(
  "aloha/single-instance-probe-transition-authority/v1",
  {
    runId: input.runId,
    familyCandidateKey: input.familyCandidateKey,
    cutoff: input.cutoff,
    beforeOutcomeHash: input.beforeOutcomeHash,
    afterOutcomeHash: input.afterOutcomeHash,
    checkpointRevisionBefore: input.checkpointRevisionBefore,
    checkpointRevision: input.checkpointRevision,
    priorOutcomePartitionRoot: input.priorOutcomePartitionRoot,
    activeOutcomePartitionRoot: input.activeOutcomePartitionRoot,
    canonicalJournalEpoch: input.canonicalJournalEpoch,
    canonicalJournalRoot: input.canonicalJournalRoot,
  },
);

export function sealProbeReceipt(input: ProbeReceiptInputV1): ProbeReceiptV1 {
  const transitionAuthorityRoot = probeTransitionAuthorityRoot(input);
  const receiptBody = deepFreeze({ ...input, transitionAuthorityRoot });
  const probeReceiptHash = hashDomain("aloha/single-instance-probe-receipt/v2", receiptBody);
  return deepFreeze({
    ...receiptBody,
    receiptLineageRoot: hashDomain("aloha/single-instance-probe-lineage/v1", {
      priorLineageRoot: input.priorLineageRoot,
      probeReceiptHash,
    }),
    probeReceiptHash,
  });
}

export function validateProbeReceipt(raw: ProbeReceiptV1): ProbeReceiptV1 {
  const value = exactObject(raw, [
    "runId", "familyCandidateKey", "cutoff", "beforeOutcomeHash", "afterOutcomeHash",
    "beforeKind", "afterKind", "candidateSubjectHash", "evidenceRoot",
    "checkpointRevisionBefore", "checkpointRevision", "priorOutcomePartitionRoot",
    "activeOutcomePartitionRoot", "canonicalJournalEpoch", "canonicalJournalRoot",
    "transitionAuthorityRoot", "sequence", "priorReceiptHash", "priorLineageRoot",
    "receiptLineageRoot", "probeReceiptHash",
  ], "probeReceipt");
  if (value.beforeKind !== "retryable") throw new TypeError("probeReceipt.beforeKind is invalid");
  if (!["verified", "chainProvenRejected", "retryable"].includes(String(value.afterKind))) {
    throw new TypeError("probeReceipt.afterKind is invalid");
  }
  const input: ProbeReceiptInputV1 = deepFreeze({
    runId: assertNonEmptyString(value.runId, "probeReceipt.runId"),
    familyCandidateKey: assertHash(value.familyCandidateKey, "probeReceipt.familyCandidateKey"),
    cutoff: validateCutoff(value.cutoff, "probeReceipt.cutoff"),
    beforeOutcomeHash: assertHash(value.beforeOutcomeHash, "probeReceipt.beforeOutcomeHash"),
    afterOutcomeHash: assertHash(value.afterOutcomeHash, "probeReceipt.afterOutcomeHash"),
    beforeKind: "retryable",
    afterKind: value.afterKind as ProbeReceiptV1["afterKind"],
    candidateSubjectHash: assertHash(value.candidateSubjectHash, "probeReceipt.candidateSubjectHash"),
    evidenceRoot: assertHash(value.evidenceRoot, "probeReceipt.evidenceRoot"),
    checkpointRevisionBefore: assertDecimalString(value.checkpointRevisionBefore, "probeReceipt.checkpointRevisionBefore"),
    checkpointRevision: assertDecimalString(value.checkpointRevision, "probeReceipt.checkpointRevision"),
    priorOutcomePartitionRoot: assertHash(value.priorOutcomePartitionRoot, "probeReceipt.priorOutcomePartitionRoot"),
    activeOutcomePartitionRoot: assertHash(value.activeOutcomePartitionRoot, "probeReceipt.activeOutcomePartitionRoot"),
    canonicalJournalEpoch: assertDecimalString(value.canonicalJournalEpoch, "probeReceipt.canonicalJournalEpoch"),
    canonicalJournalRoot: assertHash(value.canonicalJournalRoot, "probeReceipt.canonicalJournalRoot"),
    sequence: assertDecimalString(value.sequence, "probeReceipt.sequence"),
    priorReceiptHash: value.priorReceiptHash === null ? null : assertHash(value.priorReceiptHash, "probeReceipt.priorReceiptHash"),
    priorLineageRoot: assertHash(value.priorLineageRoot, "probeReceipt.priorLineageRoot"),
  });
  if (BigInt(input.checkpointRevision) !== BigInt(input.checkpointRevisionBefore) + 1n) {
    throw new TypeError("probeReceipt checkpoint revision is not a one-time transition");
  }
  if (input.beforeOutcomeHash === input.afterOutcomeHash) {
    throw new TypeError("probeReceipt cannot authorize a no-op transition");
  }
  const sequence = BigInt(input.sequence);
  if (
    sequence < 1n
    || (sequence === 1n && (
      input.priorReceiptHash !== null
      || input.priorLineageRoot !== EMPTY_PROBE_RECEIPT_LINEAGE_ROOT
    ))
    || (sequence > 1n && (
      input.priorReceiptHash === null
      || input.priorLineageRoot === EMPTY_PROBE_RECEIPT_LINEAGE_ROOT
    ))
  ) throw new TypeError("probeReceipt predecessor binding is invalid");
  const sealed = sealProbeReceipt(input);
  if (encodeCanonicalJson(sealed) !== encodeCanonicalJson(raw)) {
    throw new TypeError("probeReceipt authority or lineage mismatch");
  }
  return sealed;
}
export function candidateFinalOutcomeHash(outcome: CandidateFinalOutcomeV1): Hash {
  return hashDomain("aloha/candidate-final-outcome/v1", outcome);
}

/** Hash of the exact final outcome body before its content commitment. The
 * commitment is excluded to avoid a hash cycle; every authority and evidence
 * field remains committed by this hash. */
export function candidateFinalOutcomeBodyHash(
  outcome: CandidateFinalOutcomeV1 | Omit<CandidateFinalOutcomeV1, "outcomeCommitment">,
): Hash {
  const { outcomeCommitment: _commitment, ...body } = outcome as CandidateFinalOutcomeV1;
  return hashDomain("aloha/candidate-final-outcome-body/v1", body);
}

export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export function exactObject(value: unknown, keys: readonly string[], context: string): Record<string, unknown> {
  assertPlainObject(value, context);
  assertExactKeys(value, keys, context);
  return value;
}

export function validateCutoff(value: unknown, context: string): CanonicalCutoffV1 {
  const cutoff = exactObject(value, ["chainId", "number", "hash", "stateRoot"], context);
  return deepFreeze({
    chainId: assertNonEmptyString(cutoff.chainId, `${context}.chainId`),
    number: assertDecimalString(cutoff.number, `${context}.number`),
    hash: assertHash(cutoff.hash, `${context}.hash`),
    stateRoot: assertHash(cutoff.stateRoot, `${context}.stateRoot`),
  });
}

export function validateFailure(
  value: unknown,
  context: string,
  expectedKind: "retryable" | "invalidProgram",
): OutcomeFailureV1 {
  const failure = exactObject(
    value,
    ["stage", "failureCode", "attemptCount", "candidateSubjectHash", "evidenceRoot", "frameworkBinding"],
    context,
  );
  if (!ATTESTATION_STAGES.includes(failure.stage as AttestationStageV1)) {
    throw new TypeError(`${context}.stage is invalid`);
  }
  const attemptCount = assertDecimalString(failure.attemptCount, `${context}.attemptCount`);
  if (attemptCount === "0") throw new TypeError(`${context}.attemptCount must be positive`);
  const frameworkBinding = failure.frameworkBinding === null
    ? null
    : decodeFrameworkFailureBinding(failure.frameworkBinding, `${context}.frameworkBinding`);
  if (expectedKind === "invalidProgram" && frameworkBinding !== null) {
    throw new TypeError(`${context}.frameworkBinding is forbidden for invalidProgram`);
  }
  if (
    frameworkBinding !== null
    && (
      frameworkBinding.stage === "framework"
      || frameworkBinding.stage !== failure.stage
      || frameworkBinding.failureCode !== failure.failureCode
      || frameworkBinding.attemptCount !== attemptCount
      || frameworkBinding.candidateSubjectHash !== failure.candidateSubjectHash
      || frameworkBinding.evidenceRoot !== failure.evidenceRoot
    )
  ) throw new TypeError(`${context}.frameworkBinding lineage mismatch`);
  return deepFreeze({
    stage: failure.stage as OutcomeFailureV1["stage"],
    failureCode: assertNonEmptyString(failure.failureCode, `${context}.failureCode`),
    attemptCount,
    candidateSubjectHash: assertHash(failure.candidateSubjectHash, `${context}.candidateSubjectHash`),
    evidenceRoot: assertHash(failure.evidenceRoot, `${context}.evidenceRoot`),
    frameworkBinding,
  });
}
export function validateDerivedRejectionProof(
  value: unknown,
  evidence: RejectionEvidenceBundleV2,
  context: string,
): RejectionProofBindingV2 {
  const proof = exactObject(value, [
    "stage", "chainId", "cutoffNumber", "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
    "identitySubjectHash", "instanceNominationKey", "executorAuthorityRoot", "workerEpoch", "executorSessionHash", "executionSessionHash", "cutoffHash", "cutoffStateRoot", "orderedTransportFactsRoot",
    "effectObservationRoot", "decisionCode", "decisionBytesHash", "requestFingerprint", "evidenceBundleRoot",
    "authorityRoot", "proofHash",
  ], context);
  // Decode all fields before comparison so malformed durable rows fail with a
  // schema error instead of being accepted by a string-only comparison.
  assertNonEmptyString(proof.stage, `${context}.stage`);
  assertNonEmptyString(proof.chainId, `${context}.chainId`);
  assertDecimalString(proof.cutoffNumber, `${context}.cutoffNumber`);
  assertHash(proof.familyDefinitionHash, `${context}.familyDefinitionHash`);
  assertHash(proof.familyCandidateKey, `${context}.familyCandidateKey`);
  assertHash(proof.candidateSubjectHash, `${context}.candidateSubjectHash`);
  if (proof.identitySubjectHash !== null) assertHash(proof.identitySubjectHash, `${context}.identitySubjectHash`);
  if (proof.instanceNominationKey !== null) assertNonEmptyString(proof.instanceNominationKey, `${context}.instanceNominationKey`);
  assertHash(proof.executorAuthorityRoot, `${context}.executorAuthorityRoot`);
  assertNonEmptyString(proof.workerEpoch, `${context}.workerEpoch`);
  assertHash(proof.executorSessionHash, `${context}.executorSessionHash`);
  assertHash(proof.executionSessionHash, `${context}.executionSessionHash`);
  assertHash(proof.cutoffHash, `${context}.cutoffHash`);
  assertHash(proof.cutoffStateRoot, `${context}.cutoffStateRoot`);
  assertHash(proof.orderedTransportFactsRoot, `${context}.orderedTransportFactsRoot`);
  assertHash(proof.effectObservationRoot, `${context}.effectObservationRoot`);
  assertNonEmptyString(proof.decisionCode, `${context}.decisionCode`);
  assertHash(proof.decisionBytesHash, `${context}.decisionBytesHash`);
  assertHash(proof.requestFingerprint, `${context}.requestFingerprint`);
  assertHash(proof.evidenceBundleRoot, `${context}.evidenceBundleRoot`);
  assertHash(proof.authorityRoot, `${context}.authorityRoot`);
  assertHash(proof.proofHash, `${context}.proofHash`);
  const expected = rejectionProofFromEvidence(evidence);
  if (encodeCanonicalJson(expected) !== encodeCanonicalJson(proof)) {
    throw new TypeError(`${context} is not derived from issuer evidence`);
  }
  return expected;
}

export function validateVerifiedPublication(
  candidate: CandidateRecordV1,
  identity: IdentityVerifiedObservationV1,
  cutoff: CanonicalCutoffV1,
  publication: InstancePublicationV1,
): void {
  validateInstancePublication(publication);
  if (
    publication.familyId !== candidate.familyId
    || publication.familyDefinitionHash !== candidate.familyDefinitionHash
    || publication.familyCandidateKey !== candidate.familyCandidateKey
    || publication.instanceKey !== identity.familyInstanceKey
    || encodeCanonicalJson(publication.identityMemo) !== encodeCanonicalJson(identity.identityMemo)
    || publication.identityMemoHash !== identity.identityMemoHash
    || publication.descriptorHash !== identity.descriptorHash
    || publication.evidenceRoot !== identity.evidenceRoot
    || publication.cutoff.chainId !== cutoff.chainId
    || publication.cutoff.number !== cutoff.number
    || publication.cutoff.hash !== cutoff.hash
    || publication.cutoff.stateRoot !== cutoff.stateRoot
  ) throw new Error("publication-lineage-mismatch");
}

/** Fixed central commitment for the Family-owned opaque identity value. */
export function identityMemoHash(value: CanonicalJson): Hash {
  return hashDomain("aloha/identity-memo/v1", value);
}

export function validateIdentityObservation(
  value: unknown,
  context: string,
): IdentityVerifiedObservationV1 {
  const raw = exactObject(value, [
    "kind", "familyInstanceKey", "identityMemo", "identityMemoHash", "descriptorHash", "evidenceRoot",
  ], context);
  if (raw.kind !== "identityVerified") throw new TypeError(`${context}.kind is invalid`);
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(raw.identityMemo));
  const expectedIdentityMemoHash = identityMemoHash(identityMemo);
  const memoHash = assertHash(raw.identityMemoHash, `${context}.identityMemoHash`);
  if (memoHash !== expectedIdentityMemoHash) throw new TypeError(`${context}.identityMemoHash does not match identityMemo`);
  return deepFreeze({
    kind: "identityVerified" as const,
    familyInstanceKey: assertNonEmptyString(raw.familyInstanceKey, `${context}.familyInstanceKey`),
    identityMemo,
    identityMemoHash: memoHash,
    descriptorHash: assertHash(raw.descriptorHash, `${context}.descriptorHash`),
    evidenceRoot: assertHash(raw.evidenceRoot, `${context}.evidenceRoot`),
  });
}

export interface AttestationIdentitySemanticAuthorityV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export function identityObservationSemanticHash(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidatePartitionRoot: Hash,
  candidate: CandidateRecordV1,
  identity: IdentityVerifiedObservationV1,
  identityOrigin: AttestationIdentityOriginV1,
  authority: AttestationIdentitySemanticAuthorityV1,
): Hash {
  return hashDomain("aloha/attestation-identity-observation/v1", {
    runId,
    cutoff,
    candidatePartitionRoot,
    candidate,
    identity,
    identityOrigin,
    runtimeAuthority: authority.runtimeAuthority,
    attestationAuthorityRoot: authority.attestationAuthorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
  });
}

export function verifiedIdentitySubjectHash(
  candidate: CandidateRecordV1,
  identity: IdentityVerifiedObservationV1,
): Hash {
  return hashDomain("aloha/verified-identity-subject/v1", {
    familyDefinitionHash: candidate.familyDefinitionHash,
    familyInstanceKey: identity.familyInstanceKey,
    identityMemo: identity.identityMemo,
    identityMemoHash: identity.identityMemoHash,
    descriptorHash: identity.descriptorHash,
  });
}

export function identityCommitmentIssueInput(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidatePartitionRoot: Hash,
  candidate: CandidateRecordV1,
  identity: IdentityVerifiedObservationV1,
  identityOrigin: AttestationIdentityOriginV1,
  authority: AttestationIdentitySemanticAuthorityV1,
): import("./commitment.ts").AttestationIdentityCommitmentIssueInputV1 {
  const identityObservation = validateIdentityObservation(identity, "attestation.identityObservation");
  return deepFreeze({
    runId: assertNonEmptyString(runId, "identityCommitment.runId"),
    cutoff: validateCutoff(cutoff, "identityCommitment.cutoff"),
    candidatePartitionRoot: assertHash(candidatePartitionRoot, "identityCommitment.candidatePartitionRoot"),
    candidate,
    identityObservation,
    identityOrigin,
    identitySubjectHash: verifiedIdentitySubjectHash(candidate, identityObservation),
    identitySemanticHash: identityObservationSemanticHash(
      runId,
      cutoff,
      candidatePartitionRoot,
      candidate,
      identityObservation,
      identityOrigin,
      authority,
    ),
    attestationAuthorityRoot: authority.attestationAuthorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
  });
}
export function validateCandidateFinalOutcome(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidate: CandidateRecordV1,
  outcome: CandidateFinalOutcomeV1,
): void {
  const kind = outcome.kind;
  const commonKeys = [
    "kind", "runCandidateKey", "familyCandidateKey", "runtimeAuthority",
    "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot",
    "identityCommitment", "outcomeCommitment",
  ];
  const variantKeys = kind === "verified"
    ? ["instanceKey", "publication"]
    : kind === "chainProvenRejected"
      ? ["proof", "rejectionEvidence"]
      : ["failure"];
  exactObject(outcome, [...commonKeys, ...variantKeys], "candidateFinalOutcome");
  const runtimeAuthority = decodeRuntimeAuthorityProjectionV1(outcome.runtimeAuthority);
  const expectedRunKey = runCandidateKey(runId, candidate.familyCandidateKey);
  if (outcome.runCandidateKey !== expectedRunKey
    || outcome.familyCandidateKey !== candidate.familyCandidateKey) {
    throw new TypeError("candidate outcome candidate/run mismatch");
  }
  assertHash(outcome.attestationAuthorityRoot, "candidateFinalOutcome.attestationAuthorityRoot");
  assertHash(outcome.frameworkAuthorityRoot, "candidateFinalOutcome.frameworkAuthorityRoot");
  assertHash(outcome.executorAuthorityRoot, "candidateFinalOutcome.executorAuthorityRoot");
  const outcomeCommitment = decodeAttestationOutcomeCommitmentV1(outcome.outcomeCommitment);
  const candidatePartitionRoot = outcomeCommitment.candidatePartitionRoot;
  if (outcomeCommitment.runId !== runId
    || encodeCanonicalJson(outcomeCommitment.cutoff) !== encodeCanonicalJson(cutoff)
    || outcomeCommitment.familyDefinitionHash !== candidate.familyDefinitionHash
    || outcomeCommitment.familyCandidateKey !== candidate.familyCandidateKey
    || outcomeCommitment.candidateSubjectHash !== candidate.candidateSubjectHash
    || encodeCanonicalJson(outcomeCommitment.runtimeAuthority) !== encodeCanonicalJson(runtimeAuthority)
    || outcomeCommitment.attestationAuthorityRoot !== outcome.attestationAuthorityRoot
    || outcomeCommitment.frameworkAuthorityRoot !== outcome.frameworkAuthorityRoot
    || outcomeCommitment.executorAuthorityRoot !== outcome.executorAuthorityRoot) {
    throw new TypeError("candidate outcome commitment context mismatch");
  }
  let identityObservation: IdentityVerifiedObservationV1 | null = null;
  if (outcome.identityCommitment !== null) {
    const identityCommitment = decodeAttestationIdentityCommitmentV1(outcome.identityCommitment);
    identityObservation = validateIdentityObservation(
      identityCommitment.identityObservation,
      "candidateFinalOutcome.identityCommitment.identityObservation",
    );
    const semanticAuthority = {
      runtimeAuthority,
      attestationAuthorityRoot: outcome.attestationAuthorityRoot,
      frameworkAuthorityRoot: outcome.frameworkAuthorityRoot,
      executorAuthorityRoot: outcome.executorAuthorityRoot,
    };
    if (identityCommitment.runId !== runId
      || encodeCanonicalJson(identityCommitment.cutoff) !== encodeCanonicalJson(cutoff)
      || identityCommitment.candidatePartitionRoot !== candidatePartitionRoot
      || identityCommitment.familyDefinitionHash !== candidate.familyDefinitionHash
      || identityCommitment.familyCandidateKey !== candidate.familyCandidateKey
      || identityCommitment.candidateSubjectHash !== candidate.candidateSubjectHash
      || identityCommitment.identitySubjectHash !== verifiedIdentitySubjectHash(candidate, identityObservation)
      || identityCommitment.identitySemanticHash !== identityObservationSemanticHash(
        runId,
        cutoff,
        candidatePartitionRoot,
        candidate,
        identityObservation,
        identityCommitment.identityOrigin,
        semanticAuthority,
      )
      || encodeCanonicalJson(identityCommitment.runtimeAuthority) !== encodeCanonicalJson(runtimeAuthority)
      || identityCommitment.attestationAuthorityRoot !== outcome.attestationAuthorityRoot
      || identityCommitment.frameworkAuthorityRoot !== outcome.frameworkAuthorityRoot
      || identityCommitment.executorAuthorityRoot !== outcome.executorAuthorityRoot) {
      throw new TypeError("candidate identity commitment context mismatch");
    }
  }
  if (outcomeCommitment.outcomeBodyHash !== candidateFinalOutcomeBodyHash(outcome)) {
    throw new TypeError("candidate outcome commitment body hash mismatch");
  }
  if (outcome.kind === "verified") {
    if (outcome.identityCommitment === null) throw new TypeError("verified-outcome-identity-commitment-missing");
    if (identityObservation === null) throw new TypeError("verified identity observation missing");
    validateVerifiedPublication(candidate, identityObservation, cutoff, outcome.publication);
    if (outcome.instanceKey !== outcome.publication.instanceKey) {
      throw new TypeError("verified outcome instance key mismatch");
    }
    return;
  }
  const terminalStage = outcome.kind === "chainProvenRejected"
    ? outcome.proof.stage
    : outcome.failure.stage;
  if (terminalStage === "identity") {
    if (outcome.identityCommitment !== null) throw new TypeError("identity-stage-outcome-must-not-link-identity-commitment");
  } else if (outcome.identityCommitment === null) {
    throw new TypeError("post-identity-outcome-identity-commitment-missing");
  }
  if (outcome.kind === "chainProvenRejected") {
    const evidence = validateRejectionEvidenceBundle(outcome.rejectionEvidence);
    const proof = validateDerivedRejectionProof(outcome.proof, evidence, "candidateFinalOutcome.proof");
    if (evidence.runId !== runId
      || evidence.chainId !== cutoff.chainId
      || evidence.cutoffNumber !== cutoff.number
      || evidence.cutoffHash !== cutoff.hash
      || evidence.cutoffStateRoot !== cutoff.stateRoot
      || evidence.familyDefinitionHash !== candidate.familyDefinitionHash
      || evidence.familyCandidateKey !== candidate.familyCandidateKey
      || evidence.candidateSubjectHash !== candidate.candidateSubjectHash
      || evidence.executorAuthorityRoot !== outcome.executorAuthorityRoot
      || proof.executorAuthorityRoot !== outcome.executorAuthorityRoot
      || (evidence.stage === "identity") !== (identityObservation === null)
      || (identityObservation !== null
        && evidence.identitySubjectHash !== verifiedIdentitySubjectHash(candidate, identityObservation))) {
      throw new TypeError("candidate rejection context mismatch");
    }
    return;
  }
  const failure = validateFailure(outcome.failure, "candidateFinalOutcome.failure", outcome.kind);
  if (failure.candidateSubjectHash !== candidate.candidateSubjectHash) {
    throw new TypeError("candidate failure subject mismatch");
  }
  if (failure.frameworkBinding !== null
    && failure.frameworkBinding.authorityRoot !== outcome.frameworkAuthorityRoot) {
    throw new TypeError("candidate failure framework authority mismatch");
  }
}

export function validateAttestationPartition(
  partition: AttestationPartitionV1,
  candidates: readonly CandidateRecordV1[],
): void {
  const exact = exactObject(partition, ["runId", "cutoff", "candidatePartitionRoot", "outcomes", "runtimeAuthority", "attestationAuthorityRoot", "frameworkAuthorityRoot", "executorAuthorityRoot", "accounting", "exactOutcomePartitionRoot"], "attestationPartition");
  assertNonEmptyString(exact.runId, "attestationPartition.runId");
  validateCutoff(exact.cutoff, "attestationPartition.cutoff");
  assertHash(exact.candidatePartitionRoot, "attestationPartition.candidatePartitionRoot");
  if (exact.candidatePartitionRoot !== candidatePartitionRoot(candidates)) {
    throw new Error("attestation-partition-candidate-root-mismatch");
  }
  if (encodeCanonicalJson(exact.runtimeAuthority) !== encodeCanonicalJson(partition.runtimeAuthority)) {
    throw new TypeError("attestationPartition.runtimeAuthority is invalid");
  }
  assertHash(exact.attestationAuthorityRoot, "attestationPartition.attestationAuthorityRoot");
  assertHash(exact.frameworkAuthorityRoot, "attestationPartition.frameworkAuthorityRoot");
  assertHash(exact.executorAuthorityRoot, "attestationPartition.executorAuthorityRoot");
  if (!Array.isArray(exact.outcomes)) throw new TypeError("attestationPartition.outcomes must be an array");
  const accounting = exactObject(exact.accounting, ["pending", "verified", "chainProvenRejected", "retryable", "invalidProgram"], "attestationPartition.accounting");
  for (const key of ["pending", "verified", "chainProvenRejected", "retryable", "invalidProgram"] as const) {
    assertDecimalString(accounting[key], `attestationPartition.accounting.${key}`);
  }
  assertHash(exact.exactOutcomePartitionRoot, "attestationPartition.exactOutcomePartitionRoot");
  const byKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
  if (byKey.size !== candidates.length || partition.outcomes.length !== candidates.length) {
    throw new Error("candidate-outcome-partition-mismatch");
  }
  const sorted = [...partition.outcomes].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
  if (partition.outcomes.some((outcome, index) => outcome.familyCandidateKey !== sorted[index]?.familyCandidateKey)) {
    throw new Error("candidate-outcome-order-mismatch");
  }
  for (const outcome of partition.outcomes) {
    const candidate = byKey.get(outcome.familyCandidateKey);
    if (!candidate) throw new Error("candidate-outcome-partition-mismatch");
    if (
      outcome.attestationAuthorityRoot !== partition.attestationAuthorityRoot
      || encodeCanonicalJson(outcome.runtimeAuthority) !== encodeCanonicalJson(partition.runtimeAuthority)
      || outcome.frameworkAuthorityRoot !== partition.frameworkAuthorityRoot
      || outcome.executorAuthorityRoot !== partition.executorAuthorityRoot
    ) throw new Error("outcome-partition-authority-mismatch");
    validateCandidateFinalOutcome(partition.runId, partition.cutoff, candidate, outcome);
  }
  const expectedAccounting = {
    pending: "0",
    verified: String(sorted.filter(value => value.kind === "verified").length),
    chainProvenRejected: String(sorted.filter(value => value.kind === "chainProvenRejected").length),
    retryable: String(sorted.filter(value => value.kind === "retryable").length),
    invalidProgram: String(sorted.filter(value => value.kind === "invalidProgram").length),
  };
  if (encodeCanonicalJson(expectedAccounting) !== encodeCanonicalJson(partition.accounting)) {
    throw new Error("outcome-accounting-mismatch");
  }
  const recomputedRoot = hashDomain("aloha/exact-outcome-partition/v1", {
    runId: partition.runId,
    cutoff: partition.cutoff,
    candidatePartitionRoot: partition.candidatePartitionRoot,
    runtimeAuthority: partition.runtimeAuthority,
    attestationAuthorityRoot: partition.attestationAuthorityRoot,
    frameworkAuthorityRoot: partition.frameworkAuthorityRoot,
    executorAuthorityRoot: partition.executorAuthorityRoot,
    outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", sorted),
  });
  if (recomputedRoot !== partition.exactOutcomePartitionRoot) throw new Error("outcome-partition-root-mismatch");
}

export function assertPromotablePartition(
  partition: AttestationPartitionV1,
  expectedCandidateKeys: readonly Hash[],
): void {
  if (new Set(expectedCandidateKeys).size !== expectedCandidateKeys.length) {
    throw new Error("duplicate-expected-candidate-key");
  }
  const actual = partition.outcomes.map(outcome => outcome.familyCandidateKey).sort(compareText);
  const expected = [...expectedCandidateKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("candidate-outcome-partition-mismatch");
  }
  if (partition.accounting.pending !== "0") throw new Error("pending-outcomes");
  if (partition.accounting.retryable !== "0") throw new Error("retryable-outcomes");
  for (const outcome of partition.outcomes) {
    if (outcome.runCandidateKey !== runCandidateKey(partition.runId, outcome.familyCandidateKey)) {
      throw new Error("run-candidate-key-mismatch");
    }
  }
  const expectedAccounting = {
    pending: "0",
    verified: String(partition.outcomes.filter(value => value.kind === "verified").length),
    chainProvenRejected: String(partition.outcomes.filter(value => value.kind === "chainProvenRejected").length),
    retryable: String(partition.outcomes.filter(value => value.kind === "retryable").length),
    invalidProgram: String(partition.outcomes.filter(value => value.kind === "invalidProgram").length),
  };
  for (const key of Object.keys(expectedAccounting) as Array<keyof typeof expectedAccounting>) {
    if (partition.accounting[key] !== expectedAccounting[key]) throw new Error("outcome-accounting-mismatch");
  }
  const recomputedRoot = hashDomain("aloha/exact-outcome-partition/v1", {
    runId: partition.runId,
    cutoff: partition.cutoff,
    candidatePartitionRoot: partition.candidatePartitionRoot,
    runtimeAuthority: partition.runtimeAuthority,
    attestationAuthorityRoot: partition.attestationAuthorityRoot,
    frameworkAuthorityRoot: partition.frameworkAuthorityRoot,
    executorAuthorityRoot: partition.executorAuthorityRoot,
    outcomesRoot: hashCanonicalPartition(
      "aloha/candidate-outcomes/v1",
      [...partition.outcomes].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey)),
    ),
  });
  if (recomputedRoot !== partition.exactOutcomePartitionRoot) throw new Error("outcome-partition-root-mismatch");
  const terminal = BigInt(expectedAccounting.verified)
    + BigInt(expectedAccounting.chainProvenRejected)
    + BigInt(expectedAccounting.invalidProgram);
  if (terminal !== BigInt(expected.length)) throw new Error("terminal-accounting-mismatch");
}
