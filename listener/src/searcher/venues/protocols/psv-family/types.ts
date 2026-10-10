import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "psv"; readonly target: string }
export interface Binding {
  readonly target: string; readonly implementation: string; readonly implementationCodeHash: string; readonly proxyCodeHash: string;
  readonly gem: string; readonly stable: string; readonly gemDecimals: number; readonly stableDecimals: number;
  readonly gemCodeHash: string; readonly stableCodeHash: string;
}
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export type Direction = "sell-gem" | "buy-gem";
export type Route = FamilyRouteDescriptor & { readonly direction: Direction };
export interface State {
  readonly source: CanonicalSource; readonly paused: boolean; readonly tin: bigint; readonly tout: bigint; readonly treasury: string;
  readonly maxPerTransaction: bigint; readonly maxPerBlock: bigint; readonly remaining: bigint;
  readonly gemReserve: bigint; readonly stableReserve: bigint;
}
export interface Evidence {
  readonly kind: "psv-recipient-preview"; readonly source: CanonicalSource; readonly fingerprint: string; readonly routeKey: string;
  readonly executor: string; readonly amountIn: bigint; readonly amountOut: bigint;
}
