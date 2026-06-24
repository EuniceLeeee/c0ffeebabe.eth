import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../shared/adapters/index.js";
import { AnvilStateBackend, type StateBackend } from "../shared/state/state-backend.js";
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
import {
  DEFAULT_PINNED_WARM_POOLS_PATH,
  loadPinnedWarmPools,
  pinnedWarmHopsFromGraph,
} from "./pinned-warm-pools.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  loadPoolUniverse,
} from "./pool-universe.js";
import { AnvilSolver } from "./solver/solver.js";
import { defaultFinalVerifyFloorBps, shouldRunFinalVerify } from "./solver/final-verify-gate.js";
import { PoolStateCache } from "./solver/pool-state-cache.js";
import { PoolStateUpdater } from "./solver/pool-state-updater.js";
import { applyVictimSwapLocally, type LocalVictimApplyResult } from "./solver/victim-apply.js";
import { BotVMSimulator } from "./simulator/botvm-simulator.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "./templates/path-template.js";
import {
  LiveFixtureRecorder,
  type LiveFinalState,
  type LiveFixturePath,
} from "./live-fixture-recorder.js";
import { parseLiveBackendKind, type LiveBackendKind } from "./live-state-backend.js";
import type { LiveStateBackend, QuoteRequest } from "./live-state-backend.js";
import { RevmSimClient } from "./revm-sim-client.js";
import { RpcAnvilLiveBackend } from "./live-backends/rpc-anvil-live-backend.js";
import { RevmLiveBackend } from "./live-backends/revm-live-backend.js";
import { HybridLiveBackend } from "./live-backends/hybrid-live-backend.js";
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
  liveBackend: LiveBackendKind;
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
  quoteSafetyBps: bigint;
  /** Near-miss admission floor in bps of the flash amount (magnitude; 20 = -20bps).
   *  Lets the solver sim near-break-even quotes; in DRY-RUN only it also lets the
   *  pipeline emit a recorded (never broadcast) bundle. 0 = strictly positive. */
  quoteProfitFloorBps: bigint;
  /** Independent final-verify admission floor. Keeps diagnostic/dry-run quote
   *  floors from spending final revm overlay on candidates too negative for the
   *  quote haircut to plausibly flip positive. */
  finalVerifyFloorBps: bigint;
  revmPrewarmRouteHops: number;
  stateUpdaterEnabled: boolean;
  statePinnedK: number;
  stateRecentK: number;
  stateWatchMaxPools: number;
  pinnedWarmPoolPath: string;
  poolUniversePath: string;
  poolUniverseTopN: number;
  poolUniverseMinScore: number;
  recordLiveFixtures: boolean;
  liveFixtureDir: string;
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
  solverEntered: number;
  solverSuccess: number;
  revmSimSuccess: number;
  rpcVerifySuccess: number;
  simSuccess: number;
  submitAttempts: number;
  accepted: number;
  expiredBeforeSolver: number;
  quoteTimeouts: number;
  simReverts: number;
  finalVerifyFailed: number;
  finalVerifySkipped: number;
  missingState: number;
  revmErrors: number;
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
  const dryRun = process.env.SEARCHER_DRY_RUN === "1";
  const maxHops = Number(process.env.SEARCHER_MAX_HOPS ?? "3");
  const quoteSafetyBps = BigInt(process.env.SEARCHER_QUOTE_SAFETY_BPS ?? "9999");

  return {
    rpcUrl,
    mevShareSseUrl: process.env.MEV_SHARE_SSE_URL ?? DEFAULT_MEV_SHARE_SSE_URL,
    liveBackend: parseLiveBackendKind(process.env.SEARCHER_LIVE_BACKEND ?? "rpc"),
    botvmAddress: ethers.getAddress(botvmAddress),
    wallet,
    minProfit: BigInt(process.env.SEARCHER_MIN_PROFIT_RAW ?? "1"),
    defaultGasUsed: Number(process.env.SEARCHER_BACKRUN_GAS_USED ?? "12000000"),
    dryRun,
    enableHashOnly: process.env.SEARCHER_ENABLE_HASH_ONLY === "1",
    maxHints: Number(process.env.SEARCHER_MAX_HINTS ?? "0"),
    forkRefreshBlocks: Number(process.env.SEARCHER_FORK_REFRESH_BLOCKS ?? "5"),
    solverDeadlineMs: Number(process.env.SEARCHER_SOLVER_DEADLINE_MS ?? "8000"),
    oppTtlMs: Number(process.env.SEARCHER_OPP_TTL_MS ?? "5000"),
    gssMaxTries: Number(process.env.SEARCHER_GSS_MAX_TRIES ?? "12"),
    finalSimTopN: Number(process.env.SEARCHER_FINAL_SIM_TOP_N ?? "3"),
    quoteSafetyBps,
    quoteProfitFloorBps: BigInt(
      process.env.SEARCHER_QUOTE_PROFIT_FLOOR_BPS ?? (dryRun ? "20" : "0"),
    ),
    finalVerifyFloorBps: BigInt(
      process.env.SEARCHER_FINAL_VERIFY_FLOOR_BPS ??
        defaultFinalVerifyFloorBps(quoteSafetyBps, maxHops).toString(),
    ),
    revmPrewarmRouteHops: Number(process.env.SEARCHER_REVM_PREWARM_ROUTE_HOPS ?? "0"),
    stateUpdaterEnabled: process.env.SEARCHER_STATE_UPDATER_ENABLED !== "0",
    statePinnedK: Number(process.env.SEARCHER_STATE_PINNED_K ?? "8"),
    stateRecentK: Number(process.env.SEARCHER_STATE_RECENT_K ?? "24"),
    stateWatchMaxPools: Number(process.env.SEARCHER_STATE_WATCH_MAX_POOLS ?? "64"),
    pinnedWarmPoolPath: process.env.SEARCHER_PINNED_WARM_POOLS ?? DEFAULT_PINNED_WARM_POOLS_PATH,
    poolUniversePath: process.env.SEARCHER_POOL_UNIVERSE_PATH ?? DEFAULT_POOL_UNIVERSE_PATH,
    poolUniverseTopN: Number(process.env.SEARCHER_POOL_UNIVERSE_TOP_N ?? "0"),
    poolUniverseMinScore: Number(process.env.SEARCHER_POOL_UNIVERSE_MIN_SCORE ?? "1"),
    recordLiveFixtures: process.env.SEARCHER_RECORD_LIVE_FIXTURES === "1",
    liveFixtureDir: process.env.SEARCHER_LIVE_FIXTURE_DIR ?? resolve("searcher", "live-fixtures"),
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
  const poolStateUpdater = new PoolStateUpdater(provider, poolStateCache, {
    maxPools: config.stateWatchMaxPools,
  });
  const fixtureRecorder = new LiveFixtureRecorder(
    config.liveFixtureDir,
    config.recordLiveFixtures,
  );
  const simulator = new BotVMSimulator(state, config.botvmAddress, config.wallet.address);
  const rpcLiveBackend = new RpcAnvilLiveBackend(state, simulator);
  // revm/hybrid backends are constructed after the routing graph is built (they
  // need it to encode the victim overlay); default to rpc until then.
  let liveBackend: LiveStateBackend = rpcLiveBackend;
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
  console.log(`[searcher/live] liveBackend=${config.liveBackend}`);
  console.log(`[searcher/live] minProfitRaw=${config.minProfit}`);
  console.log(`[searcher/live] mode=${config.dryRun ? "dry-run" : "live-submit"}`);
  console.log(`[searcher/live] hashOnly=${config.enableHashOnly ? "enabled" : "disabled"}`);
  console.log(`[searcher/live] maxCandidates=${maxCandidates}`);
  console.log(`[searcher/live] maxHops=${maxHops} maxPoolsPerToken=${maxPoolsPerToken}`);
  console.log(`[searcher/live] revmPrewarmRouteHops=${config.revmPrewarmRouteHops}`);
  console.log(
    `[searcher/live] stateUpdater=${config.stateUpdaterEnabled ? "enabled" : "disabled"} ` +
      `pinnedK=${config.statePinnedK} recentK=${config.stateRecentK} ` +
      `maxPools=${config.stateWatchMaxPools}`,
  );
  console.log(
    `[searcher/live] quoteSafetyBps=${config.quoteSafetyBps} ` +
      `quoteProfitFloorBps=${config.quoteProfitFloorBps} ` +
      `finalVerifyFloorBps=${config.finalVerifyFloorBps}`,
  );
  console.log(`[searcher/live] pinnedWarmPools=${config.pinnedWarmPoolPath}`);
  console.log(
    `[searcher/live] poolUniverse=${config.poolUniversePath} ` +
      `topN=${config.poolUniverseTopN} minScore=${config.poolUniverseMinScore}`,
  );
  console.log(
    `[searcher/live] solverDeadlineMs=${config.solverDeadlineMs} ` +
      `oppTtlMs=${config.oppTtlMs} gssMaxTries=${config.gssMaxTries} ` +
      `finalSimTopN=${config.finalSimTopN}`,
  );
  if (config.recordLiveFixtures) {
    console.log(`[searcher/live] recording live fixtures to ${config.liveFixtureDir}`);
  }

  const discoveryBlocks = Number(process.env.SEARCHER_DISCOVERY_BLOCKS ?? "300");
  const discoveryTopN = Number(process.env.SEARCHER_DISCOVERY_TOP_N ?? "100");
  const factoryBlocks = Number(process.env.SEARCHER_FACTORY_BLOCKS ?? "50000");
  const refreshIntervalMs = Number(process.env.SEARCHER_REFRESH_INTERVAL_MS ?? "300000"); // 5 min
  const mainnetBackend: TokenQueryBackend = {
    call: async (req) => provider.call(req),
  };
  const pinnedWarmPools = loadPinnedWarmPools(config.pinnedWarmPoolPath);
  const universePools = loadPoolUniverse(config.poolUniversePath, {
    maxPools: config.poolUniverseTopN,
    minScore: config.poolUniverseMinScore,
  });

  // Phase 1: Factory event indexing — discover ALL pools created in recent N blocks
  const factoryPools = await indexFactoryPools(provider, factoryBlocks);
  // Phase 2: Swap event discovery — find most active pools (may include Curve etc.)
  const swapPools = await scanActivePools(provider, discoveryBlocks, discoveryTopN);
  // Merge: protocol contracts + pinned backbone + file-backed active universe + discovered pools.
  const allPools = mergePoolRegistries(
    mergePoolRegistries(
      mergePoolRegistries(
        mergePoolRegistries(POOL_REGISTRY, pinnedWarmPools),
        universePools,
      ),
      factoryPools,
    ),
    swapPools,
  );
  console.log(
    `[searcher/live] pool registry: ${POOL_REGISTRY.length} protocol + ` +
      `${pinnedWarmPools.length} pinned + ${universePools.length} universe + ` +
      `${factoryPools.length} factory + ${swapPools.length} swap-active = ` +
      `${allPools.length} total`,
  );

  // Build routing graph from all pools. File-backed universe entries can carry
  // token0/token1 metadata, so V2/V3 graph construction avoids per-pool token
  // eth_call unless the generated file is missing that metadata.
  // Factory pools are queried for token0/token1 in parallel batches.
  // This is ~1500 eth_call pairs at startup but gives full routing coverage.
  const graph = await buildTokenGraph(mainnetBackend, allPools);
  const tokenIndex = buildTokenIndex(graph);

  // Detection uses ALL known pool addresses (factory + swap + hardcoded)
  // for matching hint logs. Map: address → adapter type.
  // Routing graph is a subset for path finding.
  const allPoolMap = new Map<string, string>();
  for (const p of allPools) allPoolMap.set(p.address.toLowerCase(), p.adapter);
  detector.setGraph(graph);
  detector.setPoolAddressMap(allPoolMap);
  detector.setTokenQuery(mainnetBackend);
  planner.setGraph(graph);
  console.log(
    `[searcher/live] routing graph: ${graph.length} edges, ${tokenIndex.size} tokens | ` +
      `detection pool set: ${allPoolMap.size} addresses`,
  );

  // Now that the graph exists, wire the configured revm/hybrid backend.
  if (config.liveBackend !== "rpc") {
    const revmLiveBackend = new RevmLiveBackend(
      new RevmSimClient({ timeoutMs: Number(process.env.SEARCHER_REVM_TIMEOUT_MS ?? "60000") }),
      config.botvmAddress,
      config.wallet.address,
      provider,
      graph,
      config.rpcUrl,
    );
    liveBackend = config.liveBackend === "revm"
      ? revmLiveBackend
      : new HybridLiveBackend(revmLiveBackend, rpcLiveBackend);
  }

  // Incremental refresh: scan recent blocks for new pools every N minutes
  const knownPoolAddrs = new Set(allPools.map((p) => p.address.toLowerCase()));
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
  const recentWarmPools = new RecentWarmTracker(
    Number(process.env.SEARCHER_WARM_RECENT_TTL_BLOCKS ?? "12"),
  );
  const pinnedWarmHops = pinnedWarmHopsFromGraph(graph, pinnedWarmPools);
  const pinnedWarmTargets = new Set(pinnedWarmHops.map((hop) => hop.target.toLowerCase()));
  console.log(
    `[searcher/live] seeded pinned warm hops: ${pinnedWarmHops.length} directions ` +
      `from ${pinnedWarmPools.length} pools`,
  );

  // Between-block warmer: pinned and recent pools have independent quotas so
  // bluechip backbone pools cannot crowd out newly observed longtail pools.
  // If a new block arrives while a hint is in flight, remember the latest block
  // and warm it as soon as the hint finishes instead of dropping the warm event.
  const warmPinnedK = Number(
    process.env.SEARCHER_WARM_PINNED_K ??
      process.env.SEARCHER_WARM_TOP_K ??
      "0",
  );
  const warmRecentK = Number(
    process.env.SEARCHER_WARM_RECENT_K ??
      process.env.SEARCHER_WARM_TOP_K ??
      String(Math.min(config.stateRecentK, 1)),
  );
  const warmIdleDelayMs = Number(process.env.SEARCHER_WARM_IDLE_DELAY_MS ?? "1000");
  console.log(
    `[searcher/live] warm lanes pinnedK=${warmPinnedK} recentK=${warmRecentK} ` +
      `recentTtlBlocks=${recentWarmPools.ttl} idleDelayMs=${warmIdleDelayMs}`,
  );
  let warming = false;
  let pendingWarmBlock: number | null = null;
  let pendingWarmReason: "block" | "after-hint" = "block";
  let warmTimer: NodeJS.Timeout | null = null;
  const cancelScheduledWarm = (): void => {
    if (!warmTimer) return;
    clearTimeout(warmTimer);
    warmTimer = null;
  };
  const runWarm = (blockNumber: number, reason: "block" | "after-hint"): void => {
    if (!liveBackend.warmHotPools || warming) {
      pendingWarmBlock = blockNumber;
      pendingWarmReason = reason;
      return;
    }
    const pinned = topPinnedWarmHops(pinnedWarmHops, warmPinnedK);
    const recent = recentWarmPools.top(warmRecentK, blockNumber, pinnedWarmTargets);
    const hops = [...recent, ...pinned];
    if (hops.length === 0) return;
    warming = true;
    pendingWarmBlock = null;
    console.log(
      `[searcher/live] warm block=${blockNumber} reason=${reason} ` +
        `recent=${recent.length}/${warmRecentK} pinned=${pinned.length}/${warmPinnedK}`,
    );
    void liveBackend
      .warmHotPools(blockNumber, hops)
      .catch((err) =>
        console.log(`[searcher/live] warm error: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        warming = false;
        if (!busy && pendingWarmBlock !== null) {
          const nextBlock = pendingWarmBlock;
          const nextReason = pendingWarmReason;
          pendingWarmBlock = null;
          scheduleWarm(nextBlock, nextReason);
        }
      });
  };
  const scheduleWarm = (blockNumber: number, reason: "block" | "after-hint"): void => {
    pendingWarmBlock = blockNumber;
    pendingWarmReason = reason;
    if (busy || warming || warmTimer) return;
    warmTimer = setTimeout(() => {
      warmTimer = null;
      if (busy || warming || pendingWarmBlock === null) return;
      const nextBlock = pendingWarmBlock;
      const nextReason = pendingWarmReason;
      pendingWarmBlock = null;
      runWarm(nextBlock, nextReason);
    }, warmIdleDelayMs);
  };
  const flushPendingWarm = (): void => {
    if (busy || pendingWarmBlock === null || warming) return;
    const blockNumber = pendingWarmBlock;
    const reason = pendingWarmReason;
    pendingWarmBlock = null;
    scheduleWarm(blockNumber, reason);
  };
  if ((warmPinnedK > 0 || warmRecentK > 0) && liveBackend.warmHotPools) {
    provider.on("block", (blockNumber: number) => {
      if (busy || warming) {
        pendingWarmBlock = blockNumber;
        pendingWarmReason = "block";
        return;
      }
      scheduleWarm(blockNumber, "block");
    });
  }

  // Block-level PoolStateUpdater: seed watched V2/V3 pool state by Multicall so
  // quote/search uses local math. This is deliberately separate from the revm
  // trace warmer above; it does not touch the revm daemon.
  let stateUpdating = false;
  let pendingStateUpdateBlock: number | null = null;
  const runStateUpdate = (blockNumber: number, reason: "block" | "pending"): void => {
    if (stateUpdating) {
      pendingStateUpdateBlock = blockNumber;
      return;
    }
    const pinned = topPinnedWarmHops(pinnedWarmHops, config.statePinnedK);
    const recent = recentWarmPools.top(config.stateRecentK, blockNumber, pinnedWarmTargets);
    const hops = [...recent, ...pinned].slice(0, config.stateWatchMaxPools);
    if (hops.length === 0) return;
    stateUpdating = true;
    pendingStateUpdateBlock = null;
    console.log(
      `[searcher/live] state update block=${blockNumber} reason=${reason} ` +
        `recent=${recent.length}/${config.stateRecentK} ` +
        `pinned=${pinned.length}/${config.statePinnedK} watched=${hops.length}`,
    );
    void poolStateUpdater.update(blockNumber, hops)
      .catch((err) =>
        console.log(`[searcher/live] state update error: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        stateUpdating = false;
        if (pendingStateUpdateBlock !== null) {
          const next = pendingStateUpdateBlock;
          pendingStateUpdateBlock = null;
          runStateUpdate(next, "pending");
        }
      });
  };
  if (config.stateUpdaterEnabled) {
    provider.on("block", (blockNumber: number) => runStateUpdate(blockNumber, "block"));
  }

  const shutdown = () => {
    console.log("\n[searcher/live] shutting down");
    logStageCounters(counters);
    cancelScheduledWarm();
    clearInterval(refreshTimer);
    provider.removeAllListeners("block");
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

        cancelScheduledWarm();
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
            tokenQuery: mainnetBackend,
            counters,
            startedAt: tHint,
            cache: poolStateCache,
            poolStateUpdater,
            fixtureRecorder,
            liveBackend,
            recentWarmPools,
            pinnedWarmTargets,
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
          flushPendingWarm();
        }
      }
      if (config.maxHints > 0 && processedHints >= config.maxHints) break;
    }
  } finally {
    logStageCounters(counters);
    clearInterval(refreshTimer);
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
  tokenQuery: TokenQueryBackend;
  counters: StageCounters;
  /** Wall-clock time the hint was received; used for the opportunity TTL budget. */
  startedAt: number;
  /** Warmed pool-state cache for local-math quotes (path B). Cleared per hint. */
  cache: PoolStateCache;
  poolStateUpdater: PoolStateUpdater;
  fixtureRecorder: LiveFixtureRecorder;
  liveBackend: LiveStateBackend;
  /** Recent candidate route-hop directions for the longtail warmer lane. */
  recentWarmPools: RecentWarmTracker;
  /** Pool targets already covered by the pinned warmer lane. */
  pinnedWarmTargets: Set<string>;
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

  // Per-stage timing from hint receipt — surfaces where the wall time goes
  // (fork setup vs state prep vs detect/plan) so even a no-solver expiry is
  // debuggable: "found opportunity in Xms" and the stage breakdown on expiry.
  const segStart = ctx.startedAt;
  let segPrev = segStart;
  const seg: Record<string, number> = {};
  const segMark = (k: string): void => {
    const now = Date.now();
    seg[k] = now - segPrev;
    segPrev = now;
  };
  const segStr = (): string =>
    `${Object.entries(seg).map(([k, v]) => `${k}=${v}ms`).join(" ")} total=${Date.now() - segStart}ms`;

  const latestBlock = await ctx.provider.getBlockNumber();
  let anvilForkReady = false;
  const ensureHintFork = async (blockNumber: number, forceRefresh = false): Promise<void> => {
    if (anvilForkReady && !forceRefresh) return;
    // Fork-reuse: reset to baseline (~ms) instead of re-forking (~s) each hint;
    // only re-fork every forkRefreshBlocks to refresh state (~7x faster setup).
    if (forceRefresh) {
      await ctx.state.refreshFork(blockNumber);
    } else {
      await ctx.state.ensureFreshFork(blockNumber, ctx.config.forkRefreshBlocks);
    }
    // Pin the cache to this fork block while preserving any block-level state
    // seeded by PoolStateUpdater. The impact pool is marked later, after the
    // opportunity is known.
    ctx.cache.beginHint(blockNumber);
    anvilForkReady = true;
    segMark("fork"); // getBlockNumber + ensureFreshFork/refresh + cache reset
  };

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
  const hintImpact = await matchPoolImpactFromLogs(hintLogs, ctx.graph, ctx.poolAddrs, ctx.tokenQuery);
  segMark("match"); // pool-impact matching against the graph

  // Token-index check: does any hint Transfer involve a token we track?
  const hintTokenHit = hintImpact ? true : hintLogsMatchTokenIndex(hintLogs, ctx.tokenIndex);

  let rawTx: string | undefined;
  let eventLogs: Array<{ address: string; topics: string[]; data: string }> = [];
  let eventFrom = ethers.ZeroAddress;
  let eventNonce = 0;
  let eventTo: string | null = null;
  let eventInput = "0x";
  let eventBlockNumber = latestBlock + 1;
  let submissionMode: BundleSubmission["mode"] = "hash-only";
  let fixturePath: LiveFixturePath = "hash-only";
  let countedHintImpact = false;
  let fixtureImpact: PoolImpact | null = hintImpact;
  let fixtureOpportunities = 0;
  let fixturePlans = 0;
  let lastTerminalState: LiveFinalState = "no-profitable-quote";
  let lastTerminalError: string | undefined;

  const recordFinalState = (
    finalState: LiveFinalState,
    error?: string,
    sim?: { calldata: string; profitToken: string; netProfit: bigint; gasUsed: bigint },
  ): void => {
    const impact = fixtureImpact;
    if (!impact) return;
    ctx.fixtureRecorder.record({
      hintPayload: hint.payload,
      eventLogs,
      report: {
        txHash,
        receivedAt: ctx.startedAt,
        path: fixturePath,
        blockNumber: eventBlockNumber,
        pool: impact.pool,
        tokenIn: impact.tokenIn,
        tokenOut: impact.tokenOut,
        amountIn: impact.amountIn.toString(),
        opportunities: fixtureOpportunities,
        plans: fixturePlans,
        stageMs: { ...seg, total: Date.now() - segStart },
        finalState,
        error,
        calldata: sim?.calldata,
        profitToken: sim?.profitToken,
        netProfit: sim?.netProfit.toString(),
        gasUsed: sim?.gasUsed.toString(),
        counters: counterSnapshot(ctx.counters),
      },
    });
  };

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
      submissionMode = "standalone";
      fixturePath = "mined";
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
      fixturePath = "rawTx";
      rawTx = (await rawTxByHash(ctx.provider, txHash, tx)) ?? undefined;
      if (!rawTx) throw new Error("raw tx unavailable");

      await ensureHintFork(latestBlock);
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

  segMark("prep"); // path A impersonateSwap / path B applyRawTx / path C refetch
  const opportunities = await ctx.detector.detect(event, ctx.state);
  segMark("detect");
  if (countedHintImpact) {
    ctx.counters.impacts += Math.max(0, opportunities.length - 1);
  } else {
    ctx.counters.impacts += opportunities.length;
  }
  if (opportunities.length === 0) {
    console.log(`[searcher/live] ${txHash.slice(0, 10)} no matching graph pool`);
    return;
  }
  fixtureOpportunities = opportunities.length;
  fixtureImpact ??= poolImpactFromOpportunity(opportunities[0]);
  ctx.counters.opportunities += opportunities.length;
  console.log(
    `[searcher/live] detector: ${opportunities.length} opportunities — found in ${Date.now() - segStart}ms (${segStr()})`,
  );

  for (const opp of opportunities) {
    const plans = await ctx.planner.plan(opp, [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY]);
    segMark("plan");
    ctx.counters.plans += plans.length;
    fixturePlans += plans.length;
    console.log(`[searcher/live] planner: ${plans.length} candidate plans`);
    if (plans.length === 0) continue;

    // Backend selection happens after planning. Preparing an overlay for an
    // opportunity with zero candidate paths is pure latency waste (observed as
    // 20s+ cold revm overlay on obscure WETH pairs), and it can expire the hint
    // before the solver gets a chance on real candidate plans.
    const oppImpact = poolImpactFromOpportunity(opp) ?? fixtureImpact;
    const prepareInput = {
      event,
      impact: oppImpact,
      baseBlock: fixturePath === "mined" ? eventBlockNumber : latestBlock,
      path: fixturePath,
      routeHops: dedupeRouteHops(plans, ctx.config.revmPrewarmRouteHops),
    };
    // Feed the between-block warmer: these pools recur across hints, so record
    // their quote directions to pre-warm recent longtail pools on the next block.
    if (oppImpact) {
      ctx.recentWarmPools.record({
        adapterId: oppImpact.matchedAdapterId,
        target: oppImpact.pool,
        tokenIn: oppImpact.tokenIn,
        tokenOut: oppImpact.tokenOut,
      }, oppImpact.amountIn, prepareInput.baseBlock, ctx.pinnedWarmTargets);
      for (const hop of dedupeRouteHops(plans, Number.MAX_SAFE_INTEGER)) {
        ctx.recentWarmPools.record(hop, oppImpact.amountIn, prepareInput.baseBlock, ctx.pinnedWarmTargets);
      }
    }
    let localVictimApply: LocalVictimApplyResult | null = null;
    const supportsConfiguredBackend = ctx.config.liveBackend !== "rpc" &&
      (ctx.liveBackend.supportsPath?.(prepareInput) ?? true);
    if (supportsConfiguredBackend && oppImpact && isLocalVictimApplyAdapter(oppImpact.matchedAdapterId)) {
      const applyStarted = Date.now();
      localVictimApply = applyVictimSwapLocally(ctx.cache, oppImpact, prepareInput.baseBlock);
      if (!localVictimApply) {
        try {
          await ctx.poolStateUpdater.update(prepareInput.baseBlock, [{
            adapterId: oppImpact.matchedAdapterId,
            target: oppImpact.pool,
            tokenIn: oppImpact.tokenIn,
            tokenOut: oppImpact.tokenOut,
            amountIn: oppImpact.amountIn,
          }], { awaitTicks: true, maxTickPools: 1 });
          localVictimApply = applyVictimSwapLocally(ctx.cache, oppImpact, prepareInput.baseBlock);
        } catch (err) {
          console.log(
            `[searcher/live] victim-apply seed failed, falling back to revm overlay: ` +
              `${err instanceof Error ? err.message : String(err)}`.slice(0, 160),
          );
        }
      }
      if (localVictimApply) {
        segMark("victimApply");
        console.log(
          `[searcher/live] victim-apply local ${oppImpact.matchedAdapterId} ` +
            `${oppImpact.pool.slice(0, 10)} amountOut=${localVictimApply.amountOut} ` +
            `${Date.now() - applyStarted}ms`,
        );
      } else {
        console.log(
          `[searcher/live] victim-apply unavailable for ${oppImpact.matchedAdapterId} ` +
            `${oppImpact.pool.slice(0, 10)}, falling back to revm overlay`,
        );
      }
    }

    let useConfiguredBackend = ctx.config.liveBackend === "rpc" || localVictimApply !== null;
    if (!localVictimApply && ctx.config.liveBackend !== "rpc" && supportsConfiguredBackend) {
      try {
        await ctx.liveBackend.prepareVictimState(prepareInput);
        segMark("overlay");
        useConfiguredBackend = true;
      } catch (err) {
        ctx.counters.revmErrors++;
        const message = err instanceof Error ? err.message : String(err);
        if (isBalanceSlotMissingMessage(message)) {
          lastTerminalState = "no-profitable-quote";
          lastTerminalError = message;
          console.log(
            `[searcher/live] revm prepare skipped (balance slot missing, no anvil fallback): ` +
              `${message.slice(0, 160)}`,
          );
          recordFinalState(lastTerminalState, lastTerminalError);
          continue;
        }
        useConfiguredBackend = false;
        console.log(
          `[searcher/live] revm prepare failed, falling back to rpc/anvil: ` +
            `${message.slice(0, 160)}`,
        );
      }
    }
    if (!localVictimApply && (ctx.config.liveBackend === "rpc" || !useConfiguredBackend) && fixturePath === "hash-only") {
      if (!oppImpact) throw new Error("hash-only fallback missing impact");
      await ensureHintFork(latestBlock);
      await impersonateSwap(ctx.state, oppImpact, ctx.graph);
      await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);
      segMark("anvilOverlay");
    }
    if (!localVictimApply && (ctx.config.liveBackend === "rpc" || !useConfiguredBackend) && fixturePath === "mined") {
      await ensureHintFork(eventBlockNumber, true);
      await prepareForkExecutor(ctx.state.provider, ctx.config.wallet.address, ctx.config.botvmAddress);
      segMark("anvilMined");
    }
    const solveProbe = useConfiguredBackend ? ctx.liveBackend : ctx.simulator;
    // In revm/hybrid mode the anvil fork is never started, so route the solver's
    // state reads (PoolStateCache warm-up + quoter fallback) through the live
    // backend's warm post-victim overlay. This is what makes path-B local math
    // run against the shifted state instead of re-faulting slots or bypassing the
    // cache entirely via quoteSource. rpc mode keeps the anvil state backend.
    const useRevmReadState = useConfiguredBackend && ctx.config.liveBackend !== "rpc" && !localVictimApply;
    ctx.cache.beginHint(
      prepareInput.baseBlock,
      localVictimApply
        ? { postImpact: [localVictimApply.postImpact] }
        : oppImpact ? [oppImpact.pool] : [],
    );
    const solveState = useRevmReadState
      ? revmReadState(ctx.state, ctx.liveBackend)
      : localVictimApply
        ? blockReadState(ctx.state, ctx.provider, prepareInput.baseBlock)
      : ctx.state;

    for (const candidate of plans) {
      // Opportunity TTL (v7 AC-3a.5): a hint older than oppTtlMs is chasing stale
      // state — stop solving. Each solve is further capped to the remaining budget
      // so it never runs past the opportunity's useful life. (v7 AC-3a.3)
      const remainingMs = ctx.config.oppTtlMs - (Date.now() - ctx.startedAt);
      if (remainingMs <= 0) {
        ctx.counters.expiredBeforeSolver++;
        console.log(
          `[searcher/live] opportunity expired ` +
            `(${Date.now() - ctx.startedAt}ms > TTL ${ctx.config.oppTtlMs}ms) — never reached solver. ` +
            `stage breakdown: ${segStr()}`,
        );
        recordFinalState("expired-before-solver");
        return;
      }
      try {
        ctx.counters.solverEntered++;
        const resolved = await ctx.solver.solve(candidate, solveState, solveProbe, {
          deadlineMs: Math.min(ctx.config.solverDeadlineMs, remainingMs),
          gssMaxTries: ctx.config.gssMaxTries,
          finalSimTopN: ctx.config.finalSimTopN,
          quoteProfitFloorBps: ctx.config.quoteProfitFloorBps,
          quoteSafetyBps: ctx.config.quoteSafetyBps,
          cache: ctx.cache,
          quoteSource: useConfiguredBackend && ctx.config.liveBackend !== "rpc" && !localVictimApply
            ? ctx.liveBackend
            : undefined,
          deferPhase2Sim: localVictimApply !== null && useConfiguredBackend && ctx.config.liveBackend !== "rpc",
        });
        ctx.counters.solverSuccess++;
        // Terminal verify (v7 AC-3a.4): re-simulate the resolved plan and require
        // strictly positive profit before paying gas — never submit on a plan that
        // only broke even or drifted negative since the solver picked it.
        if (localVictimApply && useConfiguredBackend && ctx.config.liveBackend !== "rpc") {
          if (!shouldRunFinalVerify(
            resolved.netProfit,
            resolved.flashAmount,
            ctx.config.finalVerifyFloorBps,
          )) {
            ctx.counters.finalVerifySkipped++;
            lastTerminalState = "no-profitable-quote";
            lastTerminalError =
              `quoteProfit ${resolved.netProfit} below final verify floor ` +
              `${ctx.config.finalVerifyFloorBps}bps`;
            console.log(
              `[searcher/live] final verify skipped: ${lastTerminalError}`,
            );
            recordFinalState(lastTerminalState, lastTerminalError);
            continue;
          }
          try {
            await ctx.liveBackend.prepareVictimState(prepareInput);
            segMark("finalOverlay");
          } catch (err) {
            ctx.counters.revmErrors++;
            const message = err instanceof Error ? err.message : String(err);
            lastTerminalState = "sim-revert";
            lastTerminalError = `final overlay failed: ${message}`;
            console.log(
              `[searcher/live] final overlay failed after local victim-apply: ` +
                `${message.slice(0, 160)}`,
            );
            recordFinalState(lastTerminalState, lastTerminalError);
            continue;
          }
        }
        const sim = useConfiguredBackend
          ? (ctx.liveBackend.finalVerify
              ? await ctx.liveBackend.finalVerify(resolved)
              : await ctx.liveBackend.simulate(resolved))
          : await ctx.simulator.simulate(resolved);
        if (sim.success && sim.netProfit > 0n) {
          ctx.counters.simSuccess++;
          if (ctx.config.liveBackend === "rpc" || ctx.config.liveBackend === "hybrid") {
            ctx.counters.rpcVerifySuccess++;
          }
          if (ctx.config.liveBackend === "revm" || ctx.config.liveBackend === "hybrid") {
            ctx.counters.revmSimSuccess++;
          }
        }
        // The flash loan must repay (enforced by the assert-balance guard), so a
        // successful sim with positive profit guarantees token profit > 0. Gas
        // economics are the builder's concern — we submit with expectedProfit.
        if (!sim.success) {
          ctx.counters.simReverts++;
          lastTerminalState = "sim-revert";
          lastTerminalError = sim.revertReason;
          recordFinalState("sim-revert", sim.revertReason, sim);
          continue;
        }
        // Strictly positive profit required to submit — a closed-loop flash arb
        // that returns < flashAmount cannot repay the flash (reverts at repayment,
        // so sim.success is already false here), so a "losing bundle" is physically
        // impossible. The quote-profit floor only widens phase-1 admission to catch
        // quotes the safety haircut made pessimistically-negative but that sim
        // positive; it does NOT relax this gate.
        if (sim.netProfit <= 0n) {
          ctx.counters.finalVerifyFailed++;
          lastTerminalState = "final-verify-failed";
          lastTerminalError = `non-positive final profit ${sim.netProfit}`;
          recordFinalState("final-verify-failed", lastTerminalError, sim);
          continue;
        }

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
        recordFinalState("would-submit", undefined, sim);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastTerminalState = isTimeoutMessage(message) ? "quote-timeout" : "no-profitable-quote";
        lastTerminalError = message;
        if (lastTerminalState === "quote-timeout") ctx.counters.quoteTimeouts++;
        if (message.toLowerCase().includes("missing")) ctx.counters.missingState++;
        console.log(
          `[searcher/live] candidate failed: ` +
            `${message}`.slice(0, 180),
        );
      }
    }
  }
  recordFinalState(lastTerminalState, lastTerminalError);
}

