import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "yearn-auction"; readonly target: string; readonly sold: string }
export interface Binding {
  readonly target: string; readonly implementation: string; readonly implementationCodeHash: string; readonly cloneCodeHash: string;
  readonly want: string; readonly sold: string; readonly wantDecimals: number; readonly soldDecimals: number;
  readonly wantCodeHash: string; readonly soldCodeHash: string;
}
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export type Route = FamilyRouteDescriptor & { readonly direction: "take" };
export interface State { readonly source: CanonicalSource; readonly receiver: string; readonly rawPrice: bigint; readonly available: bigint }
export interface Evidence {
  readonly kind: "yearn-auction-budget"; readonly source: CanonicalSource; readonly fingerprint: string; readonly routeKey: string;
  readonly executor: string; readonly amountIn: bigint; readonly amountOut: bigint; readonly spent: bigint; readonly state: State;
}
