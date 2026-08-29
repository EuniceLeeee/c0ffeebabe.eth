import { decodeGoldxCandidate, type GoldxCandidateSeedV1, type GoldxDiscoveryPatternV1 } from "./discovery.ts";
import type { GoldxObservationV1 } from "./types.ts";
export function captureGoldxEvidence(input: { readonly observation: GoldxObservationV1; readonly pattern: GoldxDiscoveryPatternV1 }): GoldxCandidateSeedV1 | null { return decodeGoldxCandidate(input.observation, input.pattern); }
