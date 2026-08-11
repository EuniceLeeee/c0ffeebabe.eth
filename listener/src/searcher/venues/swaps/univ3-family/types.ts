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

export type UniV3CandidateSource =
  | "pool-created"
  | "pool-call"
  | "pool-swap-log";

export interface UniV3Candidate extends FamilyCandidate {
  readonly candidateKind: "univ3-pool";
  readonly pool: string;
  readonly sourceKind: UniV3CandidateSource;
  readonly hintedFactory: string | null;
  readonly hintedToken0: string | null;
  readonly hintedToken1: string | null;
  readonly hintedFee: bigint | null;
  readonly hintedTickSpacing: number | null;
}

export interface UniV3FactoryBinding {
  readonly factory: string;
  readonly reversePool: string;
}

export interface UniV3QuoterBinding {
  readonly quoter: string | null;
  readonly router: string | null;
  readonly provenance: "factory-bound-infrastructure" | "unavailable";
}

export interface UniV3IdentityFacts {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly factoryBinding: UniV3FactoryBinding;
  readonly quoterBinding: UniV3QuoterBinding;
}

export interface UniV3Identity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: UniV3IdentityFacts;
}

export interface UniV3Descriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly factoryBinding: UniV3FactoryBinding;
  readonly quoterBinding: UniV3QuoterBinding;
}

export type UniV3Direction = "zero-for-one" | "one-for-zero";

export interface UniV3Route extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly direction: UniV3Direction;
  readonly fee: bigint;
  readonly tickSpacing: number;
}

export interface UniV3PricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly factoryBinding: UniV3FactoryBinding;
  readonly quoterBinding: UniV3QuoterBinding;
}

export interface UniV3PrecisionOutcome {
  readonly amountIn: bigint;
  readonly amountOut?: bigint;
  readonly failure?: string;
}

export interface UniV3PricingSnapshot {
  readonly source: CanonicalSource;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly observationIndex: number;
  readonly observationCardinality: number;
  readonly observationCardinalityNext: number;
  readonly feeProtocol: number;
  readonly unlocked: boolean;
  readonly inactiveReason: string | null;
  readonly precision: Readonly<Record<string, UniV3PrecisionOutcome>>;
}

export interface UniV3ExactEvidence {
  readonly kind: "univ3-factory-bound-quoter";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly quoter: string | null;
  readonly caller: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly fee: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly sqrtPriceX96After: bigint;
  readonly initializedTicksCrossed: number;
  readonly gasEstimate: bigint;
}

export type UniV3IdentityEvidence =
  | {
      readonly phase: "pool-static";
      readonly factory: string;
      readonly token0: string;
      readonly token1: string;
      readonly fee: bigint;
      readonly tickSpacing: number;
    }
  | {
      readonly phase: "reverse-binding";
      readonly factory: string;
      readonly token0: string;
      readonly token1: string;
      readonly fee: bigint;
      readonly tickSpacing: number;
      readonly reversePool: string;
    };
