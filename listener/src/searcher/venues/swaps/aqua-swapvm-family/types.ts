import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Order { readonly maker: string; readonly traits: string; readonly data: string }
export interface Binding {
  readonly router: string; readonly aqua: string; readonly order: Order;
  readonly strategyHash: string; readonly tokens: readonly [string, string]; readonly codeHash: string;
}
export interface Candidate extends FamilyCandidate, Binding { readonly candidateKind: "aqua-registered-strategy" }
export interface Identity extends VerifiedIdentity { readonly facts: Binding }
export interface Descriptor extends CompiledInstanceDescriptor, Binding {}
export interface Route extends FamilyRouteDescriptor { readonly router: string; readonly i: number; readonly j: number }
export interface State {
  readonly source: CanonicalSource; readonly active: boolean; readonly balances: readonly bigint[];
  readonly capacities: readonly bigint[]; readonly decimals: readonly bigint[];
}
export interface Snapshot extends State {
  readonly points: readonly { readonly amountIn: bigint; readonly amountOut: bigint; readonly reason: string | null }[];
}
export interface Evidence {
  readonly kind: "aqua-swapvm-quote"; readonly source: CanonicalSource; readonly executor: string;
  readonly transactionOrigin: string | null; readonly binding: string; readonly routeKey: Route["routeKey"];
  readonly amountIn: bigint; readonly amountOut: bigint;
}
