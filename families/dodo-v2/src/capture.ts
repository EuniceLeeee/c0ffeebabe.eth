import { decodeDodoCandidate, type DodoCandidateSeedV1, type DodoDiscoveryPatternV1 } from "./discovery.ts";
import type { DodoObservationV1 } from "./types.ts";
export function captureDodoEvidence(input: { readonly observation: DodoObservationV1; readonly pattern: DodoDiscoveryPatternV1 }): DodoCandidateSeedV1 | null { return decodeDodoCandidate(input.observation, input.pattern); }
