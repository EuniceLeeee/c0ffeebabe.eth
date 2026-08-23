import type {
  AttestationIdentityResumeCapabilityV1,
  AttestationIdentityResumeInputV1,
  AttestationValidationAuthorityV1,
} from "../index.ts";
import { assertAttestationValidationAuthority } from "./validation-authority-verifier.ts";
import {
  issueAttestationIdentityResumeCapability,
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
