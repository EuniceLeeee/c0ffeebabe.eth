/** Pure BigInt conversion matching ArcanaMigrationSource._convertExact. */
export function arcAmount(input: {
  readonly amount: bigint;
  readonly tokenDecimals: number;
  readonly tokenTwapValue: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplierScale: bigint;
}): bigint {
  if (input.amount <= 0n) throw new Error("arcana amount must be positive");
  if (input.tokenTwapValue <= 0n || input.tokenMultiplier <= 0n || input.multiplierScale <= 0n) {
    throw new Error("arcana conversion constants must be positive");
  }
  const scaled = input.amount * input.tokenTwapValue * input.tokenMultiplier;
  const scale = 10n ** BigInt(input.tokenDecimals) * input.multiplierScale;
  if (scaled % scale !== 0n) throw new Error("arcana conversion has remainder");
  return scaled / scale;
}
