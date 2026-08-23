import {
  assertActiveRuntimeReleaseAuthorityState,
} from "./state.ts";
import {
  readIssuedRuntimeReleaseAttestationProof,
  type RuntimeReleaseAttestationProofCapabilityV1,
  type RuntimeReleaseAttestationProofPortV1,
} from "./attestation-proof-owner.ts";

function assertCurrentLease(
  issued: ReturnType<typeof readIssuedRuntimeReleaseAttestationProof>,
  authorityValue: unknown,
): void {
  if (issued.authority !== authorityValue) throw new TypeError("runtime release attestation proof authority mismatch");
  const current = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  if (current.version !== issued.version || current.binding.bindingId !== issued.bindingId) {
    throw new TypeError("runtime release attestation proof capability stale");
  }
}

/** Exact consumer: every proof call re-checks the runtime lease. */
export function assertIssuedRuntimeReleaseAttestationProofPort(
  value: unknown,
  authorityValue: unknown,
): RuntimeReleaseAttestationProofPortV1 {
  const issued = readIssuedRuntimeReleaseAttestationProof(value as RuntimeReleaseAttestationProofCapabilityV1);
  assertCurrentLease(issued, authorityValue);
  return Object.freeze({
    issueIdentity(input: unknown) {
      assertCurrentLease(issued, authorityValue);
      const result = issued.port.issueIdentity(input);
      assertCurrentLease(issued, authorityValue);
      return result;
    },
    verifyIdentity(proof: unknown, context: unknown) {
      assertCurrentLease(issued, authorityValue);
      const result = issued.port.verifyIdentity(proof, context);
      assertCurrentLease(issued, authorityValue);
      return result;
    },
    issueOutcome(input: unknown) {
      assertCurrentLease(issued, authorityValue);
      const result = issued.port.issueOutcome(input);
      assertCurrentLease(issued, authorityValue);
      return result;
    },
    verifyOutcome(proof: unknown, context: unknown) {
      assertCurrentLease(issued, authorityValue);
      const result = issued.port.verifyOutcome(proof, context);
      assertCurrentLease(issued, authorityValue);
      return result;
    },
  });
}
