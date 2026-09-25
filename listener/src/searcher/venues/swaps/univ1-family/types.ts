import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "univ1-exchange"; readonly pool: string }
export interface Binding {
  readonly pool: string; readonly token: string; readonly factory: string; readonly issuer: string;
  readonly implementation: string; readonly codeHash: string; readonly implementationCodeHash: string;
  readonly factoryCodeHash: string; readonly decimals: number; readonly model: string;
}
export interface Identity extends VerifiedIdentity { readonly facts: Binding }
export interface Descriptor extends CompiledInstanceDescriptor, Binding {}
export interface Route extends FamilyRouteDescriptor { readonly buy: boolean; readonly pool: string }
export interface PricingDescriptor { readonly instance: Descriptor }
export interface State { readonly source: CanonicalSource; readonly nativeReserve: bigint; readonly tokenReserve: bigint }
export interface Evidence {
  readonly kind: "univ1-execution-math"; readonly source: CanonicalSource; readonly executor: string;
  readonly binding: string; readonly routeKey: Route["routeKey"]; readonly amountIn: bigint; readonly amountOut: bigint;
}
