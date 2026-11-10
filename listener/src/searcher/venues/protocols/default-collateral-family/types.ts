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

export interface DefaultCollateralCandidate extends FamilyCandidate {
  readonly candidateKind: "default-collateral-share-vault";
  readonly vault: string;
}

interface DefaultCollateralBaseFacts {
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly shareCodeHash: string;
  readonly implementation: string;
  readonly asset: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
  readonly totalSupply: bigint;
}

export interface DefaultCollateralBaseEvidence
  extends DefaultCollateralBaseFacts {
  readonly phase: "base";
  readonly shareIsClone: boolean;
  readonly baseValid: boolean;
  readonly evidenceRequestIds?: readonly string[];
}

export interface DefaultCollateralSurfaceEvidence
  extends DefaultCollateralBaseFacts {
  readonly phase: "surface";
  readonly implementationCodeHash: string;
  readonly backing: bigint;
  readonly surfaceValid: boolean;
  readonly invariantProven: boolean;
  readonly evidenceRequestIds?: readonly string[];
}

export interface DefaultCollateralActiveEvidence
  extends Omit<DefaultCollateralSurfaceEvidence, "phase"> {
  readonly phase: "active";
  readonly sampleShares: bigint;
  readonly shareBurn: bigint;
  readonly assetReceipt: bigint;
  readonly supplyBurn: bigint;
  readonly behaviorValid: boolean;
  readonly behaviorProofHash: string;
}

export type DefaultCollateralIdentityEvidence =
  | DefaultCollateralBaseEvidence
  | DefaultCollateralSurfaceEvidence
  | DefaultCollateralActiveEvidence;

export interface DefaultCollateralIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly implementation: string;
  readonly shareCodeHash: string;
  readonly implementationCodeHash: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
  /** True only when the same-state proof and the read backing/supply pair both
   * prove the 1:1 redeem rate. */
  readonly oneToOne: boolean;
}

export interface DefaultCollateralDescriptor
  extends CompiledInstanceDescriptor {
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly implementation: string;
  readonly shareCodeHash: string;
  readonly implementationCodeHash: string;
  readonly assetCodeHash: string;
  readonly decimals: bigint;
}

export interface DefaultCollateralRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly adapterId: "default-collateral-withdraw";
}

export interface DefaultCollateralPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly implementation: string;
  readonly routes: readonly DefaultCollateralRoute[];
}

export interface DefaultCollateralPricingSnapshot {
  readonly source: CanonicalSource;
  readonly totalSupply: bigint;
  readonly backing: bigint;
  readonly feeBps: bigint;
  readonly quotes: Readonly<
    Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }>
  >;
  readonly unavailable: Readonly<Record<string, string>>;
}

export interface DefaultCollateralExactEvidence {
  readonly kind: "default-collateral-one-to-one";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly share: string;
  readonly asset: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly totalSupply: bigint;
  readonly backing: bigint;
  readonly feeBps: bigint;
  readonly bindingFingerprint: string;
}
