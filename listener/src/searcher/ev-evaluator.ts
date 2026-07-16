const WETH_ADDR = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const STABLE_DECIMALS = new Map<string, number>([
  ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6],
  ["0xdac17f958d2ee523a2206206994597c13d831ec7", 6],
  ["0x6b175474e89094c44da98b954eedeac495271d0f", 18],
  ["0x853d955acef822db058eb8505911ed77f175b99e", 18],
]);

export interface EvPolicy {
  ethUsd: number;
  profitHaircutBps: number;
  defaultGasUsed: number;
  gasBufferMultX10: number;
  evGate: boolean;
  bribeAllAboveGas: boolean;
  bribeBps: number;
}

export interface EvEvaluation {
  rawProfitEth: bigint;
  expectedProfitEth: bigint;
  gasUnits: bigint;
  gasCostEth: bigint;
  bidEth: bigint;
  netEvWei: bigint;
}

interface BaseFeeProvider {
  getBlock(tag: "latest"): Promise<{ baseFeePerGas?: bigint | null } | null>;
}

export function valueInEth(token: string, amount: bigint, ethUsd: number): bigint {
  const key = token.toLowerCase();
  if (key === WETH_ADDR) return amount;
  const decimals = STABLE_DECIMALS.get(key);
  if (decimals === undefined || ethUsd <= 0) return 0n;
  return (amount * 10n ** 18n) /
    (10n ** BigInt(decimals) * BigInt(Math.round(ethUsd)));
}

export function computeBidEth(
  expectedProfitEth: bigint,
  gasCostEth: bigint,
  policy: Pick<EvPolicy, "bribeAllAboveGas" | "bribeBps">,
): bigint {
  if (policy.bribeAllAboveGas) {
    return expectedProfitEth > gasCostEth ? expectedProfitEth - gasCostEth : 0n;
  }
  return (expectedProfitEth * BigInt(policy.bribeBps)) / 10000n;
}

export async function evaluateEv(
  provider: BaseFeeProvider,
  profitToken: string,
  netProfit: bigint,
  measuredGasUsed: bigint,
  policy: EvPolicy,
): Promise<EvEvaluation> {
  const rawProfitEth = valueInEth(profitToken, netProfit, policy.ethUsd);
  const expectedProfitEth =
    (rawProfitEth * BigInt(10000 - policy.profitHaircutBps)) / 10000n;
  const gasUnits = measuredGasUsed > 0n ? measuredGasUsed : BigInt(policy.defaultGasUsed);
  let gasCostEth = 0n;
  if (policy.evGate || policy.bribeAllAboveGas) {
    const latest = await provider.getBlock("latest");
    const baseFee = latest?.baseFeePerGas ?? 0n;
    const worstBaseFee = (baseFee * BigInt(policy.gasBufferMultX10)) / 10n;
    gasCostEth = gasUnits * worstBaseFee;
  }
  const bidEth = computeBidEth(expectedProfitEth, gasCostEth, policy);
  return {
    rawProfitEth,
    expectedProfitEth,
    gasUnits,
    gasCostEth,
    bidEth,
    netEvWei: expectedProfitEth - gasCostEth - bidEth,
  };
}
