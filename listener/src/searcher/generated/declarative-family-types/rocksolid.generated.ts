// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: e2dcfd3874d585d2e4dee14092b8e11d7e8120361e79a5f01845a598c1680690
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type RocksolidCandidate = FamilyCandidate & {
  readonly candidateKind: "rocksolid-receipt";
  readonly target: string;
};

export type RocksolidDescriptor = CompiledInstanceDescriptor & {
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
};

export type RocksolidExactEvidence = {
  readonly kind: "rocksolid-convert-to-shares";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
};

export type RocksolidIdentity = VerifiedIdentity & {
  readonly sampleShares: bigint;
};

export type RocksolidIdentityEvidence = {
  readonly codeHash: string;
  readonly sampleShares: bigint;
};

export type RocksolidPricingDescriptor = RocksolidPricingDraft & RocksolidPricingStatic & {

};

export type RocksolidPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly route: RocksolidRoute;
  readonly routes: ReadonlyArray<RocksolidRoute>;
};

export type RocksolidPricingStatic = {

};

export type RocksolidRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "sync-deposit";
  readonly adapterId: "rocksolid-sync-deposit";
};

export type FamilyTypes = {
  readonly candidate: RocksolidCandidate;
  readonly identityEvidence: RocksolidIdentityEvidence;
  readonly identity: RocksolidIdentity;
  readonly descriptor: RocksolidDescriptor;
  readonly route: RocksolidRoute;
  readonly pricingDraft: RocksolidPricingDraft;
  readonly pricingDescriptor: RocksolidPricingDescriptor;
  readonly pricingStatic: RocksolidPricingStatic;
  readonly exactEvidence: RocksolidExactEvidence;
};
