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

export interface MetronomeHgUsdcCandidate extends FamilyCandidate {
  readonly candidateKind: "metronome-hgusdc-router";
  readonly router: string;
  readonly observedAmount: bigint;
}

export type MetronomeHgUsdcIdentityEvidence =
  | {
      readonly phase: "base";
      readonly router: string;
      readonly sampleAmount: bigint;
      readonly behaviorValid: boolean;
    }
  | {
      readonly phase: "curve";
      readonly router: string;
      readonly sampleAmount: bigint;
      readonly behaviorValid: boolean;
      readonly curveOut: bigint;
    }
  | {
      readonly phase: "active";
      readonly router: string;
      readonly sampleAmount: bigint;
      readonly behaviorValid: boolean;
      readonly curveOut: bigint;
      readonly amountOut: bigint;
      readonly behaviorProofHash: string;
    };

export interface MetronomeHgUsdcIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly router: string;
}

export interface MetronomeHgUsdcDescriptor
  extends CompiledInstanceDescriptor {
  readonly router: string;
  readonly curve: string;
  readonly vault: string;
  readonly tokenIn: string;
  readonly curveIntermediate: string;
  readonly tokenOut: string;
  readonly pathHash: string;
}

export interface MetronomeHgUsdcRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly adapterId: "metronome-hgusdc-exit";
  readonly direction: "msusd-to-usdc";
}

export interface MetronomeHgUsdcPricingDraft {
  readonly instanceKey: InstanceKey;
  readonly router: string;
  readonly curve: string;
  readonly vault: string;
  readonly tokenIn: string;
  readonly curveIntermediate: string;
  readonly tokenOut: string;
  readonly route: MetronomeHgUsdcRoute;
}

export interface MetronomeHgUsdcPricingDescriptor
  extends MetronomeHgUsdcPricingDraft {
  readonly oneTokenIn: bigint;
}

export interface MetronomeHgUsdcPricingSnapshot
  extends ProtocolPricingSnapshot {
  readonly curveOut: bigint;
}

export interface MetronomeHgUsdcExactEvidence {
  readonly kind: "metronome-hgusdc-dependent-quote";
  readonly source: CanonicalSource;
  readonly router: string;
  readonly curve: string;
  readonly vault: string;
  readonly amountIn: bigint;
  readonly curveOut: bigint;
  readonly amountOut: bigint;
  readonly pathHash: string;
  readonly bindingFingerprint: string;
}
