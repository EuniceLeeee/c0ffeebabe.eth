import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export interface CompoundCTokenCandidate extends FamilyCandidate {
  readonly candidateKind: "compound-ctoken-market";
  readonly market: string;
}

/** Phase 1 — the market's own surfaces at the pinned block. */
export interface CompoundCTokenBaseEvidence {
  readonly phase: "base";
  readonly source: CanonicalSource;
  readonly market: string;
  readonly marketCodeHash: string;
  readonly comptroller: string;
  readonly underlying: string;
  readonly exchangeRateStored: bigint;
  readonly cash: bigint;
  readonly shareSupply: bigint;
  readonly decimals: number;
  readonly baseValid: boolean;
  readonly evidenceRequestIds: readonly string[];
}

/**
 * Phase 2 — chain-proven registry admission. Both the reverse lookup
 * (`markets(market).isListed`) and enumeration membership
 * (`getAllMarkets()` contains the market) are required.
 */
export interface CompoundCTokenRegistryEvidence
  extends Omit<CompoundCTokenBaseEvidence, "phase"> {
  readonly phase: "registry";
  readonly listedInComptroller: boolean;
  readonly registeredInAllMarkets: boolean;
  readonly registryValid: boolean;
  readonly exchangeRateCurrent: bigint;
  readonly sampleShares: bigint;
}

/**
 * Phase 3 — the redemption surface is live on the same state
 * Positive share-input redemption in a source-bound, funded caller simulation.
 */
export interface CompoundCTokenActiveEvidence
  extends Omit<CompoundCTokenRegistryEvidence, "phase"> {
  readonly phase: "active";
  readonly probeUnderlying: bigint;
  readonly probeActor: string | null;
  readonly redemptionPathLive: boolean;
  readonly behaviorProofHash: string;
}

export type CompoundCTokenIdentityEvidence =
  | CompoundCTokenBaseEvidence
  | CompoundCTokenRegistryEvidence
  | CompoundCTokenActiveEvidence;

export interface CompoundCTokenIdentity extends VerifiedIdentity {
  readonly comptroller: string;
  readonly underlying: string;
  readonly decimals: number;
  readonly redemptionPathVerified: boolean;
}

export interface CompoundCTokenDescriptor extends CompiledInstanceDescriptor {
  readonly market: string;
  readonly comptroller: string;
  readonly underlying: string;
  readonly share: string;
  readonly decimals: number;
  readonly redemptionPathVerified: boolean;
}

export interface CompoundCTokenRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "redeem";
  readonly adapterId: "compound-ctoken-redeem";
}

export interface CompoundCTokenPricingDraft {
  readonly instanceKey: string;
  readonly market: string;
  readonly comptroller: string;
  readonly routes: readonly CompoundCTokenRoute[];
}

export interface CompoundCTokenPricingDescriptor
  extends CompoundCTokenPricingDraft {
  readonly oneShare: bigint;
}

export interface CompoundCTokenState {
  readonly source: CanonicalSource;
  readonly exchangeRate: bigint;
  readonly cash: bigint;
  readonly shareSupply: bigint;
}

export interface CompoundCTokenExactEvidence {
  readonly kind: "compound-ctoken-exchange-rate";
  readonly source: CanonicalSource;
  readonly market: string;
  readonly direction: "redeem";
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly exchangeRate: bigint;
  readonly rateSource: "exchange-rate-current" | "local-zero";
  readonly bindingFingerprint: string;
}
