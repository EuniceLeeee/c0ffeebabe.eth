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
  RouteKey,
} from "../../adapter-family-identifiers.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export type AstraMultiTokenCandidateSource =
  | "observed-change-call"
  | "change-log";

export interface AstraMultiTokenCandidate extends FamilyCandidate {
  readonly candidateKind: "astra-multitoken-contract";
  readonly sourceKind: AstraMultiTokenCandidateSource;
  readonly target: string;
  readonly actor: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly observedAmountOut: bigint | null;
  readonly minAmountOut: bigint;
  readonly transactionHash: string | null;
}

export interface AstraTokenWeightBinding {
  readonly token: string;
  readonly weight: bigint;
  readonly codeHash: string;
}

export interface AstraRegistryBinding {
  readonly registryContract: string;
  readonly tokens: readonly string[];
  readonly tokenWeights: readonly AstraTokenWeightBinding[];
}

export interface AstraBehaviorBinding {
  readonly interfaceMode: "erc165" | "legacy-abi";
  readonly changesEnabled: true;
  readonly totalPercents: bigint;
  readonly changeFee: bigint;
  readonly inLendingMode: bigint | null;
  readonly activeProof: "registry-bound-effect-delta";
}

export interface AstraMultiTokenIdentityFacts {
  readonly target: string;
  readonly registryBinding: AstraRegistryBinding;
  readonly behaviorBinding: AstraBehaviorBinding;
}

export interface AstraMultiTokenIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: AstraMultiTokenIdentityFacts;
}

export interface AstraMultiTokenDescriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly registryBinding: AstraRegistryBinding;
  readonly behaviorBinding: AstraBehaviorBinding;
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

export interface AstraMultiTokenRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly pairIndex: number;
}

export interface AstraMultiTokenPricingRouteBinding {
  readonly routeKey: RouteKey;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly target: string;
}

export interface AstraMultiTokenPricingDraft {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly registryFingerprint: string;
  readonly route: AstraMultiTokenPricingRouteBinding;
}

export interface AstraMultiTokenPricingStaticEvidence {
  readonly oneToken: bigint;
}

export interface AstraMultiTokenPricingDescriptor
  extends AstraMultiTokenPricingDraft {
  readonly oneToken: bigint;
}

export interface AstraMultiTokenPricingSnapshot {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export interface AstraMultiTokenExactEvidence {
  readonly kind: "astra-multitoken-get-return";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}

export type AstraMultiTokenIdentityEvidence =
  | {
      readonly phase: "surface";
      readonly target: string;
      readonly interfaceMode: "erc165" | "legacy-abi";
      readonly tokenCount: number;
      readonly changesEnabled: true;
      readonly totalPercents: bigint;
      readonly changeFee: bigint;
      readonly inLendingMode: bigint | null;
    }
  | {
      readonly phase: "registry";
      readonly target: string;
      readonly interfaceMode: "erc165" | "legacy-abi";
      readonly tokens: readonly string[];
      readonly changesEnabled: true;
      readonly totalPercents: bigint;
      readonly changeFee: bigint;
      readonly inLendingMode: bigint | null;
    }
  | {
      readonly phase: "active-behavior";
      readonly target: string;
      readonly interfaceMode: "erc165" | "legacy-abi";
      readonly tokens: readonly string[];
      readonly tokenWeights: readonly AstraTokenWeightBinding[];
      readonly changesEnabled: true;
      readonly totalPercents: bigint;
      readonly changeFee: bigint;
      readonly inLendingMode: bigint | null;
      readonly activeAmountOut: bigint;
      readonly behaviorProofHash: string;
    };
