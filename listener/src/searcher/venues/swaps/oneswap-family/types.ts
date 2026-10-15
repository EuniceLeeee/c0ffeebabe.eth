import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";
export interface Candidate extends FamilyCandidate { readonly candidateKind: "oneswap"; readonly pool: string }
export interface ProxyBinding {
  readonly factory: string; readonly stock: string; readonly money: string; readonly ones: string;
  readonly isOnlySwap: boolean; readonly stockUnit: bigint; readonly priceMul: bigint; readonly priceDiv: bigint;
}
export interface Binding extends ProxyBinding {
  readonly pool: string; readonly implementation: string; readonly codeHash: string;
  readonly implementationCodeHash: string; readonly factoryCodeHash: string;
}
export interface Identity extends VerifiedIdentity { readonly facts: Binding }
export interface Descriptor extends CompiledInstanceDescriptor, Binding {}
export interface Route extends FamilyRouteDescriptor { readonly pool: string; readonly buy: boolean }
export interface Order { readonly id: bigint; readonly next: bigint; readonly maker: string; readonly price: bigint; readonly amount: bigint }
export interface State {
  readonly source: CanonicalSource; readonly stock: bigint; readonly money: bigint;
  readonly bookedStock: bigint; readonly bookedMoney: bigint; readonly balanceStock: bigint; readonly balanceMoney: bigint;
  readonly feeBps: bigint; readonly sells: readonly Order[]; readonly buys: readonly Order[];
  readonly sellTail: bigint; readonly buyTail: bigint;
}
export interface Evidence {
  readonly kind: "oneswap-orderbook-math"; readonly source: CanonicalSource; readonly binding: string;
  readonly executor: string; readonly routeKey: Route["routeKey"]; readonly amountIn: bigint; readonly amountOut: bigint;
  readonly amountIntoPool: bigint; readonly bookOutput: bigint; readonly fee: bigint;
}
