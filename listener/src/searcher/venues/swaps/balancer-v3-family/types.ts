import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export interface BalancerV3Candidate extends FamilyCandidate {
  readonly candidateKind: "balancer-v3-pool";
  readonly pool: string;
  readonly hintedTokenIn: string | null;
  readonly hintedTokenOut: string | null;
}
export interface BalancerV3Binding {
  readonly vault: string;
  readonly router: string;
  readonly permit2: string;
  readonly poolCodeHash: string;
  readonly vaultCodeHash: string;
  readonly routerCodeHash: string;
  readonly permit2CodeHash: string;
  readonly tokens: readonly string[];
  readonly tokenInfo: readonly { readonly tokenType: number; readonly rateProvider: string; readonly paysYieldFees: boolean }[];
  readonly decimals: readonly number[];
  readonly hooks: { readonly address: string; readonly flags: readonly boolean[]; readonly codeHash: string };
}
export interface BalancerV3Identity extends VerifiedIdentity {
  readonly facts: { readonly pool: string; readonly binding: BalancerV3Binding; readonly proofSource: CanonicalSource };
}
export interface BalancerV3Descriptor extends CompiledInstanceDescriptor {
  readonly pool: string;
  readonly binding: BalancerV3Binding;
  readonly proofSource: CanonicalSource;
}
export interface BalancerV3Route extends FamilyRouteDescriptor {
  readonly pool: string;
  readonly i: number;
  readonly j: number;
}
export interface BalancerV3PricingDescriptor {
  readonly instance: BalancerV3Descriptor;
  readonly route: BalancerV3Route;
}
export interface BalancerV3Snapshot {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly balanceIn: bigint;
  readonly balanceOut: bigint;
}
export interface BalancerV3ExactEvidence {
  readonly kind: "balancer-v3-router-exact-in";
  readonly source: CanonicalSource;
  readonly binding: string;
  readonly routeKey: BalancerV3Route["routeKey"];
  readonly executor: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}
