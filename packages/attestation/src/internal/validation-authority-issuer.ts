import {
  deepFreeze,
  hashCanonicalPartition,
  hashDomain,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  attestationPartialIdentitySemanticHash,
  candidateFinalOutcomeBodyHash,
  identityProofVerificationContext,
  validateIdentityObservation,
  validateAttestationPartition,
  validateCandidateFinalOutcome,
  type AttestationIdentityResumeInputV1,
  type AttestationIdentityResumeCapabilityV1,
  type AttestationOutcomeCapabilityV1,
  type AttestationOutcomeValidationContextV1,
  type AttestationPartitionCapabilityV1,
  type AttestationPartitionV1,
  type AttestationPersistenceBatchClaimV1,
  type AttestationPersistenceCapabilityV1,
  type AttestationWriterCapabilityV1,
  type CandidateFinalOutcomeV1,
  type AttestationOutcomeBindingContextV1,
  type AttestationValidationAuthorityV1,
  type IdentityVerifiedV1,
} from "../index.ts";
import { validateOutcomeIssuerProof } from "./outcome-proof.ts";
import { validateIdentityIssuerProof } from "./identity-proof.ts";
import type { CandidateRecordV1, CanonicalCutoffV1 } from "../../../discovery/src/index.ts";
import { ATTESTATION_VALIDATION_AUTHORITY_BRAND } from "../authority-brand.ts";
import {
  attestationOutcomeStates,
  attestationPartitionStates,
  type AttestationAuthorityStateV1,
  registerAttestationOutcomeCapability,
  registerAttestationPartitionCapability,
  registerAttestationIdentityResumeCapability,
  registerAttestationValidationAuthority,
  type AttestationIdentityResumeResolvedInputV1,
} from "./validation-authority-state.ts";

type AttestationOutcomeBodyV1 = Omit<
  AttestationOutcomeCapabilityV1,
  "attestationAuthorityRoot" | "releaseAuthorityRoot" | "releaseProvenanceHash" | "executorAuthorityRoot" | "outcomeIssuerProof"
>;

export function verifyIdentityForAuthority(
  identity: IdentityVerifiedV1,
  authority: AttestationAuthorityStateV1,
  context: AttestationOutcomeBindingContextV1,
): IdentityVerifiedV1 {
  const observation = validateIdentityObservation({
    kind: identity.kind,
    familyInstanceKey: identity.familyInstanceKey,
    identityMemoHash: identity.identityMemoHash,
    descriptorHash: identity.descriptorHash,
    evidenceRoot: identity.evidenceRoot,
  }, "attestation.identityProof.observation");
  const proofContext = identityProofVerificationContext(
    context.runId,
    context.cutoff,
    context.candidatePartitionRoot,
    context.candidate,
    observation,
    {
      releaseProvenanceHash: authority.releaseProvenanceHash,
      attestationAuthorityRoot: authority.authorityRoot,
      releaseAuthorityRoot: authority.releaseAuthorityRoot,
      frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
      executorAuthorityRoot: authority.executorAuthorityRoot,
      attestationProofIssuerKeyId: authority.attestationProofIssuerKeyId,
    },
  );
  const proof = validateIdentityIssuerProof(identity.issuerProof, proofContext);
  const verified = authority.attestationProof.verifyIdentity(proof, proofContext);
  const exact = validateIdentityIssuerProof(verified, proofContext);
  if (exact.proofHash !== proof.proofHash) throw new TypeError("attestation identity proof verifier mismatch");
  return deepFreeze({ ...observation, issuerProof: exact });
}

