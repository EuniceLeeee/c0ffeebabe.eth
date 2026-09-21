import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export type EllaDirection = "buy-token" | "sell-token";
export interface EllaCandidate extends FamilyCandidate {
  readonly candidateKind: "ella-exchange";
  readonly pool: string;
}
export interface EllaBinding {
  readonly pool: string;
  readonly token: string;
  readonly factory: string;
  readonly oracle: string;
  readonly aggregator: string;
  readonly decimals: number;
  readonly codeHash: string;
  readonly factoryCodeHash: string;
}
export interface EllaIdentity extends VerifiedIdentity { readonly facts: EllaBinding }
export interface EllaDescriptor extends CompiledInstanceDescriptor, EllaBinding {}
export interface EllaRoute extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly direction: EllaDirection;
}
export interface EllaPricingDescriptor { readonly instance: EllaDescriptor }
export interface EllaState {
  readonly source: CanonicalSource;
  readonly price: bigint;
  readonly fee: bigint;
  readonly systemCut: bigint;
  readonly feesAddress: string;
  readonly tokenBalance: bigint;
  readonly nativeBalance: bigint;
  readonly baseFeesGenerated: bigint;
  readonly feesGenerated: bigint;
}
export interface EllaEvidence {
  readonly kind: "ella-source-math";
  readonly source: CanonicalSource;
  readonly binding: string;
  readonly routeKey: EllaRoute["routeKey"];
  readonly executor: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly unavailableReason?: string;
}
