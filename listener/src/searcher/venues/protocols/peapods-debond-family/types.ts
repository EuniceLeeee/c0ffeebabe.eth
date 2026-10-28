import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "peapods-debond"; readonly pod: string }
export interface Binding {
  readonly pod: string; readonly asset: string; readonly codeHash: string; readonly assetCodeHash: string;
  readonly staking: string; readonly stakingCodeHash: string; readonly decimals: number; readonly feeBps: bigint;
}
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export type Route = FamilyRouteDescriptor;
export interface State { readonly source: CanonicalSource; readonly supply: bigint; readonly backing: bigint; readonly feeBps: bigint }
export interface Evidence {
  readonly kind: "peapods-weighted-local"; readonly source: CanonicalSource; readonly fingerprint: string;
  readonly routeKey: string; readonly executor: string; readonly amountIn: bigint; readonly amountOut: bigint;
}
