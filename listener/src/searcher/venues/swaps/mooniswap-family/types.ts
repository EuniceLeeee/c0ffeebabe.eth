import type { CompiledInstanceDescriptor, FamilyRouteDescriptor, FamilyCandidate, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export interface MooniswapBinding {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly codeHash: string;
}
export interface MooniswapCandidate extends FamilyCandidate { readonly candidateKind: "mooniswap"; readonly pool: string }
export interface MooniswapIdentity extends VerifiedIdentity, MooniswapBinding {}
export interface MooniswapDescriptor extends CompiledInstanceDescriptor, MooniswapBinding {}
export interface MooniswapRoute extends FamilyRouteDescriptor { readonly pool: string }
export interface MooniswapQuoteEvidence {
  readonly kind: "mooniswap-get-return";
  readonly source: CanonicalSource;
  readonly routeKey: MooniswapRoute["routeKey"];
  readonly binding: string;
  readonly executor: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly governance?: string;
}
export interface MooniswapSnapshot {
  readonly source: CanonicalSource;
  readonly governance: string;
  readonly active: boolean;
  readonly balance0: bigint;
  readonly balance1: bigint;
  readonly addition0: bigint;
  readonly addition1: bigint;
  readonly removal0: bigint;
  readonly removal1: bigint;
  readonly fee: bigint;
  readonly slippageFee: bigint;
}
