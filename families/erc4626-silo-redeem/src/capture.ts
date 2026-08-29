import { decodeErc4626SiloRedeemCandidate, type Erc4626SiloRedeemCandidateSeedV1, type Erc4626SiloRedeemDiscoveryPatternV1 } from "./discovery.ts";
import type { Erc4626SiloRedeemObservationV1 } from "./types.ts";
export function captureErc4626SiloRedeemEvidence(input: { readonly observation: Erc4626SiloRedeemObservationV1; readonly pattern: Erc4626SiloRedeemDiscoveryPatternV1 }): Erc4626SiloRedeemCandidateSeedV1 | null { return decodeErc4626SiloRedeemCandidate(input.observation, input.pattern); }
