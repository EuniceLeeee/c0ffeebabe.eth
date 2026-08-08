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

export type AngstromV4CandidateSource = "initialize-log" | "adapter-swap-call";

export interface AngstromV4Candidate extends FamilyCandidate {
  readonly candidateKind: "angstrom-v4-pool-key";
  readonly sourceKind: AngstromV4CandidateSource;
  readonly manager: string;
  readonly adapter: string;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
}

export interface AngstromImmutableBinding {
  readonly manager: string;
  readonly stateView: string;
  readonly quoter: string;
  readonly hook: string;
  readonly adapter: string;
  readonly controller: string;
  readonly managerCodeHash: string;
  readonly hookCodeHash: string;
  readonly adapterCodeHash: string;
}

export interface AngstromV4IdentityFacts {
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly immutableBinding: AngstromImmutableBinding;
}

export interface AngstromV4Identity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: AngstromV4IdentityFacts;
}

export interface AngstromV4Descriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly immutableBinding: AngstromImmutableBinding;
}

export type AngstromV4Direction = "zero-for-one" | "one-for-zero";

export interface AngstromV4Route extends FamilyRouteDescriptor {
  readonly manager: string;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly direction: AngstromV4Direction;
}

export interface AngstromV4PricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly poolId: string;
  readonly poolKey: V4PoolKey;
  readonly immutableBinding: AngstromImmutableBinding;
}

export interface AngstromV4PricingSnapshot {
  readonly source: CanonicalSource;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly protocolFee: bigint;
  readonly lpFee: bigint;
  readonly inactiveReason: string | null;
}

export interface AngstromV4ExactEvidence {
  readonly kind: "angstrom-v4-tx-bound-quoter";
  readonly source: CanonicalSource;
  readonly poolId: string;
  readonly poolKeyFingerprint: string;
  readonly quoter: string;
  readonly txHash: string;
  readonly runtimeEvidenceHash: string;
  readonly payloadHash: string;
  readonly attestationEvidenceHashes: readonly string[];
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export type AngstromV4IdentityEvidence =
  | {
      readonly phase: "pool-hook-static";
      readonly managerCodeHash: string;
      readonly adapterCodeHash: string;
      readonly hookCodeHash: string;
      readonly sqrtPriceX96: bigint;
      readonly liquidity: bigint;
      readonly controller: string;
    }
  | {
      readonly phase: "controller-reverse";
      readonly managerCodeHash: string;
      readonly adapterCodeHash: string;
      readonly hookCodeHash: string;
      readonly sqrtPriceX96: bigint;
      readonly liquidity: bigint;
      readonly controller: string;
      readonly canonicalHook: string;
    };
