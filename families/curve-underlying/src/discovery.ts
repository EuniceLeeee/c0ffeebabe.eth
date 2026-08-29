import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { CanonicalCutoffV1, SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import { CURVE_UNDERLYING_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { CURVE_UNDERLYING_I128_SELECTOR, CURVE_UNDERLYING_I128_SWAP_TOPIC, CURVE_UNDERLYING_UINT_SELECTOR, CURVE_UNDERLYING_UINT_SWAP_TOPIC } from "./manifest.ts";
import { canonicalAddress, type CurveCandidateV1, type CurveEvidenceV1, type CurveObservationV1 } from "./types.ts";

export type CurveDiscoveryPatternV1 = "curve-underlying-pool-surface" | "curve-underlying-i128-call" | "curve-underlying-uint-call" | "curve-underlying-i128-log" | "curve-underlying-uint-log";
export interface CurveCandidateSeedV1 { readonly target: string; readonly evidence: CurveObservationV1; }
export const CURVE_UNDERLYING_DISCOVERY_PATTERNS = Object.freeze([
  Object.freeze({ id: "curve-underlying-pool-surface" as const, kind: "address-surface" as const }),
  Object.freeze({ id: "curve-underlying-i128-call" as const, kind: "call" as const, selector: CURVE_UNDERLYING_I128_SELECTOR }),
  Object.freeze({ id: "curve-underlying-uint-call" as const, kind: "call" as const, selector: CURVE_UNDERLYING_UINT_SELECTOR }),
  Object.freeze({ id: "curve-underlying-i128-log" as const, kind: "log" as const, topic0: CURVE_UNDERLYING_I128_SWAP_TOPIC }),
  Object.freeze({ id: "curve-underlying-uint-log" as const, kind: "log" as const, topic0: CURVE_UNDERLYING_UINT_SWAP_TOPIC }),
]);

export function decodeCurveUnderlyingCandidate(observation: CurveObservationV1, pattern: CurveDiscoveryPatternV1): CurveCandidateSeedV1 | null {
  if (observation.kind === "address-surface" && pattern === "curve-underlying-pool-surface") return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  if (observation.kind === "call" && ((pattern === "curve-underlying-i128-call" && observation.selector?.toLowerCase() === CURVE_UNDERLYING_I128_SELECTOR) || (pattern === "curve-underlying-uint-call" && observation.selector?.toLowerCase() === CURVE_UNDERLYING_UINT_SELECTOR))) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  if (observation.kind === "log" && ((pattern === "curve-underlying-i128-log" && observation.topic0?.toLowerCase() === CURVE_UNDERLYING_I128_SWAP_TOPIC) || (pattern === "curve-underlying-uint-log" && observation.topic0?.toLowerCase() === CURVE_UNDERLYING_UINT_SWAP_TOPIC))) return Object.freeze({ target: canonicalAddress(observation.target), evidence: observation });
  return null;
}
export function instanceNominationKey(candidate: CurveCandidateSeedV1 | CurveCandidateV1): string { return canonicalAddress(candidate.target); }
export function candidateSnapshotHash(evidence: CurveObservationV1 | CurveEvidenceV1): Hash { return hashDomain("aloha/curve-underlying/candidate-snapshot/v1", { familyDefinitionHash: CURVE_UNDERLYING_FAMILY_DEFINITION_HASH, target: canonicalAddress(evidence.target), cutoff: evidence.cutoff, blockNumber: evidence.blockNumber, blockHash: evidence.blockHash, txHash: evidence.txHash, logIndex: evidence.logIndex, rawLocatorHash: evidence.rawLocatorHash, topic0: evidence.topic0 ?? null, selector: evidence.selector ?? null, i: evidence.i ?? null, j: evidence.j ?? null }); }
export function sourceCandidateSnapshotHash(target: string, cutoff: CanonicalCutoffV1, evidence: SourcePlanEvidenceRefV1): Hash { return hashDomain("aloha/curve-underlying/source-candidate-snapshot/v1", { familyDefinitionHash: CURVE_UNDERLYING_FAMILY_DEFINITION_HASH, target: canonicalAddress(target), cutoff, evidence }); }
