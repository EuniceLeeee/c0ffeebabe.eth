import type { V4PoolKey } from "../../../planner/token-graph.js";
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

export type UniV4CandidateSource = "initialize-log" | "manager-swap-call";

export interface UniV4Candidate extends FamilyCandidate {
  readonly candidateKind: "univ4-pool-key";
  readonly sourceKind: UniV4CandidateSource;
  readonly manager: string;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
}

export interface UniV4ManagerBinding {
  readonly manager: string;
  readonly stateView: string;
  readonly quoter: string;
  readonly managerCodeHash: string;
}

export interface UniV4IdentityFacts {
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly managerBinding: UniV4ManagerBinding;
}

export interface UniV4Identity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: UniV4IdentityFacts;
}

export interface UniV4Descriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly graphToken0: string;
  readonly graphToken1: string;
  readonly managerBinding: UniV4ManagerBinding;
  readonly hookPolicy: "no-hook";
}

export type UniV4Direction = "zero-for-one" | "one-for-zero";

export interface UniV4Route extends FamilyRouteDescriptor {
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly manager: string;
  readonly direction: UniV4Direction;
  readonly realTokenIn: string;
  readonly realTokenOut: string;
}

export interface UniV4PricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly graphToken0: string;
  readonly graphToken1: string;
  readonly managerBinding: UniV4ManagerBinding;
}

export interface UniV4PrecisionOutcome {
  readonly amountIn: bigint;
  readonly amountOut?: bigint;
  readonly failure?: string;
}

export interface UniV4PricingSnapshot {
  readonly source: CanonicalSource;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly protocolFee: bigint;
  readonly lpFee: bigint;
  readonly inactiveReason: string | null;
  readonly precision: ReadonlyMap<string, UniV4PrecisionOutcome>;
}

export interface UniV4ExactEvidence {
  readonly kind: "univ4-no-hook-quoter";
  readonly source: CanonicalSource;
  readonly poolId: string;
  readonly poolKeyFingerprint: string;
  readonly quoter: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly gasEstimate: bigint;
  readonly hookData: "0x";
}

export interface UniV4IdentityEvidence {
  readonly phase: "manager-active-proof";
  readonly managerCodeHash: string;
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
}
