import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface BalancerV2Candidate extends FamilyCandidate {
  readonly candidateKind: "balancer-v2-pool";
  readonly pool: string;
  readonly poolId: string;
  readonly hintedTokenIn: string | null;
  readonly hintedTokenOut: string | null;
}
export interface BalancerV2Binding {
  readonly vault: string;
  readonly specialization: number;
  readonly poolCodeHash: string;
  readonly vaultCodeHash: string;
  readonly tokens: readonly string[];
  readonly decimals: readonly number[];
}
export interface BalancerV2Identity extends VerifiedIdentity {
  readonly facts: { readonly pool: string; readonly poolId: string; readonly binding: BalancerV2Binding; readonly proofSource: CanonicalSource };
}
export interface BalancerV2Descriptor extends CompiledInstanceDescriptor {
  readonly pool: string; readonly poolId: string;
  readonly binding: BalancerV2Binding; readonly proofSource: CanonicalSource;
}
export interface BalancerV2Route extends FamilyRouteDescriptor {
  readonly pool: string; readonly poolId: string; readonly i: number; readonly j: number;
}
export interface BalancerV2PricingDescriptor { readonly instance: BalancerV2Descriptor; readonly route: BalancerV2Route }
export interface BalancerV2Snapshot {
  readonly source: CanonicalSource; readonly amountIn: bigint; readonly amountOut: bigint;
  readonly balanceIn: bigint; readonly balanceOut: bigint;
}
export interface BalancerV2ExactEvidence {
  readonly kind: "balancer-v2-vault-exact-in"; readonly source: CanonicalSource;
  readonly binding: string; readonly routeKey: BalancerV2Route["routeKey"]; readonly executor: string;
  readonly amountIn: bigint; readonly amountOut: bigint;
}
