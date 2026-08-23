export const PSM_WAD = 10n ** 18n;
export function psmSellQuote(amountIn: bigint, feeWad: bigint, assetScale: bigint): bigint {
  if (amountIn < 0n) throw new RangeError("amountIn must not be negative");
  if (feeWad < 0n || feeWad > PSM_WAD) throw new RangeError("feeWad must be in [0,WAD]");
  if (assetScale <= 0n) throw new RangeError("assetScale must be positive");
  const gross = amountIn * assetScale;
  return gross - gross * feeWad / PSM_WAD;
}
