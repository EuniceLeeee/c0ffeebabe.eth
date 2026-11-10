import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type {
  FamilyId,
  InstanceKey,
  LineageId,
} from "../../adapter-family-identifiers.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { ProtocolPricingSnapshot } from "../standard-family/common.js";

export type MellowQueueKind = "deposit" | "redeem";

export interface MellowQueueCandidate extends FamilyCandidate {
  readonly candidateKind: "mellow-queue";
  readonly queue: string;
  readonly kind: MellowQueueKind;
}

export interface MellowQueueIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly queue: string;
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly oracle: string;
  readonly feeManager: string;
  readonly kind: MellowQueueKind;
  readonly penaltyD6: bigint;
  readonly maxAge: number;
  readonly proxyCodeHash: string;
  readonly implementation: string;
  readonly implementationCodeHash: string;
}

export interface MellowQueueDescriptor extends CompiledInstanceDescriptor {
  readonly queue: string;
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly oracle: string;
  readonly feeManager: string;
  readonly kind: MellowQueueKind;
  readonly penaltyD6: bigint;
  readonly maxAge: number;
  readonly proxyCodeHash: string;
  readonly implementation: string;
  readonly implementationCodeHash: string;
}

export interface MellowQueueRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "deposit-to-share" | "redeem-to-asset";
  readonly adapterId: "mellow-deposit" | "mellow-redeem";
}

export interface MellowQueuePricingDraft {
  readonly instanceKey: InstanceKey;
  readonly queue: string;
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly oracle: string;
  readonly feeManager: string;
  readonly kind: MellowQueueKind;
  readonly penaltyD6: bigint;
  readonly maxAge: number;
  readonly route: MellowQueueRoute;
}

export interface MellowQueuePricingDescriptor extends MellowQueuePricingDraft {
  readonly assetDecimals: number;
  readonly shareDecimals: number;
}

export interface MellowQueuePricingSnapshot extends ProtocolPricingSnapshot {
  readonly priceD18: bigint;
}

export interface MellowQueueExactEvidence {
  readonly kind: "mellow-queue-oracle-price";
  readonly source: CanonicalSource;
  readonly queue: string;
  readonly asset: string;
  readonly share: string;
  readonly direction: MellowQueueKind;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly priceD18: bigint;
  readonly penaltyD6: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
}

export type MellowQueueIdentityEvidence =
  | {
      readonly phase: "base";
      readonly queue: string;
      readonly vault: string;
      readonly asset: string;
      readonly share: string;
      readonly oracle: string;
      readonly feeManager: string;
      readonly kind: MellowQueueKind;
      readonly penaltyD6: bigint;
      readonly maxAge: number;
      readonly proxyCodeHash: string;
      readonly implementation: string;
      readonly implementationCodeHash: string;
    }
  | {
      readonly phase: "active";
      readonly queue: string;
      readonly vault: string;
      readonly asset: string;
      readonly share: string;
      readonly oracle: string;
      readonly feeManager: string;
      readonly kind: MellowQueueKind;
      readonly penaltyD6: bigint;
      readonly maxAge: number;
      readonly proxyCodeHash: string;
      readonly implementation: string;
      readonly implementationCodeHash: string;
      readonly behaviorValid: boolean;
      readonly behaviorProofHash: string;
    };
