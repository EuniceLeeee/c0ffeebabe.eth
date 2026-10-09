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

export type KyberSwapCandidateSource =
  | "pool-call"
  | "pool-swap-log"
  | "pool-surface";

export interface KyberSwapCandidate extends FamilyCandidate {
  readonly candidateKind: "kyberswap-elastic-pool";
  readonly pool: string;
  readonly sourceKind: KyberSwapCandidateSource;
  readonly hintedFactory: string | null;
}

/** Phase 1 — the pool's own surfaces at the pinned block. */
export interface KyberSwapPoolStaticEvidence {
  readonly phase: "pool-static";
  readonly pool: string;
  readonly poolCodeHash: string;
  readonly factory: string;
  readonly token0: string;
  readonly token1: string;
  readonly feeUnits: bigint;
  readonly tickDistance: number;
  readonly sqrtP: bigint;
  readonly currentTick: number;
  readonly nearestCurrentTick: number;
  readonly locked: boolean;
  readonly baseL: bigint;
  readonly reinvestL: bigint;
  readonly staticValid: boolean;
  readonly evidenceRequestIds: readonly string[];
}

/**
 * Phase 2 — chain-proven factory admission: the pool's declared factory must
 * reverse-resolve the same pool for the pool's own token pair and fee units.
 */
export interface KyberSwapReverseBindingEvidence
  extends Omit<KyberSwapPoolStaticEvidence, "phase"> {
  readonly phase: "reverse-binding";
  readonly reversePool: string;
  readonly bindingValid: boolean;
}

export type KyberSwapIdentityEvidence =
  | KyberSwapPoolStaticEvidence
  | KyberSwapReverseBindingEvidence;

export interface KyberSwapFactoryBinding {
  readonly factory: string;
  readonly reversePool: string;
}

export interface KyberSwapIdentityFacts {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly feeUnits: bigint;
  readonly tickDistance: number;
  readonly factoryBinding: KyberSwapFactoryBinding;
}

export interface KyberSwapIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: KyberSwapIdentityFacts;
}

export interface KyberSwapDescriptor extends CompiledInstanceDescriptor {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly feeUnits: bigint;
  readonly tickDistance: number;
  readonly factoryBinding: KyberSwapFactoryBinding;
}

/** Exact-input only: the flag selects the INPUT token, never an output token. */
export type KyberSwapDirection = "token0-in" | "token1-in";

export interface KyberSwapRoute extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly direction: KyberSwapDirection;
  readonly isToken0: boolean;
  readonly feeUnits: bigint;
  readonly tickDistance: number;
}

/** Pricing works on the issued descriptor (identity-proven instance only). */
export interface KyberSwapPricingDescriptor {
  readonly instance: KyberSwapDescriptor;
}

export interface KyberSwapPoolState {
  readonly source: CanonicalSource;
  readonly sqrtP: bigint;
  readonly currentTick: number;
  readonly nearestCurrentTick: number;
  readonly locked: boolean;
  readonly baseL: bigint;
  readonly reinvestL: bigint;
  readonly feeUnits: bigint;
  /** Neighbours of `nearestCurrentTick` in the pool's initialized-tick list. */
  readonly previousTick: number | null;
  readonly nextTick: number | null;
}

export interface KyberSwapPricingSnapshot extends KyberSwapPoolState {}

export interface KyberSwapExactEvidence {
  readonly kind: "kyberswap-elastic-single-range";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly direction: KyberSwapDirection;
  readonly isToken0: boolean;
  readonly feeUnits: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly sqrtPBefore: bigint;
  readonly sqrtPAfter: bigint;
  readonly liquidity: bigint;
  readonly deltaL: bigint;
  readonly targetTick: number | null;
  /** Non-null when the state-level quote was refused instead of extrapolated. */
  readonly refusal: string | null;
  readonly bindingFingerprint: string;
}