function assertOutcomeAuthorityBinding(
  outcome: CandidateFinalOutcomeV1,
  authority: AttestationAuthorityStateV1,
  context: AttestationOutcomeBindingContextV1,
  label: string,
): void {
  if (
    outcome.attestationAuthorityRoot !== authority.authorityRoot
    || outcome.releaseAuthorityRoot !== authority.releaseAuthorityRoot
    || outcome.executorAuthorityRoot !== authority.executorAuthorityRoot
    || outcome.releaseProvenanceHash !== authority.releaseProvenanceHash
  ) throw new TypeError(`${label} authority root mismatch`);
  if (outcome.kind === "chainProvenRejected" && outcome.proof.executorAuthorityRoot !== authority.executorAuthorityRoot) {
    throw new TypeError(`${label} executor authority root mismatch`);
  }
  if (outcome.identityProof !== null) {
    const verifiedIdentity = verifyIdentityForAuthority({
      ...outcome.identityProof.identityObservation,
      issuerProof: outcome.identityProof,
    }, authority, context);
    if (verifiedIdentity.issuerProof.proofHash !== outcome.identityProof.proofHash) {
      throw new TypeError(`${label} identity proof verifier mismatch`);
    }
  }
  const proofContext = {
    runId: context.runId,
    cutoff: context.cutoff,
    candidatePartitionRoot: context.candidatePartitionRoot,
    candidate: context.candidate,
    outcomeBodyHash: candidateFinalOutcomeBodyHash(outcome),
    releaseProvenanceHash: authority.releaseProvenanceHash,
    attestationAuthorityRoot: authority.authorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
    releaseAuthorityRoot: authority.releaseAuthorityRoot,
    attestationProofIssuerKeyId: authority.attestationProofIssuerKeyId,
  } as const;
  const outcomeProof = validateOutcomeIssuerProof(outcome.outcomeIssuerProof, proofContext);
  const verifiedOutcomeProof = authority.attestationProof.verifyOutcome(outcomeProof, proofContext);
  const exactOutcomeProof = validateOutcomeIssuerProof(verifiedOutcomeProof, proofContext);
  if (exactOutcomeProof.proofHash !== outcomeProof.proofHash) throw new TypeError(`${label} outcome proof verifier mismatch`);
}

function assertPartitionAuthorityBinding(
  partition: AttestationPartitionV1,
  candidates: readonly CandidateRecordV1[],
  authority: AttestationAuthorityStateV1,
  label: string,
): void {
  if (
    partition.attestationAuthorityRoot !== authority.authorityRoot
    || partition.releaseAuthorityRoot !== authority.releaseAuthorityRoot
    || partition.executorAuthorityRoot !== authority.executorAuthorityRoot
    || partition.releaseProvenanceHash !== authority.releaseProvenanceHash
  ) throw new TypeError(`${label} authority root mismatch`);
  const byKey = new Map(candidates.map(candidate => [candidate.familyCandidateKey, candidate]));
  for (const outcome of partition.outcomes) assertOutcomeAuthorityBinding(outcome, authority, {
    runId: partition.runId,
    cutoff: partition.cutoff,
    candidatePartitionRoot: partition.candidatePartitionRoot,
    candidate: byKey.get(outcome.familyCandidateKey)!,
  }, `${label}.outcome`);
}

export function bindOutcomeAuthority(
  outcome: AttestationOutcomeBodyV1,
  authority: AttestationAuthorityStateV1,
  context: AttestationOutcomeBindingContextV1,
): AttestationOutcomeCapabilityV1 {
  const boundWithoutProof = deepFreeze({
    ...outcome,
    attestationAuthorityRoot: authority.authorityRoot,
    releaseAuthorityRoot: authority.releaseAuthorityRoot,
    releaseProvenanceHash: authority.releaseProvenanceHash,
    executorAuthorityRoot: authority.executorAuthorityRoot,
  }) as unknown as Omit<AttestationOutcomeCapabilityV1, "outcomeIssuerProof">;
  const proofInput = {
    runId: context.runId,
    cutoff: context.cutoff,
    candidatePartitionRoot: context.candidatePartitionRoot,
    candidate: context.candidate,
    outcomeBodyHash: candidateFinalOutcomeBodyHash(boundWithoutProof),
    releaseProvenanceHash: authority.releaseProvenanceHash,
    attestationAuthorityRoot: authority.authorityRoot,
    frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
    executorAuthorityRoot: authority.executorAuthorityRoot,
    releaseAuthorityRoot: authority.releaseAuthorityRoot,
    attestationProofIssuerKeyId: authority.attestationProofIssuerKeyId,
  } as const;
  const issued = authority.attestationProof.issueOutcome(proofInput);
  const normalized = validateOutcomeIssuerProof(issued, proofInput);
  const verified = authority.attestationProof.verifyOutcome(normalized, proofInput);
  const exact = validateOutcomeIssuerProof(verified, proofInput);
  if (exact.proofHash !== normalized.proofHash) throw new TypeError("attestation-outcome-proof-issuer-result-mismatch");
  const bound = deepFreeze({ ...boundWithoutProof, outcomeIssuerProof: exact }) as unknown as AttestationOutcomeCapabilityV1;
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
    attestationAuthorityRoot: authority.authorityRoot,
    releaseAuthorityRoot: authority.releaseAuthorityRoot,
    releaseProvenanceHash: authority.releaseProvenanceHash,
    executorAuthorityRoot: authority.executorAuthorityRoot,
    accounting,
    exactOutcomePartitionRoot: hashDomain("aloha/exact-outcome-partition/v1", {
      runId,
      cutoff,
      candidatePartitionRoot,
      attestationAuthorityRoot: authority.authorityRoot,
      releaseAuthorityRoot: authority.releaseAuthorityRoot,
      releaseProvenanceHash: authority.releaseProvenanceHash,
      executorAuthorityRoot: authority.executorAuthorityRoot,
      outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
    }),
  }) as unknown as AttestationPartitionCapabilityV1;
  registerAttestationPartitionCapability(partition, authority);
  return partition;
}

