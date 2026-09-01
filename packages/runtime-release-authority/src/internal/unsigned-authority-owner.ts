import {
  decodeUnsignedDryRunRuntimeAuthorityDescriptorV1,
  type UnsignedDryRunRuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";
import type { RuntimeAuthorityV1 } from "../index.ts";
import {
  registerRuntimeReleaseAuthority,
  type UnsignedDryRunRuntimeAuthorityStateV1,
} from "./state.ts";
import { issueCurrentRuntimeAuthorityPort } from "./ready-binding-owner.ts";

/**
 * Private bootstrap edge for a zero-signature dry-run.  The caller must have
 * derived the descriptor from the exact admitted deployment payload.  This
 * function issues only a process-local lifetime fence; it cannot resolve,
 * rotate, or upgrade into a signed release.
 */
export function issueUnsignedDryRunRuntimeAuthorityV1(
  descriptorValue: UnsignedDryRunRuntimeAuthorityDescriptorV1,
): RuntimeAuthorityV1 {
  const descriptor = decodeUnsignedDryRunRuntimeAuthorityDescriptorV1(descriptorValue);
  const capability = Object.freeze(Object.create(null));
  const state: UnsignedDryRunRuntimeAuthorityStateV1 = {
    authorityClass: "unsigned-dry-run",
    descriptor,
    active: true,
    version: 0n,
  };
  const authority = {
    capability,
    revoke() {
      state.active = false;
    },
  } as unknown as RuntimeAuthorityV1;
  registerRuntimeReleaseAuthority(authority, capability, state);
  (authority as unknown as { readyGeneration: RuntimeAuthorityV1["readyGeneration"] }).readyGeneration =
    issueCurrentRuntimeAuthorityPort(authority);
  return Object.freeze(authority);
}
