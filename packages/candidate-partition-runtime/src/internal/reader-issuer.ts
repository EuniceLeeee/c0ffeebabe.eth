import type { CandidatePartitionReaderPortV1 } from "../../../../specs/candidate-partition-authority/src/index.ts";
import { registerIssuedReader } from "./reader-state.ts";

/** Checkpoint-only issuer entry. */
export function issueCheckpointCandidatePartitionReader(
  reader: CandidatePartitionReaderPortV1,
): CandidatePartitionReaderPortV1 {
  return registerIssuedReader(reader);
}