function createStageCounters(): StageCounters {
  return {
    hints: 0,
    impacts: 0,
    opportunities: 0,
    plans: 0,
    solverEntered: 0,
    solverSuccess: 0,
    revmSimSuccess: 0,
    rpcVerifySuccess: 0,
    simSuccess: 0,
    submitAttempts: 0,
    accepted: 0,
    expiredBeforeSolver: 0,
    quoteTimeouts: 0,
    simReverts: 0,
    finalVerifyFailed: 0,
    finalVerifySkipped: 0,
    missingState: 0,
    revmErrors: 0,
  };
}

function logStageCounters(counters: StageCounters): void {
  console.log(
    `[searcher/live] counters ` +
      `hints=${counters.hints} ` +
      `impacts=${counters.impacts} ` +
      `opportunities=${counters.opportunities} ` +
      `plans=${counters.plans} ` +
      `solverEntered=${counters.solverEntered} ` +
      `solverSuccess=${counters.solverSuccess} ` +
      `revmSimSuccess=${counters.revmSimSuccess} ` +
      `rpcVerifySuccess=${counters.rpcVerifySuccess} ` +
      `simSuccess=${counters.simSuccess} ` +
      `submitAttempts=${counters.submitAttempts} ` +
      `accepted=${counters.accepted} ` +
      `expiredBeforeSolver=${counters.expiredBeforeSolver} ` +
      `quoteTimeouts=${counters.quoteTimeouts} ` +
      `simReverts=${counters.simReverts} ` +
      `finalVerifyFailed=${counters.finalVerifyFailed} ` +
      `finalVerifySkipped=${counters.finalVerifySkipped} ` +
      `missingState=${counters.missingState} ` +
      `revmErrors=${counters.revmErrors}`,
  );
}

