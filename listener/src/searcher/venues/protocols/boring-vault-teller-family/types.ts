import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { FamilyId, LineageId } from "../../adapter-family-identifiers.js";

export interface BoringCandidate extends FamilyCandidate {
  readonly candidateKind: "boring-vault-withdraw";
  readonly teller: string;
}

export interface BoringIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
  readonly vaultCodeHash: string;
  readonly accountantCodeHash: string;
}

export interface BoringDescriptor extends CompiledInstanceDescriptor {
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
  readonly vaultCodeHash: string;
  readonly accountantCodeHash: string;
}

export interface BoringRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "withdraw";
  readonly adapterId: "boring-vault-withdraw";
}

export interface BoringPricingDraft {
  readonly instanceKey: string;
  readonly teller: string;
  readonly vault: string;
  readonly accountant: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly shareLockPeriod: bigint;
  readonly tellerCodeHash: string;
  readonly vaultCodeHash: string;
  readonly accountantCodeHash: string;
  readonly route: BoringRoute;
}

export type BoringPricingDescriptor = BoringPricingDraft;

export interface BoringPricingSnapshot {
  readonly source: CanonicalSource;
  readonly rate: bigint;
  readonly quotes: Readonly<Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }>>;
}

export interface BoringExactEvidence {
  readonly kind: "boring-vault-withdraw";
  readonly source: CanonicalSource;
  readonly teller: string;
  readonly vault: string;
  readonly asset: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
}

export type BoringEvidence =
  | {
      readonly phase: "base";
      readonly source: CanonicalSource;
      readonly teller: string;
      readonly vault: string;
      readonly accountant: string;
      readonly paused: boolean;
      readonly shareLockPeriod: bigint;
      readonly tellerCodeHash: string;
    }
  | {
      readonly phase: "complete";
      readonly source: CanonicalSource;
      readonly teller: string;
      readonly vault: string;
      readonly accountant: string;
      readonly asset: string;
      readonly shareDecimals: number;
      readonly paused: boolean;
      readonly shareLockPeriod: bigint;
      readonly tellerCodeHash: string;
      readonly vaultCodeHash: string;
      readonly accountantCodeHash: string;
      readonly behaviorValid: boolean;
      readonly behaviorHash: string;
    };
