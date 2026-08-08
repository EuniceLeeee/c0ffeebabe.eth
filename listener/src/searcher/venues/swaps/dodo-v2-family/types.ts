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
import type { DodoPmmState } from "../dodo-pmm-math.js";

export type DodoV2CandidateSource =
  | "sell-base-call"
  | "sell-quote-call"
  | "swap-log";

export interface DodoV2Candidate extends FamilyCandidate {
  readonly candidateKind: "dodo-v2-pool";
  readonly pool: string;
  readonly sourceKind: DodoV2CandidateSource;
  readonly hintedTokenIn: string | null;
  readonly hintedTokenOut: string | null;
}

export interface DodoV2RegistryBinding {
  readonly registry: string;
  readonly listedPool: string;
}

export interface DodoV2QuoteActorBinding {
  readonly actor: string;
  readonly role: "verified-actor";
  readonly feeSemantics: "getUserFeeRate(actor)";
  readonly querySemantics: "querySellBase/querySellQuote(actor,effectiveInput)";
  readonly inputSemantics: "balance-reserve-mt-fee-v1";
}

export interface DodoV2IdentityFacts {
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly registryBinding: DodoV2RegistryBinding;
  readonly quoteActorBinding: DodoV2QuoteActorBinding;
}

export interface DodoV2Identity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: DodoV2IdentityFacts;
}

export interface DodoV2Descriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly registryBinding: DodoV2RegistryBinding;
  readonly quoteActorBinding: DodoV2QuoteActorBinding;
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

export type DodoV2Direction = "sell-base" | "sell-quote";

export interface DodoV2Route extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly direction: DodoV2Direction;
}

export interface DodoV2PricingRouteBinding {
  readonly routeKey: DodoV2Route["routeKey"];
  readonly direction: DodoV2Direction;
  readonly tokenIn: string;
  readonly tokenOut: string;
}

export interface DodoV2PricingDraft {
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly baseToken: string;
  readonly quoteToken: string;
  readonly registryBinding: DodoV2RegistryBinding;
  readonly quoteActorBinding: DodoV2QuoteActorBinding;
  readonly routes: readonly DodoV2PricingRouteBinding[];
}

export interface DodoV2StaticEvidence {
  readonly baseOneToken: bigint;
  readonly quoteOneToken: bigint;
}

export interface DodoV2PricingDescriptor extends DodoV2PricingDraft {
  readonly baseOneToken: bigint;
  readonly quoteOneToken: bigint;
}

export interface DodoInputPosition {
  readonly surplus: bigint;
  readonly deficit: bigint;
}

export interface DodoProbeCandidate {
  readonly transferAmount: bigint;
  readonly effectiveInput: bigint;
}

export interface DodoBoundedProbePlan {
  readonly kind: "bounded-onchain-probe";
  readonly reason: string;
  readonly candidates: readonly DodoProbeCandidate[];
}

export interface DodoProvablyUnavailable {
  readonly kind: "provably-unavailable";
  readonly reason: string;
}

export interface DodoProbeQuote {
  readonly transferAmount: bigint;
  readonly effectiveInput: bigint;
  readonly amountOut: bigint;
}

export interface DodoV2CurrentCore {
  readonly source: CanonicalSource;
  readonly pmm: DodoPmmState;
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
}

export interface DodoV2PricingSnapshot {
  readonly source: CanonicalSource;
  readonly pmm: DodoPmmState;
  readonly lpFeeRate: bigint;
  readonly mtFeeRate: bigint;
  readonly baseInput: DodoInputPosition;
  readonly quoteInput: DodoInputPosition;
  readonly quotes: ReadonlyMap<string, {
    readonly amountIn: bigint;
    readonly amountOut: bigint;
  }>;
  readonly unavailable: ReadonlyMap<string, string>;
}

export interface DodoV2ExactEvidence {
  readonly kind: "dodo-v2-actor-bound-query";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly actor: string;
  readonly direction: DodoV2Direction;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly effectiveInput: bigint;
  readonly amountOut: bigint;
  readonly quotePath:
    | "zero-input"
    | "actor-query"
    | "pmm-derived-after-input-adjustment";
}

export type DodoV2IdentityEvidence =
  | {
      readonly phase: "pool-behavior";
      readonly registry: string;
      readonly pool: string;
      readonly baseToken: string;
      readonly quoteToken: string;
      readonly behaviorProofHash: string;
    }
  | {
      readonly phase: "registry-binding";
      readonly registry: string;
      readonly pool: string;
      readonly baseToken: string;
      readonly quoteToken: string;
      readonly listedPools: readonly string[];
      readonly behaviorProofHash: string;
    };
