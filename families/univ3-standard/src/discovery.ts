import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { CanonicalCutoffV1, SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import { canonicalAddress, type UniV3CandidateV1, type UniV3ObservationV1 } from "./types.ts";
import { UNIV3_STANDARD_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { UNIV3_POOL_CREATED_TOPIC, UNIV3_SWAP_SELECTOR, UNIV3_SWAP_TOPIC } from "./manifest.ts";

export type UniV3DiscoveryPatternV1 = "univ3-pool-surface" | "univ3-pool-created" | "univ3-swap-call" | "univ3-swap-log";

export interface UniV3CandidateSeedV1 {
  readonly target: string;
  readonly evidence: UniV3ObservationV1;
}

export const UNIV3_DISCOVERY_PATTERNS = Object.freeze([
  Object.freeze({ id: "univ3-pool-surface" as const, kind: "address-surface" as const }),
  Object.freeze({ id: "univ3-pool-created" as const, kind: "log" as const, topic0: UNIV3_POOL_CREATED_TOPIC }),
  Object.freeze({ id: "univ3-swap-call" as const, kind: "call" as const, selector: UNIV3_SWAP_SELECTOR }),
  Object.freeze({ id: "univ3-swap-log" as const, kind: "log" as const, topic0: UNIV3_SWAP_TOPIC }),
]);

export function decodeUniV3Candidate(
  observation: UniV3ObservationV1,
  pattern: UniV3DiscoveryPatternV1,
): UniV3CandidateSeedV1 | null {
  if (observation.kind === "address-surface" && pattern === "univ3-pool-surface") return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  if (observation.kind === "call" && pattern === "univ3-swap-call" && observation.selector?.toLowerCase() === UNIV3_SWAP_SELECTOR) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  if (observation.kind === "log" && pattern === "univ3-pool-created" && observation.topic0?.toLowerCase() === UNIV3_POOL_CREATED_TOPIC) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  if (observation.kind === "log" && pattern === "univ3-swap-log" && observation.topic0?.toLowerCase() === UNIV3_SWAP_TOPIC) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  return null;
}

export function instanceNominationKey(candidate: UniV3CandidateSeedV1 | UniV3CandidateV1): string {
  return canonicalAddress(candidate.target);
}

export function candidateSnapshotHash(evidence: UniV3ObservationV1): Hash {
  return hashDomain("aloha/univ3-standard/candidate-snapshot/v1", {
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH,
    target: canonicalAddress(evidence.target),
    cutoff: evidence.cutoff,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    txHash: evidence.txHash,
    logIndex: evidence.logIndex,
    topic0: evidence.topic0 ?? null,
    selector: evidence.selector ?? null,
    rawLocatorHash: evidence.rawLocatorHash,
  });
}

export function sourceCandidateSnapshotHash(target: string, cutoff: CanonicalCutoffV1, evidence: SourcePlanEvidenceRefV1): Hash {
  return hashDomain("aloha/univ3-standard/source-candidate-snapshot/v1", { familyDefinitionHash: UNIV3_STANDARD_FAMILY_DEFINITION_HASH, target: canonicalAddress(target), cutoff, evidence });
}
