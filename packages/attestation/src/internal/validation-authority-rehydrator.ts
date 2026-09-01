import type {
  AttestationIdentityResumeCapabilityV1,
  AttestationIdentityResumeInputV1,
  AttestationOutcomeResumeCapabilityV1,
  AttestationOutcomeResumeInputV1,
  AttestationValidationAuthorityV1,
  AttestationVerifiedMemoReuseCapabilityV1,
  AttestationVerifiedMemoReuseInputV1,
} from "../index.ts";
import { encodeCanonicalJson } from "../../../canonical-codec/src/index.ts";
import { assertAttestationValidationAuthority } from "./validation-authority-verifier.ts";
import {
  issueAttestationIdentityResumeCapability,
  issueAttestationOutcomeResumeCapability,
  issueAttestationVerifiedMemoReuseCapability,
  verifyOutcomeForAuthority,
  verifyIdentityForAuthority,
} from "./validation-authority-issuer.ts";
import { attestationAuthorityStates } from "./validation-authority-state.ts";

/**
 * Checkpoint-only bridge from exact durable bytes to a process-local opaque
 * resume handle. The public validation authority intentionally has no raw
 * resume issuer method.
 */
export function rehydrateIdentityResumeCapabilityForCheckpoint(
  authority: AttestationValidationAuthorityV1,
  input: AttestationIdentityResumeInputV1,
): AttestationIdentityResumeCapabilityV1 {
  const issued = assertAttestationValidationAuthority(authority);
  const state = attestationAuthorityStates.get(issued as object);
  if (!state) throw new TypeError("attestation-validation-authority-state-missing");
  const candidate = input.candidatePartitionReader.readCandidate(
    input.candidatePartition,
    input.familyCandidateKey,
  );
  const binding = input.candidatePartitionReader.binding(input.candidatePartition);
  if (
    input.runId !== binding.runId
    || encodeCanonicalJson(binding.runtimeAuthority) !== encodeCanonicalJson(state.runtimeAuthority)
    || input.cutoff.chainId !== binding.cutoff.chainId
    || input.cutoff.number !== binding.cutoff.number
    || input.cutoff.hash !== binding.cutoff.hash
    || input.cutoff.stateRoot !== binding.cutoff.stateRoot
    || input.familyCandidateKey !== candidate.familyCandidateKey
  ) throw new TypeError("candidate partition capability lineage mismatch");
  const identity = verifyIdentityForAuthority(input.identity, state, {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: binding.candidatePartitionRoot,
    candidate,
  });
  return issueAttestationIdentityResumeCapability(state, {
    ...input,
    candidatePartitionRoot: binding.candidatePartitionRoot,
    candidate,
    identity,
  });
}

/** Checkpoint-only bridge from a publication in the active root-reachable
 * VerifiedMemoSet to a one-shot current-candidate capability. */
export function rehydrateVerifiedMemoReuseCapabilityForCheckpoint(
  authority: AttestationValidationAuthorityV1,
  input: AttestationVerifiedMemoReuseInputV1,
): AttestationVerifiedMemoReuseCapabilityV1 {
  const issued = assertAttestationValidationAuthority(authority);
  const state = attestationAuthorityStates.get(issued as object);
  if (!state) throw new TypeError("attestation-validation-authority-state-missing");
  const candidate = input.candidatePartitionReader.readCandidate(
    input.candidatePartition,
    input.familyCandidateKey,
  );
  const binding = input.candidatePartitionReader.binding(input.candidatePartition);
  if (
    input.runId !== binding.runId
    || encodeCanonicalJson(binding.runtimeAuthority) !== encodeCanonicalJson(state.runtimeAuthority)
    || input.cutoff.chainId !== binding.cutoff.chainId
    || input.cutoff.number !== binding.cutoff.number
    || input.cutoff.hash !== binding.cutoff.hash
    || input.cutoff.stateRoot !== binding.cutoff.stateRoot
    || input.familyCandidateKey !== candidate.familyCandidateKey
  ) throw new TypeError("candidate partition capability lineage mismatch");
  return issueAttestationVerifiedMemoReuseCapability(state, {
    ...input,
    candidatePartitionRoot: binding.candidatePartitionRoot,
    candidate,
  });
}

/**
 * Rehydrate a process-local final-outcome handle from checkpoint-owned bytes.
 * The outcome is never accepted from the caller as an authority claim: the
 * checkpoint has already decoded the exact durable record, while this bridge
 * rechecks its exact content/root binding against the current runtime
 * authority before issuing the one-shot handle.
 */
export function rehydrateOutcomeResumeCapabilityForCheckpoint(
  authority: AttestationValidationAuthorityV1,
  input: AttestationOutcomeResumeInputV1,
): AttestationOutcomeResumeCapabilityV1 {
  const issued = assertAttestationValidationAuthority(authority);
  const state = attestationAuthorityStates.get(issued as object);
  if (!state) throw new TypeError("attestation-validation-authority-state-missing");
  const candidate = input.candidatePartitionReader.readCandidate(
    input.candidatePartition,
    input.familyCandidateKey,
  );
  const binding = input.candidatePartitionReader.binding(input.candidatePartition);
  if (
    input.runId !== binding.runId
    || encodeCanonicalJson(binding.runtimeAuthority) !== encodeCanonicalJson(state.runtimeAuthority)
    || input.cutoff.chainId !== binding.cutoff.chainId
    || input.cutoff.number !== binding.cutoff.number
    || input.cutoff.hash !== binding.cutoff.hash
    || input.cutoff.stateRoot !== binding.cutoff.stateRoot
    || input.familyCandidateKey !== candidate.familyCandidateKey
    || input.candidate.candidateSubjectHash !== candidate.candidateSubjectHash
  ) throw new TypeError("candidate partition capability lineage mismatch");
  const outcome = verifyOutcomeForAuthority(input.outcome, state, {
    runId: input.runId,
    cutoff: input.cutoff,
    candidatePartitionRoot: binding.candidatePartitionRoot,
    candidate,
  });
  return issueAttestationOutcomeResumeCapability(state, {
    ...input,
    candidatePartitionRoot: binding.candidatePartitionRoot,
    candidate,
    outcome,
  });
}
