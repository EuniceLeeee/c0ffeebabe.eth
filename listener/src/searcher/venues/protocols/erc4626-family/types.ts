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

export interface Erc4626Candidate extends FamilyCandidate {
  readonly candidateKind: "erc4626-vault";
  readonly vault: string;
}

export interface Erc4626BaseEvidence {
  readonly phase: "base";
  readonly vault: string;
  readonly vaultCodeHash: string;
  readonly asset: string;
  readonly assetCodeHash: string;
  readonly totalAssets: bigint;
  readonly totalSupply: bigint;
  readonly sampleAssets: bigint;
  readonly sampleShares: bigint;
  readonly previewDeposit: bigint;
  readonly previewRedeem: bigint;
  readonly baseValid: boolean;
}

export interface Erc4626ActiveEvidence
  extends Omit<Erc4626BaseEvidence, "phase"> {
  readonly phase: "active";
  readonly depositVerified: boolean;
  readonly redeemVerified: boolean;
  readonly behaviorProofHash: string;
}

export type Erc4626IdentityEvidence =
  | Erc4626BaseEvidence
  | Erc4626ActiveEvidence;

export interface Erc4626Identity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly asset: string;
  readonly verifiedDirections: {
    readonly deposit: boolean;
    readonly redeem: boolean;
  };
}

export interface Erc4626Descriptor extends CompiledInstanceDescriptor {
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly verifiedDirections: Erc4626Identity["verifiedDirections"];
}

export interface Erc4626Route extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "deposit" | "redeem";
  readonly adapterId: "erc4626-deposit" | "erc4626-redeem";
}

export interface Erc4626PricingDraft {
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly routes: readonly Erc4626Route[];
}

export interface Erc4626PricingDescriptor extends Erc4626PricingDraft {
  readonly oneAsset: bigint;
  readonly oneShare: bigint;
}

export interface Erc4626ExactEvidence {
  readonly kind: "erc4626-preview";
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly direction: Erc4626Route["direction"];
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}
