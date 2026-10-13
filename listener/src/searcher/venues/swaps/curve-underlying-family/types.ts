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

export type CurveUnderlyingRegistryBinding = {
  readonly registry: string;
  readonly handlers: readonly string[];
} & (
  | { readonly lookupSemantics: "get_registry_handlers_from_pool+get_underlying_coins" }
  | { readonly lookupSemantics: "get_base_pool+get_underlying_coins"; readonly basePool: string }
  | { readonly lookupSemantics: "get_coins+get_underlying_coins"; readonly wrappedCoins: readonly string[] }
  | { readonly lookupSemantics: "pool-token+lp-minter+wrapper-token" }
);

export interface CurveUnderlyingLendingBinding {
  readonly kind: "legacy-dtoken-four" | "legacy-yvault-four";
  readonly poolCodeHash: string;
  readonly lpToken: string;
  readonly lpCodeHash: string;
  readonly wrappedCoins: readonly string[];
  readonly wrapperCodeHashes: readonly string[];
}

export interface CurveUnderlyingLegacyPlainBinding {
  readonly kind: "legacy-plain-four-no-lending";
  readonly poolCodeHash: string;
}

/** Semantics bound by immutable implementation code plus on-chain coin/LP topology.
 * Not an admission allowlist and not a universal Curve math model. */
export interface CurveUnderlyingClassicMetaBinding {
  readonly kind: "classic-meta-base-3pool-v1";
  readonly poolCodeHash: string;
  readonly metaRateMultiplier: bigint;
  readonly implementation: string;
  readonly implementationCodeHash: string;
  readonly basePool: string;
  readonly baseCodeHash: string;
  readonly baseLPToken: string;
  readonly baseCoins: readonly string[];
  readonly basePrecisions: readonly bigint[];
}

export interface CurveUnderlyingIdentityFacts {
  readonly pool: string;
  readonly coins: readonly string[];
  readonly registryBinding: CurveUnderlyingRegistryBinding;
  readonly quoteModel?: CurveUnderlyingClassicMetaBinding;
  readonly legacyPlain?: CurveUnderlyingLegacyPlainBinding;
  readonly lending?: CurveUnderlyingLendingBinding;
  readonly nativeAlias?: CurveUnderlyingNativeAlias;
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
  readonly quoteModel?: CurveUnderlyingClassicMetaBinding;
  readonly legacyPlain?: CurveUnderlyingLegacyPlainBinding;
  readonly lending?: CurveUnderlyingLendingBinding;
  readonly nativeAlias?: CurveUnderlyingNativeAlias;
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
  readonly quoteModel?: CurveUnderlyingClassicMetaBinding;
  readonly legacyPlain?: CurveUnderlyingLegacyPlainBinding;
  readonly lending?: CurveUnderlyingLendingBinding;
  readonly nativeAlias?: CurveUnderlyingNativeAlias;
}

export interface CurveUnderlyingPricingSnapshot {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly inputUnit: bigint | null;
  readonly inputBalance: bigint | null;
}

export interface CurveUnderlyingExactEvidence {
  readonly kind: "curve-underlying-get-dy" | "curve-underlying-classic-meta" | "curve-underlying-legacy-plain" | "curve-underlying-lending";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly routeKey: CurveUnderlyingRoute["routeKey"];
  readonly i: number;
  readonly j: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly nativeAlias?: CurveUnderlyingNativeAlias;
}

/** Registry direct/underlying topology plus same-state uint execution proof.
 * This is an ABI/asset variant, never a pool-address admission list. */
export interface CurveUnderlyingNativeAlias {
  /** Null is an ERC20-only pool; it must not conceal a WETH/native index. */
  readonly nativeIndex: number | null;
  readonly poolCodeHash: string;
}

export type CurveUnderlyingIdentityEvidence =
  | {
      readonly phase: "registry-surface";
      readonly pool: string;
      readonly handlers: readonly string[];
      readonly registryBinding?: CurveUnderlyingRegistryBinding;
      readonly coins: readonly string[];
      readonly poolHasCode: boolean;
      readonly poolCode: string;
    }
  | {
      readonly phase: "behavior-proof";
      readonly scaleProbe?: {
        readonly directions: readonly { readonly i: number; readonly j: number }[];
        readonly amounts?: readonly { readonly i: number; readonly j: number; readonly amountIn: bigint }[];
        readonly source?: CanonicalSource;
      };
      readonly pool: string;
      readonly handlers: readonly string[];
      readonly registryBinding?: CurveUnderlyingRegistryBinding;
      readonly coins: readonly string[];
      readonly verifiedDirections: readonly CurveUnderlyingVerifiedDirection[];
      readonly quoteModel?: CurveUnderlyingClassicMetaBinding;
  readonly legacyPlain?: CurveUnderlyingLegacyPlainBinding;
    };
