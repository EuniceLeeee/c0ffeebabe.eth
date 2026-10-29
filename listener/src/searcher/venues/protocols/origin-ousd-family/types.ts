import { ethers } from "ethers";
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

export interface OriginOusdCandidate extends FamilyCandidate {
  readonly candidateKind: "origin-ousd-vault";
  readonly target: string;
}

export interface OriginOusdIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly asset: string;
  readonly implementation: string;
  readonly proxyCodeHash: string;
  readonly implementationCodeHash: string;
  readonly tokenCodeHash: string;
}

export interface OriginOusdDescriptor extends CompiledInstanceDescriptor {
  /** Vault proxy address (call target). */
  readonly target: string;
  /** USDC, proved by vault.asset(). */
  readonly asset: string;
  /** OUSD token, bound by fixed constant + pinned runtime code hash. */
  readonly token: string;
  readonly decimalScale: bigint;
  readonly implementation: string;
  readonly proxyCodeHash: string;
  readonly implementationCodeHash: string;
  readonly tokenCodeHash: string;
}

export interface OriginOusdRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "mint-usdc-to-ousd";
  readonly adapterId: "origin-ousd-mint";
}

export interface OriginOusdPricingDescriptor {
  readonly instanceKey: InstanceKey;
  readonly target: string;
  readonly asset: string;
  readonly token: string;
  readonly decimalScale: bigint;
  readonly route: OriginOusdRoute;
}

interface OriginOusdIdentityBase {
  readonly source: CanonicalSource;
  readonly proxyCodeHash: string;
  readonly implementation: string;
  readonly tokenCodeHash: string;
}

export type OriginOusdIdentityEvidence =
  | ({ readonly phase: "proxy" } & OriginOusdIdentityBase)
  | ({
      readonly phase: "binding";
      readonly implementationCodeHash: string;
      readonly asset: string;
    } & OriginOusdIdentityBase)
  | ({
      readonly phase: "verified";
      readonly implementationCodeHash: string;
      readonly asset: string;
      readonly behaviorValid: boolean;
      readonly behaviorProofHash: string;
    } & OriginOusdIdentityBase);

export interface OriginOusdExactEvidence {
  readonly kind: "origin-ousd-1to1-mint";
  readonly source: CanonicalSource;
  readonly target: string;
  readonly asset: string;
  readonly token: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly decimalScale: bigint;
  readonly bindingFingerprint: string;
}
