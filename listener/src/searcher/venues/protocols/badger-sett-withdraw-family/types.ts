import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "badger-sett-withdraw"; readonly vault: string }
export interface RootBinding { readonly vault: string; readonly vaultImplementation: string; readonly vaultAdmin: string; readonly asset: string; readonly strategy: string }
export interface Binding extends RootBinding { readonly strategyImplementation: string; readonly strategyAdmin: string; readonly locker: string }
export type Identity = VerifiedIdentity & { readonly binding: Binding };
export type Descriptor = CompiledInstanceDescriptor & Binding;
export type Route = FamilyRouteDescriptor;
export interface State {
  readonly source: CanonicalSource; readonly binding: Binding;
  readonly supply: bigint; readonly vaultIdle: bigint; readonly strategyIdle: bigint; readonly locked: bigint;
  readonly feeBps: bigint; readonly treasury: string;
  readonly vaultPaused: boolean; readonly strategyPaused: boolean; readonly safetyCheck: boolean;
  readonly deviationBps: bigint;
}
export interface Evidence {
  readonly kind: "badger-sett-liquid-local"; readonly source: CanonicalSource;
  readonly fingerprint: string; readonly routeKey: string; readonly executor: string;
  readonly amountIn: bigint; readonly amountOut: bigint;
}
