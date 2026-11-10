import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { FamilyId, LineageId } from "../../adapter-family-identifiers.js";

export interface MetafactoryCandidate extends FamilyCandidate {
  readonly candidateKind: "metafactory-composter";
  readonly target: string;
  /** ROBOT amount carried by the observed compostAndRedeem call, if any. */
  readonly observedAmount: bigint;
}

export interface MetafactoryComposterEvidence {
  readonly phase: "composter";
  readonly target: string;
  readonly robotToken: string;
  readonly deadAddress: string;
  readonly paused: boolean;
  readonly activated: boolean;
  readonly totalEthAllocated: bigint;
  readonly circulatingSupply: bigint;
  readonly redemptionEndTime: bigint;
  readonly codeHash: string;
  readonly valid: boolean;
  readonly source: CanonicalSource;
}

export interface MetafactoryTokenEvidence
  extends Omit<MetafactoryComposterEvidence, "phase"> {
  readonly phase: "tokens";
  readonly oneToken: bigint;
  readonly robotCodeHash: string;
  readonly nativeAnchorCodeHash: string;
}

export type MetafactoryIdentityEvidence =
  | MetafactoryComposterEvidence
  | MetafactoryTokenEvidence;

export interface MetafactoryIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly tokenIn: string;
  readonly nativeAnchor: string;
  readonly deadAddress: string;
  readonly oneToken: bigint;
  readonly codeHash: string;
}

export interface MetafactoryDescriptor extends CompiledInstanceDescriptor {
  readonly target: string;
  readonly tokenIn: string;
  /** Graph denomination of the raw native payout (canonical WETH). */
  readonly nativeAnchor: string;
  readonly deadAddress: string;
  readonly oneToken: bigint;
  readonly codeHash: string;
}

export interface MetafactoryRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "compost-redeem";
  readonly adapterId: "metafactory-compost-redeem";
}

export interface MetafactoryPricingDescriptor extends MetafactoryDescriptor {
  readonly route: MetafactoryRoute;
}

export interface MetafactoryPricingSnapshot {
  readonly source: CanonicalSource;
  readonly totalEthAllocated: bigint;
  readonly circulatingSupply: bigint;
  readonly quotes: Readonly<Record<string, {
    readonly amountIn: bigint;
    readonly amountOut: bigint;
  }>>;
  readonly unavailable: Readonly<Record<string, string>>;
}

export interface MetafactoryExactEvidence {
  readonly kind: "metafactory-pro-rata-eth-quote";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly tokenIn: string;
  readonly nativeAnchor: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly totalEthAllocated: bigint;
  readonly circulatingSupply: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
}
