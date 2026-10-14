import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate {
  readonly candidateKind: "vault-spot-pair";
  readonly vault: string;
  readonly tokens: readonly [string, string];
}
export interface Binding { readonly vault: string; readonly tokens: readonly [string, string]; readonly codeHash: string }
export interface Identity extends VerifiedIdentity { readonly facts: Binding }
export interface Descriptor extends CompiledInstanceDescriptor, Binding {}
export interface Route extends FamilyRouteDescriptor { readonly vault: string; readonly i: number; readonly j: number }
export interface RootState {
  readonly source: CanonicalSource;
  readonly router: string; readonly usdg: string; readonly utils: string; readonly priceFeed: string;
  readonly includeAmmPrice: boolean; readonly active: boolean;
  readonly decimals: readonly bigint[];
}
export interface Snapshot extends RootState {
  readonly pool: readonly bigint[]; readonly available: readonly bigint[];
  readonly minPrices: readonly bigint[]; readonly maxPrices: readonly bigint[];
  readonly fees: readonly bigint[];
}
export interface Evidence {
  readonly kind: "vault-spot-execution"; readonly source: CanonicalSource; readonly executor: string;
  readonly binding: string; readonly routeKey: Route["routeKey"];
  readonly amountIn: bigint; readonly amountOut: bigint;
}
