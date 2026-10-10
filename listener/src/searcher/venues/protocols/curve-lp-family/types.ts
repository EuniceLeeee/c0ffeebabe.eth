import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export type Direction = "mint" | "redeem";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "curve-lp"; readonly pool: string }
export interface Binding {
  readonly pool: string; readonly lp: string; readonly coins: readonly [string, string];
  readonly poolCodeHash: string; readonly lpCodeHash: string; readonly coinCodeHashes: readonly [string, string];
}
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export type Route = FamilyRouteDescriptor & { readonly direction: Direction; readonly index: 0 | 1 };
export interface State { readonly source: CanonicalSource; readonly balances: readonly [bigint, bigint];
  readonly amp: bigint; readonly fee: bigint; readonly totalSupply: bigint; readonly killed: boolean }
export interface Evidence { readonly kind: "curve-lp-exact"; readonly source: CanonicalSource; readonly binding: string; readonly routeKey: string;
  readonly executor: string; readonly amountIn: bigint; readonly amountOut: bigint }
