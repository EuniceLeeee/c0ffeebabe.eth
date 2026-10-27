// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 84eead1549c41c9bd4d465c68adbd06dfd579bb8b1bf6606bb2f56551b028cd3
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type CustodianBinding = {
  readonly proofSource: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly proxyAdmin: string;
  readonly implementation: string;
  readonly share: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly assetDecimals: number;
  readonly shareCodeHash: string;
  readonly assetCodeHash: string;
};

export type CustodianSurface = {
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly proxyCodeHash: string;
  readonly proxyAdmin: string;
  readonly implementation: string;
  readonly share: string;
  readonly asset: string;
  readonly shareDecimals: number;
  readonly assetDecimals: number;
  readonly inventory: bigint;
  readonly capacity: bigint;
  readonly depositCapacity: bigint;
  readonly mintCapacity: bigint;
};

export type Erc4626ActiveEvidence = Erc4626EvidenceFields & {
  readonly phase: "active";
  readonly erc20SurfacesValid: boolean;
  readonly depositVerified: boolean;
  readonly redeemVerified: boolean;
  readonly behaviorProofHash: string;
  readonly depositRetry?: {
    readonly amount: bigint;
    readonly preview: bigint;
    readonly source: CanonicalSource;
  };
  readonly depositRetryCompleted?: boolean;
};

export type Erc4626BaseEvidence = Erc4626EvidenceFields & {
  readonly phase: "base";
};

export type Erc4626Candidate = FamilyCandidate & {
  readonly candidateKind: "erc4626-vault";
  readonly vault: string;
};

export type Erc4626Descriptor = CompiledInstanceDescriptor & {
  readonly infinifi?: InfiniFiBinding;
  readonly custodian?: CustodianBinding;
  readonly vault: string;
  readonly asset: string;
  readonly share: string;
  readonly verifiedDirections: Erc4626VerifiedDirections;
};

export type Erc4626EvidenceFields = {
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
  readonly alternateDepositSample?: {
    readonly amount: bigint;
    readonly preview: bigint;
  };
  readonly baseValid: boolean;
  readonly evidenceRequestIds?: ReadonlyArray<string>;
  readonly custodianCheck?: ("slot") | ("code");
  readonly custodianImplementation?: string;
  readonly custodianCheckSource?: CanonicalSource;
  readonly stakedUsdatCheck?: Erc4626ImplementationExclusionEvidence;
};

export type Erc4626ExactEvidence = {
  readonly kind: ("erc4626-preview") | ("frax-custodian-preview") | ("infinifi-gateway-preview");
  readonly executor?: string;
  readonly source: CanonicalSource;
  readonly vault: string;
  readonly direction: ("deposit") | ("redeem");
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
};

export type Erc4626Identity = VerifiedIdentity & {
  readonly infinifi?: InfiniFiBinding;
  readonly custodian?: CustodianBinding;
  readonly asset: string;
  readonly verifiedDirections: Erc4626VerifiedDirections;
};

export type Erc4626IdentityEvidence = (Erc4626BaseEvidence) | (Erc4626ActiveEvidence);

export type Erc4626ImplementationExclusionEvidence = {
  readonly source: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly implementation?: string;
  readonly implementationMatched?: true;
};

export type Erc4626PricingDescriptor = Erc4626PricingDraft & Erc4626PricingStatic & {

};

export type Erc4626PricingDraft = {
  readonly infinifi?: InfiniFiBinding;
  readonly custodian?: CustodianBinding;
  readonly instanceKey: InstanceKey;
  readonly vault: string;
  readonly routes: ReadonlyArray<Erc4626Route>;
};

export type Erc4626PricingStatic = {
  readonly oneAsset: bigint;
  readonly oneShare: bigint;
};

export type Erc4626Route = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: ("deposit") | ("redeem");
  readonly adapterId: ("erc4626-deposit") | ("erc4626-redeem");
};

export type Erc4626VerifiedDirections = {
  readonly deposit: boolean;
  readonly redeem: boolean;
};

export type InfiniFiBinding = InfiniFiSurface & {
  readonly yieldSharingImplementation: string;
  readonly assetDecimals: number;
  readonly codeHashes: {
    readonly asset: string;
    readonly core: string;
    readonly yieldSharing: string;
    readonly gatewayImplementation: string;
    readonly yieldSharingImplementation: string;
    readonly multicall: string;
  };
};

export type InfiniFiSurface = {
  readonly proofSource: CanonicalSource;
  readonly vault: string;
  readonly asset: string;
  readonly gateway: string;
  readonly core: string;
  readonly yieldSharing: string;
  readonly gatewayImplementation: string;
  readonly shareDecimals: number;
  readonly vaultCodeHash: string;
  readonly gatewayCodeHash: string;
};

export type FamilyTypes = {
  readonly candidate: Erc4626Candidate;
  readonly identityEvidence: Erc4626IdentityEvidence;
  readonly identity: Erc4626Identity;
  readonly descriptor: Erc4626Descriptor;
  readonly route: Erc4626Route;
  readonly pricingDraft: Erc4626PricingDraft;
  readonly pricingDescriptor: Erc4626PricingDescriptor;
  readonly pricingStatic: Erc4626PricingStatic;
  readonly exactEvidence: Erc4626ExactEvidence;
};
