import {
  DEFAULT_PROFIT_TOKEN_VALUATION,
  type ProfitTokenValuation,
} from "./profit-token-valuation.js";
import { positiveGrossProfitBid, resolveProfitMode, validatePositiveGrossProfitMode, type ProfitMode } from "../shared/profit-mode.js";

const CHAINLINK_ETH_USD = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
const CHAINLINK_ETH_USD_DECIMALS = 8;
const BASE_FEE_MAX_CHANGE_DENOMINATOR = 8n;
const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Historical-only opt-in. Never synthesize a parent to obtain a desired fee. */
export type EvFeeEnvironment = { mode: "source-block"; sourceBlockHash: string };

export interface EvPolicy {
  profitMode?: ProfitMode;
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

type EvParent = Awaited<ReturnType<BaseFeeProvider["getBlock"]>>;

/** A complete source header already observed by this invocation. It is only
 * the first side of EV's canonical check; the final provider read still runs. */
export interface EvBlockObservation {
  readonly number: number;
  readonly hash: string;
  readonly timestamp: number;
  readonly baseFeePerGas: bigint;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
}

/** Detach caller-owned fields synchronously. Incomplete or mismatched input
 * falls back to the ordinary provider read instead of weakening fee checks. */
export function snapshotEvBlockObservation(
  value: unknown,
  sourceBlock: number,
  sourceBlockHash?: string,
): EvBlockObservation | undefined {
  if (value === null || typeof value !== "object" || !Number.isSafeInteger(sourceBlock) || sourceBlock < 0) return undefined;
  const { number, hash, timestamp, baseFeePerGas, gasUsed, gasLimit } = value as Partial<EvBlockObservation>;
  if (number !== sourceBlock || typeof hash !== "string" || !BLOCK_HASH.test(hash) ||
      (sourceBlockHash !== undefined && hash.toLowerCase() !== sourceBlockHash.toLowerCase()) ||
      !Number.isSafeInteger(timestamp) || timestamp! < 0 ||
      typeof baseFeePerGas !== "bigint" || baseFeePerGas < 0n ||
      typeof gasUsed !== "bigint" || gasUsed < 0n ||
      typeof gasLimit !== "bigint" || gasLimit < 2n || gasUsed > gasLimit) return undefined;
  return Object.freeze({ number, hash: hash.toLowerCase(), timestamp: timestamp!, baseFeePerGas, gasUsed, gasLimit });
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
  policy: Pick<EvPolicy, "bribeAllAboveGas" | "bribeBps" | "profitMode">,
): bigint {
  if (resolveProfitMode(policy.profitMode) === "positive-gross-profit") {
    return positiveGrossProfitBid(expectedProfitEth);
  }
  const surplus = expectedProfitEth > gasCostEth
    ? expectedProfitEth - gasCostEth
    : 0n;
  if (policy.bribeAllAboveGas) {
    return surplus;
  }
  return (surplus * BigInt(policy.bribeBps)) / 10000n;
}

/** Reuse one pinned valuation/gas observation; never read state or simulate a
 * second time to compare the two economic policies. Plain positive-EV mode
 * never acquires the loss-accepting fallback. */
export function selectBlockScanProfitEvaluation(
  evaluation: EvEvaluation,
  policy: Pick<EvPolicy, "profitMode" | "bribeBps" | "bribeAllAboveGas">,
  minimumNet: bigint,
): { profitMode: ProfitMode; evaluation: EvEvaluation } {
  const mode = resolveProfitMode(policy.profitMode);
  if (mode === "positive-ev") return { profitMode: mode, evaluation };
  const bidEth = computeBidEth(evaluation.expectedProfitEth, evaluation.gasCostEth, { ...policy, profitMode: "positive-ev" });
  const netEvWei = evaluation.expectedProfitEth - evaluation.gasCostEth - bidEth;
  return netEvWei > 0n && netEvWei > minimumNet
    ? { profitMode: "positive-ev", evaluation: { ...evaluation, bidEth, netEvWei } }
    : { profitMode: mode, evaluation };
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
  onReadError?: (error: unknown) => void,
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
  } catch (error) {
    onReadError?.(error);
    // A production provider that supports eth_call must not silently fall back
    // to a stale static mark. Stablecoin profit is unpriceable until the pinned
    // current-block oracle read succeeds.
    return null;
  }
}

function validateEvInputs(policy: EvPolicy, sourceBlock?: number, feeEnvironment?: EvFeeEnvironment): void {
  validatePositiveGrossProfitMode(policy);
  if (feeEnvironment !== undefined && (feeEnvironment.mode !== "source-block" ||
      !BLOCK_HASH.test(feeEnvironment.sourceBlockHash) || !Number.isSafeInteger(sourceBlock) || sourceBlock! < 0)) {
    throw new Error("source-block EV requires an explicit source number and hash");
  }
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
}

