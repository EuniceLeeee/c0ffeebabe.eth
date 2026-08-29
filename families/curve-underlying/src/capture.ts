import { decodeCurveUnderlyingCandidate, type CurveCandidateSeedV1, type CurveDiscoveryPatternV1 } from "./discovery.ts";
import type { CurveObservationV1 } from "./types.ts";
export function captureCurveUnderlyingEvidence(input: { readonly observation: CurveObservationV1; readonly pattern: CurveDiscoveryPatternV1 }): CurveCandidateSeedV1 | null { return decodeCurveUnderlyingCandidate(input.observation, input.pattern); }
