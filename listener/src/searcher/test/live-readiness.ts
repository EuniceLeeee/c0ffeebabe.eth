/**
 * Live-readiness harness — measures what the V7 changes actually target:
 * coverage and search-bound on REAL recent orderflow, NOT the one historical
 * wstUSR arb (that's AC-3, a backtest regression fixture).
 *
 * Pure dry-run: no anvil, no solver, no simulate, no private key.
 *   - Build the routing graph from the live pool set (same as main.ts).
 *   - Pull recent-block swap logs, group by tx → synthetic logs-only hints.
 *   - detector.detect → planner.plan (in-memory DFS). Stop there.
 *
 * Metrics:
 *   LR-1 coverage : % of hints that match a pool AND yield >=1 candidate.
 *   LR-2 bound    : per-opportunity candidate count + planner wall
 *                   (avg / p50 / p95 / max) — the multiplier into solver/quote.
 *
 * Re-run after Stage 2 (fewer-paths) to show candidate count drops and the
 * planner wall stays bounded on the live-sized graph.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ethers } from "ethers";
import { BackrunDetector } from "../detector/detector.js";
import { TemplatePlanner } from "../planner/planner.js";
import { FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY } from "../templates/path-template.js";
import {
  buildTokenGraph,
  buildTokenIndex,
  POOL_REGISTRY,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import {
  scanActivePools,
  indexFactoryPools,
  mergePoolRegistries,
} from "../active-pool-discovery.js";
import {
  DEFAULT_PINNED_WARM_POOLS_PATH,
  loadPinnedWarmPools,
} from "../pinned-warm-pools.js";
import {
  DEFAULT_POOL_UNIVERSE_PATH,
  loadPoolUniverse,
} from "../pool-universe.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { OrderflowEvent } from "../orderflow/manual-source.js";

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

const SWAP_TOPICS = [
  ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)"), // UniV3
  ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)"), // UniV2
  ethers.id("TokenExchange(address,int128,uint256,int128,uint256)"), // Curve
  ethers.id("TokenExchange(address,uint256,uint256,uint256,uint256)"), // Curve (uint)
];

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

/** Chunked eth_getLogs over [from,to] for one topic, splitting on RPC range errors. */
async function getLogs(
  provider: ethers.JsonRpcProvider,
  topic: string,
  from: number,
  to: number,
): Promise<RawLog[]> {
  try {
    return await provider.send("eth_getLogs", [{
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
      topics: [topic],
    }]);
  } catch {
    if (to <= from) return [];
    const mid = Math.floor((from + to) / 2);
    const [a, b] = await Promise.all([
      getLogs(provider, topic, from, mid),
      getLogs(provider, topic, mid + 1, to),
    ]);
    return [...a, ...b];
  }
}

