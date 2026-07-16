import { findV2LineageByFactory } from "../venues/v2-lineage.js";

export const DEFAULT_V2_FEE_BPS = 30n;
const V2_FEE_DENOMINATOR_BPS = 10000n;

export function v2FeeBpsForFactory(factory: string | undefined): bigint {
  return findV2LineageByFactory(factory)?.measuredFeeRule?.feeBps ?? DEFAULT_V2_FEE_BPS;
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
