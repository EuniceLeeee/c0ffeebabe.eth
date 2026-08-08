const V2_FEE_DENOMINATOR_BPS = 10_000n;

/** Pure exact-input x*y=k quote with the Family's constant-bps fee rule. */
export function quoteV2ExactInput(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (V2_FEE_DENOMINATOR_BPS - feeBps);
  return (amountInWithFee * reserveOut) /
    (reserveIn * V2_FEE_DENOMINATOR_BPS + amountInWithFee);
}
