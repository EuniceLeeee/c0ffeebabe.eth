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

export interface SelfBurnNativeCandidate extends FamilyCandidate {
  readonly candidateKind: "self-burn-native-token";
  readonly token: string;
  readonly observedAmount: bigint | null;
}

export type SelfBurnNativeIdentityEvidence =
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
      readonly sampleNativeOut: bigint;
      readonly behaviorValid: boolean;
      readonly behaviorProofHash: string;
    };

export interface SelfBurnNativeIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly token: string;
}

export interface SelfBurnNativeDescriptor extends CompiledInstanceDescriptor {
  readonly token: string;
  readonly nativeAnchor: string;
}

export interface SelfBurnNativeRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "self-burn-to-native";
  readonly adapterId: "self-burn-native-redeem";
}

export interface SelfBurnNativePricingDraft {
  readonly instanceKey: InstanceKey;
  readonly token: string;
  readonly nativeAnchor: string;
  readonly route: SelfBurnNativeRoute;
}

export interface SelfBurnNativePricingDescriptor
  extends SelfBurnNativePricingDraft {
  readonly probeAmounts: readonly bigint[];
}

export interface SelfBurnNativePricingSnapshot
  extends ProtocolPricingSnapshot {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export interface SelfBurnNativeExactEvidence {
  readonly kind: "self-burn-native-effect-delta";
  readonly source: CanonicalSource;
  readonly token: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
  readonly effectsHash: string;
}
