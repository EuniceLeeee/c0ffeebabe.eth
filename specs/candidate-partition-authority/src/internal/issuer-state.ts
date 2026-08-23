import type { CandidatePartitionProofIssuerPortV1 } from "../index.ts";
const issued = new WeakSet<object>();
export function registerCandidatePartitionProofIssuer(value: CandidatePartitionProofIssuerPortV1): CandidatePartitionProofIssuerPortV1 { issued.add(value); return value; }
export function isCandidatePartitionProofIssuer(value: unknown): value is CandidatePartitionProofIssuerPortV1 { return value !== null && typeof value === "object" && issued.has(value); }
