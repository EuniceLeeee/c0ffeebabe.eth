// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 4dda425374f4bad67521a2cbbbe47ef2e232aca1201e63a323d7aaa543cb3910
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type EigenpieActiveEvidence = {
  readonly phase: "active";
  readonly targetCodeHash: string;
  readonly tokenInCodeHash: string;
  readonly tokenOutCodeHash: string;
  readonly target: string;
  readonly actor: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly behaviorProofHash: string;
  readonly active: boolean;
};

export type EigenpieCandidate = FamilyCandidate & {
  readonly candidateKind: "eigenpie-deposit-pair";
  readonly target: string;
  readonly actor: string;
  readonly tokenIn: string;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly observedAmountOut: bigint;
  readonly hasObservedAmountOut: boolean;
};

export type EigenpieDescriptor = CompiledInstanceDescriptor & {
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
  readonly sampleAmountIn: bigint;
};

export type EigenpieExactEvidence = {
  readonly kind: "eigenpie-pair-quote";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
};

export type EigenpieIdentity = VerifiedIdentity & {
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly sampleAmountIn: bigint;
};

export type EigenpieIdentityEvidence = (EigenpieQuoteEvidence) | (EigenpieActiveEvidence);

export type EigenpiePricingDescriptor = EigenpiePricingDraft & EigenpiePricingStatic & {

};

export type EigenpiePricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly route: EigenpieRoute;
  readonly routes: ReadonlyArray<EigenpieRoute>;
};

export type EigenpiePricingStatic = {
  readonly oneAsset: bigint;
};

export type EigenpieQuoteEvidence = {
  readonly phase: "quote";
  readonly targetCodeHash: string;
  readonly tokenInCodeHash: string;
  readonly target: string;
  readonly actor: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
};

export type EigenpieRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "deposit-asset";
  readonly adapterId: "eigenpie-deposit-asset";
};

export type FamilyTypes = {
  readonly candidate: EigenpieCandidate;
  readonly identityEvidence: EigenpieIdentityEvidence;
  readonly identity: EigenpieIdentity;
  readonly descriptor: EigenpieDescriptor;
  readonly route: EigenpieRoute;
  readonly pricingDraft: EigenpiePricingDraft;
  readonly pricingDescriptor: EigenpiePricingDescriptor;
  readonly pricingStatic: EigenpiePricingStatic;
  readonly exactEvidence: EigenpieExactEvidence;
};
