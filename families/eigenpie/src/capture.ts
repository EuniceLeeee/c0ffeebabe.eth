import { decodeEigenpieCandidate, type EigenpieCandidateSeedV1, type EigenpieDiscoveryPatternV1 } from "./discovery.ts";
import type { EigenpieObservationV1 } from "./types.ts";
export function captureEigenpieEvidence(input: { readonly observation: EigenpieObservationV1; readonly pattern: EigenpieDiscoveryPatternV1 }): EigenpieCandidateSeedV1 | null { return decodeEigenpieCandidate(input.observation, input.pattern); }
