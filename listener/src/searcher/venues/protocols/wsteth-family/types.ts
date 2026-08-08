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

export interface WstethCandidate extends FamilyCandidate {
  readonly candidateKind: "wsteth-converter";
  readonly target: string;
  readonly sourceKind: "observed-call" | "address-surface";
}

export interface WstethIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly steth: string;
  readonly wrapSampleOut: bigint;
  readonly unwrapSampleOut: bigint;
}

export interface WstethDescriptor extends CompiledInstanceDescriptor {
  readonly target: string;
  readonly steth: string;
  readonly wsteth: string;
}

export interface WstethRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "wrap" | "unwrap";
  readonly adapterId: "wsteth-wrap" | "wsteth-unwrap";
}

export interface WstethPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly routes: readonly WstethRoute[];
}

export interface WstethExactEvidence {
  readonly kind: "wsteth-conversion-quote";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly direction: WstethRoute["direction"];
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}

export interface WstethIdentityEvidence {
  readonly codeHash: string;
  readonly steth: string;
  readonly wrapSampleOut: bigint;
  readonly unwrapSampleOut: bigint;
}
