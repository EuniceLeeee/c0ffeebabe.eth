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

export interface FluidCreditCandidate extends FamilyCandidate {
  readonly candidateKind: "fluid-credit-vault";
  readonly vault: string;
  readonly sourceKind: "operate-call" | "address-surface";
}

export interface FluidCreditFactoryBinding {
  readonly factory: string;
  readonly vaultId: bigint;
  readonly reverseVault: string;
}

export interface FluidCreditIdentityFacts {
  readonly vault: string;
  readonly supplyToken: string;
  readonly borrowToken: string;
  readonly supplyDecimals: number;
  readonly borrowDecimals: number;
  readonly factoryBinding: FluidCreditFactoryBinding;
  readonly activeProbeActor: string;
}

export interface FluidCreditIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly facts: FluidCreditIdentityFacts;
}

export interface FluidCreditDescriptor extends CompiledInstanceDescriptor {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly supplyToken: string;
  readonly borrowToken: string;
  readonly supplyDecimals: number;
  readonly borrowDecimals: number;
  readonly factoryBinding: FluidCreditFactoryBinding;
  readonly runtimeRequirements: readonly RuntimeRequirement[];
}

export interface FluidCreditRoute extends FamilyRouteDescriptor {
  readonly vault: string;
  readonly lifecycle: "standing-position";
}

export interface FluidCreditRiskEvidence {
  readonly kind: "fluid-credit-effect-delta-risk-proof";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly routeKey: FluidCreditRoute["routeKey"];
  readonly executor: string;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly debtAmount: bigint;
  readonly nftId: bigint;
  readonly finalSupply: bigint;
  readonly finalBorrow: bigint;
  readonly collateralDelta: bigint;
  readonly debtDelta: bigint;
}

export type FluidCreditIdentityEvidence =
  | {
      readonly phase: "constants";
      readonly vault: string;
      readonly factory: string;
      readonly supplyToken: string;
      readonly borrowToken: string;
      readonly supplyDecimals: number;
      readonly borrowDecimals: number;
      readonly vaultId: bigint;
      readonly vaultHasCode: boolean;
    }
  | {
      readonly phase: "reverse-binding";
      readonly constants: Extract<
        FluidCreditIdentityEvidence,
        { readonly phase: "constants" }
      >;
      readonly reverseVault: string;
      readonly supplyTokenHasCode: boolean;
      readonly borrowTokenHasCode: boolean;
    }
  | {
      readonly phase: "active-behavior";
      readonly binding: Extract<
        FluidCreditIdentityEvidence,
        { readonly phase: "reverse-binding" }
      >;
      readonly actor: string;
      readonly collateralAmount: bigint;
      readonly debtAmount: bigint;
      readonly active: boolean;
    };
