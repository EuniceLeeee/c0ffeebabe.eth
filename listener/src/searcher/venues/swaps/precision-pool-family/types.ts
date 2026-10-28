import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "precision-pool"; readonly pool: string }
export interface Market {
  readonly token0: string; readonly token1: string; readonly sqrtPLow: bigint; readonly sqrtPHigh: bigint;
  readonly fee: bigint; readonly hook: string; readonly feeRecipient: string; readonly creatorFeeBps: bigint;
}
export interface PoolBinding extends Market { readonly factory: string }
export interface FactoryBinding { readonly trustedExecutor: string; readonly poolCode: string; readonly poolInitCodeHash: string }
export interface Binding extends PoolBinding, FactoryBinding {
  readonly pool: string; readonly codeHash: string; readonly factoryCodeHash: string;
}
export interface Identity extends VerifiedIdentity { readonly facts: Binding }
export interface Descriptor extends CompiledInstanceDescriptor, Binding {}
export interface Route extends FamilyRouteDescriptor { readonly pool: string; readonly zeroForOne: boolean }
export interface State {
  readonly source: CanonicalSource; readonly reserve0: bigint; readonly reserve1: bigint;
  readonly supply: bigint; readonly balance0: bigint; readonly balance1: bigint;
}
export interface Evidence {
  readonly kind: "precision-pool-chain-quote"; readonly source: CanonicalSource; readonly binding: string;
  readonly executor: string; readonly routeKey: Route["routeKey"]; readonly amountIn: bigint; readonly amountOut: bigint;
}
