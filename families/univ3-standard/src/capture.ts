import { decodeUniV3Candidate, type UniV3CandidateSeedV1, type UniV3DiscoveryPatternV1 } from "./discovery.ts";
import type { UniV3ObservationV1 } from "./types.ts";

export function captureUniV3Evidence(input: { readonly observation: UniV3ObservationV1; readonly pattern: UniV3DiscoveryPatternV1 }): UniV3CandidateSeedV1 | null {
  return decodeUniV3Candidate(input.observation, input.pattern);
}
