import type {
  FullGraphCoarseSweepCapabilityV1,
  FullGraphCoarseSweepEntryChunkV1,
  FullGraphCoarseSweepManifestV1,
} from "../../full-graph-coarse-sweep/src/index.ts";
import {
  assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1,
  readRuntimeReleaseFullGraphCoarseSweepEntryChunkCapabilityV1,
  readRuntimeReleaseFullGraphCoarseSweepManifestCapabilityV1,
} from "./internal/full-graph-coarse-sweep-owner.ts";

export type {
  FullGraphCoarseSweepCapabilityV1,
  FullGraphCoarseSweepEntryChunkV1,
  FullGraphCoarseSweepManifestV1,
} from "../../full-graph-coarse-sweep/src/index.ts";
export type { RuntimeReleaseFullGraphCoarseSweepServiceV1 } from "./internal/full-graph-coarse-sweep-owner.ts";
export { assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1 };

/** Fixed acceptance consumer. No caller-supplied decoder or result DTO is
 * accepted, and the runtime-release rotation fence is checked on every read. */
export function readRuntimeReleaseFullGraphCoarseSweepManifestV1(
  capability: FullGraphCoarseSweepCapabilityV1,
): FullGraphCoarseSweepManifestV1 {
  return readRuntimeReleaseFullGraphCoarseSweepManifestCapabilityV1(capability);
}

export function readRuntimeReleaseFullGraphCoarseSweepEntryChunkV1(
  capability: FullGraphCoarseSweepCapabilityV1,
  chunkOrdinal: string,
): FullGraphCoarseSweepEntryChunkV1 {
  return readRuntimeReleaseFullGraphCoarseSweepEntryChunkCapabilityV1(capability, chunkOrdinal);
}
