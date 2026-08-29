export function positiveAmount(value: string, path: string): bigint {
  if (!/^\d+$/.test(value)) throw new TypeError(`${path} must be a decimal integer`);
  const amount = BigInt(value);
  if (amount <= 0n) throw new TypeError(`${path} must be positive`);
  return amount;
}
export function observedQuote(amountIn: string, observedAmountOut: string): {
  readonly amountIn: string;
  readonly observedAmountOut: string;
} {
  positiveAmount(amountIn, "amountIn");
  positiveAmount(observedAmountOut, "observedAmountOut");
  return Object.freeze({ amountIn, observedAmountOut });
}
