const FEE_DENOMINATOR_BPS = 10_000n;

/** Exact-input x*y=k quote. Invalid economic inputs fail closed. */
export function quoteV2ExactInput(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: bigint,
): bigint {
  if (reserveIn <= 0n || reserveOut <= 0n) throw new RangeError("reserves must be positive");
  if (amountIn < 0n) throw new RangeError("amountIn must be non-negative");
  if (feeBps < 0n || feeBps >= FEE_DENOMINATOR_BPS) throw new RangeError("feeBps out of range");
  if (amountIn === 0n) return 0n;
  const amountInWithFee = amountIn * (FEE_DENOMINATOR_BPS - feeBps);
  return (amountInWithFee * reserveOut) /
    (reserveIn * FEE_DENOMINATOR_BPS + amountInWithFee);
}
