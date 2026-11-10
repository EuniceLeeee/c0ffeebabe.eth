/** Ondo BaseRWAManager._processRedemption: USD value, flat+bps fee, oracle conversion. */
export function redeemOut(input: {
  readonly amount: bigint;
  readonly priceRwa: bigint;
  readonly priceReceive: bigint;
  readonly normalizer: bigint;
  readonly receiveDecimals: number;
  readonly feeFlat: bigint;
  readonly feeBps: bigint;
  readonly feePrecision: bigint;
}): bigint {
  if (input.amount <= 0n || input.priceRwa <= 0n || input.priceReceive <= 0n ||
      input.normalizer <= 0n || input.feePrecision <= 0n) throw new Error("ondo redeem invalid input");
  const usd = input.amount * input.priceRwa / input.normalizer;
  const fee = input.feeFlat + usd * input.feeBps / input.feePrecision;
  if (fee > usd) throw new Error("ondo redeem fee exceeds value");
  return (usd - fee) * 10n ** BigInt(input.receiveDecimals) / input.priceReceive;
}
