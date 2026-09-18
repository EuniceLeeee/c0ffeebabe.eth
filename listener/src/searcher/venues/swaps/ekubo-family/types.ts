import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
import type { EkuboPoolKey } from "../ekubo/pool-key.js";

export interface EkuboCandidate extends FamilyCandidate {
  readonly candidateKind: "ekubo-pool-key";
  readonly poolId: string;
  readonly poolKey: EkuboPoolKey;
}
export interface EkuboBinding {
  readonly poolId: string;
  readonly poolKey: EkuboPoolKey;
  readonly coreCodeHash: string;
  readonly routerCodeHash: string;
  readonly decimals: readonly [number, number];
}
export interface EkuboIdentity extends VerifiedIdentity {
  readonly facts: EkuboBinding;
}
export interface EkuboDescriptor extends CompiledInstanceDescriptor, EkuboBinding {}
export interface EkuboRoute extends FamilyRouteDescriptor {
  readonly poolId: string;
  readonly isToken1: boolean;
}
export interface EkuboPricingDescriptor {
  readonly instance: EkuboDescriptor;
  readonly route: EkuboRoute;
}
export interface EkuboPricingSnapshot {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly depthIn: bigint;
  readonly depthOut: bigint;
  readonly stateAfter: string;
}
export interface EkuboExactEvidence {
  readonly kind: "ekubo-router-exact-input";
  readonly source: CanonicalSource;
  readonly executor: string;
  readonly binding: string;
  readonly routeKey: EkuboRoute["routeKey"];
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}
