import { findV2LineageByFactory } from "../venues/v2-lineage.js";

export const DEFAULT_V2_FEE_BPS = 30n;
const V2_FEE_DENOMINATOR_BPS = 10000n;

/**
 * Return an attested factory fee only.
 *
 * Unknown/provisional V2 factories may share the standard execution ABI, but
 * that does not prove their fee rule. Callers must fail closed instead of
 * silently applying the UniV2 30 bps default.
 */
export function v2FeeBpsForFactory(factory: string | undefined): bigint | null {
  return findV2LineageByFactory(factory)?.measuredFeeRule?.feeBps ?? null;
}

export function quoteV2ExactInput(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (V2_FEE_DENOMINATOR_BPS - feeBps);
  return (amountInWithFee * reserveOut) / (reserveIn * V2_FEE_DENOMINATOR_BPS + amountInWithFee);
}
