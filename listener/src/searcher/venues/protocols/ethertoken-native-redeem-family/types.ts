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

export interface EtherTokenNativeRedeemCandidate extends FamilyCandidate {
  readonly candidateKind: "ethertoken-native-redeem-token";
  readonly token: string;
  readonly observedAmount: bigint;
}

export type EtherTokenNativeRedeemIdentityEvidence =
  | {
      readonly phase: "base";
      readonly token: string;
      readonly sampleAmount: bigint;
      readonly behaviorValid: boolean;
    }
  | {
      readonly phase: "active";
      readonly token: string;
      readonly sampleAmount: bigint;
      readonly behaviorValid: boolean;
      readonly behaviorProofHash: string;
    };

export interface EtherTokenNativeRedeemIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly token: string;
}

export interface EtherTokenNativeRedeemDescriptor
  extends CompiledInstanceDescriptor {
  readonly token: string;
  readonly nativeAnchor: string;
}

export interface EtherTokenNativeRedeemRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "withdraw-to-native";
  readonly adapterId: "ethertoken-native-redeem";
}

export interface EtherTokenNativeRedeemPricingDraft {
  readonly instanceKey: InstanceKey;
  readonly token: string;
  readonly nativeAnchor: string;
  readonly route: EtherTokenNativeRedeemRoute;
}

export interface EtherTokenNativeRedeemPricingDescriptor
  extends EtherTokenNativeRedeemPricingDraft {
  readonly oneToken: bigint;
}

export interface EtherTokenNativeRedeemPricingSnapshot
  extends ProtocolPricingSnapshot {
  readonly totalSupply: bigint;
}

export interface EtherTokenNativeRedeemExactEvidence {
  readonly kind: "ethertoken-native-effect-delta";
  readonly source: CanonicalSource;
  readonly token: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
  readonly effectsHash: string;
}
