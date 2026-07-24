/**
 * Canonical Curve representation for native ETH in legacy/factory pools.
 * It is an asset identifier, not an ERC-20 contract, so calling decimals()
 * returns empty data. Curve math treats it as an 18-decimal coin.
 */
export const CURVE_NATIVE_ASSET =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const CURVE_NATIVE_RATE_MULTIPLIER = 10n ** 18n;

export function curveNativeRateMultiplier(
  asset: string,
): bigint | null {
  return asset.toLowerCase() === CURVE_NATIVE_ASSET
    ? CURVE_NATIVE_RATE_MULTIPLIER
    : null;
}

export function curveRateMultiplierFromDecimals(
  decimals: number,
): bigint {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`curve token decimals out of range: ${decimals}`);
  }
  return 10n ** BigInt(36 - decimals);
}
