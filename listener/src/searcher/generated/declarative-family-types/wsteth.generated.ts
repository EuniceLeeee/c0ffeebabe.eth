// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 78f3193acf2f06f114a71db4b0ec12bae2c7ad1b6b0a979f04183937d967ec89
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type WstethCandidate = FamilyCandidate & {
  readonly candidateKind: "wsteth-converter";
  readonly target: string;
  readonly sourceKind: ("observed-call") | ("address-surface");
};

export type WstethDescriptor = CompiledInstanceDescriptor & {
  readonly target: string;
  readonly steth: string;
  readonly wsteth: string;
};

export type WstethExactEvidence = {
  readonly kind: "wsteth-conversion-quote";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly direction: ("wrap") | ("unwrap");
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
};

export type WstethIdentity = VerifiedIdentity & {
  readonly steth: string;
  readonly wrapSampleOut: bigint;
  readonly unwrapSampleOut: bigint;
};

export type WstethIdentityEvidence = {
  readonly codeHash: string;
  readonly steth: string;
  readonly wrapSampleOut: bigint;
  readonly unwrapSampleOut: bigint;
};

export type WstethPricingDescriptor = WstethPricingDraft & WstethPricingStatic & {

};

export type WstethPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly routes: ReadonlyArray<WstethRoute>;
};

export type WstethPricingStatic = {

};

export type WstethRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: ("wrap") | ("unwrap");
  readonly adapterId: ("wsteth-wrap") | ("wsteth-unwrap");
};

export type FamilyTypes = {
  readonly candidate: WstethCandidate;
  readonly identityEvidence: WstethIdentityEvidence;
  readonly identity: WstethIdentity;
  readonly descriptor: WstethDescriptor;
  readonly route: WstethRoute;
  readonly pricingDraft: WstethPricingDraft;
  readonly pricingDescriptor: WstethPricingDescriptor;
  readonly pricingStatic: WstethPricingStatic;
  readonly exactEvidence: WstethExactEvidence;
};
