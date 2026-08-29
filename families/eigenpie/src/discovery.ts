import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type EigenpieCandidateV1, type EigenpieObservationV1 } from "./types.ts";
import { EIGENPIE_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { EIGENPIE_ASSET_DEPOSIT_TOPIC } from "./manifest.ts";

export type EigenpieDiscoveryPatternV1 = "eigenpie-surface" | "eigenpie-quote-observation";
export const EIGENPIE_OWNED_LOG_TOPIC = EIGENPIE_ASSET_DEPOSIT_TOPIC;
export interface EigenpieCandidateSeedV1 { readonly target: string; readonly evidence: EigenpieObservationV1; }
export function decodeEigenpieCandidate(observation: EigenpieObservationV1, pattern: EigenpieDiscoveryPatternV1): EigenpieCandidateSeedV1 | null {
  if ((pattern === "eigenpie-surface" || pattern === "eigenpie-quote-observation") && (observation.kind === "address-surface" || observation.kind === "call" || (observation.kind === "log" && observation.topic === EIGENPIE_OWNED_LOG_TOPIC))) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  return null;
}
export function instanceNominationKey(input: EigenpieCandidateSeedV1 | EigenpieCandidateV1): string { return canonicalAddress(input.target); }
export function candidateSnapshotHash(input: EigenpieObservationV1): Hash { return hashDomain("aloha/eigenpie/candidate-snapshot/v1", { familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, target: canonicalAddress(input.target), cutoff: input.cutoff, blockNumber: input.blockNumber, blockHash: input.blockHash, txHash: input.txHash, logIndex: input.logIndex, topic: input.topic ?? null, rawLocatorHash: input.rawLocatorHash }); }
