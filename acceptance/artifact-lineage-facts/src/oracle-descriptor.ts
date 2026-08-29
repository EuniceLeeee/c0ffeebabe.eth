import {
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

/**
 * Declarative identity for the independently implemented qualification oracle.
 * Runtime predicate code may compare this digest, but never imports or executes
 * the oracle implementation.
 */
export const ARTIFACT_LINEAGE_ORACLE_VERSION =
  "artifact-lineage-independent-oracle-v3" as const;

export const ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST: Hash = sha256Hex([
  "aloha/artifact-lineage/oracle-program-descriptor/v3",
  "sha256-bytes",
  "independent-canonical-chunked-mirror-decode",
  "canonical-hex-raw-facts-copy",
  "exact-locator-media-schema",
  "outcome-required",
  "lease-epoch-only",
  "producer-outcome-ignored",
].join("\0"));
