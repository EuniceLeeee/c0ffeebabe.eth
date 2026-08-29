import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type GoldxCandidateV1, type GoldxObservationV1 } from "./types.ts";
import { GOLDX_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
export type GoldxDiscoveryPatternV1 = "goldx-surface" | "goldx-call";
export interface GoldxCandidateSeedV1 { readonly target: string; readonly evidence: GoldxObservationV1; }
export function decodeGoldxCandidate(observation: GoldxObservationV1, pattern: GoldxDiscoveryPatternV1): GoldxCandidateSeedV1 | null { if ((pattern === "goldx-surface" || pattern === "goldx-call") && (observation.kind === "address-surface" || observation.kind === "call")) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation }); return null; }
export function instanceNominationKey(input: GoldxCandidateSeedV1 | GoldxCandidateV1): string { return canonicalAddress(input.target); }
export function candidateSnapshotHash(input: GoldxObservationV1): Hash { return hashDomain("aloha/goldx/candidate-snapshot/v1", { familyDefinitionHash: GOLDX_FAMILY_AUTHORING_HASH, target: canonicalAddress(input.target), cutoff: input.cutoff, blockNumber: input.blockNumber, blockHash: input.blockHash, txHash: input.txHash, logIndex: input.logIndex, topic: input.topic ?? null, rawLocatorHash: input.rawLocatorHash }); }
