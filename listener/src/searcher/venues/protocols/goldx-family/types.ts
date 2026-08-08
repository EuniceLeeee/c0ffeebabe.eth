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

export interface GoldxCandidate extends FamilyCandidate {
  readonly candidateKind: "goldx-minter";
  readonly target: string;
}

export interface GoldxIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly unit: bigint;
}

export interface GoldxDescriptor extends CompiledInstanceDescriptor {
  readonly target: string;
  readonly collateral: string;
  readonly receipt: string;
}

export interface GoldxRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "mint";
  readonly adapterId: "goldx-mint";
}

export interface GoldxPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly route: GoldxRoute;
}

export interface GoldxIdentityEvidence {
  readonly codeHash: string;
  readonly unit: bigint;
}

export interface GoldxExactEvidence {
  readonly kind: "goldx-unit-quote";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly unit: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}
