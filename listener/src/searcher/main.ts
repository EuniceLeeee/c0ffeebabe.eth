import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../shared/adapters/index.js";
import { AnvilStateBackend } from "../shared/state/state-backend.js";
import { BackrunDetector } from "./detector/detector.js";
import { ProductionBundleRouter, DryRunBundleRouter } from "./execution/bundle-router.js";
import { TemplatePlanner } from "./planner/planner.js";
import {
  buildTokenGraph,
  buildTokenIndex,
  POOL_REGISTRY,
  type TokenEdge,
  type TokenQueryBackend,
} from "./planner/token-graph.js";
import { scanActivePools, indexFactoryPools, mergePoolRegistries } from "./active-pool-discovery.js";
import { AnvilSolver } from "./solver/solver.js";
import { PoolStateCache } from "./solver/pool-state-cache.js";
import { BotVMSimulator } from "./simulator/botvm-simulator.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "./templates/path-template.js";
import type { OrderflowEvent } from "./orderflow/manual-source.js";
import type { BundleRouter, BundleSubmission } from "./execution/bundle-router.js";
import { detectImpactFromLogs, type PoolImpact } from "./detector/pool-impact.js";

const DEFAULT_MEV_SHARE_SSE_URL = "https://mev-share.flashbots.net";
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const FORK_ETH_BALANCE = "0x56bc75e2d63100000"; // 100 ETH

const WHALE = "0x000000000000000000000000000000000000dEaD";

interface HintLog {
  address: string;
  topics: string[];
  data: string;
}

interface LiveConfig {
  rpcUrl: string;
  mevShareSseUrl: string;
  botvmAddress: string;
  wallet: ethers.Wallet;
  minProfit: bigint;
  defaultGasUsed: number;
  dryRun: boolean;
  maxHints: number;
  enableHashOnly: boolean;
  forkRefreshBlocks: number;
  solverDeadlineMs: number;
  oppTtlMs: number;
  gssMaxTries: number;
  finalSimTopN: number;
}

interface HintEnvelope {
  payload: unknown;
  hashes: string[];
}

interface StageCounters {
  hints: number;
  impacts: number;
  opportunities: number;
  plans: number;
  solverSuccess: number;
  simSuccess: number;
  submitAttempts: number;
  accepted: number;
}