function counterSnapshot(counters: StageCounters): Record<string, number> {
  return { ...counters };
}

/**
 * A StateBackend whose reads (`call`) hit the live backend's warm post-victim
 * overlay instead of the anvil fork. In revm/hybrid mode the anvil fork is never
 * started, so this is what lets the solver's PoolStateCache warm path-B local
 * math (and the quoter's eth_call fallback) from the same shifted state the
 * daemon quotes/simulates against. Only `.call` is exercised by the solve path;
 * every other StateBackend member falls through to `base` via the prototype
 * chain. Falls back to `base` if the backend exposes no `call`.
 */
function revmReadState(base: StateBackend, backend: LiveStateBackend): StateBackend {
  if (!backend.call) return base;
  const call = backend.call.bind(backend);
  return Object.assign(Object.create(base) as StateBackend, {
    call: (req: { to: string; data: string; from?: string }) => call(req),
  });
}

/**
 * Read-only StateBackend view pinned to a mainnet block. Local victim-apply
 * runs quote/search on post-impact cache for the touched pool and pre-victim
 * block reads for every untouched pool, avoiding revm overlay in the hot path.
 */
function blockReadState(
  base: StateBackend,
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
): StateBackend {
  return Object.assign(Object.create(base) as StateBackend, {
    call: (req: { to: string; data: string; from?: string }) =>
      provider.call({
        to: req.to,
        data: req.data,
        from: req.from,
        blockTag: blockNumber,
      }),
  });
}