/** Pull recent swap logs and group them by tx → one synthetic logs-only hint per tx. */
async function recentSwapHints(
  provider: ethers.JsonRpcProvider,
  blocksBack: number,
  maxHints: number,
): Promise<OrderflowEvent[]> {
  const latest = await provider.getBlockNumber();
  const from = latest - blocksBack;

  const byTx = new Map<string, OrderflowEvent>();
  for (const topic of SWAP_TOPICS) {
    const logs = await getLogs(provider, topic, from, latest);
    for (const log of logs) {
      const tx = log.transactionHash;
      let event = byTx.get(tx);
      if (!event) {
        event = {
          txHash: tx,
          blockNumber: parseInt(log.blockNumber, 16),
          rawTx: "0x",
          from: ethers.ZeroAddress,
          nonce: 0,
          to: null,
          input: "0x",
          logs: [],
          minProfit: 1n,
        };
        byTx.set(tx, event);
      }
      event.logs.push({ address: log.address, topics: log.topics, data: log.data });
    }
  }

  const hints = [...byTx.values()];
  return hints.slice(0, maxHints);
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(label: string, values: number[]): void {
  if (values.length === 0) {
    console.log(`  ${label}: (none)`);
    return;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  console.log(
    `  ${label}: avg=${avg.toFixed(1)} p50=${pct(sorted, 50).toFixed(1)} ` +
      `p95=${pct(sorted, 95).toFixed(1)} max=${sorted[sorted.length - 1].toFixed(1)} (n=${values.length})`,
  );
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const discoveryBlocks = Number(process.env.LR_DISCOVERY_BLOCKS ?? "300");
  const discoveryTopN = Number(process.env.LR_DISCOVERY_TOP_N ?? "150");
  const factoryBlocks = Number(process.env.LR_FACTORY_BLOCKS ?? "0"); // 0 = skip factory index (fast baseline)
  const hintBlocks = Number(process.env.LR_HINT_BLOCKS ?? "5");
  const maxHints = Number(process.env.LR_MAX_HINTS ?? "200");
  const pinnedPoolPath = process.env.SEARCHER_PINNED_WARM_POOLS ?? DEFAULT_PINNED_WARM_POOLS_PATH;
  const poolUniversePath = process.env.LR_POOL_UNIVERSE_PATH ??
    process.env.SEARCHER_POOL_UNIVERSE_PATH ??
    DEFAULT_POOL_UNIVERSE_PATH;
  const poolUniverseTopN = Number(
    process.env.LR_POOL_UNIVERSE_TOP_N ??
      process.env.SEARCHER_POOL_UNIVERSE_TOP_N ??
      "0",
  );
  const poolUniverseMinScore = Number(
    process.env.LR_POOL_UNIVERSE_MIN_SCORE ??
      process.env.SEARCHER_POOL_UNIVERSE_MIN_SCORE ??
      "1",
  );

  console.log("[liveready] building live pool graph (dry-run, no anvil)");
  const pinnedPools = loadPinnedWarmPools(pinnedPoolPath);
  const universePools = loadPoolUniverse(poolUniversePath, {
    maxPools: poolUniverseTopN,
    minScore: poolUniverseMinScore,
  });
  const swapPools = await scanActivePools(provider, discoveryBlocks, discoveryTopN);
  let allPools = mergePoolRegistries(
    mergePoolRegistries(
      mergePoolRegistries(POOL_REGISTRY, pinnedPools),
      universePools,
    ),
    swapPools,
  );
  let factoryPoolCount = 0;
  if (factoryBlocks > 0) {
    const factoryPools = await indexFactoryPools(provider, factoryBlocks);
    factoryPoolCount = factoryPools.length;
    allPools = mergePoolRegistries(allPools, factoryPools);
  }
  console.log(
    `[liveready] pool registry: ${POOL_REGISTRY.length} protocol + ` +
      `${pinnedPools.length} pinned + ${universePools.length} universe + ` +
      `${factoryPoolCount} factory + ${swapPools.length} swap-active = ` +
      `${allPools.length} total`,
  );
  console.log(
    `[liveready] poolUniverse=${poolUniversePath} ` +
      `topN=${poolUniverseTopN} minScore=${poolUniverseMinScore}`,
  );

  const backend: TokenQueryBackend = { call: (req) => provider.call(req) };
  const graph = await buildTokenGraph(backend, allPools);
  const tokenIndex = buildTokenIndex(graph);
  const allPoolMap = new Map<string, string>();
  for (const p of allPools) allPoolMap.set(p.address.toLowerCase(), p.adapter);

  console.log(
    `[liveready] graph: ${graph.length} edges, ${tokenIndex.size} tokens | ` +
      `pool set: ${allPoolMap.size} addresses`,
  );

  const detector = new BackrunDetector();
  detector.setGraph(graph);
  detector.setPoolAddressMap(allPoolMap);
  detector.setTokenQuery(backend);
  const planner = new TemplatePlanner();
  planner.setGraph(graph);
  planner.setMaxCandidates(Number(process.env.SEARCHER_MAX_CANDIDATES ?? "20"));
  const maxHops = Number(process.env.LR_MAX_HOPS ?? "3");
  const maxPoolsPerToken = Number(process.env.LR_MAX_POOLS_PER_TOKEN ?? "6");
  planner.setMaxHops(maxHops);
  planner.setMaxPoolsPerToken(maxPoolsPerToken);
  console.log(`[liveready] bounds: maxHops=${maxHops} maxPoolsPerToken=${maxPoolsPerToken}`);

  const hints = await recentSwapHints(provider, hintBlocks, maxHints);
  console.log(`[liveready] replaying ${hints.length} synthetic hints from last ${hintBlocks} blocks\n`);

  // detector.detect's state arg is unused for log-based detection; stub it.
  const stubState = {} as unknown as StateBackend;
  const templates = [FLASH_LEND_SWAP_REPAY, FLASH_SWAP_REPAY];

  let hintsWithImpact = 0; // detector found >=1 opportunity
  let hintsWithCandidate = 0; // planner produced >=1 candidate
  const candidateCounts: number[] = []; // per opportunity
  const plannerWalls: number[] = []; // per opportunity, ms

  for (const hint of hints) {
    let opps;
    try {
      opps = await detector.detect(hint, stubState);
    } catch {
      continue;
    }
    if (opps.length > 0) hintsWithImpact++;

    let hintCandidates = 0;
    for (const opp of opps) {
      const t0 = performance.now();
      let plans;
      try {
        plans = await planner.plan(opp, templates);
      } catch {
        plannerWalls.push(performance.now() - t0);
        candidateCounts.push(0);
        continue;
      }
      plannerWalls.push(performance.now() - t0);
      candidateCounts.push(plans.length);
      hintCandidates += plans.length;
    }
    if (hintCandidates > 0) hintsWithCandidate++;
  }

  const n = hints.length || 1;
  console.log("=== LR-1 coverage ===");
  console.log(`  hints replayed:        ${hints.length}`);
  console.log(`  hints w/ pool impact:  ${hintsWithImpact} (${((hintsWithImpact / n) * 100).toFixed(1)}%)`);
  console.log(`  hints w/ >=1 candidate: ${hintsWithCandidate} (${((hintsWithCandidate / n) * 100).toFixed(1)}%)`);
  console.log("\n=== LR-2 search bound (per opportunity) ===");
  summarize("candidate count", candidateCounts);
  summarize("planner wall ms ", plannerWalls);
  console.log("");
}

main().catch((err) => {
  console.error(`[liveready] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