function loadEnv(): void {
  const envPath = resolve("..", ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
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

function buildConfig(provider: ethers.JsonRpcProvider): LiveConfig {
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");

  const privateKey = process.env.PRIVATE_KEY ?? process.env.OWNER_PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY or OWNER_PRIVATE_KEY required");

  const botvmAddress = process.env.BOTVM_ADDRESS;
  if (!botvmAddress) throw new Error("BOTVM_ADDRESS required");

  const wallet = new ethers.Wallet(privateKey, provider);
  const botvmOwner = process.env.BOTVM_OWNER;
  if (botvmOwner && wallet.address.toLowerCase() !== botvmOwner.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY wallet ${wallet.address} does not match BOTVM_OWNER ${botvmOwner}`,
    );
  }

  return {
    rpcUrl,
    mevShareSseUrl: process.env.MEV_SHARE_SSE_URL ?? DEFAULT_MEV_SHARE_SSE_URL,
    botvmAddress: ethers.getAddress(botvmAddress),
    wallet,
    minProfit: BigInt(process.env.SEARCHER_MIN_PROFIT_RAW ?? "1"),
    defaultGasUsed: Number(process.env.SEARCHER_BACKRUN_GAS_USED ?? "12000000"),
    dryRun: process.env.SEARCHER_DRY_RUN === "1",
    enableHashOnly: process.env.SEARCHER_ENABLE_HASH_ONLY === "1",
    maxHints: Number(process.env.SEARCHER_MAX_HINTS ?? "0"),
    forkRefreshBlocks: Number(process.env.SEARCHER_FORK_REFRESH_BLOCKS ?? "5"),
    solverDeadlineMs: Number(process.env.SEARCHER_SOLVER_DEADLINE_MS ?? "8000"),
    oppTtlMs: Number(process.env.SEARCHER_OPP_TTL_MS ?? "5000"),
    gssMaxTries: Number(process.env.SEARCHER_GSS_MAX_TRIES ?? "12"),
    finalSimTopN: Number(process.env.SEARCHER_FINAL_SIM_TOP_N ?? "3"),
  };
}

async function main(): Promise<void> {
  loadEnv();

  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const config = buildConfig(provider);
  const state = new AnvilStateBackend(config.rpcUrl);
  const detector = new BackrunDetector();
  const planner = new TemplatePlanner();
  const maxCandidates = Number(process.env.SEARCHER_MAX_CANDIDATES ?? "20");
  planner.setMaxCandidates(maxCandidates);
  const maxHops = Number(process.env.SEARCHER_MAX_HOPS ?? "3");
  const maxPoolsPerToken = Number(process.env.SEARCHER_MAX_POOLS_PER_TOKEN ?? "8");
  planner.setMaxHops(maxHops);
  planner.setMaxPoolsPerToken(maxPoolsPerToken);
  const solver = new AnvilSolver();
  // Direct provider for v3 tick data — anvil-over-RPC is slow + wrong for TickLens.
  const poolStateCache = new PoolStateCache(provider);
  const simulator = new BotVMSimulator(state, config.botvmAddress, config.wallet.address);
  const bundleRouter: BundleRouter = config.dryRun
    ? new DryRunBundleRouter()
    : new ProductionBundleRouter(
      config.wallet,
      provider,
      config.botvmAddress,
      config.defaultGasUsed,
    );

  console.log("[searcher/live] starting V5 MEV-Share searcher");
  console.log(`[searcher/live] sse=${config.mevShareSseUrl}`);
  console.log(`[searcher/live] wallet=${config.wallet.address}`);
  console.log(`[searcher/live] botvm=${config.botvmAddress}`);
  console.log(`[searcher/live] minProfitRaw=${config.minProfit}`);
  console.log(`[searcher/live] mode=${config.dryRun ? "dry-run" : "live-submit"}`);
  console.log(`[searcher/live] hashOnly=${config.enableHashOnly ? "enabled" : "disabled"}`);
  console.log(`[searcher/live] maxCandidates=${maxCandidates}`);
  console.log(`[searcher/live] maxHops=${maxHops} maxPoolsPerToken=${maxPoolsPerToken}`);
  console.log(
    `[searcher/live] solverDeadlineMs=${config.solverDeadlineMs} ` +
      `oppTtlMs=${config.oppTtlMs} gssMaxTries=${config.gssMaxTries} ` +
      `finalSimTopN=${config.finalSimTopN}`,
  );

  await state.start();

  const discoveryBlocks = Number(process.env.SEARCHER_DISCOVERY_BLOCKS ?? "300");
  const discoveryTopN = Number(process.env.SEARCHER_DISCOVERY_TOP_N ?? "100");
  const factoryBlocks = Number(process.env.SEARCHER_FACTORY_BLOCKS ?? "50000");
  const refreshIntervalMs = Number(process.env.SEARCHER_REFRESH_INTERVAL_MS ?? "300000"); // 5 min

  // Phase 1: Factory event indexing — discover ALL pools created in recent N blocks
  const factoryPools = await indexFactoryPools(provider, factoryBlocks);
  // Phase 2: Swap event discovery — find most active pools (may include Curve etc.)
  const swapPools = await scanActivePools(provider, discoveryBlocks, discoveryTopN);
  // Merge: hardcoded protocols + factory pools + swap-active pools
  const allPools = mergePoolRegistries(
    mergePoolRegistries(POOL_REGISTRY, factoryPools),
    swapPools,
  );
  console.log(
    `[searcher/live] pool registry: ${POOL_REGISTRY.length} protocol + ${factoryPools.length} factory + ${swapPools.length} swap-active = ${allPools.length} total`,
  );

  // Build routing graph from ALL pools (protocol + factory + swap-active).
  // Factory pools are queried for token0/token1 in parallel batches.
  // This is ~1500 eth_call pairs at startup but gives full routing coverage.
  const latestBlock = await provider.getBlockNumber();
  await state.refreshFork(latestBlock);
  const graph = await buildTokenGraph(state, allPools);
  const tokenIndex = buildTokenIndex(graph);

  // Detection uses ALL known pool addresses (factory + swap + hardcoded)
  // for matching hint logs. Map: address → adapter type.
  // Routing graph is a subset for path finding.
  const allPoolMap = new Map<string, string>();
  for (const p of allPools) allPoolMap.set(p.address.toLowerCase(), p.adapter);
  detector.setGraph(graph);
  detector.setPoolAddressMap(allPoolMap);
  detector.setTokenQuery(state);
  planner.setGraph(graph);
  console.log(
    `[searcher/live] routing graph: ${graph.length} edges, ${tokenIndex.size} tokens | ` +
      `detection pool set: ${allPoolMap.size} addresses`,
  );

  // Incremental refresh: scan recent blocks for new pools every N minutes
  const knownPoolAddrs = new Set(allPools.map((p) => p.address.toLowerCase()));
  const mainnetBackend: TokenQueryBackend = {
    call: async (req) => provider.call(req),
  };
  const refreshTimer = setInterval(async () => {
    try {
      const fresh = await scanActivePools(provider, 25, discoveryTopN * 2);
      const newPools = fresh.filter((p) => !knownPoolAddrs.has(p.address.toLowerCase()));
      if (newPools.length === 0) return;

      const newEdges = await buildTokenGraph(mainnetBackend, newPools);
      graph.push(...newEdges);
      for (const p of newPools) knownPoolAddrs.add(p.address.toLowerCase());

      console.log(
        `[searcher/live] refresh: +${newPools.length} pools, +${newEdges.length} edges (total ${graph.length})`,
      );
    } catch (err) {
      console.log(
        `[searcher/live] refresh error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, refreshIntervalMs);

  let processedHints = 0;
  let busy = false;
  const seen = new Set<string>();
  const counters = createStageCounters();

  const shutdown = () => {
    console.log("\n[searcher/live] shutting down");
    logStageCounters(counters);
    clearInterval(refreshTimer);
    state.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    for await (const hint of mevShareHints(config.mevShareSseUrl)) {
      processedHints++;
      counters.hints++;
      if (busy) {
        console.log("[searcher/live] skip hint: simulation already running");
        continue;
      }
      if (hint.hashes.length === 0) continue;

      for (const txHash of hint.hashes) {
        const key = txHash.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        busy = true;
        const tHint = Date.now();
        try {
          await handleHint(hint, txHash, {
            config,
            provider,
            state,
            detector,
            planner,
            solver,
            simulator,
            bundleRouter,
            graph,
            tokenIndex,
            poolAddrs: allPoolMap,
            counters,
            startedAt: tHint,
            cache: poolStateCache,
          });
        } catch (err) {
          console.log(
            `[searcher/live] ${txHash.slice(0, 10)} skip: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          console.log(`[searcher/live] ${txHash.slice(0, 10)} end-to-end ${Date.now() - tHint}ms`);
          logStageCounters(counters);
          busy = false;
        }
      }
      if (config.maxHints > 0 && processedHints >= config.maxHints) break;
    }
  } finally {
    logStageCounters(counters);
    state.stop();
  }
}

interface HandleCtx {
  config: LiveConfig;
  provider: ethers.JsonRpcProvider;
  state: AnvilStateBackend;
  detector: BackrunDetector;
  planner: TemplatePlanner;
  solver: AnvilSolver;
  simulator: BotVMSimulator;
  bundleRouter: BundleRouter;
  graph: TokenEdge[];
  tokenIndex: Map<string, Set<string>>;
  poolAddrs: Map<string, string>;
  counters: StageCounters;
  /** Wall-clock time the hint was received; used for the opportunity TTL budget. */
  startedAt: number;
  /** Warmed pool-state cache for local-math quotes (path B). Cleared per hint. */
  cache: PoolStateCache;
}

/**
 * Process a single MEV-Share hint. Two paths:
 *
 * Path A (hint has logs):
 *   Parse Curve TokenExchange from hint logs → match graph pool
 *   → impersonate whale on Anvil → equivalent swap → pool state shifted
 *   → detect/plan/solve/simulate → mev_sendBundle (hash-only, no rawTx needed)
 *
 * Path B (fallback: can fetch full tx from RPC):
 *   getTransaction → rawTx → applyRawTx on Anvil (current V5 logic)
 *   → detect/plan/solve/simulate → mev_sendBundle (hash-only)
 */
async function handleHint(
  hint: HintEnvelope,
  txHash: string,
  ctx: HandleCtx,
): Promise<void> {
  console.log(`[searcher/live] hint tx=${txHash}`);

  const latestBlock = await ctx.provider.getBlockNumber();
  // Fork-reuse: reset to baseline (~ms) instead of re-forking (~s) each hint;
  // only re-fork every forkRefreshBlocks to refresh state (~7x faster setup).
  await ctx.state.ensureFreshFork(latestBlock, ctx.config.forkRefreshBlocks);
  // Fork/pool state changes per hint (reset + impersonated victim swap), so
  // drop warmed local-math state; it lazy-warms again on first quote this hint.
  // v3 tick data is read directly at the fork's block.
  ctx.cache.clear();
  ctx.cache.setTickBlock(latestBlock);

  // ── Try Path A: hint-log-based impersonate simulation ──
  const hintLogs = extractLogs(hint.payload);
  if (hintLogs.length > 0 && hintLogs.length <= 5) {
    for (const l of hintLogs) {
      const isTransfer = l.topics[0]?.toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
      if (isTransfer && l.topics.length >= 3) {
        const from = "0x" + l.topics[1].slice(26);
        const to = "0x" + l.topics[2].slice(26);
        console.log(`[searcher/live] ${txHash.slice(0, 10)} Transfer: token=${l.address.slice(0, 10)} from=${from.slice(0, 10)} to=${to.slice(0, 10)}`);
      } else {
        console.log(`[searcher/live] ${txHash.slice(0, 10)} log: addr=${l.address.slice(0, 10)} t0=${l.topics[0]?.slice(0, 10)}`);
      }
    }
  } else if (hintLogs.length > 5) {
    console.log(`[searcher/live] ${txHash.slice(0, 10)} hint has ${hintLogs.length} logs (batch)`);
  }
  const hintImpact = await matchPoolImpactFromLogs(hintLogs, ctx.graph, ctx.poolAddrs, ctx.state);

  // Token-index check: does any hint Transfer involve a token we track?
  const hintTokenHit = hintImpact ? true : hintLogsMatchTokenIndex(hintLogs, ctx.tokenIndex);

  let rawTx: string | undefined;
  let eventLogs: Array<{ address: string; topics: string[]; data: string }>;
  let eventFrom = ethers.ZeroAddress;
  let eventNonce = 0;
  let eventTo: string | null = null;
  let eventInput = "0x";
  let eventBlockNumber = latestBlock + 1;
  let submissionMode: BundleSubmission["mode"] = "hash-only";
  let countedHintImpact = false;

  if (hintImpact) {
    ctx.counters.impacts++;
    countedHintImpact = true;

    // Path A: hash-only — approximate simulation via impersonate swap
    if (!ctx.config.enableHashOnly) {
      throw new Error("hash-only hint (no rawTx); set SEARCHER_ENABLE_HASH_ONLY=1 to enable");
    }
    console.log(
      `[searcher/live] hint via logs (approximate): pool=${hintImpact.pool.slice(0, 10)} ` +
        `amountIn=${hintImpact.amountIn}`,
    );
    await impersonateSwap(ctx.state, hintImpact, ctx.graph);
    await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);

    // Use hint logs directly for detector
    eventLogs = hintLogs.map((l) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
    }));
  } else if (!hintTokenHit) {
    // No pool match AND no token match — skip early
    throw new Error("no matching graph pool");
  } else {
    // Token hit but no pool impact — try to fetch full tx from RPC
    console.log(`[searcher/live] ${txHash.slice(0, 10)} token-index hit, trying RPC fetch`);
    const tx = await ctx.provider.getTransaction(txHash);
    if (!tx) throw new Error("tx not available from RPC (private MEV-Share tx)");

    if (tx.blockNumber !== null) {
      // ── Path C: tx already mined — fork at that block, check for next-block arb ──
      console.log(
        `[searcher/live] ${txHash.slice(0, 10)} mined in block ${tx.blockNumber}, checking next-block arb`,
      );
      await ctx.state.refreshFork(tx.blockNumber);
      await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);
      submissionMode = "standalone";
      eventBlockNumber = tx.blockNumber;

      const receipt = await ctx.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error("on-chain receipt missing or reverted");
      }
      eventFrom = tx.from;
      eventNonce = tx.nonce;
      eventTo = tx.to;
      eventInput = tx.data;
      eventLogs = receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      }));
      // Debug: classify receipt log events
      const SWAP_TOPICS_DEBUG = new Set([
        "0xd78ad95ff46318e747eaa5cff20e23073340ceaa01c11f3ebc2f1e60f7ee5c52", // UniV2 Swap
        "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // UniV3 Swap
      ]);
      const swapCount = eventLogs.filter((l) => SWAP_TOPICS_DEBUG.has(l.topics[0]?.toLowerCase() ?? "")).length;
      const xferCount = eventLogs.filter((l) => l.topics[0]?.toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef").length;
      console.log(
        `[searcher/live] ${txHash.slice(0, 10)} receipt: ${eventLogs.length} logs (${xferCount} Transfer, ${swapCount} Swap)`,
      );
    } else {
      // ── Path B: pending tx — apply raw tx on fork ──
      submissionMode = "victim-bundle";
      rawTx = (await rawTxByHash(ctx.provider, txHash, tx)) ?? undefined;
      if (!rawTx) throw new Error("raw tx unavailable");

      const appliedHash = await ctx.state.applyRawTx(rawTx);
      if (appliedHash.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error(`local victim hash mismatch ${appliedHash}`);
      }

      await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);

      const receipt = await ctx.state.provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        throw new Error("local victim receipt missing or reverted");
      }

      eventFrom = tx.from;
      eventNonce = tx.nonce;
      eventTo = tx.to;
      eventInput = tx.data;
      eventLogs = receipt.logs.map((log) => ({
        address: log.address,
        topics: [...log.topics],
        data: log.data,
      }));
    }
  }

  // ── Common pipeline: detect → plan → solve → simulate → submit ──
  const event: OrderflowEvent = {
    txHash,
    blockNumber: eventBlockNumber,
    rawTx: rawTx ?? "0x",
    from: eventFrom,
    nonce: eventNonce,
    to: eventTo,
    input: eventInput,
    logs: eventLogs,
    minProfit: ctx.config.minProfit,
  };

  const opportunities = await ctx.detector.detect(event, ctx.state);
  if (countedHintImpact) {
    ctx.counters.impacts += Math.max(0, opportunities.length - 1);
  } else {
    ctx.counters.impacts += opportunities.length;
  }
  if (opportunities.length === 0) {
    console.log(`[searcher/live] ${txHash.slice(0, 10)} no matching graph pool`);
    return;
  }
  ctx.counters.opportunities += opportunities.length;
  console.log(`[searcher/live] detector: ${opportunities.length} opportunities`);

  for (const opp of opportunities) {
    const plans = await ctx.planner.plan(opp, [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY]);
    ctx.counters.plans += plans.length;
    console.log(`[searcher/live] planner: ${plans.length} candidate plans`);
    for (const candidate of plans) {
      // Opportunity TTL (v7 AC-3a.5): a hint older than oppTtlMs is chasing stale
      // state — stop solving. Each solve is further capped to the remaining budget
      // so it never runs past the opportunity's useful life. (v7 AC-3a.3)
      const remainingMs = ctx.config.oppTtlMs - (Date.now() - ctx.startedAt);
      if (remainingMs <= 0) {
        console.log(
          `[searcher/live] opportunity expired ` +
            `(${Date.now() - ctx.startedAt}ms > TTL ${ctx.config.oppTtlMs}ms), abandoning`,
        );
        return;
      }
      try {
        const resolved = await ctx.solver.solve(candidate, ctx.state, ctx.simulator, {
          deadlineMs: Math.min(ctx.config.solverDeadlineMs, remainingMs),
          gssMaxTries: ctx.config.gssMaxTries,
          finalSimTopN: ctx.config.finalSimTopN,
          cache: ctx.cache,
        });
        ctx.counters.solverSuccess++;
        // Terminal verify (v7 AC-3a.4): re-simulate the resolved plan and require
        // strictly positive profit before paying gas — never submit on a plan that
        // only broke even or drifted negative since the solver picked it.
        const sim = await ctx.simulator.simulate(resolved);
        if (sim.success && sim.netProfit > 0n) ctx.counters.simSuccess++;
        // The flash loan must repay (enforced by the assert-balance guard), so a
        // successful sim with positive profit guarantees token profit > 0. Gas
        // economics are the builder's concern — we submit with expectedProfit.
        if (!sim.success || sim.netProfit <= 0n) continue;

        const targetBlock = (await ctx.provider.getBlockNumber()) + 1;
        ctx.counters.submitAttempts++;
        const results = await ctx.bundleRouter.submit({
          victimTxHash: txHash,
          victimRawTx: rawTx,
          mode: submissionMode,
          backrunCalldata: sim.calldata,
          targetBlock,
          expectedProfit: sim.netProfit,
          gasUsed: sim.gasUsed > 0n ? sim.gasUsed : ctx.config.defaultGasUsed,
        });
        ctx.counters.accepted += results.filter((r) => r.accepted).length;
        const bundleHash = results.find((r) => r.bundleHash)?.bundleHash;
        const mode = submissionMode === "standalone"
          ? "standalone eth_sendBundle"
          : rawTx ? "eth_sendBundle" : "mev_sendBundle";
        console.log(
          `[searcher/live] submitted via ${mode} targetBlock=${targetBlock} ` +
            `profit=${sim.netProfit}` +
            `${bundleHash ? ` bundleHash=${bundleHash}` : ""}`,
        );
        return;
      } catch (err) {
        console.log(
          `[searcher/live] candidate failed: ` +
            `${err instanceof Error ? err.message : String(err)}`.slice(0, 180),
        );
      }
    }
  }
}

function createStageCounters(): StageCounters {
  return {
    hints: 0,
    impacts: 0,
    opportunities: 0,
    plans: 0,
    solverSuccess: 0,
    simSuccess: 0,
    submitAttempts: 0,
    accepted: 0,
  };
}

function logStageCounters(counters: StageCounters): void {
  console.log(
    `[searcher/live] counters ` +
      `hints=${counters.hints} ` +
      `impacts=${counters.impacts} ` +
      `opportunities=${counters.opportunities} ` +
      `plans=${counters.plans} ` +
      `solverSuccess=${counters.solverSuccess} ` +
      `simSuccess=${counters.simSuccess} ` +
      `submitAttempts=${counters.submitAttempts} ` +
      `accepted=${counters.accepted}`,
  );
}

// ─── Hint Log Parsing ─────────────────────────────────────────

/** Extract logs array from MEV-Share hint payload. */
function extractLogs(payload: unknown): HintLog[] {
  if (payload && typeof payload === "object" && "logs" in payload) {
    const logs = (payload as Record<string, unknown>).logs;
    if (Array.isArray(logs)) {
      return logs.filter(
        (l): l is HintLog =>
          l != null &&
          typeof l === "object" &&
          typeof (l as any).address === "string" &&
          Array.isArray((l as any).topics) &&
          typeof (l as any).data === "string",
      );
    }
  }
  return [];
}

async function matchPoolImpactFromLogs(
  logs: HintLog[],
  graph: TokenEdge[],
  broadPoolAddrs: Map<string, string> | undefined,
  tokenQuery?: TokenQueryBackend,
): Promise<PoolImpact | null> {
  const impacts = await detectImpactFromLogs(logs, graph, broadPoolAddrs, tokenQuery);
  return impacts.length > 0 ? impacts[0] : null;
}

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Check if any Transfer log's token address is in our token index. */
function hintLogsMatchTokenIndex(
  logs: HintLog[],
  tokenIndex: Map<string, Set<string>>,
): boolean {
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (tokenIndex.has(log.address.toLowerCase())) return true;
  }
  return false;
}

// ─── Impersonate Swap (Path A simulation) ─────────────────────

const CURVE_EXCHANGE_IFACE = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);
const UNIV3_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
]);
const UNIV3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNIV2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const UNIV2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
]);
const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
]);
const UNIV3_FEE_IFACE = new ethers.Interface([
  "function fee() view returns (uint24)",
]);

async function impersonateSwap(
  state: AnvilStateBackend,
  impact: PoolImpact,
  graph: TokenEdge[],
): Promise<void> {
  const whaleAddr = ethers.getAddress(WHALE);

  await state.provider.send("anvil_setBalance", [whaleAddr, FORK_ETH_BALANCE]);
  await dealToken(state, impact.tokenIn, whaleAddr, impact.amountIn * 2n);
  await state.provider.send("anvil_impersonateAccount", [whaleAddr]);

  try {
    const poolAddr = ethers.getAddress(impact.pool);
    let approveTarget: string;
    if (isCurveAdapter(impact.matchedAdapterId)) {
      approveTarget = poolAddr;
    } else if (impact.matchedAdapterId === "univ2-swap") {
      approveTarget = UNIV2_ROUTER;
    } else {
      approveTarget = UNIV3_SWAP_ROUTER;
    }
    const approveData = ERC20_IFACE.encodeFunctionData("approve", [approveTarget, impact.amountIn * 2n]);
    await state.send({ from: whaleAddr, to: impact.tokenIn, data: approveData });

    if (isCurveAdapter(impact.matchedAdapterId)) {
      const poolEdge = graph.find(
        (e) => e.target.toLowerCase() === impact.pool.toLowerCase() &&
          e.tokenIn.toLowerCase() === impact.tokenIn.toLowerCase() &&
          e.curveI !== undefined,
      );
      if (!poolEdge || poolEdge.curveI === undefined || poolEdge.curveJ === undefined) {
        throw new Error(`no curve edge for impersonate: ${impact.pool}`);
      }
      const exchangeData = CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [
        poolEdge.curveI, poolEdge.curveJ, impact.amountIn, 0,
      ]);
      await state.send({ from: whaleAddr, to: poolAddr, data: exchangeData, gas: "0x1000000" });

    } else if (impact.matchedAdapterId === "univ2-swap") {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const swapData = UNIV2_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
        impact.amountIn, 0, [impact.tokenIn, impact.tokenOut], whaleAddr, deadline,
      ]);
      await state.send({ from: whaleAddr, to: UNIV2_ROUTER, data: swapData, gas: "0x1000000" });

    } else if (impact.matchedAdapterId === "univ3-swap") {
      const feeData = UNIV3_FEE_IFACE.encodeFunctionData("fee", []);
      const feeResult = await state.call({ to: impact.pool, data: feeData });
      const fee = Number(BigInt(feeResult));

      const swapData = UNIV3_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
        tokenIn: impact.tokenIn,
        tokenOut: impact.tokenOut,
        fee,
        recipient: whaleAddr,
        amountIn: impact.amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      }]);
      await state.send({ from: whaleAddr, to: UNIV3_SWAP_ROUTER, data: swapData, gas: "0x1000000" });
    } else {
      throw new Error(`hash-only impersonate unsupported adapter ${impact.matchedAdapterId}`);
    }
  } finally {
    await state.provider.send("anvil_stopImpersonatingAccount", [whaleAddr]);
  }
}

function isCurveAdapter(adapterId: string): boolean {
  return adapterId.startsWith("curve-");
}

/**
 * Deal ERC-20 tokens to an address on Anvil.
 * Uses anvil_setStorageAt to write the balanceOf mapping slot.
 * Handles both standard (slot 0) and non-standard storage layouts by
 * trying common balance slots.
 */
async function dealToken(
  state: AnvilStateBackend,
  token: string,
  to: string,
  amount: bigint,
): Promise<void> {
  const tokenAddr = ethers.getAddress(token);
  const toAddr = ethers.getAddress(to);

  // Common ERC-20 balanceOf mapping base slots.
  // For each candidate, compute keccak256(abi.encode(address, slotIndex))
  // and try writing. Use snapshot/revert so wrong guesses don't pollute state.
  const BALANCE_SLOTS_TO_TRY = [0, 1, 2, 3, 4, 5, 9, 51];

  for (const slotIndex of BALANCE_SLOTS_TO_TRY) {
    const snap = await state.snapshot();
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [toAddr, slotIndex],
      ),
    );
    const value = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
    await state.provider.send("anvil_setStorageAt", [tokenAddr, slot, value]);

    const balAfter = await readBalance(state, tokenAddr, toAddr);
    if (balAfter >= amount) return; // Correct slot found, state is clean

    // Wrong slot — revert to avoid polluting storage
    await state.revert(snap);
  }

  // None worked. The impersonate swap will fail with insufficient balance.
  // Caller catches this as a normal hint-skip.
  console.log(
    `[searcher/live] warning: dealToken could not find balance slot for ${tokenAddr}`,
  );
}

async function readBalance(
  state: AnvilStateBackend,
  token: string,
  account: string,
): Promise<bigint> {
  try {
    return await state.getTokenBalance(token, account);
  } catch {
    return 0n;
  }
}

async function prepareForkExecutor(
  provider: ethers.JsonRpcProvider,
  owner: string,
  botvmAddress: string,
): Promise<void> {
  const code = await provider.getCode(botvmAddress);
  if (code === "0x") throw new Error(`BOTVM_ADDRESS has no code on fork: ${botvmAddress}`);
  await provider.send("anvil_setBalance", [ethers.getAddress(owner), FORK_ETH_BALANCE]);
  await provider.send("anvil_impersonateAccount", [ethers.getAddress(owner)]);
}

async function rawTxByHash(
  provider: ethers.JsonRpcProvider,
  txHash: string,
  tx: ethers.TransactionResponse,
): Promise<string | null> {
  try {
    const raw = await provider.send("eth_getRawTransactionByHash", [txHash]);
    if (typeof raw === "string" && raw.startsWith("0x")) return raw;
  } catch {
    // Some RPC providers do not expose raw pending transactions.
  }

  try {
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
  } catch {
    return null;
  }
}

async function* mevShareHints(url: string): AsyncGenerator<HintEnvelope> {
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }
      console.log("[searcher/live] MEV-Share SSE connected");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = parseSseData(frame);
          if (!data) continue;
          const payload = JSON.parse(data) as unknown;
          yield { payload, hashes: extractTxHashes(payload) };
        }
      }
    } catch (err) {
      console.log(
        `[searcher/live] SSE reconnect: ${err instanceof Error ? err.message : String(err)}`,
      );
      await sleep(1_000);
    }
  }
}

function parseSseData(frame: string): string | null {
  const parts: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) parts.push(line.slice(5).trimStart());
  }
  const data = parts.join("\n").trim();
  if (!data || data === "[DONE]") return null;
  return data;
}

function extractTxHashes(value: unknown): string[] {
  const hashes = new Set<string>();

  function walk(node: unknown, key = ""): void {
    if (typeof node === "string") {
      if ((key === "hash" || key === "txHash" || key === "transactionHash") && TX_HASH_RE.test(node)) {
        hashes.add(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, childKey);
    }
  }

  walk(value);
  return [...hashes];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(`[searcher/live] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
