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

export type UniV2CandidateSource =
  | "pair-created"
  | "pair-call"
  | "pair-swap-log"
  | "pair-sync-log"
  | "pair-surface";

export interface UniV2Candidate extends FamilyCandidate {
  readonly candidateKind: "univ2-pair";
  readonly pool: string;
  readonly sourceKind: UniV2CandidateSource;
  readonly hintedFactory: string | null;
  readonly hintedToken0: string | null;
  readonly hintedToken1: string | null;
}

export interface UniV2FeeRule {
  readonly kind: "constant-bps" | "included-in-pool-quote";
  readonly feeBps: bigint;
  readonly evidence: "measured-factory" | "standard-v2-default" | "pool-quote";
}

export type UniV2QuoteModel =
  | { readonly kind: "constant-product" }
  | {
      readonly kind: "pool-get-amount-out";
      readonly probe0: bigint;
      readonly probe1: bigint;
    };

export interface UniV2FactoryBinding {
  readonly factory: string;
  readonly reversePool: string;
}

export interface UniV2IdentityFacts {
  readonly quoteModel: UniV2QuoteModel;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly feeRule: UniV2FeeRule;
  readonly factoryBinding: UniV2FactoryBinding;
}

export interface UniV2Identity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: UniV2IdentityFacts;
}

export interface UniV2Descriptor extends CompiledInstanceDescriptor {
  readonly quoteModel: UniV2QuoteModel;
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly feeRule: UniV2FeeRule;
  readonly factoryBinding: UniV2FactoryBinding;
}

export type UniV2Direction = "zero-for-one" | "one-for-zero";

export interface UniV2Route extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly direction: UniV2Direction;
  readonly feeBps: bigint;
}

export interface UniV2PricingDescriptor {
  readonly quoteModel: UniV2QuoteModel;
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly feeRule: UniV2FeeRule;
  readonly factoryBinding: UniV2FactoryBinding;
}

export interface UniV2PricingSnapshot {
  readonly source: CanonicalSource;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly balance0: bigint;
  readonly balance1: bigint;
  readonly blockTimestampLast: number;
  readonly quoted0?: bigint;
  readonly quoted1?: bigint;
}

export interface UniV2ExactEvidence {
  readonly quoteModel: UniV2QuoteModel["kind"];
  readonly kind: "univ2-reserves-exact";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly feeBps: bigint;
  readonly inputBalance?: bigint;
  readonly maxAmountIn?: bigint;
  readonly unavailableReason?: "input-reserve-capacity";
}

export type UniV2IdentityEvidence =
  | {
      readonly phase: "pool-static";
      readonly factory: string;
      readonly token0: string;
      readonly token1: string;
    }
  | {
      readonly phase: "reverse-binding";
      readonly factory: string;
      readonly token0: string;
      readonly token1: string;
      readonly reversePool: string;
      readonly quoteSurface: "pool-get-amount-out" | "no-pool-quote-witness";
      readonly probe0: bigint;
      readonly probe1: bigint;
    };
