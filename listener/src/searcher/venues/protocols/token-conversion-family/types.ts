import type { FamilyCandidate, VerifiedIdentity, CompiledInstanceDescriptor, FamilyRouteDescriptor } from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

// Additional conversions require their own proven semantic variant. In particular,
// xWin allocation shares are not a wrapped-token or ERC4626 variant.
export type ConversionVariant = "btb-bear-v1" | "xwin-allocations-v1";
export type Direction = "mint" | "redeem";
export interface ConversionCandidate extends FamilyCandidate {
  readonly candidateKind: "token-conversion";
  readonly target: string;
  readonly variantHint?: ConversionVariant;
}
export type ConversionBinding = {
  readonly asset: string;
  readonly codeHash: string;
} & ({
  readonly variant: "btb-bear-v1";
  readonly assetCodeHash: string;
} | {
  readonly variant: "xwin-allocations-v1";
  readonly proxyAdmin: string;
});
export type ConversionIdentity = VerifiedIdentity & ConversionBinding;
export type ConversionDescriptor = CompiledInstanceDescriptor & ConversionBinding & { readonly target: string };
export interface ConversionRoute extends FamilyRouteDescriptor {
  readonly target: string;
  readonly direction: Direction;
  readonly adapterId: "token-conversion-mint" | "token-conversion-redeem";
}
export type ConversionPricingDescriptor = ConversionDescriptor & {
  readonly routes: readonly ConversionRoute[];
};
export interface ConversionSnapshot {
  readonly source: CanonicalSource;
  readonly supply: bigint;
  readonly backing: bigint;
  readonly quotes: Readonly<Record<string, { readonly amountIn: bigint; readonly amountOut: bigint }>>;
}
export interface ConversionExactEvidence {
  readonly kind: "token-conversion-balance-quote";
  readonly source: CanonicalSource;
  readonly executor: string;
  readonly direction: Direction;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly bindingFingerprint: string;
}
