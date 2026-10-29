// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 260ec2f31ad313dc18dd1b079416575a723c0b334aac3861d6d10b5bfded8e33
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type SiloActiveEvidence = {
  readonly phase: "active";
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
  readonly totalSupply: bigint;
  readonly sampleShares: bigint;
  readonly sampleAssets: bigint;
  readonly expectedPayout: bigint;
  readonly behaviorValid: boolean;
  readonly behaviorProofHash: string;
};

export type SiloBaseEvidence = {
  readonly phase: "base";
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
  readonly totalSupply: bigint;
  readonly sampleShares: bigint;
  readonly behaviorValid: boolean;
};

export type SiloCandidate = FamilyCandidate & {
  readonly candidateKind: "erc4626-silo-payout";
  readonly vault: string;
  readonly payoutToken: string;
  readonly observedMode: ("redeem") | ("withdraw");
  readonly observedAmount: bigint;
  readonly transactionHash?: string;
  readonly blockNumber?: number;
  readonly blockHash?: string;
};

export type SiloDescriptor = CompiledInstanceDescriptor & {
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
};

export type SiloExactEvidence = {
  readonly kind: "erc4626-silo-preview-chain";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly payoutToken: string;
  readonly amountIn: bigint;
  readonly previewAssets: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
  readonly readProof?: SiloReadProof;
};

export type SiloIdentity = VerifiedIdentity & {
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
};

export type SiloIdentityEvidence = (SiloBaseEvidence) | (SiloPreviewEvidence) | (SiloActiveEvidence);

export type SiloPreviewEvidence = {
  readonly phase: "preview";
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
  readonly totalSupply: bigint;
  readonly sampleShares: bigint;
  readonly sampleAssets: bigint;
  readonly behaviorValid: boolean;
};

export type SiloPricingDescriptor = SiloPricingDraft & SiloPricingStatic & {

};

export type SiloPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
  readonly route: SiloRoute;
  readonly routes: ReadonlyArray<SiloRoute>;
};

export type SiloPricingStatic = {
  readonly oneShare: bigint;
};

export type SiloReadProof = {
  readonly initialResults: ReadonlyArray<{

  }>;
  readonly dependentEvidence: ReadonlyArray<{

  }>;
};

export type SiloRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "silo-redeem";
  readonly adapterId: "erc4626-redeem-silo";
};

export type FamilyTypes = {
  readonly candidate: SiloCandidate;
  readonly identityEvidence: SiloIdentityEvidence;
  readonly identity: SiloIdentity;
  readonly descriptor: SiloDescriptor;
  readonly route: SiloRoute;
  readonly pricingDraft: SiloPricingDraft;
  readonly pricingDescriptor: SiloPricingDescriptor;
  readonly pricingStatic: SiloPricingStatic;
  readonly exactEvidence: SiloExactEvidence;
};
