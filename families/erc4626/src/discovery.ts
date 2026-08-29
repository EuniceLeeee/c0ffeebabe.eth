import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { canonicalAddress, type Erc4626CandidateV1, type Erc4626ObservationV1 } from "./types.ts";
import { ERC4626_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { ERC4626_WITHDRAW_TOPIC } from "./manifest.ts";
export type Erc4626DiscoveryPatternV1 = "erc4626-surface" | "erc4626-call";
export const ERC4626_OWNED_LOG_TOPIC = ERC4626_WITHDRAW_TOPIC;
export interface Erc4626CandidateSeedV1 { readonly target: string; readonly evidence: Erc4626ObservationV1; }
export function decodeErc4626Candidate(observation: Erc4626ObservationV1, pattern: Erc4626DiscoveryPatternV1): Erc4626CandidateSeedV1 | null { if ((pattern === "erc4626-surface" || pattern === "erc4626-call") && (observation.kind === "address-surface" || observation.kind === "call" || (observation.kind === "log" && observation.topic === ERC4626_OWNED_LOG_TOPIC))) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation }); return null; }
export function instanceNominationKey(input: Erc4626CandidateSeedV1 | Erc4626CandidateV1): string { return canonicalAddress(input.target); }
export function candidateSnapshotHash(input: Erc4626ObservationV1): Hash { return hashDomain("aloha/erc4626/candidate-snapshot/v1", { familyDefinitionHash: ERC4626_FAMILY_AUTHORING_HASH, target: canonicalAddress(input.target), cutoff: input.cutoff, blockNumber: input.blockNumber, blockHash: input.blockHash, txHash: input.txHash, logIndex: input.logIndex, topic: input.topic ?? null, rawLocatorHash: input.rawLocatorHash }); }
