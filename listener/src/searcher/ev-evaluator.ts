import {
  DEFAULT_PROFIT_TOKEN_VALUATION,
  type ProfitTokenValuation,
} from "./profit-token-valuation.js";

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
  valuationAvailable: boolean;
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

export function valueInEth(
  token: string,
  amount: bigint,
  ethUsd: number,
  valuation: ProfitTokenValuation = DEFAULT_PROFIT_TOKEN_VALUATION,
): bigint {
  return valuation.valueInEth(token, amount, ethUsd) ?? 0n;
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
  valuation: ProfitTokenValuation = DEFAULT_PROFIT_TOKEN_VALUATION,
): Promise<EvEvaluation> {
  const valuedProfit = valuation.valueInEth(profitToken, netProfit, policy.ethUsd);
  const valuationAvailable = valuedProfit !== null;
  const rawProfitEth = valuedProfit ?? 0n;
  const expectedProfitEth =
    (rawProfitEth * BigInt(10000 - policy.profitHaircutBps)) / 10000n;
  const gasUnits = measuredGasUsed > 0n ? measuredGasUsed : BigInt(policy.defaultGasUsed);
  let gasCostEth = 0n;
  if (valuationAvailable && (policy.evGate || policy.bribeAllAboveGas)) {
    const latest = await provider.getBlock("latest");
    const baseFee = latest?.baseFeePerGas ?? 0n;
    const worstBaseFee = (baseFee * BigInt(policy.gasBufferMultX10)) / 10n;
    gasCostEth = gasUnits * worstBaseFee;
  }
  const bidEth = computeBidEth(expectedProfitEth, gasCostEth, policy);
  return {
    valuationAvailable,
    rawProfitEth,
    expectedProfitEth,
    gasUnits,
    gasCostEth,
    bidEth,
    netEvWei: expectedProfitEth - gasCostEth - bidEth,
  };
}
