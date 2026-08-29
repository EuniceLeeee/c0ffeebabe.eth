import type {
  AttestationOutcomeCapabilityV1,
  AttestationPartitionCapabilityV1,
  AttestationPersistenceBatchClaimV1,
  AttestationPersistenceCapabilityV1,
  AttestationWriterCapabilityV1,
  AttestationIdentityResumeInputV1,
  IdentityVerifiedV1,
  AttestationOutcomeResumeInputV1,
  AttestationOutcomeResumeCapabilityV1,
  AttestationVerifiedMemoReuseInputV1,
} from "../index.ts";
import type { CandidateRecordV1 } from "../../../discovery/src/index.ts";
import type { InstancePublicationV1 } from "../../../catalog/src/index.ts";

export type AttestationIdentityResumeResolvedInputV1 = AttestationIdentityResumeInputV1 & {
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
};
import type { AttestationProofIssuerVerifierPortV1 } from "../internal-authority.ts";
import type { Hash } from "../../../canonical-codec/src/index.ts";
import type { CanonicalCutoffV1 } from "../../../discovery/src/index.ts";

/**
 * Process-local authority state.  This module deliberately contains only
 * opaque membership state; it does not import the attestation engine or any
 * validator.  The issuer and verifier are the only modules allowed to
 * interpret these maps.
 */

export interface AttestationAuthorityStateV1 {
  readonly authorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly attestationProof: AttestationProofIssuerVerifierPortV1;
  readonly attestationProofIssuerKeyId: Hash;
  readonly outcomeCapabilities: WeakSet<object>;
  readonly partitionCapabilities: WeakSet<object>;
  readonly resumeCapabilities: WeakSet<object>;
  readonly writerConsumers: WeakMap<object, AttestationWriterConsumerV1>;
}

export interface AttestationWriterConsumerV1 {
  readonly candidatePartitionRoot: Hash;
  claim(
    writerCapability: AttestationWriterCapabilityV1,
    persistenceCapabilities: readonly AttestationPersistenceCapabilityV1[],
  ): AttestationPersistenceBatchClaimV1;
}

export const attestationAuthorityStates = new WeakMap<object, AttestationAuthorityStateV1>();
/** Process-local identity of an engine-issued service.  The release owner
 * uses this to reject a shape-compatible service whose openRunSession method
 * could be deployment-injected. */
export const attestationServiceStates = new WeakMap<object, AttestationAuthorityStateV1>();
export const attestationOutcomeStates = new WeakMap<object, AttestationAuthorityStateV1>();
export const attestationPartitionStates = new WeakMap<object, AttestationAuthorityStateV1>();

export interface AttestationIdentityResumeStateV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identity: IdentityVerifiedV1;
  readonly outcomeHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationOutcomeResumeStateV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly outcome: AttestationOutcomeCapabilityV1;
  readonly outcomeHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationVerifiedMemoReuseStateV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly publication: InstancePublicationV1;
  readonly verifiedMemoSetRoot: Hash;
  readonly authorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
}

export const attestationIdentityResumeStates = new WeakMap<object, AttestationIdentityResumeStateV1>();
export const consumedAttestationIdentityResumeCapabilities = new WeakSet<object>();
export const attestationOutcomeResumeStates = new WeakMap<object, AttestationOutcomeResumeStateV1>();
export const consumedAttestationOutcomeResumeCapabilities = new WeakSet<object>();
export const attestationVerifiedMemoReuseStates = new WeakMap<object, AttestationVerifiedMemoReuseStateV1>();
export const consumedAttestationVerifiedMemoReuseCapabilities = new WeakSet<object>();

export function registerAttestationValidationAuthority(
  authority: object,
  state: AttestationAuthorityStateV1,
): void {
  attestationAuthorityStates.set(authority, state);
}

export function registerAttestationService(
  service: object,
  state: AttestationAuthorityStateV1,
): void {
  attestationServiceStates.set(service, state);
}

export function registerAttestationOutcomeCapability(
  outcome: AttestationOutcomeCapabilityV1,
  state: AttestationAuthorityStateV1,
): void {
  state.outcomeCapabilities.add(outcome);
  attestationOutcomeStates.set(outcome, state);
}

export function registerAttestationPartitionCapability(
  partition: AttestationPartitionCapabilityV1,
  state: AttestationAuthorityStateV1,
): void {
  state.partitionCapabilities.add(partition);
  attestationPartitionStates.set(partition, state);
}

export function registerAttestationIdentityResumeCapability(
  capability: object,
  input: AttestationIdentityResumeResolvedInputV1,
  state: AttestationAuthorityStateV1,
): void {
  state.resumeCapabilities.add(capability);
  attestationIdentityResumeStates.set(capability, {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    familyCandidateKey: input.candidate.familyCandidateKey,
    candidateSubjectHash: input.candidate.candidateSubjectHash,
    identity: input.identity,
    outcomeHash: input.outcomeHash,
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    releaseAuthorityRoot: input.releaseAuthorityRoot,
    releaseProvenanceHash: input.releaseProvenanceHash,
    executorAuthorityRoot: input.executorAuthorityRoot,
  });
}

export function registerAttestationOutcomeResumeCapability(
  capability: object,
  input: AttestationOutcomeResumeInputV1 & { readonly candidatePartitionRoot: Hash },
  state: AttestationAuthorityStateV1,
): void {
  state.resumeCapabilities.add(capability);
  attestationOutcomeResumeStates.set(capability, {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    familyCandidateKey: input.candidate.familyCandidateKey,
    candidateSubjectHash: input.candidate.candidateSubjectHash,
    outcome: input.outcome,
    outcomeHash: input.outcomeHash,
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    releaseAuthorityRoot: input.releaseAuthorityRoot,
    releaseProvenanceHash: input.releaseProvenanceHash,
    executorAuthorityRoot: input.executorAuthorityRoot,
  });
}

export function registerAttestationVerifiedMemoReuseCapability(
  capability: object,
  input: AttestationVerifiedMemoReuseInputV1 & {
    readonly candidatePartitionRoot: Hash;
    readonly candidate: CandidateRecordV1;
  },
  state: AttestationAuthorityStateV1,
): void {
  state.resumeCapabilities.add(capability);
  attestationVerifiedMemoReuseStates.set(capability, {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    familyCandidateKey: input.candidate.familyCandidateKey,
    candidateSubjectHash: input.candidate.candidateSubjectHash,
    publication: input.publication,
    verifiedMemoSetRoot: input.verifiedMemoSetRoot,
    authorityRoot: state.authorityRoot,
    releaseAuthorityRoot: state.releaseAuthorityRoot,
    releaseProvenanceHash: state.releaseProvenanceHash,
  });
}
