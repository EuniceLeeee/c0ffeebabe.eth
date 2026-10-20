import type { GenericBinding } from "./generic.js";
import type { ZapShape } from "./zap.js";
import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export type Direction = "mint" | "redeem";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "curve-lp"; readonly pool: string }
export interface Binding {
  readonly zap?: ZapShape;
  readonly generic?: GenericBinding;
  readonly pool: string; readonly lp: string; readonly coins: readonly string[];
  readonly ng?: { readonly model: string; readonly array: "dynamic" | "fixed2"; readonly external: readonly { readonly address: string; readonly codeHash: string }[]; readonly decimals: readonly number[]; readonly registryHandler: string; readonly factory: string; readonly factoryCodeHash: string; readonly views: string; readonly viewsCodeHash: string;
    readonly directions: readonly { readonly direction: Direction; readonly index: number; readonly directOutput: boolean }[] };
  readonly poolCodeHash: string; readonly lpCodeHash: string; readonly coinCodeHashes: readonly string[];
}
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export type Route = FamilyRouteDescriptor & { readonly direction: Direction; readonly index: number };
export interface State { readonly source: CanonicalSource; readonly balances: readonly bigint[];
  readonly amp: bigint; readonly fee: bigint; readonly totalSupply: bigint; readonly killed: boolean }
export interface Evidence { readonly kind: "curve-lp-exact"; readonly source: CanonicalSource; readonly binding: string; readonly routeKey: string;
  readonly executor: string; readonly amountIn: bigint; readonly amountOut: bigint }
