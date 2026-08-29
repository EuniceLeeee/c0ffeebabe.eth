import {
  assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1,
  readRuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  readRuntimeReleaseNativeFullFamilyAuditCapabilityV1,
  readRuntimeReleaseNativeFullFamilyAuditChunkBytesCapabilityV1,
  type RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  type RuntimeReleaseFullFamilyTerminalBindingServiceV1,
  type RuntimeReleaseFullFamilyTerminalBindingV1,
} from "./internal/full-family-terminal-owner.ts";
import type {
  NativeFullFamilyAuditChunkRefV1,
  NativeFullFamilyAuditV1,
} from "../../search-pipeline/src/index.ts";

export type {
  RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  RuntimeReleaseFullFamilyTerminalBindingServiceV1,
  RuntimeReleaseFullFamilyTerminalBindingV1,
} from "./internal/full-family-terminal-owner.ts";
export type {
  NativeFullFamilyAuditChunkRefV1,
  NativeFullFamilyAuditManifestV1,
  NativeFullFamilyAuditSectionManifestV1,
  NativeFullFamilyAuditSectionV1,
  NativeFullFamilyAuditV1,
} from "../../search-pipeline/src/index.ts";

/** Fixed read-only consumer. Callers cannot inject a reader or decoded DTO. */
export function readRuntimeReleaseFullFamilyTerminalBindingV1(
  capability: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
): RuntimeReleaseFullFamilyTerminalBindingV1 {
  return readRuntimeReleaseFullFamilyTerminalBindingCapabilityV1(capability);
}

/** Materializes and validates every semantic chunk retained by the fixed
 * release consumer. No caller-provided DTO or reader participates. */
export function readRuntimeReleaseNativeFullFamilyAuditV1(
  capability: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
): NativeFullFamilyAuditV1 {
  return readRuntimeReleaseNativeFullFamilyAuditCapabilityV1(capability);
}

/** Reads only bytes named by an exact manifest-issued ref for this binding. */
export function readRuntimeReleaseNativeFullFamilyAuditChunkV1(
  capability: RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
  ref: NativeFullFamilyAuditChunkRefV1,
): Uint8Array {
  return readRuntimeReleaseNativeFullFamilyAuditChunkBytesCapabilityV1(capability, ref);
}

export { assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1 };
