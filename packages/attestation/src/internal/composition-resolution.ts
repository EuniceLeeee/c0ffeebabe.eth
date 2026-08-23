import {
  assertHash,
  assertExactKeys,
} from "../../../canonical-codec/src/index.ts";
import type {
  AttestationCompositionResolvedV2,
  AttestationProofIssuerVerifierPortV1,
} from "../internal-authority.ts";
import { assertIssuedRuntimeReleaseAttestationComposition } from "../../../runtime-release-authority/src/internal/attestation-composition-consumer.ts";
import {
  decodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
} from "../../../../specs/release-authority/src/index.ts";

function normalizeComposition(value: unknown, context: string): AttestationCompositionResolvedV2 {
  assertExactKeys(value, ["provenance"], context);
  const provenance = value.provenance;
  assertExactKeys(provenance, ["runtimeBinding", "releaseProvenanceHash", "attestationProof", "attestationProofIssuerKeyId"], `${context}.provenance`);
  const runtimeBinding = decodeRuntimeReleaseBindingV1(provenance.runtimeBinding as object);
  const releaseProvenanceHash = assertHash(provenance.releaseProvenanceHash, `${context}.provenance.releaseProvenanceHash`);
  const expectedProvenanceHash = runtimeReleaseBindingProvenanceHash(runtimeBinding);
  if (releaseProvenanceHash !== expectedProvenanceHash) throw new TypeError(`${context}.provenance hash mismatch`);
  const attestationProofIssuerKeyId = assertHash(
    provenance.attestationProofIssuerKeyId,
    `${context}.provenance.attestationProofIssuerKeyId`,
  );
  if (attestationProofIssuerKeyId !== runtimeBinding.attestationProofIssuerKeyId) {
    throw new TypeError(`${context}.provenance.attestationProofIssuerKeyId mismatch`);
  }
  const identityProof = provenance.attestationProof;
  if (identityProof === null || typeof identityProof !== "object") throw new TypeError(`${context}.provenance.attestationProof invalid`);
  assertExactKeys(identityProof, ["issueIdentity", "verifyIdentity", "issueOutcome", "verifyOutcome"], `${context}.provenance.attestationProof`);
  if (
    typeof identityProof.issueIdentity !== "function"
    || typeof identityProof.verifyIdentity !== "function"
    || typeof identityProof.issueOutcome !== "function"
    || typeof identityProof.verifyOutcome !== "function"
  ) {
    throw new TypeError(`${context}.provenance.attestationProof invalid`);
  }
  return Object.freeze({
    provenance: Object.freeze({
      runtimeBinding,
      releaseProvenanceHash,
      attestationProof: identityProof as unknown as AttestationProofIssuerVerifierPortV1,
      attestationProofIssuerKeyId,
    }),
  });
}

/**
 * Resolve only a runtime-release-authority-issued composition.  The raw
 * RuntimeReleaseBinding, a shape-complete resolver, a cloned binding, and a
 * caller-supplied proof port all fail before normalization.
 */
export function resolveCompositionBinding(value: unknown): AttestationCompositionResolvedV2 {
  const resolved = assertIssuedRuntimeReleaseAttestationComposition(value);
  const runtimeBinding = decodeRuntimeReleaseBindingV1(resolved.provenance.runtimeBinding);
  const attestationProof = resolved.proofPort as unknown as AttestationProofIssuerVerifierPortV1;
  return normalizeComposition({
    provenance: {
      runtimeBinding,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(runtimeBinding),
      attestationProof,
      attestationProofIssuerKeyId: runtimeBinding.attestationProofIssuerKeyId,
    },
  }, "attestation-composition-resolution");
}
