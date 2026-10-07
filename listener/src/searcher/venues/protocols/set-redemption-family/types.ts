import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "set-redemption"; readonly set: string; readonly module: string }
export interface Binding { readonly set: string; readonly module: string; readonly controller: string; readonly controllerCodeHash: string; readonly components: readonly string[] }
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export interface Route extends FamilyRouteDescriptor { readonly component: string }
export interface State { readonly source: CanonicalSource; readonly supply: bigint; readonly multiplier: bigint; readonly units: readonly bigint[]; readonly balances: readonly bigint[] }
export interface Evidence { readonly kind: "set-redemption-local-quote"; readonly source: CanonicalSource; readonly binding: string; readonly routeKey: string; readonly executor: string; readonly amountIn: bigint; readonly outputs: readonly bigint[] }
