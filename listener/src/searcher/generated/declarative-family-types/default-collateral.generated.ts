// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 97e1a5fe3c9366f87493231ac914c9b4a9742c6fd264c20f1baf18c42dfec32e
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type DefaultCollateralActiveEvidence = {
  readonly phase: "active";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly shareCodeHash: string;
  readonly implementation: string;
  readonly asset: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
  readonly totalSupply: bigint;
  readonly shareIsClone: boolean;
  readonly baseValid: boolean;
  readonly implementationCodeHash: string;
  readonly backing: bigint;
  readonly surfaceValid: boolean;
  readonly invariantProven: boolean;
  readonly sampleShares: bigint;
  readonly shareBurn: bigint;
  readonly assetReceipt: bigint;
  readonly supplyBurn: bigint;
  readonly behaviorValid: boolean;
  readonly behaviorProofHash: string;
};

export type DefaultCollateralBaseEvidence = {
  readonly phase: "base";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly shareCodeHash: string;
  readonly implementation: string;
  readonly asset: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
  readonly totalSupply: bigint;
  readonly shareIsClone: boolean;
  readonly baseValid: boolean;
  readonly evidenceRequestIds?: ReadonlyArray<string>;
};

export type DefaultCollateralCandidate = FamilyCandidate & {
  readonly candidateKind: "default-collateral-share-vault";
  readonly vault: string;
};

export type DefaultCollateralDescriptor = CompiledInstanceDescriptor & {
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly implementation: string;
  readonly shareCodeHash: string;
  readonly implementationCodeHash: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
};

export type DefaultCollateralExactEvidence = {
  readonly kind: "default-collateral-one-to-one";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly totalSupply: bigint;
  readonly backing: bigint;
  readonly feeBps: bigint;
  readonly bindingFingerprint: string;
};

export type DefaultCollateralIdentity = VerifiedIdentity & {
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly implementation: string;
  readonly shareCodeHash: string;
  readonly implementationCodeHash: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
  readonly oneToOne: boolean;
};

export type DefaultCollateralIdentityEvidence = (DefaultCollateralBaseEvidence) | (DefaultCollateralSurfaceEvidence) | (DefaultCollateralActiveEvidence);

export type DefaultCollateralPricingDescriptor = DefaultCollateralPricingDraft & DefaultCollateralPricingStatic & {

};

export type DefaultCollateralPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly implementation: string;
  readonly routes: ReadonlyArray<DefaultCollateralRoute>;
};

export type DefaultCollateralPricingStatic = {

};

export type DefaultCollateralRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "redeem";
  readonly adapterId: "default-collateral-withdraw";
};

export type DefaultCollateralSurfaceEvidence = {
  readonly phase: "surface";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly shareCodeHash: string;
  readonly implementation: string;
  readonly asset: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
  readonly totalSupply: bigint;
  readonly shareIsClone: boolean;
  readonly baseValid: boolean;
  readonly implementationCodeHash: string;
  readonly backing: bigint;
  readonly surfaceValid: boolean;
  readonly invariantProven: boolean;
  readonly evidenceRequestIds?: ReadonlyArray<string>;
};

export type FamilyTypes = {
  readonly candidate: DefaultCollateralCandidate;
  readonly identityEvidence: DefaultCollateralIdentityEvidence;
  readonly identity: DefaultCollateralIdentity;
  readonly descriptor: DefaultCollateralDescriptor;
  readonly route: DefaultCollateralRoute;
  readonly pricingDraft: DefaultCollateralPricingDraft;
  readonly pricingDescriptor: DefaultCollateralPricingDescriptor;
  readonly pricingStatic: DefaultCollateralPricingStatic;
  readonly exactEvidence: DefaultCollateralExactEvidence;
};
