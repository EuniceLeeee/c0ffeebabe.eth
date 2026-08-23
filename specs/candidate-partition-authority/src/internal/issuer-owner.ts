import type { CandidatePartitionProofIssuerPortV1 } from "../index.ts";
import { registerCandidatePartitionProofIssuer } from "./issuer-state.ts";
export function issueCandidatePartitionProofIssuerPort(value: CandidatePartitionProofIssuerPortV1): CandidatePartitionProofIssuerPortV1 {
  if (value === null || typeof value !== "object") throw new TypeError("candidate partition proof issuer invalid");
  return registerCandidatePartitionProofIssuer(value);
}
