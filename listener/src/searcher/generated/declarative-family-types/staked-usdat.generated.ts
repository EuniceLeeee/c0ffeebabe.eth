// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 4477e3802297177e07caf6e5d78d150c3af51510f8043358237112522e9b5dfe
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type StakedUsdatBinding = {
  readonly proofSource: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly implementation: string;
  readonly implementationCodeHash: string;
  readonly asset: string;
  readonly oracle: string;
  readonly withdrawalQueue: string;
};

export type StakedUsdatCandidate = FamilyCandidate & {
  readonly candidateKind: "erc4626-vault";
  readonly vault: string;
};

export type StakedUsdatDescriptor = CompiledInstanceDescriptor & {
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly stakedUsdat: StakedUsdatBinding;
  readonly verifiedDirections: StakedUsdatVerifiedDirections;
};

export type StakedUsdatExactEvidence = {
  readonly kind: "erc4626-preview";
  readonly executor: string;
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly direction: "deposit";
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
};

export type StakedUsdatIdentity = VerifiedIdentity & {
  readonly asset: string;
  readonly stakedUsdat: StakedUsdatBinding;
  readonly verifiedDirections: StakedUsdatVerifiedDirections;
};

export type StakedUsdatPricingDescriptor = StakedUsdatPricingDraft & StakedUsdatPricingStatic & {

};

export type StakedUsdatPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly stakedUsdat: StakedUsdatBinding;
  readonly routes: ReadonlyArray<StakedUsdatRoute>;
};

export type StakedUsdatPricingStatic = {
  readonly oneAsset: bigint;
  readonly oneShare: bigint;
};

export type StakedUsdatRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "deposit";
  readonly adapterId: "staked-usdat-deposit";
};

export type StakedUsdatVerifiedDirections = {
  readonly deposit: boolean;
  readonly redeem: boolean;
};

export type FamilyTypes = {
  readonly candidate: StakedUsdatCandidate;
  readonly identity: StakedUsdatIdentity;
  readonly descriptor: StakedUsdatDescriptor;
  readonly route: StakedUsdatRoute;
  readonly pricingDraft: StakedUsdatPricingDraft;
  readonly pricingDescriptor: StakedUsdatPricingDescriptor;
  readonly pricingStatic: StakedUsdatPricingStatic;
  readonly exactEvidence: StakedUsdatExactEvidence;
};
