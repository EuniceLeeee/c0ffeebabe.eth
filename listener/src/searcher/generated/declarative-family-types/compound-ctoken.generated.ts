// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 40559139ed85100b3776174adfb77ce666361b8abbb93b80c1ba4cae9f8f8e59
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type CompoundCTokenActiveEvidence = CompoundCTokenEvidenceFields & CompoundCTokenRegistryFields & {
  readonly phase: "active";
  readonly probeUnderlying: bigint;
  readonly probeActor?: string;
  readonly redemptionPathLive: boolean;
  readonly behaviorProofHash: string;
};

export type CompoundCTokenBaseEvidence = CompoundCTokenEvidenceFields & {
  readonly phase: "base";
};

export type CompoundCTokenCandidate = FamilyCandidate & {
  readonly candidateKind: "compound-ctoken-market";
  readonly market: string;
};

export type CompoundCTokenDescriptor = CompiledInstanceDescriptor & {
  readonly market: string;
  readonly comptroller: string;
  readonly underlying: string;
  readonly share: string;
  readonly decimals: number;
  readonly redemptionPathVerified: boolean;
};

export type CompoundCTokenEvidenceFields = {
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
  readonly evidenceRequestIds: ReadonlyArray<string>;
};

export type CompoundCTokenExactEvidence = {
  readonly kind: "compound-ctoken-exchange-rate";
  readonly source: CanonicalSource;
  readonly market: string;
  readonly direction: "redeem";
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly exchangeRate: bigint;
  readonly rateSource: ("exchange-rate-current") | ("local-zero");
  readonly bindingFingerprint: string;
};

export type CompoundCTokenIdentity = VerifiedIdentity & {
  readonly comptroller: string;
  readonly underlying: string;
  readonly decimals: number;
  readonly redemptionPathVerified: boolean;
  readonly facts: CompoundCTokenIdentityFacts;
};

export type CompoundCTokenIdentityEvidence = (CompoundCTokenBaseEvidence) | (CompoundCTokenRegistryEvidence) | (CompoundCTokenActiveEvidence);

export type CompoundCTokenIdentityFacts = {
  readonly market: string;
  readonly comptroller: string;
  readonly underlying: string;
  readonly exchangeRateStored: bigint;
  readonly cash: bigint;
  readonly shareSupply: bigint;
  readonly decimals: number;
  readonly listedInComptroller: boolean;
  readonly registeredInAllMarkets: boolean;
};

export type CompoundCTokenPricingDescriptor = CompoundCTokenPricingDraft & CompoundCTokenPricingStatic & {

};

export type CompoundCTokenPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly market: string;
  readonly comptroller: string;
  readonly routes: ReadonlyArray<CompoundCTokenRoute>;
};

export type CompoundCTokenPricingStatic = {
  readonly oneShare: bigint;
};

export type CompoundCTokenRegistryEvidence = CompoundCTokenEvidenceFields & CompoundCTokenRegistryFields & {
  readonly phase: "registry";
};

export type CompoundCTokenRegistryFields = {
  readonly listedInComptroller: boolean;
  readonly registeredInAllMarkets: boolean;
  readonly registryValid: boolean;
  readonly exchangeRateCurrent: bigint;
  readonly sampleShares: bigint;
};

export type CompoundCTokenRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "redeem";
  readonly adapterId: "compound-ctoken-redeem";
};

export type FamilyTypes = {
  readonly candidate: CompoundCTokenCandidate;
  readonly identityEvidence: CompoundCTokenIdentityEvidence;
  readonly identity: CompoundCTokenIdentity;
  readonly descriptor: CompoundCTokenDescriptor;
  readonly route: CompoundCTokenRoute;
  readonly pricingDraft: CompoundCTokenPricingDraft;
  readonly pricingDescriptor: CompoundCTokenPricingDescriptor;
  readonly pricingStatic: CompoundCTokenPricingStatic;
  readonly exactEvidence: CompoundCTokenExactEvidence;
};
