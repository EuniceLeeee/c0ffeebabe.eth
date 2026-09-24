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

export interface PsmCandidate extends FamilyCandidate {
  readonly candidateKind: "lite-psm";
  readonly target: string;
}

export interface PsmIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly gem: string;
  readonly dai: string;
}

export interface PsmDescriptor extends CompiledInstanceDescriptor {
  readonly target: string;
  readonly gem: string;
  readonly dai: string;
  readonly decimalScale: bigint;
}

export interface PsmRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "sell-gem" | "buy-gem";
  readonly adapterId: "psm";
}

export interface PsmPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly routes: readonly PsmRoute[];
  readonly decimalScale: bigint;
}

export interface PsmIdentityEvidence {
  readonly codeHash: string;
  readonly gem: string;
  readonly dai: string;
  readonly tin: bigint;
  readonly tout: bigint;
}

export interface PsmExactEvidence {
  readonly kind: "psm-directional-fee";
  readonly direction: PsmRoute["direction"];
  readonly source: CanonicalSource;
  readonly target: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly fee: bigint;
  readonly bindingFingerprint: string;
}
