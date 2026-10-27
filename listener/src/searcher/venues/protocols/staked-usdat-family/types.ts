import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor,
  VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { InstanceKey } from "../../adapter-family-identifiers.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { StakedUsdatBinding } from "./identity-proof.js";

export interface StakedUsdatCandidate extends FamilyCandidate {
  readonly candidateKind: "erc4626-vault";
  readonly vault: string;
}

export interface StakedUsdatIdentity extends VerifiedIdentity {
  readonly stakedUsdat?: StakedUsdatBinding;
  readonly asset: string;
  readonly verifiedDirections: { readonly deposit: boolean; readonly redeem: boolean };
}

export interface StakedUsdatDescriptor extends CompiledInstanceDescriptor {
  readonly stakedUsdat?: StakedUsdatBinding;
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly verifiedDirections: StakedUsdatIdentity["verifiedDirections"];
}

export interface StakedUsdatRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "deposit";
  readonly adapterId: "staked-usdat-deposit";
}

export interface StakedUsdatPricingDraft {
  readonly stakedUsdat?: StakedUsdatBinding;
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly routes: readonly StakedUsdatRoute[];
}

export interface StakedUsdatPricingDescriptor extends StakedUsdatPricingDraft {
  readonly oneAsset: bigint;
  readonly oneShare: bigint;
}

export interface StakedUsdatExactEvidence {
  readonly kind: "erc4626-preview";
  readonly executor?: string;
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly direction: StakedUsdatRoute["direction"];
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}

export type { StakedUsdatBinding } from "./identity-proof.js";
