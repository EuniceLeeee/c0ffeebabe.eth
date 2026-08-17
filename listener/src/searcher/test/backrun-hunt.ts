/**
 * Trusted production gate for victim-driven backruns.
 *
 * The wrapper copies this main-side source into each target worktree before
 * execution, so a challenger cannot weaken its own replay. The expected route
 * and victim are data supplied by the signed A/B report, not hard-coded here.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import {
  buildExecuteCalldata,
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { mergePoolRegistries } from "../pool-registry-merge.js";
import { BackrunDetector } from "../detector/detector.js";
import { loadPinnedWarmPools } from "../pinned-warm-pools.js";
import { TemplatePlanner, type CandidatePlan } from "../planner/planner.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenPath,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { DEFAULT_POOL_UNIVERSE_PATH, loadPoolUniverse } from "../pool-universe.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { FlashLiquidityCache } from "../solver/flash-liquidity.js";
import { AnvilSolver, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";
import { evaluateEv } from "../ev-evaluator.js";
import { DEFAULT_BRIBE_BPS } from "../live-envelope.js";

interface EdgeSpec {
  adapterId: string;
  slotKind: "swap" | "protocol";
  tokenIn: string;
  tokenOut: string;
  target: string;
  poolId?: string;
}

interface HuntResult {
  schema_version: 2;
  fork_block: number;
  winner_tx_hash: string;
  winner_transaction_index: number;
  victim_tx_hash: string;
  stage: "not_admitted" | "path_found" | "final_sim_success";
  expected_pool_ids: string[];
  matched_pool_ids: string[];
  expected_route: EdgeSpec[];
  matched_route: EdgeSpec[];
  has_protocol_edge: boolean;
  closed_route: boolean;
  final_sim_success: boolean;
  net_profit_raw: string | null;
  pre_gross_raw: string | null;
  post_gross_raw: string | null;
  pre_execution_success: boolean | null;
  pre_execution_net_raw: string | null;
  post_execution_success: boolean | null;
  post_execution_net_raw: string | null;
  pre_execution_block: number | null;
  pre_execution_index: number | null;
  post_execution_block: number | null;
  post_execution_index: number | null;
  pre_state_anchor_kind: "parent-block" | "previous-tx";
  pre_state_anchor_hash: string | null;
  post_state_anchor_kind: "victim-tx";
  post_state_anchor_hash: string;
  victim_effect_kind: "swap" | "oracle" | null;
  oracle_route_edge_index: number | null;
  oracle_probe_amount_in_raw: string | null;
  oracle_before_amount_out_raw: string | null;
  oracle_after_amount_out_raw: string | null;
  trigger_route_signature: string | null;
  full_prefix_route_signature: string | null;
  full_prefix_gross_raw: string | null;
  full_prefix_execution_success: boolean | null;
  full_prefix_execution_net_raw: string | null;
  full_prefix_execution_block: number | null;
  full_prefix_execution_index: number | null;
  trigger_ev_bucket: "positive" | "non_positive" | "unverified";
  full_prefix_ev_bucket: "positive" | "non_positive" | "unverified";
  trigger_ev: ProductionEvEvidence | null;
  full_prefix_ev: ProductionEvEvidence | null;
  full_vs_trigger: "match" | "diverge" | "unverified";
  causal_replay_error: string | null;
}

interface StateAnchors {
  preKind: "parent-block" | "previous-tx";
  preHash: string | null;
  postHash: string;
}

interface VictimEffectProof {
  kind: "swap" | "oracle" | null;
  oracleRouteEdgeIndex: number | null;
  oracleProbeAmountIn: bigint | null;
  oracleBeforeAmountOut: bigint | null;
  oracleAfterAmountOut: bigint | null;
}

interface ExactExecutionResult {
  success: boolean;
  netProfit: bigint;
  blockNumber: number | null;
  transactionIndex: number | null;
  ev: ProductionEvEvidence | null;
}

interface ProductionEvEvidence {
  decision:
    | "allow"
    | "below_ev_gate"
    | "unpriceable_profit_token"
    | "missing_gas_estimate"
    | "missing_fee_state"
    | "disabled";
  profitToken: string;
  gasUsed: string;
  calldataHash: string;
  netEvWei: string;
  expectedProfitEth: string;
  gasCostEth: string;
  bidEth: string;
  minNetEth: string;
  decisionParentBlock: number;
  targetBlock: number;
  decisionParentHash: string | null;
  ethUsd: number | null;
  ethUsdRoundId: string | null;
  ethUsdUpdatedAt: string | null;
  maxBaseFeePerGas: string;
}

const CANDIDATE_CAP = 6;

function loadEnv(): void {
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnv();
  process.env.SEARCHER_DRY_RUN = "1";
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");
  const victimTxHash = requiredEnv("HUNT_VICTIM_TX_HASH").toLowerCase();
  const winnerTxHash = requiredEnv("HUNT_WINNER_TX_HASH").toLowerCase();
  const sampleBlock = positiveInt("HUNT_SAMPLE_BLOCK");
  const parentBlock = sampleBlock - 1;
  const route = parseRoute(requiredEnv("AB_EXPECTED_ROUTE_JSON"));
  const expectedPools = csv("AB_EXPECTED_POOL_IDS");
  const universePath = process.env.HUNT_UNIVERSE_PATH ?? DEFAULT_POOL_UNIVERSE_PATH;
  const maxPools = optionalPositiveInt("HUNT_MAX_POOLS", 6_000);
  const postPort = positiveInt("SEARCHER_BACKRUN_HUNT_ANVIL_PORT");
  const prePort = positiveInt("SEARCHER_BACKRUN_HUNT_PRE_ANVIL_PORT");
  const fullPrefixPort = positiveInt("SEARCHER_BACKRUN_HUNT_FULL_PREFIX_ANVIL_PORT");
  if (new Set([prePort, postPort, fullPrefixPort]).size !== 3) {
    throw new Error("boundary/trigger/full-prefix backrun hunt Anvil ports must differ");
  }
  const triggerKind = requiredEnv("AB_TRIGGER_KIND");
  if (triggerKind !== "victim-swap" && triggerKind !== "oracle-update") {
    throw new Error("AB_TRIGGER_KIND must be victim-swap|oracle-update");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const preState = new AnvilStateBackend(rpcUrl, `http://127.0.0.1:${prePort}`, prePort);
  const postState = new AnvilStateBackend(rpcUrl, `http://127.0.0.1:${postPort}`, postPort);
  const fullPrefixState = new AnvilStateBackend(
    rpcUrl,
    `http://127.0.0.1:${fullPrefixPort}`,
    fullPrefixPort,
  );
  try {
    const victim = await provider.getTransaction(victimTxHash);
    const receipt = await provider.getTransactionReceipt(victimTxHash);
    const winnerReceipt = await provider.getTransactionReceipt(winnerTxHash);
    if (!victim || !receipt || receipt.blockNumber !== sampleBlock) {
      throw new Error("victim transaction/receipt does not match HUNT_SAMPLE_BLOCK");
    }
    if (!winnerReceipt || winnerReceipt.blockNumber !== sampleBlock
        || Number(winnerReceipt.index) <= Number(receipt.index)) {
      throw new Error("winner transaction must follow the victim in HUNT_SAMPLE_BLOCK");
    }
    const winnerIndex = Number(winnerReceipt.index);
    const rawVictim = await rawTransaction(provider, victimTxHash, victim);
    const anchors: StateAnchors = {
      preKind: "parent-block",
      preHash: null,
      postHash: victimTxHash,
    };
    const graph = await routeGraph(provider, parentBlock, universePath, maxPools, route);
    const matchedPath = expectedPath(graph, route);
    if (!matchedPath) {
      emit(pathResult(
        parentBlock,
        winnerTxHash,
        winnerIndex,
        victimTxHash,
        expectedPools,
        route,
        [],
        "not_admitted",
        anchors,
      ));
      return;
    }

    await preState.forkAt(parentBlock);
    try {
      const triggerHashes = await postState.queueHistoricalRawTransactions(sampleBlock, [{
        rawTx: rawVictim,
        expectedHash: victimTxHash,
      }]);
      await postState.mineQueuedHistoricalBlock(triggerHashes, "trigger-only-block");
    } catch (error) {
      emit({
        ...pathResult(
          parentBlock,
          winnerTxHash,
          winnerIndex,
          victimTxHash,
          expectedPools,
          route,
          matchedPath,
          "not_admitted",
          anchors,
        ),
        causal_replay_error: errorMessage(error),
      });
      return;
    }

    let fullPrefixReady = true;
    let fullPrefixError: string | null = null;
    try {
      const fullPrefixHashes = await fullPrefixState.queueHistoricalBlockPrefix(
        sampleBlock,
        winnerIndex - 1,
      );
      await fullPrefixState.mineQueuedHistoricalBlock(fullPrefixHashes, "full-prefix-block");
    } catch (error) {
      fullPrefixReady = false;
      fullPrefixError = errorMessage(error);
    }
    await Promise.all([
      installForkBotVm(preState.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR),
      installForkBotVm(postState.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR),
      ...(fullPrefixReady
        ? [installForkBotVm(fullPrefixState.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR)]
        : []),
    ]);
    const detector = new BackrunDetector();
    detector.setGraph(graph);
    detector.setTokenQuery(latestTokenBackend(postState.provider));
    const event = {
      txHash: victimTxHash,
      blockNumber: sampleBlock,
      transactionIndex: Number(receipt.index),
      rawTx: rawVictim,
      from: victim.from,
      nonce: victim.nonce,
      to: victim.to,
      input: victim.data,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      })),
      minProfit: 1n,
      sourceBlockHash: (await provider.getBlock(parentBlock))?.hash ?? undefined,
      logsCompleteness: "complete-receipt" as const,
      victimState: "materialized" as const,
    };

    const opportunities = await detector.detect(event, postState);
    if (opportunities.length === 0) {
      emit({
        ...pathResult(
          parentBlock,
          winnerTxHash,
          winnerIndex,
          victimTxHash,
          expectedPools,
          route,
          matchedPath,
          "not_admitted",
          anchors,
        ),
        causal_replay_error: fullPrefixError,
      });
      return;
    }

    const planner = new TemplatePlanner();
    planner.setGraph(graph);
    planner.setMaxHops(Math.max(3, route.length));
    planner.setMaxPoolsPerToken(8);
    planner.setMaxCandidates(20);
    const flashLiquidity = new FlashLiquidityCache(postState.provider, [
      { adapterId: "morpho-flash", holder: ADDR.MORPHO },
      { adapterId: "balancer-flash", holder: ADDR.BALANCER_VAULT },
    ]);
    await flashLiquidity.refresh(unique(graph.flatMap((edge) => [edge.tokenIn, edge.tokenOut])));
    planner.setFlashLiquidity(flashLiquidity);

    const plans: CandidatePlan[] = [];
    for (const opportunity of opportunities) {
      plans.push(...await planner.plan(opportunity, [FLASH_SWAP_REPAY]));
    }
    const expectedIndex = plans.findIndex((plan) => pathMatches(plan.tokenPath, route));
    if (expectedIndex < 0 || expectedIndex >= CANDIDATE_CAP) {
      emit({
        ...pathResult(
          parentBlock,
          winnerTxHash,
          winnerIndex,
          victimTxHash,
          expectedPools,
          route,
          matchedPath,
          "not_admitted",
          anchors,
        ),
        causal_replay_error: fullPrefixError,
      });
      return;
    }
    const selectedPlan = plans[expectedIndex];
    const effectProof = await victimEffectProof(
      selectedPlan,
      route,
      triggerKind,
      preState,
      postState,
    );

    let solved: ResolvedPlan;
    try {
      solved = await solveCandidate(postState, selectedPlan);
    } catch {
      emit({
        ...pathResult(
          parentBlock,
          winnerTxHash,
          winnerIndex,
          victimTxHash,
          expectedPools,
          route,
          matchedPath,
          "path_found",
          anchors,
        ),
        ...proofResult(effectProof),
        causal_replay_error: fullPrefixError,
      });
      return;
    }
    const post = await propagateAmountsWithRawOutputs(selectedPlan.tokenPath, solved.flashAmount, postState, {
      safetyBps: 10000n,
    });
    const postGross = post.amounts.at(-1)! - solved.flashAmount;
    const pre = await propagateAmountsWithRawOutputs(selectedPlan.tokenPath, solved.flashAmount, preState, {
      safetyBps: 10000n,
    });
    const preGross = pre.amounts.at(-1)! - solved.flashAmount;
    const postExecution = await executeResolvedPlanWithRawPrefix(
      postState,
      solved,
      sampleBlock,
      [{ rawTx: rawVictim, expectedHash: victimTxHash }],
    );
    const preExecution = await executeResolvedPlanWithRawPrefix(
      preState,
      solved,
      sampleBlock,
      [],
    );
    const signature = routeSignature(route);
    let fullPrefixGross: bigint | null = null;
    let fullPrefixExecution: ExactExecutionResult | null = null;
    let fullPrefixSignature: string | null = null;
    if (fullPrefixReady) {
      try {
        const fullPrefixSolved = await solveCandidate(fullPrefixState, selectedPlan);
        const fullPrefixAmounts = await propagateAmountsWithRawOutputs(
          selectedPlan.tokenPath,
          fullPrefixSolved.flashAmount,
          fullPrefixState,
          { safetyBps: 10000n },
        );
        fullPrefixGross = fullPrefixAmounts.amounts.at(-1)! - fullPrefixSolved.flashAmount;
        fullPrefixExecution = await executeResolvedPlanInHistoricalBlock(
          fullPrefixState,
          fullPrefixSolved,
          sampleBlock,
          winnerIndex - 1,
        );
        fullPrefixSignature = signature;
      } catch (error) {
        fullPrefixError = errorMessage(error);
      }
    }
    const triggerBucket = evBucket(postExecution);
    const fullPrefixBucket = evBucket(fullPrefixExecution);
    const fullVsTrigger = fullPrefixExecution === null
      ? "unverified"
      : fullPrefixSignature === signature
        && fullPrefixExecution.success === postExecution.success
        && fullPrefixBucket === triggerBucket
        ? "match"
        : "diverge";
    const finalSuccess = postExecution.success && postExecution.netProfit > 0n
      && !preExecution.success && preExecution.netProfit <= 0n
      && preGross <= 0n && postGross > 0n
      && preExecution.blockNumber === sampleBlock
      && preExecution.transactionIndex === 0
      && postExecution.blockNumber === sampleBlock
      && postExecution.transactionIndex === 1
      && fullPrefixExecution?.blockNumber === sampleBlock
      && fullPrefixExecution.transactionIndex === winnerIndex
      && fullVsTrigger === "match"
      && effectProof.kind === (triggerKind === "oracle-update" ? "oracle" : "swap")
      && (triggerKind !== "oracle-update"
        || effectProof.oracleBeforeAmountOut !== effectProof.oracleAfterAmountOut);
    emit({
      ...pathResult(
        parentBlock,
        winnerTxHash,
        winnerIndex,
        victimTxHash,
        expectedPools,
        route,
        matchedPath,
        finalSuccess ? "final_sim_success" : "path_found",
        anchors,
      ),
      ...proofResult(effectProof),
      final_sim_success: finalSuccess,
      net_profit_raw: postExecution.netProfit.toString(),
      pre_gross_raw: preGross.toString(),
      post_gross_raw: postGross.toString(),
      pre_execution_success: preExecution.success,
      pre_execution_net_raw: preExecution.netProfit.toString(),
      post_execution_success: postExecution.success,
      post_execution_net_raw: postExecution.netProfit.toString(),
      pre_execution_block: preExecution.blockNumber,
      pre_execution_index: preExecution.transactionIndex,
      post_execution_block: postExecution.blockNumber,
      post_execution_index: postExecution.transactionIndex,
      trigger_route_signature: signature,
      full_prefix_route_signature: fullPrefixSignature,
      full_prefix_gross_raw: fullPrefixGross?.toString() ?? null,
      full_prefix_execution_success: fullPrefixExecution?.success ?? null,
      full_prefix_execution_net_raw: fullPrefixExecution?.netProfit.toString() ?? null,
      full_prefix_execution_block: fullPrefixExecution?.blockNumber ?? null,
      full_prefix_execution_index: fullPrefixExecution?.transactionIndex ?? null,
      trigger_ev_bucket: triggerBucket,
      full_prefix_ev_bucket: fullPrefixBucket,
      trigger_ev: postExecution.ev,
      full_prefix_ev: fullPrefixExecution?.ev ?? null,
      full_vs_trigger: fullVsTrigger,
      causal_replay_error: fullPrefixError,
    });
  } finally {
    preState.stop();
    postState.stop();
    fullPrefixState.stop();
    provider.destroy();
  }
}

async function routeGraph(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  universePath: string,
  maxPools: number,
  route: EdgeSpec[],
): Promise<TokenEdge[]> {
  const universe = loadPoolUniverse(universePath, { maxPools, minScore: 1 });
  const protocol = POOL_REGISTRY.filter((pool) => pool.adapter !== "fluid-vault");
  const committed = mergePoolRegistries(mergePoolRegistries(universe, protocol), loadPinnedWarmPools())
    .map(lowerPoolEntry);
  const identities = new Set(route.flatMap((edge) => [edge.target, edge.poolId])
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase()));
  const required = committed.filter((pool) =>
    identities.has(pool.address.toLowerCase()) ||
    (pool.poolId ? identities.has(pool.poolId.toLowerCase()) : false),
  );
  return buildTokenGraph(tokenBackend(provider, blockNumber), required);
}

function lowerPoolEntry(pool: PoolEntry): PoolEntry {
  return {
    ...pool,
    address: lowerAddress(pool.address),
    token0: lowerOptionalAddress(pool.token0),
    token1: lowerOptionalAddress(pool.token1),
    currency0: lowerOptionalAddress(pool.currency0),
    currency1: lowerOptionalAddress(pool.currency1),
    hooks: lowerOptionalAddress(pool.hooks),
    fixedTokenIn: lowerOptionalAddress(pool.fixedTokenIn),
    fixedTokenOut: lowerOptionalAddress(pool.fixedTokenOut),
    poolId: pool.poolId?.toLowerCase(),
  };
}

function lowerOptionalAddress(value: string | undefined): string | undefined {
  return value === undefined ? undefined : lowerAddress(value);
}

function lowerAddress(value: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress.toLowerCase();
  return ethers.getAddress(value.toLowerCase()).toLowerCase();
}

function latestTokenBackend(provider: ethers.JsonRpcProvider): TokenQueryBackend {
  return {
    call: (req) => provider.call({ to: req.to, data: req.data }),
    getLogs: async (req) => provider.send("eth_getLogs", [req]),
  };
}

async function victimEffectProof(
  plan: CandidatePlan,
  route: EdgeSpec[],
  triggerKind: "victim-swap" | "oracle-update",
  preState: AnvilStateBackend,
  postState: AnvilStateBackend,
): Promise<VictimEffectProof> {
  const opportunity = plan.opportunity as unknown as {
    victimEffect?: {
      kind?: unknown;
    };
  };
  const effect = opportunity.victimEffect;
  if (triggerKind === "victim-swap") {
    return emptyProof(effect?.kind === "swap" ? "swap" : null);
  }
  if (effect?.kind !== "oracle") return emptyProof(null);

  const edgeIndex = optionalNonNegativeInt("AB_ORACLE_ROUTE_EDGE_INDEX");
  if (edgeIndex === null || edgeIndex >= route.length) return emptyProof("oracle");
  const spec = route[edgeIndex];
  const edge = plan.tokenPath.edges.find((candidate) => edgeMatches(candidate, spec));
  if (!edge) return emptyProof("oracle");
  try {
    const trustedRoot = resolve(requiredEnv("HUNT_TRUSTED_ROOT"));
    const trustedQuoter = await import(pathToFileURL(resolve(
      trustedRoot,
      "listener/src/searcher/solver/quoter.ts",
    )).href) as typeof import("../solver/quoter.js");
    const probeAmount = await oneToken(preState, edge.tokenIn);
    const quoteArgs = [
      edge.adapterId,
      edge.target,
      edge.tokenIn,
      edge.tokenOut,
      probeAmount,
    ] as const;
    const before = await trustedQuoter.quote(
      ...quoteArgs,
      preState,
      undefined,
      edge.v4PoolKey,
      edge.poolToken0,
      edge.poolToken1,
    );
    const after = await trustedQuoter.quote(
      ...quoteArgs,
      postState,
      undefined,
      edge.v4PoolKey,
      edge.poolToken0,
      edge.poolToken1,
    );
    return {
      kind: "oracle",
      oracleRouteEdgeIndex: edgeIndex,
      oracleProbeAmountIn: probeAmount,
      oracleBeforeAmountOut: before,
      oracleAfterAmountOut: after,
    };
  } catch {
    return emptyProof("oracle");
  }
}

async function oneToken(state: AnvilStateBackend, token: string): Promise<bigint> {
  if (same(token, ethers.ZeroAddress)) return 10n ** 18n;
  const iface = new ethers.Interface(["function decimals() view returns (uint8)"]);
  const data = await state.call({ to: token, data: iface.encodeFunctionData("decimals") });
  const decimals = Number(iface.decodeFunctionResult("decimals", data)[0]);
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`invalid token decimals ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

function emptyProof(kind: "swap" | "oracle" | null): VictimEffectProof {
  return {
    kind,
    oracleRouteEdgeIndex: null,
    oracleProbeAmountIn: null,
    oracleBeforeAmountOut: null,
    oracleAfterAmountOut: null,
  };
}

function proofResult(proof: VictimEffectProof): Pick<
  HuntResult,
  | "victim_effect_kind"
  | "oracle_route_edge_index"
  | "oracle_probe_amount_in_raw"
  | "oracle_before_amount_out_raw"
  | "oracle_after_amount_out_raw"
> {
  return {
    victim_effect_kind: proof.kind,
    oracle_route_edge_index: proof.oracleRouteEdgeIndex,
    oracle_probe_amount_in_raw: proof.oracleProbeAmountIn?.toString() ?? null,
    oracle_before_amount_out_raw: proof.oracleBeforeAmountOut?.toString() ?? null,
    oracle_after_amount_out_raw: proof.oracleAfterAmountOut?.toString() ?? null,
  };
}

async function rawTransaction(
  provider: ethers.JsonRpcProvider,
  hash: string,
  tx: ethers.TransactionResponse,
): Promise<string> {
  const raw = await provider.send("eth_getRawTransactionByHash", [hash]);
  if (typeof raw === "string" && raw !== "0x") return raw;
  return ethers.Transaction.from({
    type: tx.type,
    to: tx.to,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    data: tx.data,
    value: tx.value,
    chainId: tx.chainId,
    accessList: tx.accessList,
    signature: tx.signature,
  }).serialized;
}

async function solveCandidate(state: AnvilStateBackend, plan: CandidatePlan): Promise<ResolvedPlan> {
  return new AnvilSolver().solve(
    plan,
    state,
    new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER),
    {
      finalSimTopN: 6,
      gssMaxTries: 10,
      quoteProfitFloorBps: 0n,
      quoteSafetyBps: 10000n,
    },
  );
}

async function executeResolvedPlanWithRawPrefix(
  state: AnvilStateBackend,
  plan: ResolvedPlan,
  blockNumber: number,
  transactions: Array<{ rawTx: string; expectedHash: string }>,
): Promise<ExactExecutionResult> {
  return executeResolvedPlan(state, plan, async () =>
    state.queueHistoricalRawTransactions(blockNumber, transactions));
}

async function executeResolvedPlanInHistoricalBlock(
  state: AnvilStateBackend,
  plan: ResolvedPlan,
  blockNumber: number,
  prefixThroughIndex: number,
): Promise<ExactExecutionResult> {
  return executeResolvedPlan(state, plan, async () =>
    state.queueHistoricalBlockPrefix(blockNumber, prefixThroughIndex));
}

async function executeResolvedPlan(
  state: AnvilStateBackend,
  plan: ResolvedPlan,
  queuePrefix: () => Promise<string[]>,
): Promise<ExactExecutionResult> {
  const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const balanceData = erc20.encodeFunctionData("balanceOf", [DEFAULT_SEARCHER_EXECUTOR]);
  try {
    const prefixHashes = await queuePrefix();
    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    const pre = BigInt(await state.provider.call({ to: plan.profitToken, data: balanceData }));
    const script = compilePlan(plan.root, DEFAULT_SEARCHER_EXECUTOR);
    const calldata = buildExecuteCalldata(script);
    await state.provider.send("anvil_setBalance", [
      ethers.getAddress(DEFAULT_SEARCHER_OWNER),
      "0x56bc75e2d63100000",
    ]);
    await state.provider.send("anvil_impersonateAccount", [ethers.getAddress(DEFAULT_SEARCHER_OWNER)]);
    const txHash = await state.provider.send("eth_sendTransaction", [{
      from: ethers.getAddress(DEFAULT_SEARCHER_OWNER),
      to: ethers.getAddress(DEFAULT_SEARCHER_EXECUTOR),
      data: calldata,
      gas: "0x1000000",
    }]);
    await state.mineQueuedHistoricalBlock([...prefixHashes, txHash], "backrun-counterfactual-block");
    const receipt = await state.provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return { success: false, netProfit: 0n, blockNumber: null, transactionIndex: null, ev: null };
    }
    const post = BigInt(await state.provider.call({ to: plan.profitToken, data: balanceData }));
    const netProfit = post - pre;
    const ev = await productionEvEvidence(
      state,
      plan,
      netProfit,
      receipt.gasUsed,
      calldata,
      receipt.blockNumber,
    );
    return {
      success: netProfit > 0n,
      netProfit,
      blockNumber: receipt.blockNumber,
      transactionIndex: Number(receipt.index),
      ev,
    };
  } catch {
    return { success: false, netProfit: 0n, blockNumber: null, transactionIndex: null, ev: null };
  }
}

function evBucket(result: ExactExecutionResult | null): HuntResult["trigger_ev_bucket"] {
  if (result === null) return "unverified";
  if (!result.ev) return "unverified";
  return result.success && result.netProfit > 0n && result.ev.decision === "allow"
    ? "positive"
    : "non_positive";
}

async function productionEvEvidence(
  state: AnvilStateBackend,
  plan: ResolvedPlan,
  netProfit: bigint,
  gasUsed: bigint,
  calldata: string,
  targetBlock: number,
): Promise<ProductionEvEvidence> {
  const decisionParentBlock = targetBlock - 1;
  const minNetEth = BigInt(process.env.SEARCHER_MIN_NET_ETH ?? "0");
  const evGate = process.env.SEARCHER_EV_GATE === "1";
  const evaluation = await evaluateEv(
    state.provider,
    plan.profitToken,
    netProfit,
    gasUsed,
    {
      profitHaircutBps: Number(process.env.SEARCHER_PROFIT_HAIRCUT_BPS ?? "0"),
      evGate,
      bribeAllAboveGas: process.env.SEARCHER_BRIBE_ALL_ABOVE_GAS === "1",
      bribeBps: Number(process.env.SEARCHER_BRIBE_BPS ?? DEFAULT_BRIBE_BPS.toString()),
    },
    undefined,
    decisionParentBlock,
  );
  const targetHeader = await state.provider.getBlock(targetBlock);
  if (
    evaluation.feeStateAvailable &&
    targetHeader?.baseFeePerGas !== evaluation.maxBaseFeePerGas
  ) {
    throw new Error(
      `EV fee anchor mismatch parent=${decisionParentBlock} target=${targetBlock} ` +
      `predicted=${evaluation.maxBaseFeePerGas} actual=${targetHeader?.baseFeePerGas ?? "missing"}`,
    );
  }
  return {
    decision: !evGate
      ? "disabled"
      : !evaluation.valuationAvailable
        ? "unpriceable_profit_token"
        : !evaluation.gasMeasurementAvailable
          ? "missing_gas_estimate"
          : !evaluation.feeStateAvailable
            ? "missing_fee_state"
            : evaluation.netEvWei <= minNetEth
              ? "below_ev_gate"
              : "allow",
    profitToken: plan.profitToken.toLowerCase(),
    gasUsed: gasUsed.toString(),
    calldataHash: createHash("sha256").update(calldata).digest("hex"),
    netEvWei: evaluation.netEvWei.toString(),
    expectedProfitEth: evaluation.expectedProfitEth.toString(),
    gasCostEth: evaluation.gasCostEth.toString(),
    bidEth: evaluation.bidEth.toString(),
    minNetEth: minNetEth.toString(),
    decisionParentBlock,
    targetBlock,
    decisionParentHash: evaluation.sourceBlockHash,
    ethUsd: evaluation.ethUsd,
    ethUsdRoundId: evaluation.ethUsdRoundId?.toString() ?? null,
    ethUsdUpdatedAt: evaluation.ethUsdUpdatedAt?.toString() ?? null,
    maxBaseFeePerGas: evaluation.maxBaseFeePerGas.toString(),
  };
}

function routeSignature(route: EdgeSpec[]): string {
  return route.map((edge) => [
    edge.adapterId,
    edge.slotKind,
    edge.target.toLowerCase(),
    edge.tokenIn.toLowerCase(),
    edge.tokenOut.toLowerCase(),
    edge.poolId?.toLowerCase() ?? "",
  ].join(":"))
    .join("|");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function pathResult(
  forkBlock: number,
  winnerTxHash: string,
  winnerTransactionIndex: number,
  victimTxHash: string,
  expectedPools: string[],
  expectedRoute: EdgeSpec[],
  path: TokenEdge[],
  stage: HuntResult["stage"],
  anchors: StateAnchors,
): HuntResult {
  return {
    schema_version: 2,
    fork_block: forkBlock,
    winner_tx_hash: winnerTxHash,
    winner_transaction_index: winnerTransactionIndex,
    victim_tx_hash: victimTxHash,
    stage,
    expected_pool_ids: expectedPools,
    matched_pool_ids: unique(path.map((edge) => (edge.poolId ?? edge.target).toLowerCase())),
    expected_route: normalizeRoute(expectedRoute),
    matched_route: normalizePath(path),
    has_protocol_edge: path.some((edge) => edge.slotKind === "protocol"),
    closed_route: path.length > 1 && same(path[0].tokenIn, path.at(-1)!.tokenOut),
    final_sim_success: false,
    net_profit_raw: null,
    pre_gross_raw: null,
    post_gross_raw: null,
    pre_execution_success: null,
    pre_execution_net_raw: null,
    post_execution_success: null,
    post_execution_net_raw: null,
    pre_execution_block: null,
    pre_execution_index: null,
    post_execution_block: null,
    post_execution_index: null,
    pre_state_anchor_kind: anchors.preKind,
    pre_state_anchor_hash: anchors.preHash,
    post_state_anchor_kind: "victim-tx",
    post_state_anchor_hash: anchors.postHash,
    victim_effect_kind: null,
    oracle_route_edge_index: null,
    oracle_probe_amount_in_raw: null,
    oracle_before_amount_out_raw: null,
    oracle_after_amount_out_raw: null,
    trigger_route_signature: null,
    full_prefix_route_signature: null,
    full_prefix_gross_raw: null,
    full_prefix_execution_success: null,
    full_prefix_execution_net_raw: null,
    full_prefix_execution_block: null,
    full_prefix_execution_index: null,
    trigger_ev_bucket: "unverified",
    full_prefix_ev_bucket: "unverified",
    trigger_ev: null,
    full_prefix_ev: null,
    full_vs_trigger: "unverified",
    causal_replay_error: null,
  };
}

function expectedPath(graph: TokenEdge[], specs: EdgeSpec[]): TokenEdge[] | null {
  const path: TokenEdge[] = [];
  for (const spec of specs) {
    const edge = graph.find((candidate) => edgeMatches(candidate, spec));
    if (!edge) return null;
    path.push(edge);
  }
  return path;
}

function pathMatches(path: TokenPath, specs: EdgeSpec[]): boolean {
  return path.edges.length === specs.length && specs.some((_spec, offset) =>
    path.edges.every((edge, index) => edgeMatches(edge, specs[(index + offset) % specs.length])),
  );
}

function edgeMatches(edge: TokenEdge, spec: EdgeSpec): boolean {
  return edge.adapterId === spec.adapterId &&
    edge.slotKind === spec.slotKind &&
    same(edge.tokenIn, spec.tokenIn) &&
    same(edge.tokenOut, spec.tokenOut) &&
    same(edge.target, spec.target) &&
    (!spec.poolId || same(edge.poolId ?? "", spec.poolId));
}

function tokenBackend(provider: ethers.JsonRpcProvider, blockNumber: number): TokenQueryBackend {
  return {
    call: (req) => provider.call({ to: req.to, data: req.data, blockTag: blockNumber }),
    getLogs: async (req) => provider.send("eth_getLogs", [req]),
  };
}

function parseRoute(raw: string): EdgeSpec[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 8) {
    throw new Error("AB_EXPECTED_ROUTE_JSON must contain 2..8 edges");
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("route edge must be an object");
    const edge = entry as Record<string, unknown>;
    for (const key of ["adapterId", "target", "tokenIn", "tokenOut"] as const) {
      if (typeof edge[key] !== "string" || edge[key].length === 0) {
        throw new Error(`route edge ${key} missing`);
      }
    }
    if (edge.slotKind !== "swap" && edge.slotKind !== "protocol") {
      throw new Error("route edge slotKind must be swap|protocol");
    }
    return edge as unknown as EdgeSpec;
  });
}

function normalizeRoute(route: EdgeSpec[]): EdgeSpec[] {
  return route.map((edge) => ({
    adapterId: edge.adapterId,
    slotKind: edge.slotKind,
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
  }));
}

function normalizePath(path: TokenEdge[]): EdgeSpec[] {
  return path.map((edge) => ({
    adapterId: edge.adapterId,
    slotKind: edge.slotKind === "protocol" ? "protocol" : "swap",
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
  }));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} required`);
  return value;
}

function positiveInt(name: string): number {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalNonNegativeInt(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function csv(name: string): string[] {
  return requiredEnv(name).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function emit(result: HuntResult): void {
  console.log(`BACKRUN_HUNT_RESULT=${JSON.stringify(result)}`);
}

main().catch((error) => {
  console.error(`backrun-hunt FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
