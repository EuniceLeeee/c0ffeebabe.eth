export const DEFAULT_V2_FEE_BPS = 30n;
const V2_FEE_DENOMINATOR_BPS = 10000n;

export const V2_FEE_BPS_BY_FACTORY: Record<string, bigint> = {
  "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f": 30n, // UniV2
  "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac": 30n, // SushiV2
  "0x1097053fd2ea711dad45caccc45eff7548fcb362": 25n, // PancakeV2 mainnet; verify on node.
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
