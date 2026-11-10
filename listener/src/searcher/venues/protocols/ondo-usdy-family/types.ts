import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { FamilyId, LineageId } from "../../adapter-family-identifiers.js";

export interface OndoCandidate extends FamilyCandidate {
  readonly candidateKind: "ondo-usdy-redeem";
  readonly manager: string;
  readonly receive: string;
}

export interface OndoIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId; readonly lineageId: LineageId;
  readonly manager: string; readonly rwa: string; readonly receive: string;
  readonly oracle: string; readonly fees: string; readonly normalizer: bigint;
  readonly rwaDecimals: number; readonly receiveDecimals: number;
  readonly minimumRwaPrice: bigint; readonly redeemPaused: boolean;
  readonly priceRwa: bigint; readonly priceReceive: bigint;
  readonly feeFlat: bigint; readonly feeBps: bigint; readonly feePrecision: bigint;
  readonly managerCodeHash: string;
}

export interface OndoDescriptor extends CompiledInstanceDescriptor {
  readonly manager: string; readonly rwa: string; readonly receive: string;
  readonly oracle: string; readonly fees: string; readonly normalizer: bigint;
  readonly rwaDecimals: number; readonly receiveDecimals: number;
  readonly minimumRwaPrice: bigint; readonly feeFlat: bigint; readonly feeBps: bigint; readonly feePrecision: bigint;
  readonly managerCodeHash: string;
}

export interface OndoRoute extends FamilyRouteDescriptor {
  readonly target: string; readonly direction: "redeem"; readonly adapterId: "ondo-usdy-redeem";
}

export interface OndoPricingDraft {
  readonly instanceKey: string; readonly manager: string; readonly rwa: string; readonly receive: string;
  readonly oracle: string; readonly fees: string; readonly normalizer: bigint;
  readonly rwaDecimals: number; readonly receiveDecimals: number;
  readonly minimumRwaPrice: bigint; readonly feeFlat: bigint; readonly feeBps: bigint; readonly feePrecision: bigint;
  readonly route: OndoRoute;
}

export interface OndoPricingDescriptor extends OndoPricingDraft { readonly route: OndoRoute }

export interface OndoPricingSnapshot {
  readonly source: CanonicalSource;
  readonly priceRwa: bigint; readonly priceReceive: bigint;
  readonly feeFlat: bigint; readonly feeBps: bigint; readonly feePrecision: bigint;
  readonly quotes: Readonly<Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }>>;
}

export interface OndoExactEvidence {
  readonly kind: "ondo-usdy-redeem";
  readonly source: CanonicalSource;
  readonly manager: string; readonly rwa: string; readonly receive: string;
  readonly amountIn: bigint; readonly amountOut: bigint;
  readonly executor: string; readonly bindingFingerprint: string;
}

export type OndoEvidence =
  | { readonly phase: "base"; readonly source: CanonicalSource; readonly manager: string; readonly rwa: string; readonly receive: string;
      readonly oracle: string; readonly fees: string; readonly normalizer: bigint; readonly rwaDecimals: number; readonly receiveDecimals: number;
      readonly minimumRwaPrice: bigint; readonly redeemPaused: boolean; readonly managerCodeHash: string; }
  | { readonly phase: "complete"; readonly source: CanonicalSource; readonly manager: string; readonly rwa: string; readonly receive: string;
      readonly oracle: string; readonly fees: string; readonly normalizer: bigint; readonly rwaDecimals: number; readonly receiveDecimals: number;
      readonly minimumRwaPrice: bigint; readonly priceRwa: bigint; readonly priceReceive: bigint; readonly feeFlat: bigint; readonly feeBps: bigint;
      readonly feePrecision: bigint; readonly managerCodeHash: string; readonly redeemPaused?: boolean; readonly behaviorValid: boolean; readonly behaviorHash: string; };
