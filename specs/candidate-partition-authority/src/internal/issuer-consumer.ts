import type { CandidatePartitionProofIssuerPortV1 } from "../index.ts";
import { isCandidatePartitionProofIssuer } from "./issuer-state.ts";
export function assertIssuedCandidatePartitionProofIssuer(value: unknown): CandidatePartitionProofIssuerPortV1 {
  if (!isCandidatePartitionProofIssuer(value)) throw new TypeError("candidate partition proof issuer is not release-issued");
  return value;
}
