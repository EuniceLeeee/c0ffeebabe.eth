import {
  decodeRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityDescriptorV1,
} from "../../../runtime-authority/src/index.ts";
import type { RuntimeAuthorityV1 } from "../index.ts";
import {
  registerRuntimeReleaseAuthority,
  type RuntimeAuthorityStateV1,
} from "./state.ts";
import { issueCurrentRuntimeAuthorityPort } from "./ready-binding-owner.ts";

/** Issue the process-local lifetime fence for one exact runtime. */
export function issueRuntimeAuthorityInternalV1(
  descriptorValue: RuntimeAuthorityDescriptorV1,
): RuntimeAuthorityV1 {
  const descriptor = decodeRuntimeAuthorityDescriptorV1(descriptorValue);
  const capability = Object.freeze(Object.create(null));
  const state: RuntimeAuthorityStateV1 = {
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
