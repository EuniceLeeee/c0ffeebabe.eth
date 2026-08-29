import { decodeErc4626Candidate, type Erc4626CandidateSeedV1, type Erc4626DiscoveryPatternV1 } from "./discovery.ts";
import type { Erc4626ObservationV1 } from "./types.ts";
export function captureErc4626Evidence(input: { readonly observation: Erc4626ObservationV1; readonly pattern: Erc4626DiscoveryPatternV1 }): Erc4626CandidateSeedV1 | null { return decodeErc4626Candidate(input.observation, input.pattern); }
