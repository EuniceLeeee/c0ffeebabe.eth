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

export interface Erc4626SiloRedeemCandidate extends FamilyCandidate {
  readonly candidateKind: "erc4626-silo-payout";
  readonly vault: string;
  readonly payoutToken: string;
  readonly observedMode: "redeem" | "withdraw";
  readonly observedAmount: bigint;
}

export type Erc4626SiloRedeemIdentityEvidence =
  | {
      readonly phase: "base";
      readonly vault: string;
      readonly payoutToken: string;
      readonly underlyingAsset: string;
      readonly totalSupply: bigint;
      readonly sampleShares: bigint;
      readonly behaviorValid: boolean;
    }
  | {
      readonly phase: "preview";
      readonly vault: string;
      readonly payoutToken: string;
      readonly underlyingAsset: string;
      readonly totalSupply: bigint;
      readonly sampleShares: bigint;
      readonly sampleAssets: bigint;
      readonly behaviorValid: boolean;
    }
  | {
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

export interface Erc4626SiloRedeemIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
}

export interface Erc4626SiloRedeemDescriptor
  extends CompiledInstanceDescriptor {
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
}

export interface Erc4626SiloRedeemRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "silo-redeem";
  readonly adapterId: "erc4626-redeem-silo";
}

export interface Erc4626SiloRedeemPricingDraft {
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly payoutToken: string;
  readonly underlyingAsset: string;
  readonly route: Erc4626SiloRedeemRoute;
}

export interface Erc4626SiloRedeemPricingDescriptor
  extends Erc4626SiloRedeemPricingDraft {
  readonly oneShare: bigint;
}

export interface Erc4626SiloRedeemPricingSnapshot
  extends ProtocolPricingSnapshot {
  readonly previewAssets: bigint;
}

export interface Erc4626SiloRedeemExactEvidence {
  readonly kind: "erc4626-silo-active-redeem";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly payoutToken: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
  readonly effectsHash: string;
}
