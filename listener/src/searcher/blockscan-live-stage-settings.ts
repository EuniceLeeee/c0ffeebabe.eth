import { ethers } from "ethers";
import { BLOCKSCAN_ENUMERATION_DEFAULTS } from "./blockscan-enumeration-config.js";
import { resolveBlockScanSolverSearchConfig } from "./blockscan-solver-search-config.js";

const DEFAULT_BLOCKSCAN_REFINE_CANDIDATES = BLOCKSCAN_ENUMERATION_DEFAULTS.refineCandidates;

/** Coarse enumeration cap, shared by live and historical entry points. */
export function resolveBlockScanRefineCandidates(env: NodeJS.ProcessEnv = process.env, maxCandidates = 0): number {
  const requested = Number(env.SEARCHER_BLOCKSCAN_REFINE_CANDIDATES ?? DEFAULT_BLOCKSCAN_REFINE_CANDIDATES);
  return Math.max(maxCandidates, Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_BLOCKSCAN_REFINE_CANDIDATES);
}

/** Live stage policy, shared by main and diagnostics. Preserve each setting's
 * existing fallback/clamping rule; core enumeration config remains separate. */
export function resolveBlockScanLiveStageSettings(env: NodeJS.ProcessEnv = process.env, maxCandidates = 0) {
  const singleFundingRaw = env.SEARCHER_BLOCKSCAN_SINGLE_FUNDING_ENABLED ?? "0";
  if (singleFundingRaw !== "0" && singleFundingRaw !== "1")
    throw new Error("SEARCHER_BLOCKSCAN_SINGLE_FUNDING_ENABLED must be 0 or 1");
  const fixedInputRaw = env.SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT;
  let fixedEffectiveWethInput: bigint | undefined;
  if (fixedInputRaw !== undefined) {
    if (!/^\d+(?:\.\d{1,18})?$/.test(fixedInputRaw))
      throw new Error("SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT must be a positive WETH amount");
    fixedEffectiveWethInput = ethers.parseEther(fixedInputRaw);
    if (fixedEffectiveWethInput <= 0n || fixedEffectiveWethInput > ethers.MaxUint256)
      throw new Error("SEARCHER_BLOCKSCAN_EFFECTIVE_WETH_INPUT must be a positive uint256 WETH amount");
  }
  const passBudgetRaw = Number(env.SEARCHER_BLOCKSCAN_PASS_BUDGET_MS ?? "11000");
  const passBudgetMs = Number.isFinite(passBudgetRaw)
    ? Math.max(1, Math.floor(passBudgetRaw)) : 11_000;
  const largeGraphPassBudgetRaw = Number(env.SEARCHER_BLOCKSCAN_LARGE_GRAPH_PASS_BUDGET_MS ?? "30000");
  const largeGraphPassBudgetMs = Number.isFinite(largeGraphPassBudgetRaw)
    ? Math.max(passBudgetMs, Math.floor(largeGraphPassBudgetRaw)) : Math.max(passBudgetMs, 30_000);
  const largeGraphEdgeThresholdRaw = Number(env.SEARCHER_BLOCKSCAN_LARGE_GRAPH_EDGE_THRESHOLD ?? "20000");
  const largeGraphEdgeThreshold = Number.isFinite(largeGraphEdgeThresholdRaw)
    ? Math.max(1, Math.floor(largeGraphEdgeThresholdRaw)) : 20_000;
  const startupWarmBudgetRaw = Number(env.SEARCHER_BLOCKSCAN_STARTUP_PREWARM_BUDGET_MS ?? "300000");
  const startupWarmBudgetMs = Number.isSafeInteger(startupWarmBudgetRaw) && startupWarmBudgetRaw > 0
    ? startupWarmBudgetRaw : 300_000;
  const hotPricingFamilyBudgetRaw = Number(env.SEARCHER_BLOCKSCAN_STATE_HOT_FAMILY_BUDGET_MS ?? "5000");
  const hotPricingFamilyBudgetMs = Number.isFinite(hotPricingFamilyBudgetRaw) && hotPricingFamilyBudgetRaw > 0
    ? Math.floor(hotPricingFamilyBudgetRaw) : 5_000;
  const runtimePublicationReserveRaw = Number(env.SEARCHER_BLOCKSCAN_RUNTIME_PUBLICATION_RESERVE_MS ?? "1500");
  const runtimePublicationReserveMs = Number.isFinite(runtimePublicationReserveRaw) && runtimePublicationReserveRaw > 0
    ? Math.floor(runtimePublicationReserveRaw) : 1_500;
  const solveReserveRaw = Number(env.SEARCHER_BLOCKSCAN_SOLVE_RESERVE_MS ?? "8000");
  const solveReserveMs = Number.isFinite(solveReserveRaw) ? Math.max(0, Math.floor(solveReserveRaw)) : 8_000;
  const solveConcurrencyRaw = Number(env.SEARCHER_BLOCKSCAN_SOLVE_CONCURRENCY ?? "4");
  const solveConcurrency = Number.isFinite(solveConcurrencyRaw) ? Math.max(1, Math.floor(solveConcurrencyRaw)) : 4;
  const solverSearch = resolveBlockScanSolverSearchConfig(env);
  const finalSimulationConcurrencyRaw = Number(env.SEARCHER_BLOCKSCAN_FINAL_SIM_CONCURRENCY ?? "1");
  const finalSimulationConcurrency = Number.isFinite(finalSimulationConcurrencyRaw)
    ? Math.max(1, Math.floor(finalSimulationConcurrencyRaw)) : 1;
  const refineCandidates = resolveBlockScanRefineCandidates(env, maxCandidates);
  const exactRefineHardBudgetRaw = Number(env.SEARCHER_BLOCKSCAN_EXACT_REFINE_HARD_BUDGET_MS ?? "4000");
  const exactRefineHardBudgetMs = Number.isFinite(exactRefineHardBudgetRaw) && exactRefineHardBudgetRaw > 0
    ? Math.max(1_000, Math.floor(exactRefineHardBudgetRaw)) : 4_000;
  const exactConcurrencyRaw = Number(env.SEARCHER_BLOCKSCAN_EXACT_CONCURRENCY ??
    // Backward-compatible read only. Exact has its own explicit name.
    env.SEARCHER_BLOCKSCAN_MID_CONCURRENCY ?? String(refineCandidates));
  const exactConcurrency = Number.isFinite(exactConcurrencyRaw) && exactConcurrencyRaw > 0
    ? Math.max(1, Math.floor(exactConcurrencyRaw)) : refineCandidates;
  const exactProbeTimeoutRaw = Number(env.SEARCHER_BLOCKSCAN_EXACT_PROBE_TIMEOUT_MS ?? "4000");
  const exactProbeTimeoutMs = Number.isFinite(exactProbeTimeoutRaw) && exactProbeTimeoutRaw > 0
    ? Math.max(100, Math.floor(exactProbeTimeoutRaw)) : 4_000;
  const exactRpcBatchSizeRaw = Number(env.SEARCHER_BLOCKSCAN_EXACT_RPC_BATCH_SIZE ?? "64");
  const exactRpcBatchSize = Number.isFinite(exactRpcBatchSizeRaw) && exactRpcBatchSizeRaw > 0
    ? Math.max(1, Math.floor(exactRpcBatchSizeRaw)) : 64;
  const exactRpcBatchConcurrencyRaw = Number(env.SEARCHER_BLOCKSCAN_EXACT_RPC_BATCH_CONCURRENCY ?? "16");
  const exactRpcBatchConcurrency = Number.isFinite(exactRpcBatchConcurrencyRaw) && exactRpcBatchConcurrencyRaw > 0
    ? Math.max(1, Math.floor(exactRpcBatchConcurrencyRaw)) : 16;
  // Deliberately no rounding/fallback: the live transport constructor owns
  // validation of non-integer/non-finite state concurrency, as before.
  const stateRpcBatchConcurrency = Math.max(1, Number(env.SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY ?? "4"));
  const configuredTransportCapacity = stateRpcBatchConcurrency + exactRpcBatchConcurrency;
  const transportCapacityOverride = env.SEARCHER_RPC_TRANSPORT_MAX_CONCURRENCY;
  const transportCapacity = transportCapacityOverride === undefined ? configuredTransportCapacity : Number(transportCapacityOverride);
  if (transportCapacityOverride !== undefined &&
      (!Number.isSafeInteger(configuredTransportCapacity) || !Number.isSafeInteger(transportCapacity) ||
        transportCapacity < 1 || transportCapacity > configuredTransportCapacity)) {
    throw new Error("SEARCHER_RPC_TRANSPORT_MAX_CONCURRENCY must be a positive integer no greater than configured transport capacity");
  }
  // A throttled batch degrades to concurrency 1 and keeps retrying there; only
  // that batch pays the patience, never the whole live scope. The backoff is
  // capped so a long refusal cannot turn into an unbounded stall.
  const throttleRetriesAtOneRaw = Number(env.SEARCHER_RPC_THROTTLE_RETRIES_AT_ONE ?? "3");
  const throttleRetriesAtOne = Number.isSafeInteger(throttleRetriesAtOneRaw) && throttleRetriesAtOneRaw >= 1
    ? throttleRetriesAtOneRaw : 3;
  const throttleMaxDelayRaw = Number(env.SEARCHER_RPC_THROTTLE_MAX_DELAY_MS ?? "30000");
  const throttleMaxDelayMs = Number.isSafeInteger(throttleMaxDelayRaw) && throttleMaxDelayRaw > 0
    ? throttleMaxDelayRaw : 30_000;
  return Object.freeze({ singleFunding: singleFundingRaw === "1", fixedEffectiveWethInput,
    passBudgetMs, largeGraphPassBudgetMs, largeGraphEdgeThreshold,
    startupWarmBudgetMs, hotPricingFamilyBudgetMs, runtimePublicationReserveMs, solveReserveMs,
    solveConcurrency, solverSearch, finalSimulationConcurrency, refineCandidates,
    sourceSimulationTimeoutMs: Number(env.SEARCHER_REVM_TIMEOUT_MS ?? "60000"),
    exactRefineHardBudgetMs, exactConcurrency, exactProbeTimeoutMs, exactRpcBatchSize, exactRpcBatchConcurrency,
    stateRpcBatchConcurrency, transport: Object.freeze({
      capacity: transportCapacity,
      producerReserved: transportCapacityOverride === undefined ? stateRpcBatchConcurrency
        : Math.min(stateRpcBatchConcurrency, Math.max(1, transportCapacity - 1)),
      maxRetriesAtOne: throttleRetriesAtOne, maxRetryDelayMs: throttleMaxDelayMs,
    }) });
}

export type BlockScanLiveStageSettings = ReturnType<typeof resolveBlockScanLiveStageSettings>;
