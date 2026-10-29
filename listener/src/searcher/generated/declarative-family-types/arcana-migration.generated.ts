// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 5e4b9a250af172e4be61e9bff6aed3e2120d03236ead04377cf2ea9933f1cdd2
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type ArcanaActiveEvidence = {
  readonly phase: "active";
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly proxyCodeHash: string;
  readonly behaviorValid: boolean;
  readonly behaviorProofHash: string;
};

export type ArcanaBaseEvidence = {
  readonly phase: "base";
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: "";
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly proxyCodeHash: string;
};

export type ArcanaCandidate = FamilyCandidate & {
  readonly candidateKind: "arcana-migration";
  readonly source: string;
  readonly tokenId: string;
};

export type ArcanaDescriptor = CompiledInstanceDescriptor & {
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly proxyCodeHash: string;
};

export type ArcanaExactEvidence = {
  readonly kind: "arcana-migration-preview";
  readonly source: CanonicalSource;
  readonly sourceContract: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
};

export type ArcanaIdentity = VerifiedIdentity & {
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly proxyCodeHash: string;
};

export type ArcanaIdentityEvidence = (ArcanaBaseEvidence) | (ArcanaActiveEvidence);

export type ArcanaPricingDescriptor = ArcanaPricingDraft & ArcanaPricingStatic & {

};

export type ArcanaPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly route: ArcanaRoute;
};

export type ArcanaPricingStatic = {
  readonly oldTokenDecimals: number;
  readonly arcTokenDecimals: number;
};

export type ArcanaRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "migrate-to-arc";
  readonly adapterId: "arcana-migration";
};

export type FamilyTypes = {
  readonly candidate: ArcanaCandidate;
  readonly identityEvidence: ArcanaIdentityEvidence;
  readonly identity: ArcanaIdentity;
  readonly descriptor: ArcanaDescriptor;
  readonly route: ArcanaRoute;
  readonly pricingDraft: ArcanaPricingDraft;
  readonly pricingDescriptor: ArcanaPricingDescriptor;
  readonly pricingStatic: ArcanaPricingStatic;
  readonly exactEvidence: ArcanaExactEvidence;
};
