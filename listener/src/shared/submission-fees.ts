export type BribeGasBasis = "gas-limit" | "measured-gas";
export const BRIBE_WALLET_RESERVE = 500_000_000_000_000n;

export function resolveBribeGasBasis(value: string | undefined): BribeGasBasis {
  if (value === undefined || value === "gas-limit") return "gas-limit";
  if (value === "measured-gas") return value;
  throw new Error("SEARCHER_BRIBE_GAS_BASIS must be gas-limit or measured-gas");
}

/** Fee arithmetic only: no RPC or signing. Wallet affordability always uses the full gas limit. */
export function computeSubmissionFees(input: {
  measuredGasUsed: bigint;
  targetBaseFee: bigint;
  bribeWei: bigint;
  walletBalance: bigint;
  basis: BribeGasBasis;
  expectedProfitEth?: bigint;
}) {
  const { measuredGasUsed: gas, targetBaseFee: base, bribeWei, walletBalance, expectedProfitEth } = input;
  const basis = resolveBribeGasBasis(input.basis);
  if (gas <= 0n || gas > BigInt(Number.MAX_SAFE_INTEGER) || base <= 0n || bribeWei < 0n || walletBalance < 0n) {
    throw new Error("invalid submission fee inputs");
  }
  // In measured mode the EV-approved bid is an expected payment, NOT a hard
  // payment cap if actual gas rises. Do not replace the measured EV check with
  // a worst-gas EV claim; the latter may be negative and is recorded explicitly.
  if (basis === "measured-gas" && (expectedProfitEth === undefined || expectedProfitEth <= base * gas + bribeWei)) {
    throw new Error("measured-gas bribe requires positive EV-approved expected profit");
  }
  const gasLimit = (gas * 13n + 9n) / 10n;
  if (basis === "measured-gas" && walletBalance < base * gasLimit + BRIBE_WALLET_RESERVE) {
    throw new Error("wallet cannot cover gas limit and reserve");
  }
  const headroom = walletBalance > base * gasLimit + BRIBE_WALLET_RESERVE
    ? walletBalance - base * gasLimit - BRIBE_WALLET_RESERVE : 0n;
  const denominator = basis === "measured-gas" ? gas : gasLimit;
  const walletBudget = basis === "measured-gas" ? (headroom / gasLimit) * gas : headroom;
  const bribeBudget = bribeWei < walletBudget ? bribeWei : walletBudget;
  const priorityFee = bribeBudget / denominator;
  const maxFeePerGas = base + priorityFee;
  const estimatedBribeWei = priorityFee * gas;
  const maxBribeWei = priorityFee * gasLimit;
  return {
    basis, gasLimit, denominator, bribeBudget, priorityFee, maxFeePerGas,
    walletLimited: bribeBudget < bribeWei, estimatedBribeWei, maxBribeWei,
    worstGasCostWei: maxFeePerGas * gasLimit,
    estimatedNetWei: expectedProfitEth === undefined ? null : expectedProfitEth - maxFeePerGas * gas,
    netAtGasLimitWei: expectedProfitEth === undefined ? null : expectedProfitEth - maxFeePerGas * gasLimit,
  };
}
