import type { CanonicalJson, Hash } from "../../canonical-codec/src/index.ts";
import type { CandidateRecordV1, CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import type { RuntimeReleaseBindingV1 } from "../../../specs/release-authority/src/index.ts";
import type {
  RuntimeReleaseAttestationCompositionBindingV1,
  RuntimeReleaseAttestationCompositionCapabilityV1,
  RuntimeReleaseAttestationCompositionResolutionPortV1,
} from "../../../specs/release-authority/src/index.ts";

export interface VerifiedMemoReuseProofV1 {
  readonly kind: "verifiedMemoReuseProof";
  readonly familyId: string;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly instanceNominationKey: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly oldInstancePublicationHash: Hash;
  readonly requestedArtifactDependencyRoot: Hash;
  readonly descriptorHash: Hash;
  readonly validityDependencyRoot: Hash;
  readonly candidateToCanonicalIdentityBindingProof: Hash;
  readonly identityMemo: CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly evidenceRoot: Hash;
  readonly proofHash: Hash;
}

export type AttestationIdentityOriginV1 =
  | { readonly kind: "fresh" }
  | {
    readonly kind: "verified-memo-reuse";
    readonly verifiedMemoSetRoot: Hash;
    readonly proof: VerifiedMemoReuseProofV1;
  };

/**
 * Release qualification is outside the candidate repository.  These are
 * readonly contracts for the already-qualified approval and its authority
 * coordinates; no trust anchor, signer, or minting helper lives here.
 */
/**
 * Exact per-candidate proof input.  The issuer is outside the candidate
 * runtime; the candidate supplies only already observed semantic hashes.
 */
export interface AttestationIdentityProofIssueInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash">;
  /** Exact normalized family observation.  Restart verification derives the
   * subject and semantic hashes from these signed bytes rather than trusting
   * a separately persisted identity-shaped object. */
  readonly identityObservation: {
    readonly kind: "identityVerified";
    readonly familyInstanceKey: string;
    readonly identityMemo: CanonicalJson;
    readonly identityMemoHash: Hash;
    readonly descriptorHash: Hash;
    readonly evidenceRoot: Hash;
  };
  readonly identitySubjectHash: Hash;
  /** The proof binds the pre-proof identity semantic hash; the persisted
   * partial hash additionally commits the returned proofHash. */
  readonly identitySemanticHash: Hash;
  /** Owner-observed source of this identity. The signed proof makes this
   * durable across checkpoint restart and prevents fresh/reuse substitution. */
  readonly identityOrigin: AttestationIdentityOriginV1;
  readonly releaseProvenanceHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly attestationProofIssuerKeyId: Hash;
}

export type AttestationIdentityProofVerificationContextV1 = AttestationIdentityProofIssueInputV1;

export interface AttestationIdentityIssuerProofV1 {
  readonly kind: "aloha.attestation-identity-issuer-proof";
  readonly version: "2";
  readonly proofHash: Hash;
  readonly payloadHash: Hash;
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly identityObservation: {
    readonly kind: "identityVerified";
    readonly familyInstanceKey: string;
    readonly identityMemo: CanonicalJson;
    readonly identityMemoHash: Hash;
    readonly descriptorHash: Hash;
    readonly evidenceRoot: Hash;
  };
  readonly identitySubjectHash: Hash;
  readonly identitySemanticHash: Hash;
  readonly identityOrigin: AttestationIdentityOriginV1;
  readonly releaseProvenanceHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly sequence: string;
  readonly signatureAlgorithm: "ed25519";
  readonly issuerKeyId: Hash;
  readonly signatureHex: `0x${string}`;
}

/**
 * The final-outcome proof is deliberately a separate signed domain from the
 * identity proof.  It commits the exact final body (with no proof field) and
 * all restart authority coordinates, so a valid identity proof cannot be
 * replayed with a rewritten publication, rejection, or retryable outcome.
 */
export interface AttestationOutcomeProofIssueInputV1 {
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly candidate: Pick<CandidateRecordV1, "familyDefinitionHash" | "familyCandidateKey" | "candidateSubjectHash">;
  readonly outcomeBodyHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly attestationProofIssuerKeyId: Hash;
}

export type AttestationOutcomeProofVerificationContextV1 = AttestationOutcomeProofIssueInputV1;

export interface AttestationOutcomeIssuerProofV1 {
  readonly kind: "aloha.attestation-outcome-issuer-proof";
  readonly version: "2";
  readonly proofHash: Hash;
  readonly payloadHash: Hash;
  readonly runId: string;
  readonly cutoff: CanonicalCutoffV1;
  readonly candidatePartitionRoot: Hash;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly outcomeBodyHash: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly attestationAuthorityRoot: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly sequence: string;
  readonly signatureAlgorithm: "ed25519";
  readonly issuerKeyId: Hash;
  readonly signatureHex: `0x${string}`;
}

/** The only seam through which a release may issue/verify identity proofs. */
export interface AttestationProofIssuerVerifierPortV1 {
  issueIdentity(input: AttestationIdentityProofIssueInputV1): AttestationIdentityIssuerProofV1;
  verifyIdentity(
    value: unknown,
    context: AttestationIdentityProofVerificationContextV1,
  ): AttestationIdentityIssuerProofV1;
  issueOutcome(input: AttestationOutcomeProofIssueInputV1): AttestationOutcomeIssuerProofV1;
  verifyOutcome(
    value: unknown,
    context: AttestationOutcomeProofVerificationContextV1,
  ): AttestationOutcomeIssuerProofV1;
}

export interface AttestationReleaseProvenanceV2 {
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly releaseProvenanceHash: Hash;
  readonly attestationProof: AttestationProofIssuerVerifierPortV1;
  readonly attestationProofIssuerKeyId: Hash;
}

export interface AttestationCompositionResolvedV2 {
  readonly provenance: AttestationReleaseProvenanceV2;
}

/**
 * These are aliases of the neutral runtime-release contract.  The concrete
 * capability is issued by runtime-release-authority's private owner; the
 * Attestation package never accepts a raw binding or a structural resolver.
 */
export type AttestationCompositionCapabilityV1 = RuntimeReleaseAttestationCompositionCapabilityV1;
export type AttestationCompositionResolutionPortV1 = RuntimeReleaseAttestationCompositionResolutionPortV1;
export type AttestationCompositionBindingV1 = RuntimeReleaseAttestationCompositionBindingV1;
