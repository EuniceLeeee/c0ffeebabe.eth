import type { CanonicalJson, Hash } from "../../canonical-codec/src/index.ts";
import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import type { RuntimeAuthorityProjectionV1 } from "../../runtime-authority/src/index.ts";

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

/** Cloneable runtime content identity. It is not a release approval or a
 * signing authority; the engine binds it into every durable commitment. */
export interface AttestationCompositionResolvedV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
}
