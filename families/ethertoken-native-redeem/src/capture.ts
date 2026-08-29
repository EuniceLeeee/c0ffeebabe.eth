import { decodeEtherTokenNativeRedeemCandidate, type EtherTokenNativeRedeemCandidateSeedV1, type EtherTokenNativeRedeemDiscoveryPatternV1 } from "./discovery.ts";
import type { EtherTokenNativeRedeemObservationV1 } from "./types.ts";
export function captureEtherTokenNativeRedeemEvidence(input: { readonly observation: EtherTokenNativeRedeemObservationV1; readonly pattern: EtherTokenNativeRedeemDiscoveryPatternV1 }): EtherTokenNativeRedeemCandidateSeedV1 | null { return decodeEtherTokenNativeRedeemCandidate(input.observation, input.pattern); }
