import {
  DEFAULT_PROFIT_TOKEN_VALUATION,
  type ProfitTokenValuation,
} from "./profit-token-valuation.js";

const CHAINLINK_ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const CHAINLINK_ETH_USD_DECIMALS = 8;
const BASE_FEE_MAX_CHANGE_DENOMINATOR = 8n;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

export interface EvPolicy {
  profitHaircutBps: number;
  evGate: boolean;
  bribeAllAboveGas: boolean;
  bribeBps: number;
}

export interface EvEvaluation {
  valuationAvailable: boolean;
  gasMeasurementAvailable: boolean;
  feeStateAvailable: boolean;
  sourceBlockHash: string | null;
  ethUsd: number | null;
  ethUsdRoundId: bigint | null;
  ethUsdUpdatedAt: bigint | null;
  rawProfitEth: bigint;
  expectedProfitEth: bigint;
  gasUnits: bigint;
  maxBaseFeePerGas: bigint;
  gasCostEth: bigint;
  bidEth: bigint;
  netEvWei: bigint;
}

interface BaseFeeProvider {
  getBlock(tag: "latest" | number): Promise<{
    number?: number;
    hash?: string | null;
    timestamp?: number;
    baseFeePerGas?: bigint | null;
    gasUsed?: bigint;
    gasLimit?: bigint;
  } | null>;
  call?(
    transaction: { to: string; data: string; blockTag?: number },
  ): Promise<string>;
}

interface EthUsdObservation {
  value: number;
  roundId: bigint;
  updatedAt: bigint;
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
  const surplus = expectedProfitEth > gasCostEth
    ? expectedProfitEth - gasCostEth
    : 0n;
  if (policy.bribeAllAboveGas) {
    return surplus;
  }
  return (surplus * BigInt(policy.bribeBps)) / 10000n;
}

/**
 * The next block's EIP-1559 base fee is fully determined by its parent.
 * Searcher bundles target exactly parent.number + 1, so a blanket 2x fee
 * estimate rejects valid thin opportunities without buying extra safety.
 */
export function nextBlockBaseFee(parent: {
  baseFeePerGas?: bigint | null;
  gasUsed?: bigint;
  gasLimit?: bigint;
}): bigint | null {
  const baseFee = parent.baseFeePerGas;
  const gasUsed = parent.gasUsed;
  const gasLimit = parent.gasLimit;
  if (
    baseFee === null ||
    baseFee === undefined ||
    baseFee <= 0n ||
    gasUsed === undefined ||
    gasLimit === undefined ||
    gasLimit <= 0n
  ) {
    return null;
  }
  const gasTarget = gasLimit / 2n;
  if (gasTarget <= 0n || gasUsed === gasTarget) return baseFee;
  if (gasUsed > gasTarget) {
    let delta =
      (baseFee * (gasUsed - gasTarget)) /
      gasTarget /
      BASE_FEE_MAX_CHANGE_DENOMINATOR;
    if (delta < 1n) delta = 1n;
    return baseFee + delta;
  }
  const delta =
    (baseFee * (gasTarget - gasUsed)) /
    gasTarget /
    BASE_FEE_MAX_CHANGE_DENOMINATOR;
  return baseFee - delta;
}

async function readPinnedEthUsd(
  provider: BaseFeeProvider,
  sourceBlock: number | undefined,
  sourceTimestamp: number | undefined,
): Promise<EthUsdObservation | null> {
  if (!provider.call) return null;
  try {
    const encoded = await provider.call(
      {
        to: CHAINLINK_ETH_USD,
        data: LATEST_ROUND_DATA_SELECTOR,
        blockTag: sourceBlock,
      },
    );
    if (!/^0x[0-9a-fA-F]{320,}$/.test(encoded)) return null;
    const words = encoded.slice(2).match(/.{64}/g);
    if (!words || words.length < 5) return null;
    const roundId = BigInt(`0x${words[0]}`);
    const rawAnswer = BigInt(`0x${words[1]}`);
    const updatedAt = BigInt(`0x${words[3]}`);
    const answeredInRound = BigInt(`0x${words[4]}`);
    const signBit = 1n << 255n;
    const answer = rawAnswer >= signBit ? rawAnswer - (1n << 256n) : rawAnswer;
    if (
      roundId <= 0n ||
      answer <= 0n ||
      updatedAt <= 0n ||
      answeredInRound < roundId ||
      (sourceTimestamp !== undefined &&
        (updatedAt > BigInt(sourceTimestamp) ||
          BigInt(sourceTimestamp) - updatedAt > 3_600n))
    ) {
      return null;
    }
    const value = Number(answer) / 10 ** CHAINLINK_ETH_USD_DECIMALS;
    return Number.isFinite(value) && value > 0
      ? { value, roundId, updatedAt }
      : null;
  } catch {
    // A production provider that supports eth_call must not silently fall back
    // to a stale static mark. Stablecoin profit is unpriceable until the pinned
    // current-block oracle read succeeds.
    return null;
  }
}

