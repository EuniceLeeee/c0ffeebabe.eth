// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: a0a9cd64f9f281127297a02b73a8a0cfe9a7d44d57c74ac1cb8135f5b60ae277
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type PsmCandidate = FamilyCandidate & {
  readonly candidateKind: "lite-psm";
  readonly target: string;
};

export type PsmDescriptor = CompiledInstanceDescriptor & {
  readonly target: string;
  readonly gem: string;
  readonly dai: string;
  readonly decimalScale: bigint;
};

export type PsmExactEvidence = {
  readonly kind: "psm-directional-fee";
  readonly direction: ("sell-gem") | ("buy-gem");
  readonly source: CanonicalSource;
  readonly target: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly fee: bigint;
  readonly bindingFingerprint: string;
};

export type PsmIdentity = VerifiedIdentity & {
  readonly gem: string;
  readonly dai: string;
};

export type PsmIdentityEvidence = {
  readonly codeHash: string;
  readonly gem: string;
  readonly dai: string;
  readonly tin: bigint;
  readonly tout: bigint;
};

export type PsmPricingDescriptor = PsmPricingDraft & PsmPricingStatic & {

};

export type PsmPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly routes: ReadonlyArray<PsmRoute>;
  readonly decimalScale: bigint;
};

export type PsmPricingStatic = {

};

export type PsmRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: ("sell-gem") | ("buy-gem");
  readonly adapterId: "psm";
};

export type FamilyTypes = {
  readonly candidate: PsmCandidate;
  readonly identityEvidence: PsmIdentityEvidence;
  readonly identity: PsmIdentity;
  readonly descriptor: PsmDescriptor;
  readonly route: PsmRoute;
  readonly pricingDraft: PsmPricingDraft;
  readonly pricingDescriptor: PsmPricingDescriptor;
  readonly pricingStatic: PsmPricingStatic;
  readonly exactEvidence: PsmExactEvidence;
};
