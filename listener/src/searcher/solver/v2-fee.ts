export const DEFAULT_V2_FEE_BPS = 30n;
const V2_FEE_DENOMINATOR_BPS = 10000n;

// Only fee-VERIFIED factories go here. Uni/Sushi = 30bps = the old 997 behavior
// (bit-identical, zero regression). The remaining ~14% of v2 pools sit on 10+
// other forks (0x1159341319…, 0xeb2a625b…, each ≤65 pools) and stay at DEFAULT
// 30 until their fee is empirically fork-swap-verified — memory hardcoding is
// unsafe. Add a row ONLY with a measured feeBps + the proof.
export const V2_FEE_BPS_BY_FACTORY: Record<string, bigint> = {
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f": 30n, // UniV2
  "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac": 30n, // SushiV2
  // 0.25% fork (PancakeV2-lineage), fork-swap VERIFIED 2026-07-14 on pair
  // 0x17C1Ae82D99379240059940093762c5e4539aba5 (WETH/USDT): eth_call swap() with a
  // balanceOf override succeeds at amount1Out(feeBps=25) and reverts at 24 → 25bps.
  "0x1097053fd2ea711dad45caccc45eff7548fcb362": 25n,
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
