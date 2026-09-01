import type { InstancePublicationV1 } from "../../../catalog/src/index.ts";
import type { Hash } from "../../../canonical-codec/src/index.ts";
import type { CandidateRecordV1, CanonicalCutoffV1 } from "../../../discovery/src/index.ts";
import type { RuntimeAuthorityProjectionV1 } from "../../../runtime-authority/src/index.ts";
import type {
  AttestationIdentityResumeInputV1,
  AttestationOutcomeCapabilityV1,
  AttestationOutcomeResumeInputV1,
  AttestationPartitionCapabilityV1,
  AttestationPersistenceBatchClaimV1,
  AttestationPersistenceCapabilityV1,
  AttestationVerifiedMemoReuseInputV1,
  AttestationWriterCapabilityV1,
  IdentityVerifiedV1,
} from "../index.ts";

export type AttestationIdentityResumeResolvedInputV1 = AttestationIdentityResumeInputV1 & {
  readonly candidatePartitionRoot: Hash;
  readonly candidate: CandidateRecordV1;
};

/** Process-local authority state. Cloneable durable facts are content
 * commitments; only capability membership and the monotonic sequence remain
 * process-local. */
export interface AttestationAuthorityStateV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly authorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  nextCommitmentSequence: bigint;
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
export const attestationServiceStates = new WeakMap<object, AttestationAuthorityStateV1>();
export const attestationOutcomeStates = new WeakMap<object, AttestationAuthorityStateV1>();
export const attestationPartitionStates = new WeakMap<object, AttestationAuthorityStateV1>();

interface ResumeAuthorityFactsV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
}

export interface AttestationIdentityResumeStateV1 extends ResumeAuthorityFactsV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identity: IdentityVerifiedV1;
  readonly outcomeHash: Hash;
}

export interface AttestationOutcomeResumeStateV1 extends ResumeAuthorityFactsV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly outcome: AttestationOutcomeCapabilityV1;
  readonly outcomeHash: Hash;
}

export interface AttestationVerifiedMemoReuseStateV1 extends ResumeAuthorityFactsV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly publication: InstancePublicationV1;
  readonly verifiedMemoSetRoot: Hash;
}

export const attestationIdentityResumeStates = new WeakMap<object, AttestationIdentityResumeStateV1>();
export const consumedAttestationIdentityResumeCapabilities = new WeakSet<object>();
export const attestationOutcomeResumeStates = new WeakMap<object, AttestationOutcomeResumeStateV1>();
export const consumedAttestationOutcomeResumeCapabilities = new WeakSet<object>();
export const attestationVerifiedMemoReuseStates = new WeakMap<object, AttestationVerifiedMemoReuseStateV1>();
export const consumedAttestationVerifiedMemoReuseCapabilities = new WeakSet<object>();

function authorityFacts(state: AttestationAuthorityStateV1): ResumeAuthorityFactsV1 {
  return {
    runtimeAuthority: state.runtimeAuthority,
    attestationAuthorityRoot: state.authorityRoot,
    frameworkAuthorityRoot: state.frameworkAuthorityRoot,
    executorAuthorityRoot: state.executorAuthorityRoot,
  };
}

export function registerAttestationValidationAuthority(authority: object, state: AttestationAuthorityStateV1): void {
  attestationAuthorityStates.set(authority, state);
}

export function registerAttestationService(service: object, state: AttestationAuthorityStateV1): void {
  attestationServiceStates.set(service, state);
}

export function registerAttestationOutcomeCapability(outcome: AttestationOutcomeCapabilityV1, state: AttestationAuthorityStateV1): void {
  state.outcomeCapabilities.add(outcome);
  attestationOutcomeStates.set(outcome, state);
}

export function registerAttestationPartitionCapability(partition: AttestationPartitionCapabilityV1, state: AttestationAuthorityStateV1): void {
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
    ...authorityFacts(state),
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
    ...authorityFacts(state),
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
    ...authorityFacts(state),
  });
}
