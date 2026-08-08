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

export interface RocksolidCandidate extends FamilyCandidate {
  readonly candidateKind: "rocksolid-receipt";
  readonly target: string;
}

export interface RocksolidIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly sampleShares: bigint;
}

export interface RocksolidDescriptor extends CompiledInstanceDescriptor {
  readonly target: string;
  readonly asset: string;
  readonly receipt: string;
}

export interface RocksolidRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "sync-deposit";
  readonly adapterId: "rocksolid-sync-deposit";
}

export interface RocksolidPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly route: RocksolidRoute;
}

export interface RocksolidIdentityEvidence {
  readonly codeHash: string;
  readonly sampleShares: bigint;
}

export interface RocksolidExactEvidence {
  readonly kind: "rocksolid-convert-to-shares";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}