export function issueAttestationIdentityResumeCapability(
  state: AttestationAuthorityStateV1,
  input: AttestationIdentityResumeResolvedInputV1,
): AttestationIdentityResumeCapabilityV1 {
  if (input === null || typeof input !== "object") throw new TypeError("attestation-identity-resume-input-invalid");
  if (
    input.attestationAuthorityRoot !== state.authorityRoot
    || input.releaseAuthorityRoot !== state.releaseAuthorityRoot
    || input.releaseProvenanceHash !== state.releaseProvenanceHash
    || input.executorAuthorityRoot !== state.executorAuthorityRoot
  ) throw new TypeError("attestation-identity-resume-authority-mismatch");
  const outcomeHash = attestationPartialIdentitySemanticHash(input);
  if (outcomeHash !== input.outcomeHash) throw new TypeError("attestation-identity-resume-hash-mismatch");
  const capability = Object.freeze({}) as AttestationIdentityResumeCapabilityV1;
  registerAttestationIdentityResumeCapability(capability, input, state);
  return capability;
}

export function issueAttestationValidationAuthority(
  state: AttestationAuthorityStateV1,
): AttestationValidationAuthorityV1 {
  const authority = {
    [ATTESTATION_VALIDATION_AUTHORITY_BRAND]: true as const,
    authorityRoot: state.authorityRoot,
    releaseAuthorityRoot: state.releaseAuthorityRoot,
    releaseProvenanceHash: state.releaseProvenanceHash,
    frameworkAuthorityRoot: state.frameworkAuthorityRoot,
    executorAuthorityRoot: state.executorAuthorityRoot,
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
      if (value === null || typeof value !== "object" || !state.outcomeCapabilities.has(value)) {
        throw new TypeError("attestation-outcome-capability-not-issued");
      }
      const owner = attestationOutcomeStates.get(value);
      if (
        !owner
        || owner.authorityRoot !== state.authorityRoot
        || owner.releaseAuthorityRoot !== state.releaseAuthorityRoot
        || owner.executorAuthorityRoot !== state.executorAuthorityRoot
      ) throw new TypeError("attestation-outcome-capability-authority-mismatch");
      const outcome = value as CandidateFinalOutcomeV1;
      validateCandidateFinalOutcome(context.runId, context.cutoff, context.candidate, outcome);
      assertOutcomeAuthorityBinding(outcome, state, context, "attestation outcome");
      return outcome;
    },
    validatePartitionCapability(value: unknown, candidates: readonly CandidateRecordV1[]): AttestationPartitionV1 {
      if (value === null || typeof value !== "object" || !state.partitionCapabilities.has(value)) {
        throw new TypeError("attestation-partition-capability-not-issued");
      }
      const owner = attestationPartitionStates.get(value);
      if (
        !owner
        || owner.authorityRoot !== state.authorityRoot
        || owner.releaseAuthorityRoot !== state.releaseAuthorityRoot
        || owner.executorAuthorityRoot !== state.executorAuthorityRoot
      ) throw new TypeError("attestation-partition-capability-authority-mismatch");
      const partition = value as AttestationPartitionV1;
      validateAttestationPartition(partition, candidates);
      assertPartitionAuthorityBinding(partition, candidates, state, "attestation partition");
      for (const outcome of partition.outcomes) {
        const outcomeOwner = attestationOutcomeStates.get(outcome);
        if (
          !outcomeOwner
          || outcomeOwner.authorityRoot !== state.authorityRoot
          || outcomeOwner.releaseAuthorityRoot !== state.releaseAuthorityRoot
          || outcomeOwner.executorAuthorityRoot !== state.executorAuthorityRoot
        ) {
          throw new TypeError("attestation-partition-outcome-capability-mismatch");
        }
      }
      return partition;
    },
    validateDurableOutcome(value: unknown, context: AttestationOutcomeValidationContextV1): CandidateFinalOutcomeV1 {
      if (value === null || typeof value !== "object") throw new TypeError("attestation-outcome-invalid");
      const outcome = value as CandidateFinalOutcomeV1;
      validateCandidateFinalOutcome(context.runId, context.cutoff, context.candidate, outcome);
      assertOutcomeAuthorityBinding(outcome, state, context, "durable attestation outcome");
      return outcome;
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