function evFeeContext(
  parentBefore: EvParent,
  needsFeeState: boolean,
  valuation: ProfitTokenValuation,
  sourceBlock?: number,
  feeEnvironment?: EvFeeEnvironment,
) {
  const targetBaseFee = feeEnvironment
    ? (typeof parentBefore?.baseFeePerGas === "bigint" && parentBefore.baseFeePerGas >= 0n
      ? parentBefore.baseFeePerGas : null)
    : parentBefore ? nextBlockBaseFee(parentBefore) : null;
  let sourceBlockHash =
    typeof parentBefore?.hash === "string" && BLOCK_HASH.test(parentBefore.hash)
      ? parentBefore.hash.toLowerCase()
      : null;
  let feeStateAvailable = !needsFeeState || targetBaseFee !== null;
  if (feeEnvironment && parentBefore?.hash?.toLowerCase() !== feeEnvironment.sourceBlockHash.toLowerCase()) {
    feeStateAvailable = false;
    sourceBlockHash = null;
  }
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

  const valuationSourceMatches = valuation.source === undefined ||
    (valuation.source.number === sourceBlock && valuation.source.number === parentBefore?.number &&
      valuation.source.hash.toLowerCase() === sourceBlockHash);
  return { parentBefore, needsFeeState, targetBaseFee, sourceBlockHash, feeStateAvailable, valuationSourceMatches, sourceBlock };
}

