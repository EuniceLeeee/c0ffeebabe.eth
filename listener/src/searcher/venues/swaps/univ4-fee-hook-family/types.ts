import type {
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
import type { V4PoolKey } from "../../../planner/token-graph.js";
import type {
  UniV4Descriptor,
  UniV4Direction,
  UniV4ManagerBinding,
  UniV4PrecisionOutcome,
  UniV4PricingDescriptor,
  UniV4PricingSnapshot,
} from "../univ4-family/types.js";

export type {
  UniV4PrecisionOutcome,
  UniV4PricingDescriptor,
  UniV4PricingSnapshot,
} from "../univ4-family/types.js";

export type FeeHookCandidateSource =
  | "initialize-log"
  | "manager-swap-call"
  | "pool-surface";

export interface FeeHookCandidate extends FamilyCandidate {
  readonly candidateKind: "univ4-pool-key";
  readonly sourceKind: FeeHookCandidateSource;
  readonly manager: string;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
}

export interface FeeHookIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: {
    readonly poolId: string;
    readonly poolKey: V4PoolKey;
    readonly managerBinding: UniV4ManagerBinding;
    readonly hookCodeHash: string;
  };
}

export interface FeeHookDescriptor extends UniV4Descriptor {
  readonly hookPolicy: "fee-hook";
  readonly hook: string;
}

export type FeeHookRoute = FamilyRouteDescriptor & {
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly manager: string;
  readonly direction: UniV4Direction;
  readonly realTokenIn: string;
  readonly realTokenOut: string;
};

export type FeeHookPricingDescriptor = UniV4PricingDescriptor;
export type FeeHookPricingSnapshot = UniV4PricingSnapshot;
export type FeeHookPrecisionOutcome = UniV4PrecisionOutcome;

export interface FeeHookExactEvidence {
  readonly kind: "univ4-fee-hook-quoter";
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

export interface FeeHookIdentityEvidence {
  readonly phase: "fee-hook-active-proof";
  readonly managerCodeHash: string;
  readonly hookCodeHash: string;
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
}
