/** Pure BigInt pricing for Mellow sync queues. Mirrors SyncQueue.sol exactly. */
export const D6 = 1_000_000n;
export const D18 = 1_000_000_000_000_000_000n;

export function depositShares(input: {
  readonly assets: bigint;
  readonly priceD18: bigint;
  readonly penaltyD6: bigint;
  readonly feeShares?: bigint;
}): bigint {
  const { assets, priceD18, penaltyD6 } = input;
  if (assets <= 0n) throw new Error("mellow deposit amount must be positive");
  if (priceD18 <= 0n) throw new Error("mellow price must be positive");
  if (penaltyD6 > 500_000n) throw new Error("mellow penalty out of range");
  const gross = (assets * priceD18 * (D6 - penaltyD6)) / D6 / D18;
  const fee = input.feeShares ?? 0n;
  if (fee >= gross) throw new Error("mellow deposit fee consumes full amount");
  return gross - fee;
}

export function redeemAssets(input: {
  readonly shares: bigint;
  readonly priceD18: bigint;
  readonly penaltyD6: bigint;
  readonly feeShares?: bigint;
}): bigint {
  const { shares, priceD18, penaltyD6 } = input;
  if (shares <= 0n) throw new Error("mellow redeem shares must be positive");
  if (priceD18 <= 0n) throw new Error("mellow price must be positive");
  if (penaltyD6 > 500_000n) throw new Error("mellow penalty out of range");
  const netShares = (shares * (D6 - penaltyD6)) / D6;
  const fee = input.feeShares ?? 0n;
  if (fee >= netShares) throw new Error("mellow redeem fee consumes full amount");
  const assets = ((netShares - fee) * D18) / priceD18;
  if (assets <= 0n) throw new Error("mellow redeem output zero");
  return assets;
}
