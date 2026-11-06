// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 5f344f282601a36bfe0f6af0deffd36da972d64be003497282aa0ca7708da5fb
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type GoldxCandidate = FamilyCandidate & {
  readonly candidateKind: "goldx-minter";
  readonly target: string;
};

export type GoldxDescriptor = CompiledInstanceDescriptor & {
  readonly target: string;
  readonly collateral: string;
  readonly receipt: string;
};

export type GoldxExactEvidence = {
  readonly kind: "goldx-unit-quote";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly unit: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
};

export type GoldxIdentity = VerifiedIdentity & {
  readonly unit: bigint;
};

export type GoldxIdentityEvidence = {
  readonly codeHash: string;
  readonly unit: bigint;
};

export type GoldxPricingDescriptor = GoldxPricingDraft & GoldxPricingStatic & {

};

export type GoldxPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly route: GoldxRoute;
  readonly routes: ReadonlyArray<GoldxRoute>;
};

export type GoldxPricingStatic = {

};

export type GoldxRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "mint";
  readonly adapterId: "goldx-mint";
};

export type FamilyTypes = {
  readonly candidate: GoldxCandidate;
  readonly identityEvidence: GoldxIdentityEvidence;
  readonly identity: GoldxIdentity;
  readonly descriptor: GoldxDescriptor;
  readonly route: GoldxRoute;
  readonly pricingDraft: GoldxPricingDraft;
  readonly pricingDescriptor: GoldxPricingDescriptor;
  readonly pricingStatic: GoldxPricingStatic;
  readonly exactEvidence: GoldxExactEvidence;
};
