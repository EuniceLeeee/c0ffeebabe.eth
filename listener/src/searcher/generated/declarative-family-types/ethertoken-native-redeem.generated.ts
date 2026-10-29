// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 53bc18e376cb41440bc2f99d1194db92c4b68d240ca9bcb18866a82ea7fedc55
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type EtherTokenNativeActiveEvidence = {
  readonly phase: "active";
  readonly token: string;
  readonly sampleAmount: bigint;
  readonly behaviorValid: boolean;
  readonly behaviorProofHash: string;
};

export type EtherTokenNativeBaseEvidence = {
  readonly phase: "base";
  readonly token: string;
  readonly sampleAmount: bigint;
  readonly behaviorValid: boolean;
};

export type EtherTokenNativeDescriptor = CompiledInstanceDescriptor & {
  readonly token: string;
  readonly nativeAnchor: string;
};

export type EtherTokenNativeExactEvidence = {
  readonly kind: "ethertoken-native-one-to-one";
  readonly source: CanonicalSource;
  readonly token: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
};

export type EtherTokenNativeIdentity = VerifiedIdentity & {
  readonly token: string;
};

export type EtherTokenNativeIdentityEvidence = (EtherTokenNativeBaseEvidence) | (EtherTokenNativeActiveEvidence);

export type EtherTokenNativePricingDescriptor = EtherTokenNativePricingDraft & EtherTokenNativePricingStatic & {

};

export type EtherTokenNativePricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly token: string;
  readonly nativeAnchor: string;
  readonly routes: ReadonlyArray<EtherTokenNativeRoute>;
};

export type EtherTokenNativePricingStatic = {
  readonly oneToken: bigint;
};

export type EtherTokenNativeRedeemCandidate = FamilyCandidate & {
  readonly candidateKind: "ethertoken-native-redeem-token";
  readonly token: string;
  readonly observedAmount: bigint;
};

export type EtherTokenNativeRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "withdraw-to-native";
  readonly adapterId: "ethertoken-native-redeem";
};

export type FamilyTypes = {
  readonly candidate: EtherTokenNativeRedeemCandidate;
  readonly identityEvidence: EtherTokenNativeIdentityEvidence;
  readonly identity: EtherTokenNativeIdentity;
  readonly descriptor: EtherTokenNativeDescriptor;
  readonly route: EtherTokenNativeRoute;
  readonly pricingDraft: EtherTokenNativePricingDraft;
  readonly pricingDescriptor: EtherTokenNativePricingDescriptor;
  readonly pricingStatic: EtherTokenNativePricingStatic;
  readonly exactEvidence: EtherTokenNativeExactEvidence;
};
