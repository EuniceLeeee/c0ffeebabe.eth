import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "balancer-v1-pool"; readonly pool: string }
export interface Binding {
  readonly pool: string; readonly factory: string; readonly model: string;
  readonly poolCodeHash: string; readonly factoryCodeHash: string;
  readonly tokens: readonly string[]; readonly weights: readonly bigint[]; readonly swapFee: bigint;
}
export interface Identity extends VerifiedIdentity { readonly facts: Binding }
export interface Descriptor extends CompiledInstanceDescriptor, Binding {}
export interface Route extends FamilyRouteDescriptor { readonly pool: string; readonly i: number; readonly j: number }
export interface PricingDescriptor { readonly instance: Descriptor }
export interface State { readonly source: CanonicalSource; readonly balances: readonly bigint[] }
export interface Evidence {
  readonly kind: "balancer-v1-chain-exact-in"; readonly source: CanonicalSource; readonly executor: string;
  readonly binding: string; readonly routeKey: Route["routeKey"]; readonly amountIn: bigint; readonly amountOut: bigint;
}
