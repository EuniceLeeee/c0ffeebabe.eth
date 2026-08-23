import {
  candidatePartitionBindingFromProof,
  decodeCandidatePartitionProofV1,
  type CandidatePartitionProofIssuerPortV1,
  type CandidatePartitionProofReleaseBindingV1,
} from "../../../../specs/candidate-partition-authority/src/index.ts";
import { issueCandidatePartitionProofIssuerPort } from "../../../../specs/candidate-partition-authority/src/internal/issuer-owner.ts";
import { assertIssuedCandidatePartitionProofIssuer } from "../../../../specs/candidate-partition-authority/src/internal/issuer-consumer.ts";
import type { CandidatePartitionProofPayloadV1, CandidatePartitionProofVerificationContextV1 } from "../../../../specs/candidate-partition-authority/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";

interface CandidatePartitionProofIssuerStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly implementation: CandidatePartitionProofIssuerPortV1;
  readonly version: bigint;
}

const states = new WeakMap<object, CandidatePartitionProofIssuerStateV1>();

function currentRelease(
  authority: RuntimeReleaseAuthorityV1,
): CandidatePartitionProofReleaseBindingV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(authority);
  return Object.freeze({
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(state.binding),
    releaseAuthorityRoot: state.binding.releaseAuthorityRoot,
    candidatePartitionProofIssuerKeyId: state.binding.candidatePartitionProofIssuerKeyId,
  });
}

function sameRelease(
  left: CandidatePartitionProofReleaseBindingV1,
  right: CandidatePartitionProofReleaseBindingV1,
): boolean {
  return left.releaseProvenanceHash === right.releaseProvenanceHash
    && left.releaseAuthorityRoot === right.releaseAuthorityRoot
    && left.candidatePartitionProofIssuerKeyId === right.candidatePartitionProofIssuerKeyId;
}

function assertCurrent(state: CandidatePartitionProofIssuerStateV1): CandidatePartitionProofReleaseBindingV1 {
  const authorityState = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (authorityState.version !== state.version) throw new TypeError("candidate partition proof issuer stale after runtime release rotation");
  const release = currentRelease(state.authority);
  const implementationRelease = state.implementation.currentRelease();
  if (!sameRelease(implementationRelease, release)) {
    throw new TypeError("candidate partition proof implementation is not bound to the current runtime release");
  }
  return release;
}

/**
 * Bind an externally-issued proof implementation to the verified runtime
 * release.  Checkpoint receives only the neutral projection and proof
 * methods; the signed runtime binding never crosses that boundary.
 */
export function issueRuntimeReleaseCandidatePartitionProofIssuer(
  authorityValue: unknown,
  implementationValue: unknown,
): CandidatePartitionProofIssuerPortV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const authorityState = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  const implementation = assertIssuedCandidatePartitionProofIssuer(implementationValue);
  const state: CandidatePartitionProofIssuerStateV1 = {
    authority,
    implementation,
    version: authorityState.version,
  };
  assertCurrent(state);
  const issuer = issueCandidatePartitionProofIssuerPort(Object.freeze({
    currentRelease(): CandidatePartitionProofReleaseBindingV1 {
      return assertCurrent(state);
    },
    issue(payload: CandidatePartitionProofPayloadV1) {
      const release = assertCurrent(state);
      if (payload.releaseProvenanceHash !== release.releaseProvenanceHash || payload.issuerKeyId !== release.candidatePartitionProofIssuerKeyId) {
        throw new TypeError("candidate partition proof payload is not release-bound");
      }
      const proof = implementation.issue(payload);
      return implementation.verify(proof, {
        binding: candidatePartitionBindingFromProof(proof),
        release,
      });
    },
    verify(value: unknown, context: CandidatePartitionProofVerificationContextV1) {
      const release = assertCurrent(state);
      if (!sameRelease(context.release, release)) throw new TypeError("candidate partition proof context is stale");
      const proof = implementation.verify(value, { binding: context.binding, release });
      return decodeCandidatePartitionProofV1(proof);
    },
  }));
  states.set(issuer as object, state);
  return issuer;
}

export function isRuntimeReleaseCandidatePartitionProofIssuer(value: unknown): boolean {
  return value !== null && typeof value === "object" && states.has(value);
}
