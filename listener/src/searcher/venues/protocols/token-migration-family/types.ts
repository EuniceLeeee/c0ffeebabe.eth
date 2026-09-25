import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { MigrationBinding } from "./codec.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "token-migration"; readonly target: string }
export interface Identity extends VerifiedIdentity, MigrationBinding { readonly oneToken: bigint; readonly codeHash: string }
export interface Descriptor extends CompiledInstanceDescriptor, MigrationBinding {
  readonly target: string; readonly oneToken: bigint; readonly codeHash: string;
}
export interface Route extends FamilyRouteDescriptor { readonly target: string; readonly direction: "migrate"; readonly adapterId: "token-migration" }
export interface PricingDescriptor extends Descriptor { readonly route: Route }
export interface Snapshot { readonly source: CanonicalSource; readonly halted: boolean; readonly inventory: bigint; readonly amountIn: bigint; readonly amountOut: bigint }
export interface ExactEvidence {
  readonly kind: "mantle-migration-amount-quote"; readonly source: CanonicalSource;
  readonly executor: string; readonly bindingFingerprint: string; readonly amountIn: bigint; readonly amountOut: bigint;
}
