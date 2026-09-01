import {
  decodeRuntimeAuthorityDescriptorV1,
  decodeSignedReleaseRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityDescriptorV1,
  type SignedReleaseRuntimeAuthorityDescriptorV1,
} from "../../../../packages/runtime-authority/src/index.ts";
import {
  assertActiveRuntimeAuthorityState,
} from "./state.ts";

export function readActiveRuntimeAuthorityDescriptorV1(
  authorityValue: unknown,
): RuntimeAuthorityDescriptorV1 {
  return decodeRuntimeAuthorityDescriptorV1(
    assertActiveRuntimeAuthorityState(authorityValue).descriptor,
  );
}

/**
 * One release-owner derivation for every neutral runtime consumer.  Callers
 * receive only the exact descriptor committed by the active signed binding;
 * no downstream package may reconstruct it from partial provenance facts.
 */
export function readActiveSignedRuntimeAuthorityDescriptorV1(
  authorityValue: unknown,
): SignedReleaseRuntimeAuthorityDescriptorV1 {
  return decodeSignedReleaseRuntimeAuthorityDescriptorV1(
    readActiveRuntimeAuthorityDescriptorV1(authorityValue),
  );
}
