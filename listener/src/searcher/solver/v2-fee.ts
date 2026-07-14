export const DEFAULT_V2_FEE_BPS = 30n;
const V2_FEE_DENOMINATOR_BPS = 10000n;

// Only fee-VERIFIED factories go here (both 30bps = current 997 behavior, so
// bit-identical + zero regression). The ~14% of v2 pools on other forks (10+
// factories, each ≤65 pools: 0x1159341319…, 0xeb2a625b…, 0x1097053f… etc.) stay
// at DEFAULT 30 until their fee is empirically fork-swap-verified — memory
// hardcoding is unsafe (the mainnet PancakeV2 fee was NOT confirmed). Add a row
// only with a measured feeBps + the tx/receipt that proved it.
export const V2_FEE_BPS_BY_FACTORY: Record<string, bigint> = {
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f": 30n, // UniV2
  "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac": 30n, // SushiV2
};

export function v2FeeBpsForFactory(factory: string | undefined): bigint {
  if (!factory) return DEFAULT_V2_FEE_BPS;
  return V2_FEE_BPS_BY_FACTORY[factory.toLowerCase()] ?? DEFAULT_V2_FEE_BPS;
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
