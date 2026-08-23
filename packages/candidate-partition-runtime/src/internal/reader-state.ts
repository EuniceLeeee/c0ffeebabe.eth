import type { CandidatePartitionReaderPortV1 } from "../../../../specs/candidate-partition-authority/src/index.ts";

const issuedReaders = new WeakSet<object>();

export function registerIssuedReader(
  reader: CandidatePartitionReaderPortV1,
): CandidatePartitionReaderPortV1 {
  if (reader === null || typeof reader !== "object") {
    throw new TypeError("candidate partition reader is not an object");
  }
  issuedReaders.add(reader);
  return reader;
}

export function isIssuedReader(value: unknown): value is CandidatePartitionReaderPortV1 {
  return value !== null && typeof value === "object" && issuedReaders.has(value);
}
