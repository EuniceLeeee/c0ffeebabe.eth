import type {
  AttestationOutcomeCapabilityV1,
  AttestationPartitionCapabilityV1,
  AttestationPersistenceBatchClaimV1,
  AttestationPersistenceCapabilityV1,
  AttestationWriterCapabilityV1,
  AttestationIdentityResumeInputV1,
  IdentityVerifiedV1,
} from "../index.ts";
import type { CandidateRecordV1 } from "../../../discovery/src/index.ts";

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
export const attestationOutcomeStates = new WeakMap<object, AttestationAuthorityStateV1>();
export const attestationPartitionStates = new WeakMap<object, AttestationAuthorityStateV1>();

export interface AttestationIdentityResumeStateV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly identity: IdentityVerifiedV1;
  readonly outcomeHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly executorAuthorityRoot: Hash;
}

export const attestationIdentityResumeStates = new WeakMap<object, AttestationIdentityResumeStateV1>();
export const consumedAttestationIdentityResumeCapabilities = new WeakSet<object>();

export function registerAttestationValidationAuthority(
  authority: object,
  state: AttestationAuthorityStateV1,
): void {
  attestationAuthorityStates.set(authority, state);
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
    candidateSnapshotHash: input.candidate.candidateSnapshotHash,
    identity: input.identity,
    outcomeHash: input.outcomeHash,
    attestationAuthorityRoot: input.attestationAuthorityRoot,
    releaseAuthorityRoot: input.releaseAuthorityRoot,
    releaseProvenanceHash: input.releaseProvenanceHash,
    executorAuthorityRoot: input.executorAuthorityRoot,
  });
}
