// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 81655964933a25644941f91161cb78f6e49de99cf7c7cc2cbe9142ecff78c01f
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type BoringBaseEvidence = {
  readonly phase: "base";
  readonly source: CanonicalSource;
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly paused: boolean;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
};

export type BoringCandidate = FamilyCandidate & {
  readonly candidateKind: "boring-vault-withdraw";
  readonly teller: string;
};

export type BoringCompleteEvidence = {
  readonly phase: "complete";
  readonly source: CanonicalSource;
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly paused: boolean;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
  readonly vaultCodeHash: string;
  readonly accountantCodeHash: string;
  readonly behaviorValid: boolean;
  readonly behaviorHash: string;
};

export type BoringDescriptor = CompiledInstanceDescriptor & {
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
  readonly vaultCodeHash: string;
  readonly accountantCodeHash: string;
};

export type BoringExactEvidence = {
  readonly kind: "boring-vault-withdraw";
  readonly source: CanonicalSource;
  readonly teller: string;
  readonly vault: string;
  readonly asset: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
};

export type BoringIdentity = VerifiedIdentity & {
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
  readonly vaultCodeHash: string;
  readonly accountantCodeHash: string;
};

export type BoringIdentityEvidence = (BoringBaseEvidence) | (BoringCompleteEvidence);

export type BoringPricingDescriptor = BoringPricingDraft & BoringPricingStatic & {

};

export type BoringPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
  readonly vaultCodeHash: string;
  readonly accountantCodeHash: string;
  readonly route: BoringRoute;
  readonly routes: ReadonlyArray<BoringRoute>;
};

export type BoringPricingStatic = {

};

export type BoringRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "withdraw";
  readonly adapterId: "boring-vault-withdraw";
};

export type FamilyTypes = {
  readonly candidate: BoringCandidate;
  readonly identityEvidence: BoringIdentityEvidence;
  readonly identity: BoringIdentity;
  readonly descriptor: BoringDescriptor;
  readonly route: BoringRoute;
  readonly pricingDraft: BoringPricingDraft;
  readonly pricingDescriptor: BoringPricingDescriptor;
  readonly pricingStatic: BoringPricingStatic;
  readonly exactEvidence: BoringExactEvidence;
};
