import {
  deepFreeze,
  encodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import { validateInstancePublication } from "../../../catalog/src/index.ts";
import type { CandidateRecordV1, CanonicalCutoffV1 } from "../../../discovery/src/index.ts";
import { ATTESTATION_VALIDATION_AUTHORITY_BRAND } from "../authority-brand.ts";
import {
  attestationPartialIdentitySemanticHash,
  candidateFinalOutcomeBodyHash,
  candidateFinalOutcomeHash,
  identityCommitmentIssueInput,
  identityObservationSemanticHash,
  validateAttestationPartition,
  validateCandidateFinalOutcome,
  validateIdentityObservation,
  verifiedIdentitySubjectHash,
  type AttestationIdentityResumeCapabilityV1,
  type AttestationOutcomeBindingContextV1,
  type AttestationOutcomeCapabilityV1,
  type AttestationOutcomeResumeCapabilityV1,
  type AttestationOutcomeResumeInputV1,
  type AttestationOutcomeValidationContextV1,
  type AttestationPartitionCapabilityV1,
  type AttestationPartitionV1,
  type AttestationPersistenceBatchClaimV1,
  type AttestationPersistenceCapabilityV1,
  type AttestationValidationAuthorityV1,
  type AttestationVerifiedMemoReuseCapabilityV1,
  type AttestationVerifiedMemoReuseInputV1,
  type AttestationWriterCapabilityV1,
  type CandidateFinalOutcomeBodyV1,
  type CandidateFinalOutcomeV1,
  type IdentityVerifiedObservationV1,
  type IdentityVerifiedV1,
} from "../index.ts";
import {
  createAttestationIdentityCommitmentV1,
  createAttestationOutcomeCommitmentV1,
  decodeAttestationIdentityCommitmentV1,
  attestationIdentityCommitmentPayloadFromIssueInputV1,
  attestationOutcomeCommitmentPayloadFromIssueInputV1,
} from "../commitment.ts";
import {
  attestationOutcomeStates,
  attestationPartitionStates,
  registerAttestationIdentityResumeCapability,
  registerAttestationOutcomeCapability,
  registerAttestationOutcomeResumeCapability,
  registerAttestationPartitionCapability,
  registerAttestationValidationAuthority,
  registerAttestationVerifiedMemoReuseCapability,
  type AttestationAuthorityStateV1,
  type AttestationIdentityResumeResolvedInputV1,
} from "./validation-authority-state.ts";

type AttestationOutcomeBodyV1 = CandidateFinalOutcomeBodyV1;

function sameCanonical(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function nextSequence(state: AttestationAuthorityStateV1): string {
  const value = state.nextCommitmentSequence;
  state.nextCommitmentSequence += 1n;
  return String(value);
}

function assertAuthorityFacts(
  value: {
    readonly runtimeAuthority: unknown;
    readonly attestationAuthorityRoot: Hash;
    readonly frameworkAuthorityRoot: Hash;
    readonly executorAuthorityRoot: Hash;
  },
  state: AttestationAuthorityStateV1,
  label: string,
): void {
  if (
    !sameCanonical(value.runtimeAuthority, state.runtimeAuthority)
    || value.attestationAuthorityRoot !== state.authorityRoot
    || value.frameworkAuthorityRoot !== state.frameworkAuthorityRoot
    || value.executorAuthorityRoot !== state.executorAuthorityRoot
  ) throw new TypeError(`${label} authority mismatch`);
}

export function bindIdentityAuthority(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidatePartitionRoot: Hash,
  candidate: CandidateRecordV1,
  observation: IdentityVerifiedObservationV1,
  identityOrigin: import("../internal-authority.ts").AttestationIdentityOriginV1,
  authority: AttestationAuthorityStateV1,
): IdentityVerifiedV1 {
  const normalized = validateIdentityObservation(observation, "attestation.identityVerified");
  const input = identityCommitmentIssueInput(
    runId,
    cutoff,
    candidatePartitionRoot,
    candidate,
    normalized,
    identityOrigin,
    {
      runtimeAuthority: authority.runtimeAuthority,
      attestationAuthorityRoot: authority.authorityRoot,
      frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
      executorAuthorityRoot: authority.executorAuthorityRoot,
    },
  );
  const identityCommitment = createAttestationIdentityCommitmentV1(
    attestationIdentityCommitmentPayloadFromIssueInputV1(
      authority.runtimeAuthority,
      input,
      nextSequence(authority),
    ),
  );
  return deepFreeze({ ...normalized, identityCommitment });
}

export function verifyIdentityForAuthority(
  identity: IdentityVerifiedV1,
  authority: AttestationAuthorityStateV1,
  context: AttestationOutcomeBindingContextV1,
): IdentityVerifiedV1 {
  const observation = validateIdentityObservation({
    kind: identity.kind,
    familyInstanceKey: identity.familyInstanceKey,
    identityMemo: identity.identityMemo,
    identityMemoHash: identity.identityMemoHash,
    descriptorHash: identity.descriptorHash,
    evidenceRoot: identity.evidenceRoot,
  }, "attestation.identityCommitment.observation");
  const commitment = decodeAttestationIdentityCommitmentV1(identity.identityCommitment);
  assertAuthorityFacts(commitment, authority, "attestation identity commitment");
  const committedObservation = validateIdentityObservation(
    commitment.identityObservation,
    "attestation.identityCommitment.identityObservation",
  );
  if (!sameCanonical(observation, committedObservation)
    || commitment.runId !== context.runId
    || !sameCanonical(commitment.cutoff, context.cutoff)
    || commitment.candidatePartitionRoot !== context.candidatePartitionRoot
    || commitment.familyDefinitionHash !== context.candidate.familyDefinitionHash
    || commitment.familyCandidateKey !== context.candidate.familyCandidateKey
    || commitment.candidateSubjectHash !== context.candidate.candidateSubjectHash
    || commitment.identitySubjectHash !== verifiedIdentitySubjectHash(context.candidate, observation)
    || commitment.identitySemanticHash !== identityObservationSemanticHash(
      context.runId,
      context.cutoff,
      context.candidatePartitionRoot,
      context.candidate,
      observation,
      commitment.identityOrigin,
      {
        runtimeAuthority: authority.runtimeAuthority,
        attestationAuthorityRoot: authority.authorityRoot,
        frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
        executorAuthorityRoot: authority.executorAuthorityRoot,
      },
    )) throw new TypeError("attestation identity commitment lineage mismatch");
  return deepFreeze({ ...observation, identityCommitment: commitment });
}

export function assertOutcomeAuthorityBinding(
  outcome: CandidateFinalOutcomeV1,
  authority: AttestationAuthorityStateV1,
  context: AttestationOutcomeBindingContextV1,
  label: string,
): void {
  assertAuthorityFacts(outcome, authority, label);
  if (outcome.outcomeCommitment.candidatePartitionRoot !== context.candidatePartitionRoot) {
    throw new TypeError(`${label} candidate partition mismatch`);
  }
  if (outcome.identityCommitment !== null) {
    verifyIdentityForAuthority({
      ...outcome.identityCommitment.identityObservation,
      identityCommitment: outcome.identityCommitment,
    }, authority, context);
  }
}

export function verifyOutcomeForAuthority(
  outcome: CandidateFinalOutcomeV1,
  authority: AttestationAuthorityStateV1,
  context: AttestationOutcomeBindingContextV1,
): CandidateFinalOutcomeV1 {
  validateCandidateFinalOutcome(context.runId, context.cutoff, context.candidate, outcome);
  assertOutcomeAuthorityBinding(outcome, authority, context, "durable attestation outcome");
  return deepFreeze(outcome);
}

function assertPartitionAuthorityBinding(
  partition: AttestationPartitionV1,
  candidates: readonly CandidateRecordV1[],
  authority: AttestationAuthorityStateV1,
  label: string,
): void {
  assertAuthorityFacts(partition, authority, label);
  const byKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
  for (const outcome of partition.outcomes) {
    const candidate = byKey.get(outcome.familyCandidateKey);
    if (!candidate) throw new TypeError(`${label} candidate missing`);
    assertOutcomeAuthorityBinding(outcome, authority, {
      runId: partition.runId,
      cutoff: partition.cutoff,
      candidatePartitionRoot: partition.candidatePartitionRoot,
      candidate,
    }, `${label}.outcome`);
  }
}

export function bindOutcomeAuthority(
  outcome: AttestationOutcomeBodyV1,
  authority: AttestationAuthorityStateV1,
  context: AttestationOutcomeBindingContextV1,
): AttestationOutcomeCapabilityV1 {
  const boundBody = deepFreeze({
    ...outcome,
    runtimeAuthority: authority.runtimeAuthority,
    attestationAuthorityRoot: authority.authorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
  });
  const outcomeCommitment = createAttestationOutcomeCommitmentV1(
    attestationOutcomeCommitmentPayloadFromIssueInputV1(
      authority.runtimeAuthority,
      {
        runId: context.runId,
        cutoff: context.cutoff,
        candidatePartitionRoot: context.candidatePartitionRoot,
        candidate: context.candidate,
        outcomeBodyHash: candidateFinalOutcomeBodyHash(boundBody),
        attestationAuthorityRoot: authority.authorityRoot,
        frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
        executorAuthorityRoot: authority.executorAuthorityRoot,
      },
      nextSequence(authority),
    ),
  );
  const bound = deepFreeze({ ...boundBody, outcomeCommitment }) as AttestationOutcomeCapabilityV1;
  validateCandidateFinalOutcome(context.runId, context.cutoff, context.candidate, bound);
  registerAttestationOutcomeCapability(bound, authority);
  return bound;
}

export function bindPartitionAuthority(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidatePartitionRoot: Hash,
  outcomes: readonly AttestationOutcomeCapabilityV1[],
  accounting: AttestationPartitionV1["accounting"],
  authority: AttestationAuthorityStateV1,
): AttestationPartitionCapabilityV1 {
  const partition = deepFreeze({
    runId,
    cutoff,
    candidatePartitionRoot,
    outcomes,
    runtimeAuthority: authority.runtimeAuthority,
    attestationAuthorityRoot: authority.authorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
    accounting,
    exactOutcomePartitionRoot: hashDomain("aloha/exact-outcome-partition/v1", {
      runId,
      cutoff,
      candidatePartitionRoot,
      runtimeAuthority: authority.runtimeAuthority,
      attestationAuthorityRoot: authority.authorityRoot,
      frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
      executorAuthorityRoot: authority.executorAuthorityRoot,
      outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
    }),
  }) as AttestationPartitionCapabilityV1;
  registerAttestationPartitionCapability(partition, authority);
  return partition;
}

export function issueAttestationIdentityResumeCapability(
  state: AttestationAuthorityStateV1,
  input: AttestationIdentityResumeResolvedInputV1,
): AttestationIdentityResumeCapabilityV1 {
  if (input === null || typeof input !== "object") throw new TypeError("attestation-identity-resume-input-invalid");
  assertAuthorityFacts(input, state, "attestation identity resume");
  verifyIdentityForAuthority(input.identity, state, {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    candidate: input.candidate,
  });
  if (attestationPartialIdentitySemanticHash(input) !== input.outcomeHash) {
    throw new TypeError("attestation-identity-resume-hash-mismatch");
  }
  const capability = Object.freeze({}) as AttestationIdentityResumeCapabilityV1;
  registerAttestationIdentityResumeCapability(capability, input, state);
  return capability;
}

export function issueAttestationOutcomeResumeCapability(
  state: AttestationAuthorityStateV1,
  input: AttestationOutcomeResumeInputV1 & { readonly candidatePartitionRoot: Hash },
): AttestationOutcomeResumeCapabilityV1 {
  if (input === null || typeof input !== "object") throw new TypeError("attestation-outcome-resume-input-invalid");
  assertAuthorityFacts(input, state, "attestation outcome resume");
  if (candidateFinalOutcomeHash(input.outcome) !== input.outcomeHash) {
    throw new TypeError("attestation-outcome-resume-hash-mismatch");
  }
  verifyOutcomeForAuthority(input.outcome, state, {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: input.candidatePartitionRoot,
    candidate: input.candidate,
  });
  const capability = Object.freeze({}) as AttestationOutcomeResumeCapabilityV1;
  registerAttestationOutcomeResumeCapability(capability, input, state);
  return capability;
}

export function issueAttestationVerifiedMemoReuseCapability(
  state: AttestationAuthorityStateV1,
  input: AttestationVerifiedMemoReuseInputV1 & {
    readonly candidatePartitionRoot: Hash;
    readonly candidate: CandidateRecordV1;
  },
): AttestationVerifiedMemoReuseCapabilityV1 {
  if (input === null || typeof input !== "object") throw new TypeError("attestation-memo-reuse-input-invalid");
  validateInstancePublication(input.publication);
  if (input.publication.familyId !== input.candidate.familyId
    || input.publication.instanceKey !== input.candidate.instanceNominationKey) {
    throw new TypeError("attestation-memo-reuse-candidate-binding-mismatch");
  }
  const capability = Object.freeze({}) as AttestationVerifiedMemoReuseCapabilityV1;
  registerAttestationVerifiedMemoReuseCapability(capability, input, state);
  return capability;
}

export function issueAttestationValidationAuthority(
  state: AttestationAuthorityStateV1,
): AttestationValidationAuthorityV1 {
  const evidenceSnapshot = deepFreeze({
    runtimeAuthority: state.runtimeAuthority,
    attestationAuthorityRoot: state.authorityRoot,
    frameworkAuthorityRoot: state.frameworkAuthorityRoot,
    executorAuthorityRoot: state.executorAuthorityRoot,
  });
  const sameOwner = (owner: AttestationAuthorityStateV1 | undefined): boolean => owner === state;
  const authority = {
    [ATTESTATION_VALIDATION_AUTHORITY_BRAND]: true as const,
    runtimeAuthority: state.runtimeAuthority,
    authorityRoot: state.authorityRoot,
    frameworkAuthorityRoot: state.frameworkAuthorityRoot,
    executorAuthorityRoot: state.executorAuthorityRoot,
    readEvidenceAuthority: () => evidenceSnapshot,
    claimWriterCapabilities(
      writerCapability: AttestationWriterCapabilityV1,
      persistenceCapabilities: readonly AttestationPersistenceCapabilityV1[],
    ): AttestationPersistenceBatchClaimV1 {
      if (writerCapability === null || typeof writerCapability !== "object") {
        throw new TypeError("attestation-writer-capability-invalid");
      }
      const consumer = state.writerConsumers.get(writerCapability);
      if (!consumer) throw new TypeError("attestation-writer-capability-not-issued");
      if (!Array.isArray(persistenceCapabilities)) throw new TypeError("attestation-persistence-capabilities-invalid");
      return consumer.claim(writerCapability, persistenceCapabilities);
    },
    validateOutcomeCapability(value: unknown, context: AttestationOutcomeValidationContextV1): CandidateFinalOutcomeV1 {
      if (value === null || typeof value !== "object" || !state.outcomeCapabilities.has(value)
        || !sameOwner(attestationOutcomeStates.get(value))) {
        throw new TypeError("attestation-outcome-capability-not-issued");
      }
      return verifyOutcomeForAuthority(value as CandidateFinalOutcomeV1, state, context);
    },
    validatePartitionCapability(value: unknown, candidates: readonly CandidateRecordV1[]): AttestationPartitionV1 {
      if (value === null || typeof value !== "object" || !state.partitionCapabilities.has(value)
        || !sameOwner(attestationPartitionStates.get(value))) {
        throw new TypeError("attestation-partition-capability-not-issued");
      }
      const partition = value as AttestationPartitionV1;
      validateAttestationPartition(partition, candidates);
      assertPartitionAuthorityBinding(partition, candidates, state, "attestation partition");
      if (partition.outcomes.some(outcome => !sameOwner(attestationOutcomeStates.get(outcome)))) {
        throw new TypeError("attestation-partition-outcome-capability-mismatch");
      }
      return partition;
    },
    validateDurableOutcome(value: unknown, context: AttestationOutcomeValidationContextV1): CandidateFinalOutcomeV1 {
      if (value === null || typeof value !== "object") throw new TypeError("attestation-outcome-invalid");
      return verifyOutcomeForAuthority(value as CandidateFinalOutcomeV1, state, context);
    },
    validateDurablePartition(value: unknown, candidates: readonly CandidateRecordV1[]): AttestationPartitionV1 {
      if (value === null || typeof value !== "object") throw new TypeError("attestation-partition-invalid");
      const partition = value as AttestationPartitionV1;
      validateAttestationPartition(partition, candidates);
      assertPartitionAuthorityBinding(partition, candidates, state, "durable attestation partition");
      return partition;
    },
  } satisfies AttestationValidationAuthorityV1;
  registerAttestationValidationAuthority(authority, state);
  return Object.freeze(authority);
}
