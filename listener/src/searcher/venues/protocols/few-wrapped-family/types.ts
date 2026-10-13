import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export type Direction = "wrap" | "unwrap";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "few-wrapper"; readonly target: string; }
export interface Binding {
  readonly target: string; readonly asset: string; readonly factory: string;
  readonly codeHash: string; readonly assetCodeHash: string; readonly factoryCodeHash: string;
}
export type Identity = VerifiedIdentity & Binding;
export type Descriptor = CompiledInstanceDescriptor & Binding;
export interface Route extends FamilyRouteDescriptor {
  readonly target: string; readonly direction: Direction; readonly adapterId: "few-wrap" | "few-unwrap";
}
export type PricingDescriptor = Descriptor & { readonly routes: readonly Route[] };
export interface Snapshot {
  readonly source: CanonicalSource;
  readonly quotes: Readonly<Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }>>;
}
export interface Evidence {
  readonly kind: "few-execution-receipt"; readonly source: CanonicalSource; readonly executor: string;
  readonly direction: Direction; readonly amountIn: bigint; readonly amountOut: bigint; readonly bindingFingerprint: string;
}
