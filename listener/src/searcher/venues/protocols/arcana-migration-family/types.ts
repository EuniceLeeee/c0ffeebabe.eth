import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type { FamilyId, InstanceKey, LineageId } from "../../adapter-family-identifiers.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { ProtocolPricingSnapshot } from "../standard-family/common.js";

export interface ArcanaCandidate extends FamilyCandidate {
  readonly candidateKind: "arcana-migration";
  readonly source: string;
  readonly tokenId: string;
}

export interface ArcanaIdentity extends VerifiedIdentity {
  readonly familyId: FamilyId;
  readonly lineageId: LineageId;
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly proxyCodeHash: string;
}

export interface ArcanaDescriptor extends CompiledInstanceDescriptor {
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly proxyCodeHash: string;
}

export interface ArcanaRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: "migrate-to-arc";
  readonly adapterId: "arcana-migration";
}

export interface ArcanaPricingDraft {
  readonly instanceKey: InstanceKey;
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly route: ArcanaRoute;
}

export interface ArcanaPricingDescriptor extends ArcanaPricingDraft {
  readonly oldTokenDecimals: number;
  readonly arcTokenDecimals: number;
}

export interface ArcanaPricingSnapshot extends ProtocolPricingSnapshot {}

export interface ArcanaExactEvidence {
  readonly kind: "arcana-migration-preview";
  readonly source: CanonicalSource;
  readonly sourceContract: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly executor: string;
  readonly bindingFingerprint: string;
}

export interface ArcanaBaseEvidence {
  readonly phase: "base";
  readonly source: string;
  readonly destination: string;
  readonly oldToken: string;
  readonly arcToken: string;
  readonly tokenId: string;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
  readonly proxyCodeHash: string;
}

export type ArcanaIdentityEvidence =
  | ArcanaBaseEvidence
  | ({ readonly phase: "active"; readonly behaviorValid: boolean; readonly behaviorProofHash: string } & Omit<ArcanaBaseEvidence, "phase">);
