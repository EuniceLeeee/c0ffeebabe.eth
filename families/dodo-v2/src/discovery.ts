import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { DODO_V2_SELL_BASE_SELECTOR, DODO_V2_SELL_QUOTE_SELECTOR, DODO_V2_SWAP_TOPIC } from "./manifest.ts";
import { canonicalAddress, type DodoCandidateV1, type DodoEvidenceV1, type DodoObservationV1 } from "./types.ts";
export type DodoDiscoveryPatternV1 = "dodo-v2-pool-surface" | "dodo-v2-sell-base-call" | "dodo-v2-sell-quote-call" | "dodo-v2-swap-log";
export interface DodoCandidateSeedV1 { readonly target: string; readonly evidence: DodoObservationV1; }
export const DODO_V2_DISCOVERY_PATTERNS = Object.freeze([
  Object.freeze({ id: "dodo-v2-pool-surface" as const, kind: "address-surface" as const }),
  Object.freeze({ id: "dodo-v2-sell-base-call" as const, kind: "call" as const, selector: DODO_V2_SELL_BASE_SELECTOR }),
  Object.freeze({ id: "dodo-v2-sell-quote-call" as const, kind: "call" as const, selector: DODO_V2_SELL_QUOTE_SELECTOR }),
  Object.freeze({ id: "dodo-v2-swap-log" as const, kind: "log" as const, topic0: DODO_V2_SWAP_TOPIC }),
]);
export function decodeDodoCandidate(observation: DodoObservationV1, pattern: DodoDiscoveryPatternV1): DodoCandidateSeedV1 | null { if (observation.kind === "address-surface" && pattern === "dodo-v2-pool-surface") return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation }); if (observation.kind === "call" && observation.callType === "CALL" && observation.callSucceeded === true && ((pattern === "dodo-v2-sell-base-call" && observation.selector?.toLowerCase() === DODO_V2_SELL_BASE_SELECTOR) || (pattern === "dodo-v2-sell-quote-call" && observation.selector?.toLowerCase() === DODO_V2_SELL_QUOTE_SELECTOR))) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation }); if (observation.kind === "log" && pattern === "dodo-v2-swap-log" && observation.topic0?.toLowerCase() === DODO_V2_SWAP_TOPIC) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation }); return null; }
export function instanceNominationKey(candidate: DodoCandidateSeedV1 | DodoCandidateV1): string { return canonicalAddress(candidate.target); }
export function candidateSnapshotHash(evidence: DodoObservationV1 | DodoEvidenceV1): Hash { return hashDomain("aloha/dodo-v2/candidate-snapshot/v1", { familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, target: canonicalAddress(evidence.target), cutoff: evidence.cutoff, blockNumber: evidence.blockNumber, blockHash: evidence.blockHash, txHash: evidence.txHash, logIndex: evidence.logIndex, rawLocatorHash: evidence.rawLocatorHash, topic0: evidence.topic0 ?? null, selector: evidence.selector ?? null, callType: evidence.callType ?? null, callSucceeded: evidence.callSucceeded ?? null, sellBase: evidence.sellBase ?? null }); }
