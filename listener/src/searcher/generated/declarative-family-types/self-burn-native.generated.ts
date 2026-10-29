// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: c76616c842fd8d5699c247923b62d492de55dfec4323324593b92f694242ca17
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type SelfBurnNativeActiveEvidence = {
  readonly phase: "active";
  readonly token: string;
  readonly sampleAmount: bigint;
  readonly sampleNativeOut: bigint;
  readonly behaviorValid: boolean;
  readonly behaviorProofHash: string;
};

export type SelfBurnNativeBaseEvidence = {
  readonly phase: "base";
  readonly token: string;
  readonly sampleAmount: bigint;
  readonly behaviorValid: boolean;
};

export type SelfBurnNativeCandidate = FamilyCandidate & {
  readonly candidateKind: "self-burn-native-token";
  readonly token: string;
  readonly observedAmount: bigint;
};

export type SelfBurnNativeDescriptor = CompiledInstanceDescriptor & {
  readonly token: string;
  readonly nativeAnchor: string;
};

export type SelfBurnNativeExactEvidence = {
  readonly kind: "self-burn-native-fee-quote";
  readonly source: CanonicalSource;
  readonly token: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
  readonly fee: bigint;
};

export type SelfBurnNativeIdentity = VerifiedIdentity & {
  readonly token: string;
};

export type SelfBurnNativeIdentityEvidence = (SelfBurnNativeBaseEvidence) | (SelfBurnNativeActiveEvidence);

export type SelfBurnNativePricingDescriptor = SelfBurnNativePricingDraft & SelfBurnNativePricingStatic & {

};

export type SelfBurnNativePricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly token: string;
  readonly nativeAnchor: string;
  readonly routes: ReadonlyArray<SelfBurnNativeRoute>;
};

export type SelfBurnNativePricingStatic = {
  readonly probeAmounts: ReadonlyArray<bigint>;
};

export type SelfBurnNativeRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "self-burn-to-native";
  readonly adapterId: "self-burn-native-redeem";
};

export type FamilyTypes = {
  readonly candidate: SelfBurnNativeCandidate;
  readonly identityEvidence: SelfBurnNativeIdentityEvidence;
  readonly identity: SelfBurnNativeIdentity;
  readonly descriptor: SelfBurnNativeDescriptor;
  readonly route: SelfBurnNativeRoute;
  readonly pricingDraft: SelfBurnNativePricingDraft;
  readonly pricingDescriptor: SelfBurnNativePricingDescriptor;
  readonly pricingStatic: SelfBurnNativePricingStatic;
  readonly exactEvidence: SelfBurnNativeExactEvidence;
};