export async function evaluateEv(
  provider: BaseFeeProvider,
  profitToken: string,
  netProfit: bigint,
  measuredGasUsed: bigint,
  policy: EvPolicy,
  valuation: ProfitTokenValuation = DEFAULT_PROFIT_TOKEN_VALUATION,
  sourceBlock?: number,
): Promise<EvEvaluation> {
  if (
    !Number.isInteger(policy.profitHaircutBps) ||
    policy.profitHaircutBps < 0 ||
    policy.profitHaircutBps > 10_000
  ) {
    throw new Error("profitHaircutBps must be an integer between 0 and 10000");
  }
  if (
    !Number.isInteger(policy.bribeBps) ||
    policy.bribeBps < 0 ||
    policy.bribeBps > 10_000
  ) {
    throw new Error("bribeBps must be an integer between 0 and 10000");
  }
  const needsFeeState = policy.evGate || policy.bribeAllAboveGas;
  const parentBefore = needsFeeState
    ? await provider.getBlock(sourceBlock ?? "latest")
    : null;
  const targetBaseFee = parentBefore ? nextBlockBaseFee(parentBefore) : null;
  let sourceBlockHash =
    typeof parentBefore?.hash === "string" && BLOCK_HASH.test(parentBefore.hash)
      ? parentBefore.hash.toLowerCase()
      : null;
  let feeStateAvailable = !needsFeeState || targetBaseFee !== null;
  if (
    needsFeeState &&
    sourceBlock !== undefined &&
    (
      parentBefore?.number !== sourceBlock ||
      sourceBlockHash === null
    )
  ) {
    feeStateAvailable = false;
  }

  const valueWithoutUsd = valuation.valueInEth(
    profitToken,
    netProfit,
    Number.NaN,
  );
  const ethUsdObservation = valueWithoutUsd === null
    ? await readPinnedEthUsd(
        provider,
        sourceBlock,
        parentBefore?.timestamp,
      )
    : null;
  const ethUsd = ethUsdObservation?.value ?? null;

  if (needsFeeState && sourceBlock !== undefined && feeStateAvailable) {
    const parentAfter = await provider.getBlock(sourceBlock);
    const hashAfter =
      typeof parentAfter?.hash === "string" && BLOCK_HASH.test(parentAfter.hash)
        ? parentAfter.hash.toLowerCase()
        : null;
    if (
      parentAfter?.number !== sourceBlock ||
      hashAfter === null ||
      hashAfter !== sourceBlockHash
    ) {
      feeStateAvailable = false;
      sourceBlockHash = null;
    }
  }

  const valuedProfit = valueWithoutUsd ?? valuation.valueInEth(
    profitToken,
    netProfit,
    ethUsd ?? Number.NaN,
  );
  const valuationAvailable = valuedProfit !== null;
  const rawProfitEth = valuedProfit ?? 0n;
  const expectedProfitEth =
    (rawProfitEth * BigInt(10000 - policy.profitHaircutBps)) / 10000n;
  const gasMeasurementAvailable = measuredGasUsed > 0n;
  const gasUnits = gasMeasurementAvailable ? measuredGasUsed : 0n;
  const maxBaseFeePerGas =
    feeStateAvailable && targetBaseFee !== null ? targetBaseFee : 0n;
  let gasCostEth = 0n;
  if (valuationAvailable && needsFeeState && feeStateAvailable) {
    gasCostEth = gasUnits * maxBaseFeePerGas;
  }
  const bidEth = computeBidEth(expectedProfitEth, gasCostEth, policy);
  return {
    valuationAvailable,
    gasMeasurementAvailable,
    feeStateAvailable,
    sourceBlockHash,
    ethUsd,
    ethUsdRoundId: ethUsdObservation?.roundId ?? null,
    ethUsdUpdatedAt: ethUsdObservation?.updatedAt ?? null,
    rawProfitEth,
    expectedProfitEth,
    gasUnits,
    maxBaseFeePerGas,
    gasCostEth,
    bidEth,
    netEvWei: expectedProfitEth - gasCostEth - bidEth,
  };
}