function isLocalVictimApplyAdapter(adapterId: string): boolean {
  return adapterId === "univ2-swap" || adapterId === "univ3-swap";
}

/**
 * Recent longtail warm lane. Pinned pools are handled in a separate lane, so
 * they are excluded here; otherwise high-frequency bluechip paths crowd out the
 * just-seen longtail pools we are trying to catch on their second/third swap.
 */
class RecentWarmTracker {
  private hops = new Map<string, { hop: QuoteRequest; count: number; lastSeenBlock: number }>();

  constructor(private readonly ttlBlocks: number) {}

  get ttl(): number {
    return this.ttlBlocks;
  }

  record(
    hop: { adapterId: string; target: string; tokenIn: string; tokenOut: string },
    amountIn: bigint,
    blockNumber: number,
    excludeTargets: Set<string>,
  ): void {
    if (amountIn <= 0n) return;
    if (excludeTargets.has(hop.target.toLowerCase())) return;
    const key = `${hop.target.toLowerCase()}|${hop.tokenIn.toLowerCase()}|${hop.tokenOut.toLowerCase()}`;
    const existing = this.hops.get(key);
    if (existing) {
      existing.count++;
      existing.hop.amountIn = amountIn;
      existing.lastSeenBlock = blockNumber;
    } else {
      this.hops.set(key, { hop: { ...hop, amountIn }, count: 1, lastSeenBlock: blockNumber });
    }
  }

