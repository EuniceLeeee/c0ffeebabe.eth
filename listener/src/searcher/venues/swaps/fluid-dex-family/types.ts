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

export interface FluidDexCandidate extends FamilyCandidate {
  readonly candidateKind: "fluid-dex";
  readonly pool: string;
  readonly sourceKind: "swap-call" | "swap-log" | "address-surface";
}

export interface FluidDexFactoryBinding {
  readonly factory: string;
  readonly dexId: bigint;
  readonly reverseDex: string;
}

export interface FluidDexQuoteBinding {
  readonly target: string;
  readonly recipient: string;
  readonly completion: "return-or-revert-data";
  readonly successEncoding: "FluidDexSwapResult(uint256)-revert";
}

export interface FluidDexIdentityFacts {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly factoryBinding: FluidDexFactoryBinding;
  readonly quoteBinding: FluidDexQuoteBinding;
}

export interface FluidDexIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: FluidDexIdentityFacts;
}

export interface FluidDexDescriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly factoryBinding: FluidDexFactoryBinding;
  readonly quoteBinding: FluidDexQuoteBinding;
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

export interface FluidDexRoute extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly swap0To1: boolean;
}

export interface FluidDexPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly quoteBinding: FluidDexQuoteBinding;
  readonly route: FluidDexRoute;
}

export interface FluidDexPricingSnapshot {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly completion: "reverted-as-declared";
}

export interface FluidDexExactEvidence {
  readonly kind: "fluid-dex-declared-revert-quote";
  readonly source: CanonicalSource;
  readonly pool: string;
  readonly routeKey: FluidDexRoute["routeKey"];
  readonly swap0To1: boolean;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly completion: "reverted-as-declared" | "local-zero";
}

export type FluidDexIdentityEvidence =
  | {
      readonly phase: "constants";
      readonly pool: string;
      readonly dexId: bigint;
      readonly factory: string;
      readonly token0: string;
      readonly token1: string;
    }
  | {
      readonly phase: "reverse-binding";
      readonly pool: string;
      readonly dexId: bigint;
      readonly factory: string;
      readonly token0: string;
      readonly token1: string;
      readonly token0Decimals: number;
      readonly token1Decimals: number;
      readonly reverseDex: string;
      readonly poolHasCode: boolean;
      readonly token0HasCode: boolean;
      readonly token1HasCode: boolean;
    }
  | {
      readonly phase: "active-behavior";
      readonly binding: Extract<
        FluidDexIdentityEvidence,
        { readonly phase: "reverse-binding" }
      >;
      readonly zeroToOneAmountOut: bigint | null;
      readonly oneToZeroAmountOut: bigint | null;
    };
