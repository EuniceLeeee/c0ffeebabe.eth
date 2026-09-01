import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  type SignedReleaseRuntimeAuthorityDescriptorV1,
} from "../../../../packages/runtime-authority/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";

/**
 * One release-owner derivation for every neutral runtime consumer.  Callers
 * receive only the exact descriptor committed by the active signed binding;
 * no downstream package may reconstruct it from partial provenance facts.
 */
export function readActiveSignedRuntimeAuthorityDescriptorV1(
  authorityValue: unknown,
): SignedReleaseRuntimeAuthorityDescriptorV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  return createSignedReleaseRuntimeAuthorityDescriptorV1({
    authorityClass: "signed-release",
    runtimeBindingId: state.binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(state.binding),
    implementationCommit: state.binding.candidateReleaseCommit,
  });
}
