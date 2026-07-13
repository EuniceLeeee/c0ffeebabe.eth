/**
 * Trusted production gate for victim-driven backruns.
 *
 * The wrapper copies this main-side source into each target worktree before
 * execution, so a challenger cannot weaken its own replay. The expected route
 * and victim are data supplied by the signed A/B report, not hard-coded here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import {
  buildExecuteCalldata,
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { mergePoolRegistries } from "../active-pool-discovery.js";
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

interface EdgeSpec {
  adapterId: string;
  tokenIn: string;
  tokenOut: string;
  target?: string;
  poolId?: string;
}

interface HuntResult {
  schema_version: 1;
  fork_block: number;
  victim_tx_hash: string;
  stage: "not_admitted" | "path_found" | "final_sim_success";
  expected_pool_ids: string[];
  matched_pool_ids: string[];
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
  pre_state_anchor_kind: "parent-block" | "previous-tx";
  pre_state_anchor_hash: string | null;
  post_state_anchor_kind: "victim-tx";
  post_state_anchor_hash: string;
  victim_effect_kind: "swap" | "oracle" | null;
  oracle_route_edge_index: number | null;
  oracle_probe_amount_in_raw: string | null;
  oracle_before_amount_out_raw: string | null;
  oracle_after_amount_out_raw: string | null;
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
  const sampleBlock = positiveInt("HUNT_SAMPLE_BLOCK");
  const parentBlock = sampleBlock - 1;
  const route = parseRoute(requiredEnv("AB_EXPECTED_ROUTE_JSON"));
  const expectedPools = csv("AB_EXPECTED_POOL_IDS");
  const universePath = process.env.HUNT_UNIVERSE_PATH ?? DEFAULT_POOL_UNIVERSE_PATH;
  const maxPools = optionalPositiveInt("HUNT_MAX_POOLS", 6_000);
  const postPort = positiveInt("SEARCHER_BACKRUN_HUNT_ANVIL_PORT");
  const prePort = positiveInt("SEARCHER_BACKRUN_HUNT_PRE_ANVIL_PORT");
  if (prePort === postPort) throw new Error("pre/post backrun hunt Anvil ports must differ");
  const triggerKind = requiredEnv("AB_TRIGGER_KIND");
  if (triggerKind !== "victim-swap" && triggerKind !== "oracle-update") {
    throw new Error("AB_TRIGGER_KIND must be victim-swap|oracle-update");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const preState = new AnvilStateBackend(rpcUrl, `http://127.0.0.1:${prePort}`, prePort);
  const postState = new AnvilStateBackend(rpcUrl, `http://127.0.0.1:${postPort}`, postPort);
  try {
    const victim = await provider.getTransaction(victimTxHash);
    const receipt = await provider.getTransactionReceipt(victimTxHash);
    if (!victim || !receipt || receipt.blockNumber !== sampleBlock) {
      throw new Error("victim transaction/receipt does not match HUNT_SAMPLE_BLOCK");
    }
    const rawVictim = await rawTransaction(provider, victimTxHash, victim);
    const anchors = await stateAnchors(provider, sampleBlock, Number(receipt.index), victimTxHash);
    const graph = await routeGraph(provider, parentBlock, universePath, maxPools, route);
    const matchedPath = expectedPath(graph, route);
    if (!matchedPath) {
      emit(pathResult(parentBlock, victimTxHash, expectedPools, [], "not_admitted", anchors));
      return;
    }

    await prepareExactPreState(
      provider,
      preState,
      parentBlock,
      sampleBlock,
      Number(receipt.index),
      anchors,
    );
    await postState.prepareVictimPostState({
      txHash: victimTxHash,
      rawTx: rawVictim,
      from: victim.from,
      nonce: victim.nonce,
      transactionIndex: Number(receipt.index),
      blockNumber: sampleBlock,
      preferSequentialPrefix: true,
    });
    await Promise.all([
      installForkBotVm(preState.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR),
      installForkBotVm(postState.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR),
    ]);
    const detector = new BackrunDetector();
    detector.setGraph(graph);
    detector.setTokenQuery(latestTokenBackend(preState.provider));
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
    };

    const opportunities = await detector.detect(event, postState);
    if (opportunities.length === 0) {
      emit(pathResult(parentBlock, victimTxHash, expectedPools, matchedPath, "not_admitted", anchors));
      return;
    }

    const planner = new TemplatePlanner();
    planner.setGraph(graph);
    planner.setMaxHops(Math.max(3, route.length));
    planner.setMaxPoolsPerToken(8);
    planner.setMaxCandidates(20);
    const flashLiquidity = new FlashLiquidityCache(postState.provider);
    await flashLiquidity.refresh(unique(graph.flatMap((edge) => [edge.tokenIn, edge.tokenOut])));
    planner.setFlashLiquidity(flashLiquidity);

    const plans: CandidatePlan[] = [];
    for (const opportunity of opportunities) {
      plans.push(...await planner.plan(opportunity, [FLASH_SWAP_REPAY]));
    }
    const expectedIndex = plans.findIndex((plan) => pathMatches(plan.tokenPath, route));
    if (expectedIndex < 0 || expectedIndex >= CANDIDATE_CAP) {
      emit(pathResult(parentBlock, victimTxHash, expectedPools, matchedPath, "not_admitted", anchors));
      return;
    }
    const selectedPlan = plans[expectedIndex];
    const effectProof = victimEffectProof(selectedPlan, route, triggerKind);

    let solved: ResolvedPlan;
    try {
      solved = await solveCandidate(postState, selectedPlan);
    } catch {
      emit({
        ...pathResult(parentBlock, victimTxHash, expectedPools, matchedPath, "path_found", anchors),
        ...proofResult(effectProof),
      });
      return;
    }
    const post = await propagateAmountsWithRawOutputs(selectedPlan.tokenPath, solved.flashAmount, postState, {
      safetyBps: 10000n,
    });
    const postGross = post.amounts.at(-1)! - solved.flashAmount;
    const postExecution = await executeResolvedPlan(postState, solved);
    const pre = await propagateAmountsWithRawOutputs(selectedPlan.tokenPath, solved.flashAmount, preState, {
      safetyBps: 10000n,
    });
    const preGross = pre.amounts.at(-1)! - solved.flashAmount;
    const preExecution = await executeResolvedPlan(preState, solved);
    const finalSuccess = postExecution.success && postExecution.netProfit > 0n
      && !preExecution.success && preExecution.netProfit <= 0n
      && preGross <= 0n && postGross > 0n
      && effectProof.kind === (triggerKind === "oracle-update" ? "oracle" : "swap")
      && (triggerKind !== "oracle-update"
        || effectProof.oracleBeforeAmountOut !== effectProof.oracleAfterAmountOut);
    emit({
      ...pathResult(
        parentBlock,
        victimTxHash,
        expectedPools,
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
    });
  } finally {
    preState.stop();
    postState.stop();
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

async function stateAnchors(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  victimIndex: number,
  victimTxHash: string,
): Promise<StateAnchors> {
  if (victimIndex === 0) {
    return { preKind: "parent-block", preHash: null, postHash: victimTxHash };
  }
  const block = await provider.getBlock(blockNumber, true);
  if (!block) throw new Error(`block ${blockNumber} unavailable`);
  const victim = block.prefetchedTransactions[victimIndex];
  const previous = block.prefetchedTransactions[victimIndex - 1];
  if (!victim || victim.hash.toLowerCase() !== victimTxHash.toLowerCase()) {
    throw new Error(`victim transaction ${victimIndex} unavailable in block ${blockNumber}`);
  }
  if (!previous) throw new Error(`previous transaction ${victimIndex - 1} unavailable`);
  return {
    preKind: "previous-tx",
    preHash: previous.hash.toLowerCase(),
    postHash: victimTxHash,
  };
}

async function prepareExactPreState(
  provider: ethers.JsonRpcProvider,
  state: AnvilStateBackend,
  parentBlock: number,
  sampleBlock: number,
  victimIndex: number,
  anchors: StateAnchors,
): Promise<void> {
  if (anchors.preKind === "parent-block") {
    await state.forkAt(parentBlock);
    return;
  }
  if (!anchors.preHash) throw new Error("previous-tx anchor hash missing");
  const previous = await provider.getTransaction(anchors.preHash);
  if (!previous || !previous.from) throw new Error("previous transaction details unavailable");
  await state.prepareVictimPostState({
    txHash: anchors.preHash,
    rawTx: await rawTransaction(provider, anchors.preHash, previous),
    from: previous.from,
    nonce: previous.nonce,
    transactionIndex: victimIndex - 1,
    blockNumber: sampleBlock,
    preferSequentialPrefix: true,
  });
}

function latestTokenBackend(provider: ethers.JsonRpcProvider): TokenQueryBackend {
  return {
    call: (req) => provider.call({ to: req.to, data: req.data }),
    getLogs: async (req) => provider.send("eth_getLogs", [req]),
  };
}

function victimEffectProof(
  plan: CandidatePlan,
  route: EdgeSpec[],
  triggerKind: "victim-swap" | "oracle-update",
): VictimEffectProof {
  const opportunity = plan.opportunity as unknown as {
    victimEffect?: {
      kind?: unknown;
      priceChanges?: Array<{
        adapterId?: unknown;
        target?: unknown;
        tokenIn?: unknown;
        tokenOut?: unknown;
        probeAmountIn?: unknown;
        beforeAmountOut?: unknown;
        afterAmountOut?: unknown;
      }>;
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
  const change = (effect.priceChanges ?? []).find((candidate) =>
    candidate.adapterId === spec.adapterId
      && same(String(candidate.tokenIn ?? ""), spec.tokenIn)
      && same(String(candidate.tokenOut ?? ""), spec.tokenOut)
      && (!spec.target || same(String(candidate.target ?? ""), spec.target)),
  );
  if (!change) return emptyProof("oracle");
  try {
    return {
      kind: "oracle",
      oracleRouteEdgeIndex: edgeIndex,
      oracleProbeAmountIn: BigInt(change.probeAmountIn as bigint),
      oracleBeforeAmountOut: BigInt(change.beforeAmountOut as bigint),
      oracleAfterAmountOut: BigInt(change.afterAmountOut as bigint),
    };
  } catch {
    return emptyProof("oracle");
  }
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

async function executeResolvedPlan(
  state: AnvilStateBackend,
  plan: ResolvedPlan,
): Promise<{ success: boolean; netProfit: bigint }> {
  const snapshot = await state.snapshot();
  const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const balanceData = erc20.encodeFunctionData("balanceOf", [DEFAULT_SEARCHER_EXECUTOR]);
  try {
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
    await state.provider.send("evm_mine", []);
    const receipt = await state.provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return { success: false, netProfit: 0n };
    const post = BigInt(await state.provider.call({ to: plan.profitToken, data: balanceData }));
    const netProfit = post - pre;
    return { success: netProfit > 0n, netProfit };
  } catch {
    return { success: false, netProfit: 0n };
  } finally {
    await state.revert(snapshot);
  }
}

function pathResult(
  forkBlock: number,
  victimTxHash: string,
  expectedPools: string[],
  path: TokenEdge[],
  stage: HuntResult["stage"],
  anchors: StateAnchors,
): HuntResult {
  return {
    schema_version: 1,
    fork_block: forkBlock,
    victim_tx_hash: victimTxHash,
    stage,
    expected_pool_ids: expectedPools,
    matched_pool_ids: unique(path.map((edge) => (edge.poolId ?? edge.target).toLowerCase())),
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
    pre_state_anchor_kind: anchors.preKind,
    pre_state_anchor_hash: anchors.preHash,
    post_state_anchor_kind: "victim-tx",
    post_state_anchor_hash: anchors.postHash,
    victim_effect_kind: null,
    oracle_route_edge_index: null,
    oracle_probe_amount_in_raw: null,
    oracle_before_amount_out_raw: null,
    oracle_after_amount_out_raw: null,
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
    same(edge.tokenIn, spec.tokenIn) &&
    same(edge.tokenOut, spec.tokenOut) &&
    (!spec.target || same(edge.target, spec.target)) &&
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
    for (const key of ["adapterId", "tokenIn", "tokenOut"] as const) {
      if (typeof edge[key] !== "string" || edge[key].length === 0) {
        throw new Error(`route edge ${key} missing`);
      }
    }
    return edge as unknown as EdgeSpec;
  });
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
