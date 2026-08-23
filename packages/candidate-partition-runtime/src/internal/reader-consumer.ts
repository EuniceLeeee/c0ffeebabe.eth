import type { CandidatePartitionReaderPortV1 } from "../../../../specs/candidate-partition-authority/src/index.ts";
import { isIssuedReader } from "./reader-state.ts";

/** Attestation-only consumer entry. */
export function assertIssuedCandidatePartitionReader(
  value: unknown,
): CandidatePartitionReaderPortV1 {
  if (!isIssuedReader(value)) {
    throw new TypeError("candidate partition reader is not checkpoint-issued");
  }
  return value;
}
