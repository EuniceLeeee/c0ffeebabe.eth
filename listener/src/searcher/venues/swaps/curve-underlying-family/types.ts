import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  RuntimeRequirement,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type {
  FamilyId,
  InstanceKey,
  LineageId,
} from "../../adapter-family-identifiers.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export interface CurveUnderlyingCandidate extends FamilyCandidate {
  readonly candidateKind: "curve-underlying-pool";
  readonly pool: string;
  readonly sourceKind:
    | "underlying-swap-log"
    | "exchange-underlying-call"
    | "pool-surface";
  readonly hintedI: number | null;
  readonly hintedJ: number | null;
}

export interface CurveUnderlyingVerifiedDirection {
  readonly i: number;
  readonly j: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly behaviorProbeAmountIn: bigint;
  readonly behaviorProbeAmountOut: bigint;
}

export interface CurveUnderlyingRegistryBinding {
  readonly registry: string;
  readonly handlers: readonly string[];
  readonly lookupSemantics:
    "get_registry_handlers_from_pool+get_underlying_coins";
}

export interface CurveUnderlyingIdentityFacts {
  readonly pool: string;
  readonly coins: readonly string[];
  readonly registryBinding: CurveUnderlyingRegistryBinding;
  readonly verifiedDirections: readonly CurveUnderlyingVerifiedDirection[];
}

export interface CurveUnderlyingIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: CurveUnderlyingIdentityFacts;
}

export interface CurveUnderlyingDescriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly coins: readonly string[];
  readonly registryBinding: CurveUnderlyingRegistryBinding;
  readonly verifiedDirections: readonly CurveUnderlyingVerifiedDirection[];
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

export interface CurveUnderlyingRoute extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly i: number;
  readonly j: number;
  readonly semantics: "exchange_underlying(i,j,dx,minDy)";
}

export interface CurveUnderlyingPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly registry: string;
  readonly coins: readonly string[];
  readonly route: CurveUnderlyingRoute;
}

export interface CurveUnderlyingPricingSnapshot {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly inputUnit: bigint | null;
  readonly inputBalance: bigint | null;
}

export interface CurveUnderlyingExactEvidence {
  readonly kind: "curve-underlying-get-dy";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly routeKey: CurveUnderlyingRoute["routeKey"];
  readonly i: number;
  readonly j: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export type CurveUnderlyingIdentityEvidence =
  | {
      readonly phase: "registry-surface";
      readonly pool: string;
      readonly handlers: readonly string[];
      readonly coins: readonly string[];
      readonly poolHasCode: boolean;
    }
  | {
      readonly phase: "behavior-proof";
      readonly pool: string;
      readonly handlers: readonly string[];
      readonly coins: readonly string[];
      readonly verifiedDirections: readonly CurveUnderlyingVerifiedDirection[];
    };