function finishEvEvaluation(
  context: ReturnType<typeof evFeeContext>,
  profitToken: string,
  netProfit: bigint,
  measuredGasUsed: bigint,
  policy: EvPolicy,
  valuation: ProfitTokenValuation,
  valueWithoutUsd: bigint | null,
  ethUsdObservation: EthUsdObservation | null,
  parentAfter: EvParent,
): EvEvaluation {
  const { needsFeeState, targetBaseFee, valuationSourceMatches, sourceBlock } = context;
  let { sourceBlockHash, feeStateAvailable } = context;
  const ethUsd = ethUsdObservation?.value ?? null;
  if (needsFeeState && sourceBlock !== undefined && feeStateAvailable) {
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

  const valuedProfit = valuationSourceMatches && (valuation.source === undefined || feeStateAvailable) ? valueWithoutUsd ?? valuation.valueInEth(
    profitToken,
    netProfit,
    ethUsd ?? Number.NaN,
  ) : null;
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

export async function evaluateEv(
  provider: BaseFeeProvider,
  profitToken: string,
  netProfit: bigint,
  measuredGasUsed: bigint,
  policy: EvPolicy,
  valuation: ProfitTokenValuation = DEFAULT_PROFIT_TOKEN_VALUATION,
  sourceBlock?: number,
  feeEnvironment?: EvFeeEnvironment,
  initialParent?: EvBlockObservation,
): Promise<EvEvaluation> {
  validateEvInputs(policy, sourceBlock, feeEnvironment);
  const needsFeeState = policy.evGate || policy.bribeAllAboveGas || feeEnvironment !== undefined || valuation.source !== undefined;
  const observedParent = sourceBlock === undefined ? undefined : snapshotEvBlockObservation(
    initialParent, sourceBlock, feeEnvironment?.sourceBlockHash ?? valuation.source?.hash,
  );
  const parentBefore = needsFeeState
    ? observedParent ?? await provider.getBlock(sourceBlock ?? "latest") : null;
  const context = evFeeContext(parentBefore, needsFeeState, valuation, sourceBlock, feeEnvironment);
  const valueWithoutUsd = context.valuationSourceMatches ? valuation.valueInEth(profitToken, netProfit, Number.NaN) : null;
  const ethUsdObservation = context.valuationSourceMatches && valuation.source === undefined && valueWithoutUsd === null
    ? await readPinnedEthUsd(provider, sourceBlock, parentBefore?.timestamp) : null;
  const parentAfter = needsFeeState && sourceBlock !== undefined && context.feeStateAvailable
    ? await provider.getBlock(sourceBlock) : null;
  return finishEvEvaluation(context, profitToken, netProfit, measuredGasUsed, policy, valuation,
    valueWithoutUsd, ethUsdObservation, parentAfter);
}

export interface PreparedEvEvaluation {
  readonly initialHeaderReused: boolean;
  readonly oraclePrefetched: boolean;
  /** Single-use. The callback must perform a fresh canonical read; it is invoked
   * only after all valuation reads for the actual final-simulation profit settle. */
  evaluate(
    netProfit: bigint,
    measuredGasUsed: bigint,
    readFinalParent: () => Promise<EvParent>,
  ): Promise<EvEvaluation>;
}

/** Prepare only source/fee/valuation dependencies while the mandatory final
 * simulation runs. A solver profit is a prefetch hint, never a valuation result.
 * Evidence stays inside this invocation's closure; no caller-supplied prepared
 * packet or cross-request cache can substitute for the final canonical read. */
export async function prepareEvEvaluation(input: {
  provider: BaseFeeProvider;
  profitToken: string;
  profitHint: bigint;
  policy: EvPolicy;
  valuation: ProfitTokenValuation;
  sourceBlock: number;
  sourceBlockHash: string;
  feeEnvironment?: EvFeeEnvironment;
  initialParent?: EvBlockObservation;
  checkActive?: () => void;
  /** The owner propagates fatal/cancellation/deadline errors; ordinary oracle
   * failures retain evaluateEv's unpriceable-result behavior. */
  onReadError?: (error: unknown) => void;
}): Promise<PreparedEvEvaluation> {
  const { provider, profitToken, profitHint, sourceBlock, checkActive, onReadError } = input;
  if (!Number.isSafeInteger(sourceBlock) || sourceBlock < 0 || !BLOCK_HASH.test(input.sourceBlockHash)) {
    throw new Error("prepared EV requires an explicit source number and hash");
  }
  const sourceBlockHash = input.sourceBlockHash.toLowerCase();
  const policy = Object.freeze({ ...input.policy });
  const feeEnvironment = input.feeEnvironment === undefined ? undefined : Object.freeze({ ...input.feeEnvironment });
  const valuation: ProfitTokenValuation = Object.freeze({
    ...(input.valuation.source === undefined ? {} : { source: Object.freeze({ ...input.valuation.source }) }),
    // EV does not invoke canValue; retain compatibility with existing minimal
    // valuation views used by callers of the legacy evaluator.
    canValue: input.valuation.canValue,
    valueInEth: input.valuation.valueInEth.bind(input.valuation),
  });
  validateEvInputs(policy, sourceBlock, feeEnvironment);
  checkActive?.();
  const needsFeeState = policy.evGate || policy.bribeAllAboveGas || feeEnvironment !== undefined || valuation.source !== undefined;
  const observed = snapshotEvBlockObservation(input.initialParent, sourceBlock, sourceBlockHash);
  const parent = needsFeeState ? observed ?? await provider.getBlock(sourceBlock) : null;
  // Detach fallback provider objects as well as the raw-header fast path.
  const parentBefore: EvParent = parent === null ? null : Object.freeze({
    number: parent.number, hash: parent.hash, timestamp: parent.timestamp,
    baseFeePerGas: parent.baseFeePerGas, gasUsed: parent.gasUsed, gasLimit: parent.gasLimit,
  });
  checkActive?.();
  const context = evFeeContext(parentBefore, needsFeeState, valuation, sourceBlock, feeEnvironment);
  let oraclePrefetched = false;
  let prefetchedOracle: EthUsdObservation | null = null;
  if (context.valuationSourceMatches && valuation.source === undefined) {
    // A generic valuation can depend on amount. A hint failure must not reject
    // an actual amount that would be valid; only the owner-fenced error escapes.
    let hintNeedsOracle = false;
    try { hintNeedsOracle = valuation.valueInEth(profitToken, profitHint, Number.NaN) === null; }
    catch (error) { onReadError?.(error); }
    if (hintNeedsOracle) {
      checkActive?.();
      oraclePrefetched = true;
      prefetchedOracle = await readPinnedEthUsd(provider, sourceBlock, parentBefore?.timestamp, onReadError);
      checkActive?.();
    }
  }
  let consumed = false;
  return Object.freeze({
    initialHeaderReused: needsFeeState && observed !== undefined,
    oraclePrefetched,
    async evaluate(netProfit: bigint, measuredGasUsed: bigint, readFinalParent: () => Promise<EvParent>) {
      if (consumed) throw new Error("prepared EV already consumed");
      consumed = true;
      checkActive?.();
      const valueWithoutUsd = context.valuationSourceMatches ? valuation.valueInEth(profitToken, netProfit, Number.NaN) : null;
      const needsOracle = context.valuationSourceMatches && valuation.source === undefined && valueWithoutUsd === null;
      const ethUsdObservation = needsOracle ? oraclePrefetched ? prefetchedOracle
        : await readPinnedEthUsd(provider, sourceBlock, parentBefore?.timestamp, onReadError) : null;
      checkActive?.();
      // This read comes after both the simulation (the caller's dependency)
      // and every oracle dependency, including a hint-missed actual amount.
      const parentAfter = await readFinalParent();
      checkActive?.();
      return finishEvEvaluation(context, profitToken, netProfit, measuredGasUsed, policy, valuation,
        valueWithoutUsd, ethUsdObservation, parentAfter);
    },
  });
}
