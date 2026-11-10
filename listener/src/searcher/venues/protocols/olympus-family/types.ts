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

export interface OlympusCandidate extends FamilyCandidate {
  readonly candidateKind: "olympus-staking";
  readonly target: string;
}

export interface OlympusIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly gOHM: string;
  readonly OHM: string;
  readonly gOhmDecimals: bigint;
  readonly ohmDecimals: bigint;
}

export interface OlympusDescriptor extends CompiledInstanceDescriptor {
  readonly staking: string;
  readonly gOHM: string;
  readonly OHM: string;
  readonly gOhmDecimals: bigint;
  readonly ohmDecimals: bigint;
}

export interface OlympusRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "unstake";
  readonly adapterId: "olympus-unstake";
}

export interface OlympusPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly staking: string;
  readonly gOHM: string;
  readonly OHM: string;
  readonly route: OlympusRoute;
}

export interface OlympusPricingSnapshot {
  readonly source: CanonicalSource;
  readonly index: bigint;
  readonly quotes: Readonly<
    Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }>
  >;
}

export interface OlympusIdentityEvidence {
  readonly phase: "surface" | "complete";
  readonly source: CanonicalSource;
  readonly staking: string;
  readonly stakingCodeHash: string;
  readonly gOHM: string;
  readonly OHM: string;
  readonly gOhmCodeHash?: string;
  readonly ohmCodeHash?: string;
  readonly gOhmDecimals?: bigint;
  readonly ohmDecimals?: bigint;
}

export interface OlympusExactEvidence {
  readonly kind: "olympus-index-unstake";
  readonly source: CanonicalSource;
  readonly staking: string;
  readonly gOHM: string;
  readonly OHM: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Raw `staking.index()` value; 9-decimal OHM-per-gOHM exchange rate. */
  readonly index: bigint;
  readonly bindingFingerprint: string;
}
