import {
  assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1,
  readRuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  type RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  type RuntimeReleaseFullFamilyTerminalBindingServiceV1,
  type RuntimeReleaseFullFamilyTerminalBindingV1,
} from "./internal/full-family-terminal-owner.ts";

export type {
  RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  RuntimeReleaseFullFamilyTerminalBindingServiceV1,
  RuntimeReleaseFullFamilyTerminalBindingV1,
} from "./internal/full-family-terminal-owner.ts";

/** Fixed read-only consumer. Callers cannot inject a reader or decoded DTO. */
export function readRuntimeReleaseFullFamilyTerminalBindingV1(
  capability: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
): RuntimeReleaseFullFamilyTerminalBindingV1 {
  return readRuntimeReleaseFullFamilyTerminalBindingCapabilityV1(capability);
}

export { assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1 };
