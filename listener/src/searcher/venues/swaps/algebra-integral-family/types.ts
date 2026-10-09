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

export type AlgebraIntegralCandidateSource =
  | "factory-pool-log"
  | "pool-call"
  | "pool-swap-log"
  | "pool-surface";

export interface AlgebraIntegralCandidate extends FamilyCandidate {
  readonly candidateKind: "algebra-integral-pool";
  readonly pool: string;
  readonly sourceKind: AlgebraIntegralCandidateSource;
  readonly hintedFactory: string | null;
  readonly hintedToken0: string | null;
  readonly hintedToken1: string | null;
}

export interface AlgebraFactoryBinding {
  readonly factory: string;
  readonly reversePool: string;
}

interface AlgebraFeeBindingBase {
  /** Historical lastFee, not an immutable price or a plugin override fee. */
  readonly fee: bigint;
  readonly pluginConfig: number;
  readonly plugin: string;
}

export interface AlgebraQuoterBinding {
  readonly quoter: string;
  readonly quoterCodeHash: string;
  readonly poolDeployer: string;
  readonly pluginCodeHash: string;
  readonly pluginFactory: string;
}

export type AlgebraExecutedFeeBinding = AlgebraFeeBindingBase & (
  | { readonly kind: "global-state-last-fee" }
  | { readonly kind: "cypher-bound-quoter"; readonly quoterBinding: AlgebraQuoterBinding }
);

export interface AlgebraIntegralIdentityFacts {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tickSpacing: number;
  readonly factoryBinding: AlgebraFactoryBinding;
  readonly executedFee: AlgebraExecutedFeeBinding;
}

export interface AlgebraIntegralIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: AlgebraIntegralIdentityFacts;
}

export interface AlgebraIntegralDescriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tickSpacing: number;
  readonly factoryBinding: AlgebraFactoryBinding;
  readonly executedFee: AlgebraExecutedFeeBinding;
}

export type AlgebraIntegralDirection = "zero-for-one" | "one-for-zero";

export interface AlgebraIntegralRoute extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly direction: AlgebraIntegralDirection;
  readonly tickSpacing: number;
}

export interface AlgebraIntegralPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly tickSpacing: number;
  readonly factoryBinding: AlgebraFactoryBinding;
  readonly executedFee: AlgebraExecutedFeeBinding;
}

export interface AlgebraIntegralPricingSnapshot {
  readonly source: CanonicalSource;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly lastFee: bigint;
  readonly executedFee: bigint | null;
  /** fee() is a raw hint only for plugin variants; Exact executes the Quoter. */
  readonly rawFeeView: bigint;
  readonly pluginConfig: number;
  readonly communityFee: number;
  readonly unlocked: boolean;
  readonly liquidity: bigint;
  readonly tickSpacing: number;
  readonly nextTickGlobal: number;
  readonly prevTickGlobal: number;
  readonly inactiveReason: string | null;
}

export interface AlgebraStaticExactEvidence {
  readonly kind: "algebra-integral-single-range";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly tickSpacing: number;
  readonly executedFee: bigint;
  readonly feeProvenance: "algebra-static-last-fee";
  readonly pluginFeeProvenance: "structurally-zero-without-dynamic-fee-flag";
  readonly pluginConfig: number;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly sqrtPriceX96Before: bigint;
  readonly sqrtPriceX96After: bigint;
  readonly rangeBoundTick: number;
  readonly rangeBoundSqrtPriceX96: bigint;
  readonly declinedReason: string | null;
}

export interface AlgebraQuoterExactEvidence {
  readonly kind: "algebra-integral-bound-quoter";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly tickSpacing: number;
  readonly binding: string;
  readonly routeKey: string;
  readonly executor: string;
  readonly transactionOrigin: string;
  readonly quoter: string;
  readonly plugin: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** The Quoter returns globalState.lastFee, NOT the beforeSwap override. */
  readonly reportedLastFee: bigint;
  readonly declinedReason: string | null;
}

export type AlgebraIntegralExactEvidence = AlgebraStaticExactEvidence | AlgebraQuoterExactEvidence;

/** Phase 1 — the pool's own static and single-slot surfaces at the cutoff. */
export interface AlgebraPoolStaticEvidence {
  readonly phase: "pool-static";
  readonly source: CanonicalSource;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly tickSpacing: number;
  readonly plugin: string;
  readonly pluginConfig: number;
  readonly lastFee: bigint;
  readonly feeView: bigint;
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  readonly unlocked: boolean;
}

/** Phase 2 — the factory's own reverse lookup for the pair. */
export interface AlgebraReverseBindingEvidence
  extends Omit<AlgebraPoolStaticEvidence, "phase"> {
  readonly phase: "reverse-binding";
  readonly reversePool: string;
  readonly quoterBinding?: AlgebraQuoterBinding;
  readonly unsupportedQuoterReason?: string;
}

export type AlgebraIntegralIdentityEvidence =
  | AlgebraPoolStaticEvidence
  | AlgebraReverseBindingEvidence;
