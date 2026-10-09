import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "set-redemption"; readonly set: string; readonly module: string; readonly legacyCore?: true }
export interface LegacyBinding { readonly kind: "set-token" | "rebalancing-v3"; readonly setCodeHash: string; readonly factory: string; readonly factoryCodeHash: string; readonly vault: string }
export interface Binding { readonly set: string; readonly module: string; readonly controller: string; readonly controllerCodeHash: string; readonly components: readonly string[]; readonly legacy?: LegacyBinding }
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export interface Route extends FamilyRouteDescriptor { readonly component: string }
export interface State { readonly source: CanonicalSource; readonly supply: bigint; readonly multiplier: bigint; readonly units: readonly bigint[]; readonly balances: readonly bigint[]; readonly naturalUnit?: bigint }
export interface Evidence { readonly kind: "set-redemption-local-quote"; readonly source: CanonicalSource; readonly binding: string; readonly routeKey: string; readonly executor: string; readonly amountIn: bigint; readonly outputs: readonly bigint[] }