  top(k: number, blockNumber: number, excludeTargets: Set<string>): QuoteRequest[] {
    if (k <= 0) return [];
    this.prune(blockNumber, excludeTargets);
    return [...this.hops.values()]
      .sort((a, b) => b.count - a.count || b.lastSeenBlock - a.lastSeenBlock)
      .slice(0, k)
      .map((e) => e.hop);
  }

  private prune(blockNumber: number, excludeTargets: Set<string>): void {
    for (const [key, entry] of this.hops) {
      const expired = this.ttlBlocks >= 0 && blockNumber - entry.lastSeenBlock > this.ttlBlocks;
      const pinned = excludeTargets.has(entry.hop.target.toLowerCase());
      if (expired || pinned) this.hops.delete(key);
    }
  }
}

function topPinnedWarmHops(
  hops: Array<QuoteRequest & { weight?: number }>,
  k: number,
): QuoteRequest[] {
  if (k <= 0) return [];
  return [...hops]
    .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
    .slice(0, k)
    .map(({ adapterId, target, tokenIn, tokenOut, amountIn }) => ({
      adapterId,
      target,
      tokenIn,
      tokenOut,
      amountIn,
    }));
}

function dedupeRouteHops(
  plans: Array<{
    tokenPath: { edges: Array<{ adapterId: string; target: string; tokenIn: string; tokenOut: string }> };
  }>,
  maxHops: number,
): Array<{ adapterId: string; target: string; tokenIn: string; tokenOut: string }> {
  if (maxHops <= 0) return [];
  const seen = new Set<string>();
  const hops: Array<{ adapterId: string; target: string; tokenIn: string; tokenOut: string }> = [];
  for (const plan of plans) {
    for (const edge of plan.tokenPath.edges) {
      const key = `${edge.adapterId}:${edge.target.toLowerCase()}:${edge.tokenIn.toLowerCase()}:${edge.tokenOut.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hops.push({
        adapterId: edge.adapterId,
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
      });
      if (hops.length >= maxHops) return hops;
    }
  }
  return hops;
}

function poolImpactFromOpportunity(
  opportunity: { hints: Record<string, unknown> } | undefined,
): PoolImpact | null {
  const impact = opportunity?.hints.impact;
  if (!impact || typeof impact !== "object") return null;
  const maybe = impact as Partial<PoolImpact>;
  if (
    typeof maybe.pool !== "string" ||
    typeof maybe.tokenIn !== "string" ||
    typeof maybe.tokenOut !== "string" ||
    typeof maybe.amountIn !== "bigint"
  ) {
    return null;
  }
  return maybe as PoolImpact;
}

function isTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("timeout") || lower.includes("timed out") || lower.includes("deadline");
}

function isBalanceSlotMissingMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("balance slot") ||
    lower.includes("could not locate erc20") ||
    lower.includes("could not find balance");
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
