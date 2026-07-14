/**
 * Block-scan exemplar hunt harness.
 *
 * Mainnet-fork + dry-run only. Builds the real protocol-enriched graph at a
 * pinned block, scans it for standing dislocations, then fork-solves the top
 * ranked candidates on local Anvil state.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { AnvilStateBackend, type StateBackend } from "../../shared/state/state-backend.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { detectBlockScanOpportunities, type ProtocolMid } from "../detector/blockscan-scanner.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import type { QuoteRequest } from "../live-state-backend.js";
import { mergePoolRegistries } from "../active-pool-discovery.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { DEFAULT_POOL_UNIVERSE_PATH, loadPoolUniverse } from "../pool-universe.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { PoolStateUpdater } from "../solver/pool-state-updater.js";
import { metronomeSynthPoolIface, quoteFluidDex } from "../solver/quoter.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

const ERC20 = new ethers.Interface(["function decimals() view returns (uint8)"]);
const ERC4626 = new ethers.Interface([
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
]);
const WSTETH = new ethers.Interface([
  "function getWstETHByStETH(uint256 _stETHAmount) view returns (uint256)",
  "function getStETHByWstETH(uint256 _wstETHAmount) view returns (uint256)",
]);
const PSM = new ethers.Interface(["function tin() view returns (uint256)"]);
const V3META = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

const WAD = 10n ** 18n;
const PSM_TO18 = 10n ** 12n;
const Q96 = 1n << 96n;

type ProtocolClass = "erc4626" | "wsteth" | "psm" | "metronome";

interface HuntConfig {
  rpcUrl: string;
  blockNumber: number;
  universePath: string;
  maxPools: number;
  maxHops: number;
  minSpreadBps: number;
  budgetMs: number;
  maxCandidates: number;
  topK: number;
  outPath: string;
  anvilPort: number;
  stateChunk: number;
}

interface WarmCounts {
  chunks: number;
  swapHops: number;
  v2v3Hops: number;
}

interface CurveWarmCounts {
  curveWarmed: number;
  curveFailed: number;
}

interface ProtocolMidResult {
  mids: Map<string, ProtocolMid>;
  classCounts: Map<ProtocolClass, number>;
}

interface OpportunityReport {
  rank: number;
  ring: string[];
  pools: string[];
  poolIds: string[];
  adapterIds: string[];
  spreadBps: number | null;
  searchCenter: string;
  maxInput: string;
  hasProtocolEdge: boolean;
  seedEdges: Array<{
    adapterId: string;
    target: string;
    tokenIn: string;
    tokenOut: string;
    slotKind: string;
    poolId?: string;
  }>;
}

interface SolveReport {
  ring: string[];
  pools: string[];
  spreadBps: number | null;
  planCount: number;
  solved: string | null;
  solveError: string | null;
  searchCenter: string | null;
}

let checks = 0;
let passed = 0;

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

async function check(name: string, run: () => boolean | Promise<boolean>): Promise<void> {
  checks += 1;
  let ok = false;
  try {
    ok = await run();
  } catch (err) {
    console.error(`[blockscan-hunt] ${name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!ok) {
    console.error(`[blockscan-hunt] ${name}: FAIL`);
    throw new Error(name);
  }
  passed += 1;
  console.log(`[blockscan-hunt] ${name}: PASS`);
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required for block-scan hunt.");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const state = new AnvilStateBackend(
    rpcUrl,
    `http://127.0.0.1:${envInt("SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT", 8566)}`,
    envInt("SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT", 8566),
  );

  try {
    const latest = await withTimeout(
      provider.getBlockNumber(),
      30_000,
      `upstream RPC preflight ${redactRpcUrl(rpcUrl)}`,
      rpcUrl,
    );
    const blockNumber = resolveBlockNumber(latest);
    if (latest < blockNumber) {
      throw new Error(`upstream latest block ${latest} is before HUNT_BLOCK ${blockNumber}`);
    }
    const cfg = readConfig(rpcUrl, blockNumber);
    console.log(
      `[blockscan-hunt] upstream=${redactRpcUrl(rpcUrl)} block=${cfg.blockNumber} ` +
        `universe=${cfg.universePath} maxPools=${cfg.maxPools} maxHops=${cfg.maxHops}`,
    );

    const cache = new PoolStateCache(provider);
    cache.setTickBlock(cfg.blockNumber);
    const callBackend = new PinnedCallBackend(provider, cfg.blockNumber);
    const graphBackend = tokenBackend(provider, cfg.blockNumber);

    const universePools = loadPoolUniverse(cfg.universePath, {
      maxPools: cfg.maxPools,
      minScore: 1,
    }).map(lowerPoolEntry);
    const protocolPools = POOL_REGISTRY
      .filter((pool) => pool.adapter !== "fluid-vault")
      .map(lowerPoolEntry);
    const pools = mergePoolRegistries(universePools, protocolPools);
    const rawEdges = await buildTokenGraph(graphBackend, pools);
    const edges = rawEdges.map(lowerEdge);
    const protocolEdges = edges.filter((edge) => edge.slotKind === "protocol");

    await check("graph has swap edges and protocol edges", () =>
      edges.length > 0 && protocolEdges.length > 0,
    );

    const warmCounts = await warmSwapState(provider, cache, cfg, edges);
    await check("v2/v3 state warm completed", () =>
      warmCounts.swapHops === 0 || warmCounts.chunks > 0,
    );

    const curveCounts = await warmCurves(callBackend, cache, cfg.blockNumber, edges);
    await check("curve warm pass accounted for every curve pool", () =>
      curveCounts.curveWarmed + curveCounts.curveFailed === uniqueCurvePools(edges).size,
    );

    const protocolMidResult = await buildProtocolMids(
      provider,
      callBackend,
      cfg.blockNumber,
      edges,
      Date.now() + cfg.budgetMs,
    );
    const protocolMids = protocolMidResult.mids;
    await check("protocol mids cover erc4626, wsteth, psm, and metronome", () =>
      (protocolMidResult.classCounts.get("erc4626") ?? 0) > 0 &&
      (protocolMidResult.classCounts.get("wsteth") ?? 0) > 0 &&
      (protocolMidResult.classCounts.get("psm") ?? 0) > 0 &&
      (protocolMidResult.classCounts.get("metronome") ?? 0) > 0,
    );

    const scan = detectBlockScanOpportunities({
      edges,
      cache,
      sourceBlock: cfg.blockNumber,
      swapTouched: null,
      cfg: {
        maxHops: cfg.maxHops,
        minSpreadBps: cfg.minSpreadBps,
        maxCandidates: cfg.maxCandidates,
        budgetMs: cfg.budgetMs,
        pricedTokens: pricedTokens(),
        protocolMids,
      },
    });
    await check("block scan executed", () =>
      scan.stateBlock === cfg.blockNumber && scan.scannedPairs >= 0,
    );

    const opportunityReports = scan.opportunities.map((opp, i) =>
      describeOpportunity(i + 1, opp, cache, cfg.blockNumber, protocolMids),
    );
    for (const opp of opportunityReports) {
      console.log(
        `[blockscan-hunt] opp rank=${opp.rank} spreadBps=${formatSpread(opp.spreadBps)} ` +
          `center=${opp.searchCenter} protocol=${opp.hasProtocolEdge} ` +
          `ring=${opp.ring.join("->")} pools=${opp.pools.join(",")} ` +
          `adapters=${opp.adapterIds.join(",")}`,
      );
    }

    const solvedReports = await solveTopK(state, cache, cfg, scan.opportunities, protocolMids);
    await check("fork-solve top candidates recorded", () =>
      solvedReports.length === Math.min(cfg.topK, scan.opportunities.length),
    );

    const bestNet = bestSolvedNet(solvedReports);
    const verdict = scan.opportunities.length === 0
      ? "no_candidates"
      : bestNet !== null && bestNet > 0n
        ? "ev_positive_found"
        : "candidates_all_negative";
    const report = {
      stateBlock: cfg.blockNumber,
      universePools: universePools.length,
      graphPools: pools.length,
      edges: edges.length,
      maxHops: cfg.maxHops,
      protocolEdges: protocolEdges.length,
      protocolMids: protocolMids.size,
      scannedPairs: scan.scannedPairs,
      swapVenuesSkipped: scan.debug?.skippedVenues ?? 0,
      stateWarm: warmCounts,
      curveWarmed: curveCounts.curveWarmed,
      curveFailed: curveCounts.curveFailed,
      opportunities: opportunityReports,
      solved: solvedReports,
      verdict,
    };
    mkdirSync(dirname(cfg.outPath), { recursive: true });
    writeFileSync(cfg.outPath, `${JSON.stringify(report, jsonReplacer, 2)}\n`);
    await check("report written", () => readFileSync(cfg.outPath, "utf8").length > 0);
    emitProductionReplayResult(cfg, opportunityReports, solvedReports);

    console.log(
      `blockscan-hunt verdict=${verdict} block=${cfg.blockNumber} ` +
        `opps=${scan.opportunities.length} bestNet=${bestNet === null ? "null" : bestNet.toString()}`,
    );
  } finally {
    state.stop();
    provider.destroy();
  }
}

function emitProductionReplayResult(
  cfg: HuntConfig,
  opportunities: OpportunityReport[],
  solved: SolveReport[],
): void {
  const expectedPools = (process.env.AB_EXPECTED_POOL_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (expectedPools.length === 0) return;
  const expectedProtocol = process.env.AB_EXPECTED_ROUTE_SCOPE === "dex-permissionless-protocol";
  const opportunityIndex = opportunities.findIndex((entry) => {
    const pools = new Set(entry.pools.map((pool) => pool.toLowerCase()));
    return expectedPools.every((pool) => pools.has(pool)) && entry.hasProtocolEdge === expectedProtocol;
  });
  const opportunity = opportunityIndex >= 0 ? opportunities[opportunityIndex] : null;
  const solve = opportunityIndex >= 0 ? solved[opportunityIndex] ?? null : null;
  let stage = "not_admitted";
  if (opportunity) stage = "path_found";
  if (solve?.solved !== null && solve?.solved !== undefined) {
    stage = BigInt(solve.solved) > 0n ? "final_sim_success" : "path_found";
  }
  const closedRoute = Boolean(opportunity
    && opportunity.ring.length >= 2
    && opportunity.ring[0].toLowerCase() === opportunity.ring.at(-1)?.toLowerCase());
  console.log(`BLOCKSCAN_HUNT_RESULT=${JSON.stringify({
    schema_version: 1,
    fork_block: cfg.blockNumber,
    stage,
    expected_pool_ids: expectedPools,
    matched_pool_ids: opportunity?.pools.map((pool) => pool.toLowerCase()) ?? [],
    has_protocol_edge: opportunity?.hasProtocolEdge ?? false,
    closed_route: closedRoute,
    final_sim_success: stage === "final_sim_success",
    net_profit_raw: solve?.solved ?? null,
  })}`);
}

function readConfig(rpcUrl: string, blockNumber: number): HuntConfig {
  void rpcUrl;
  const anvilPort = envInt("SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT", 8566);
  return {
    rpcUrl,
    blockNumber,
    universePath: process.env.HUNT_UNIVERSE_PATH ?? DEFAULT_POOL_UNIVERSE_PATH,
    maxPools: envInt("HUNT_MAX_POOLS", 1500),
    maxHops: envInt("HUNT_MAX_HOPS", 4),
    minSpreadBps: envInt("HUNT_MIN_SPREAD_BPS", 10),
    budgetMs: envInt("HUNT_BUDGET_MS", 10_000),
    maxCandidates: envInt("HUNT_MAX_CANDIDATES", 16),
    topK: envInt("HUNT_TOP_K", 3),
    outPath: process.env.HUNT_OUT ?? `/tmp/blockscan-hunt-${blockNumber}.json`,
    anvilPort,
    stateChunk: envInt("HUNT_STATE_CHUNK", 250),
  };
}

function resolveBlockNumber(latest: number): number {
  const raw = process.env.HUNT_BLOCK?.trim();
  if (!raw) return latest - 1;
  if (raw === "latest") return latest;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`HUNT_BLOCK must be a positive integer or latest, got ${raw}`);
  }
  return parsed;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

function tokenBackend(provider: ethers.JsonRpcProvider, blockNumber: number): TokenQueryBackend {
  return {
    call: (req) => provider.call({ to: req.to, data: req.data, blockTag: blockNumber }),
    getLogs: async (req) => provider.send("eth_getLogs", [req]) as Promise<Array<{ data: string; topics: string[] }>>,
  };
}

async function warmSwapState(
  provider: ethers.JsonRpcProvider,
  cache: PoolStateCache,
  cfg: HuntConfig,
  edges: TokenEdge[],
): Promise<WarmCounts> {
  const swapHops = quoteHops(edges.filter((edge) => edge.slotKind === "swap"));
  const v2v3Hops = swapHops.filter((hop) =>
    hop.adapterId === "univ2-swap" || hop.adapterId === "univ3-swap",
  );
  let chunks = 0;
  for (let i = 0; i < swapHops.length; i += cfg.stateChunk) {
    const chunk = swapHops.slice(i, i + cfg.stateChunk);
    const updater = new PoolStateUpdater(provider, cache, {
      maxPools: cfg.stateChunk,
      maxV3TickPoolsPerBlock: 0,
    });
    await updater.update(cfg.blockNumber, chunk, { awaitTicks: false, maxTickPools: 0 });
    chunks++;
  }
  // snapshotV3 returns null unless the ticks layer is seeded (token0/token1/fee live there),
  // and the scanner's mid only needs sqrtPriceX96/liquidity/fee — NOT the tick arrays. So seed
  // v3 ticks metadata-only (empty bitmap/ticks) to make every v3 venue priceable for DETECTION
  // without the slow TickLens walk. Exact quoting happens in the solver against the fork.
  const v3Seeded = await seedV3TickMetadata(provider, cache, cfg.blockNumber, edges);
  console.log(
    `[blockscan-hunt] state warm block=${cfg.blockNumber} ` +
      `swapHops=${swapHops.length} v2v3Hops=${v2v3Hops.length} chunks=${chunks} v3TickMeta=${v3Seeded}`,
  );
  return { chunks, swapHops: swapHops.length, v2v3Hops: v2v3Hops.length };
}

async function seedV3TickMetadata(
  provider: ethers.JsonRpcProvider,
  cache: PoolStateCache,
  blockNumber: number,
  edges: TokenEdge[],
): Promise<number> {
  const pools = new Set<string>();
  for (const edge of edges) {
    if (edge.slotKind === "swap" && edge.adapterId === "univ3-swap") pools.add(edge.target.toLowerCase());
  }
  let seeded = 0;
  await Promise.all(
    [...pools].map(async (pool) => {
      try {
        const [t0, t1, fee, ts] = await Promise.all([
          provider.call({ to: pool, data: V3META.encodeFunctionData("token0"), blockTag: blockNumber }),
          provider.call({ to: pool, data: V3META.encodeFunctionData("token1"), blockTag: blockNumber }),
          provider.call({ to: pool, data: V3META.encodeFunctionData("fee"), blockTag: blockNumber }),
          provider.call({ to: pool, data: V3META.encodeFunctionData("tickSpacing"), blockTag: blockNumber }),
        ]);
        cache.seedV3Ticks({
          pool,
          token0: String(V3META.decodeFunctionResult("token0", t0)[0]),
          token1: String(V3META.decodeFunctionResult("token1", t1)[0]),
          fee: BigInt(V3META.decodeFunctionResult("fee", fee)[0] as bigint),
          tickSpacing: Number(V3META.decodeFunctionResult("tickSpacing", ts)[0]),
          tickBitmap: new Map<number, bigint>(),
          ticks: new Map<number, bigint>(),
          blockNumber,
        });
        seeded++;
      } catch {
        // Not a v3 pool (or read failure) — leave unseeded; the scanner skips it.
      }
    }),
  );
  return seeded;
}

function quoteHops(edges: TokenEdge[]): QuoteRequest[] {
  return edges.map((edge) => ({
    adapterId: edge.adapterId,
    target: edge.target,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenOut,
    amountIn: 0n,
    poolToken0: edge.poolToken0,
    poolToken1: edge.poolToken1,
    ...(edge.v4PoolKey ? { v4PoolKey: edge.v4PoolKey } : {}),
  }));
}

async function warmCurves(
  state: StateBackend,
  cache: PoolStateCache,
  blockNumber: number,
  edges: TokenEdge[],
): Promise<CurveWarmCounts> {
  let curveWarmed = 0;
  let curveFailed = 0;
  for (const edge of uniqueCurvePools(edges).values()) {
    try {
      await cache.quoteCurve(state, edge.target, edge.tokenIn, edge.tokenOut, 1n);
      if (cache.snapshotCurve(edge.target, blockNumber)) curveWarmed++;
      else curveFailed++;
    } catch (err) {
      curveFailed++;
      console.log(
        `[blockscan-hunt] curve warm failed pool=${edge.target} ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log(`[blockscan-hunt] curve warm warmed=${curveWarmed} failed=${curveFailed}`);
  return { curveWarmed, curveFailed };
}

function uniqueCurvePools(edges: TokenEdge[]): Map<string, TokenEdge> {
  const out = new Map<string, TokenEdge>();
  for (const edge of edges) {
    if (edge.slotKind !== "swap" || !edge.adapterId.includes("curve")) continue;
    const key = edge.target.toLowerCase();
    if (!out.has(key)) out.set(key, edge);
  }
  return out;
}

async function buildProtocolMids(
  provider: ethers.JsonRpcProvider,
  state: StateBackend,
  blockNumber: number,
  edges: TokenEdge[],
  deadlineAtMs: number,
): Promise<ProtocolMidResult> {
  const mids = new Map<string, ProtocolMid>();
  const classCounts = new Map<ProtocolClass, number>();
  const decimals = new Map<string, number>();
  let fluidFailed = 0;
  let fluidMids = 0;
  let deadlineHit = false;

  for (const edge of edges) {
    if (Date.now() >= deadlineAtMs) {
      deadlineHit = true;
      break;
    }
    const protocolClass = classifyProtocol(edge);
    if (!protocolClass) continue;
    try {
      const tokenInDec = await tokenDecimals(provider, blockNumber, edge.tokenIn, decimals);
      const oneIn = 10n ** BigInt(tokenInDec);
      const mid = await readProtocolMid(provider, blockNumber, edge, oneIn);
      if (!Number.isFinite(mid) || mid <= 0) continue;
      // Crude rank/size proxy only. The fork solver truth-checks executable
      // sizes, so this depth value is not load-bearing.
      const depthIn = oneIn * 10_000n;
      mids.set(protocolKey(edge.target, edge.tokenIn, edge.tokenOut), {
        mid,
        feeBps: 0,
        depthIn,
      });
      classCounts.set(protocolClass, (classCounts.get(protocolClass) ?? 0) + 1);
    } catch (err) {
      console.log(
        `[blockscan-hunt] protocol mid failed adapter=${edge.adapterId} target=${edge.target} ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!deadlineHit) {
    for (const edge of edges) {
      if (Date.now() >= deadlineAtMs) {
        deadlineHit = true;
        break;
      }
      if (!isFluidDexSwap(edge)) continue;
      try {
        const tokenInDec = await tokenDecimals(provider, blockNumber, edge.tokenIn, decimals);
        const oneIn = 10n ** BigInt(tokenInDec);
        const mid = await readFluidDexMid(state, edge, oneIn);
        if (!Number.isFinite(mid) || mid <= 0) continue;
        mids.set(protocolKey(edge.target, edge.tokenIn, edge.tokenOut), {
          mid,
          feeBps: 0,
          depthIn: oneIn * 10_000n,
        });
        fluidMids++;
      } catch (err) {
        fluidFailed++;
        console.log(
          `[blockscan-hunt] fluid mid failed adapter=${edge.adapterId} target=${edge.target} ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  console.log(
    `[blockscan-hunt] protocol mids total=${mids.size} ` +
      `erc4626=${classCounts.get("erc4626") ?? 0} ` +
      `wsteth=${classCounts.get("wsteth") ?? 0} psm=${classCounts.get("psm") ?? 0} ` +
      `metronome=${classCounts.get("metronome") ?? 0} ` +
      `fluid=${fluidMids} fluidFailed=${fluidFailed} deadline=${deadlineHit ? 1 : 0}`,
  );
  return { mids, classCounts };
}

function isFluidDexSwap(edge: TokenEdge): boolean {
  return edge.slotKind === "swap" && edge.adapterId.toLowerCase().includes("fluid-dex");
}

function classifyProtocol(edge: TokenEdge): ProtocolClass | null {
  if (edge.adapterId === "psm") return "psm";
  if (edge.adapterId === "metronome-synth-swap") return "metronome";
  if (edge.adapterId === "wsteth-wrap" || edge.adapterId === "wsteth-unwrap") return "wsteth";
  if (
    edge.adapterId === "erc4626-deposit" ||
    edge.adapterId === "erc4626-redeem" ||
    edge.adapterId === "erc4626-redeem-silo"
  ) {
    return "erc4626";
  }
  return null;
}

async function readProtocolMid(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  edge: TokenEdge,
  oneIn: bigint,
): Promise<number> {
  if (edge.adapterId === "erc4626-deposit") {
    const out = await callUint(provider, blockNumber, edge.target, ERC4626.encodeFunctionData("previewDeposit", [oneIn]), "previewDeposit");
    return Number(out) / Number(oneIn);
  }
  if (edge.adapterId === "erc4626-redeem") {
    const out = await callUint(provider, blockNumber, edge.target, ERC4626.encodeFunctionData("previewRedeem", [oneIn]), "previewRedeem");
    return Number(out) / Number(oneIn);
  }
  if (edge.adapterId === "erc4626-redeem-silo") {
    const value = await callUint(provider, blockNumber, edge.target, ERC4626.encodeFunctionData("previewRedeem", [oneIn]), "previewRedeem");
    const out = await callUint(provider, blockNumber, edge.tokenOut, ERC4626.encodeFunctionData("previewWithdraw", [value]), "previewWithdraw");
    return Number(out) / Number(oneIn);
  }
  if (edge.adapterId === "wsteth-wrap") {
    const out = await callUint(provider, blockNumber, edge.target, WSTETH.encodeFunctionData("getWstETHByStETH", [oneIn]), "getWstETHByStETH");
    return Number(out) / Number(oneIn);
  }
  if (edge.adapterId === "wsteth-unwrap") {
    const out = await callUint(provider, blockNumber, edge.target, WSTETH.encodeFunctionData("getStETHByWstETH", [oneIn]), "getStETHByWstETH");
    return Number(out) / Number(oneIn);
  }
  if (edge.adapterId === "psm") {
    let tin = 0n;
    try {
      tin = await callUint(provider, blockNumber, edge.target, PSM.encodeFunctionData("tin"), "tin");
    } catch {
      tin = 0n;
    }
    return Number(PSM_TO18 * (WAD - tin)) / Number(WAD);
  }
  if (edge.adapterId === "metronome-synth-swap") {
    const result = await provider.call({
      to: edge.target,
      data: metronomeSynthPoolIface.encodeFunctionData("quoteSwapOut", [
        edge.tokenIn,
        edge.tokenOut,
        oneIn,
      ]),
      blockTag: blockNumber,
    });
    const decoded = metronomeSynthPoolIface.decodeFunctionResult("quoteSwapOut", result);
    return Number(decoded[0]) / Number(oneIn);
  }
  throw new Error(`unsupported protocol adapter ${edge.adapterId}`);
}

async function readFluidDexMid(
  state: StateBackend,
  edge: TokenEdge,
  oneIn: bigint,
): Promise<number> {
  const out = await quoteFluidDex(
    state,
    edge.target,
    edge.tokenIn,
    edge.tokenOut,
    oneIn,
    edge.poolToken0,
    edge.poolToken1,
  );
  return Number(out) / Number(oneIn);
}

async function tokenDecimals(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  token: string,
  cache: Map<string, number>,
): Promise<number> {
  const key = token.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const data = await provider.call({
    to: token,
    data: ERC20.encodeFunctionData("decimals"),
    blockTag: blockNumber,
  });
  const dec = Number(ERC20.decodeFunctionResult("decimals", data)[0]);
  cache.set(key, dec);
  return dec;
}

async function callUint(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  target: string,
  data: string,
  fnName: string,
): Promise<bigint> {
  const result = await provider.call({ to: target, data, blockTag: blockNumber });
  const iface = fnName === "tin" ? PSM : fnName.startsWith("get") ? WSTETH : ERC4626;
  return BigInt(iface.decodeFunctionResult(fnName, result)[0]);
}

function pricedTokens(): Map<string, { maxBorrow: bigint }> {
  return new Map([
    [ADDR.WETH.toLowerCase(), { maxBorrow: 2_000n * 10n ** 18n }],
    [ADDR.USDC.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.USDT.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
    [ADDR.DAI.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 18n }],
  ]);
}

async function solveTopK(
  state: AnvilStateBackend,
  cache: PoolStateCache,
  cfg: HuntConfig,
  opportunities: BlockScanOpportunity[],
  protocolMids: ReadonlyMap<string, ProtocolMid>,
): Promise<SolveReport[]> {
  const top = opportunities.slice(0, cfg.topK);
  if (top.length === 0) return [];

  console.log(
    `[blockscan-hunt] fork upstream=${redactRpcUrl(cfg.rpcUrl)} ` +
      `block=${cfg.blockNumber} anvil=http://127.0.0.1:${cfg.anvilPort}`,
  );
  await state.forkAt(cfg.blockNumber);
  await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);

  const planner = new TemplatePlanner();
  const solver = new AnvilSolver();
  const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
  const reports: SolveReport[] = [];

  for (const opp of top) {
    const spreadBps = estimateSpreadBps(cache, cfg.blockNumber, opp.seedEdges, protocolMids);
    let planCount = 0;
    let solved: ResolvedPlan | null = null;
    let solveError: string | null = null;
    let searchCenter: string | null = null;
    try {
      planner.setGraph(opp.seedEdges);
      const plans = await planner.planBlockScanFromSeedEdges(opp, [FLASH_SWAP_REPAY]);
      planCount = plans.length;
      if (plans.length === 0) {
        throw new Error("no candidate plans");
      }
      // Exact solve reads the FORK directly (matches searcher:blockscan-fork-solve); do NOT pass
      // the detection cache — it holds metadata-only v3 ticks for cheap mids, which would corrupt
      // a cache-local exact quote. The fork + eth_call quoter is the source of truth for EV.
      const center = await resolveSearchCenter(plans[0], opp.flashToken, state, {});
      searchCenter = center.toString();
      solved = await solver.solve(plans[0], state, simulator, {
        finalSimTopN: 3,
        gssMaxTries: 8,
        quoteProfitFloorBps: 0n,
        quoteSafetyBps: 10000n,
      });
    } catch (err) {
      solveError = err instanceof Error ? err.message : String(err);
    }
    const report = {
      ring: ringTokens(opp.seedEdges),
      pools: uniqueStrings(opp.seedEdges.map(edgePoolIdentity)),
      spreadBps,
      planCount,
      solved: solved ? solved.netProfit.toString() : null,
      solveError,
      searchCenter,
    };
    reports.push(report);
    console.log(
      `[blockscan-hunt] solve rank=${reports.length} planCount=${planCount} ` +
        `net=${report.solved ?? "null"} error=${solveError ? solveError.slice(0, 160) : "none"}`,
    );
  }
  return reports;
}

function describeOpportunity(
  rank: number,
  opp: BlockScanOpportunity,
  cache: PoolStateCache,
  blockNumber: number,
  protocolMids: ReadonlyMap<string, ProtocolMid>,
): OpportunityReport {
  return {
    rank,
    ring: ringTokens(opp.seedEdges),
    pools: uniqueStrings(opp.seedEdges.map(edgePoolIdentity)),
    poolIds: uniqueStrings(opp.seedEdges.map((edge) => edge.poolId?.toLowerCase()).filter(isString)),
    adapterIds: opp.seedEdges.map((edge) => edge.adapterId),
    spreadBps: estimateSpreadBps(cache, blockNumber, opp.seedEdges, protocolMids),
    searchCenter: opp.searchSeed.searchCenter.toString(),
    maxInput: opp.searchSeed.maxInput.toString(),
    hasProtocolEdge: opp.seedEdges.some((edge) => edge.slotKind === "protocol"),
    seedEdges: opp.seedEdges.map((edge) => ({
      adapterId: edge.adapterId,
      target: edge.target.toLowerCase(),
      tokenIn: edge.tokenIn.toLowerCase(),
      tokenOut: edge.tokenOut.toLowerCase(),
      slotKind: edge.slotKind,
      ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
    })),
  };
}

function estimateSpreadBps(
  cache: PoolStateCache,
  blockNumber: number,
  edges: TokenEdge[],
  protocolMids: ReadonlyMap<string, ProtocolMid>,
): number | null {
  let product = 1;
  for (const edge of edges) {
    const mid = directedMid(cache, blockNumber, edge, protocolMids);
    if (mid === null) return null;
    product *= mid.mid * (1 - mid.feeBps / 10_000);
  }
  const spread = (product - 1) * 10_000;
  return Number.isFinite(spread) ? spread : null;
}

function directedMid(
  cache: PoolStateCache,
  blockNumber: number,
  edge: TokenEdge,
  protocolMids: ReadonlyMap<string, ProtocolMid>,
): { mid: number; feeBps: number } | null {
  const tokenIn = edge.tokenIn.toLowerCase();
  const tokenOut = edge.tokenOut.toLowerCase();
  if (edge.slotKind === "protocol" || isFluidDexSwap(edge)) {
    return externalDirectedMid(protocolMids, edge.target, tokenIn, tokenOut);
  }
  if (edge.adapterId === "univ2-swap") {
    const snap = cache.snapshotV2(edge.target, blockNumber);
    if (!snap) return null;
    return reserveMid(
      tokenIn,
      tokenOut,
      snap.token0,
      snap.token1,
      snap.reserve0,
      snap.reserve1,
      30,
    );
  }
  if (edge.adapterId === "univ3-swap") {
    const snap = cache.snapshotV3(edge.target, blockNumber);
    if (!snap || snap.state.sqrtPriceX96 <= 0n) return null;
    const price0To1 = (Number(snap.state.sqrtPriceX96) / Number(Q96)) ** 2;
    if (snap.token0.toLowerCase() === tokenIn && snap.token1.toLowerCase() === tokenOut) {
      return { mid: price0To1, feeBps: Number(snap.state.fee) / 100 };
    }
    if (snap.token1.toLowerCase() === tokenIn && snap.token0.toLowerCase() === tokenOut) {
      return { mid: 1 / price0To1, feeBps: Number(snap.state.fee) / 100 };
    }
    return null;
  }
  if (edge.adapterId.includes("curve")) {
    const snap = cache.snapshotCurve(edge.target, blockNumber);
    if (!snap) return null;
    const i = snap.coins.findIndex((coin) => coin.toLowerCase() === tokenIn);
    const j = snap.coins.findIndex((coin) => coin.toLowerCase() === tokenOut);
    if (i < 0 || j < 0) return null;
    const state = snap.kind === "plain" ? snap.plain : snap.ng;
    if (!state) return null;
    return reserveMid(
      tokenIn,
      tokenOut,
      tokenIn,
      tokenOut,
      state.balances[i],
      state.balances[j],
      state.fee === undefined ? 4 : Number(state.fee) / 1_000_000,
    );
  }
  return null;
}

function externalDirectedMid(
  mids: ReadonlyMap<string, ProtocolMid>,
  target: string,
  tokenIn: string,
  tokenOut: string,
): { mid: number; feeBps: number } | null {
  const direct = mids.get(protocolKey(target, tokenIn, tokenOut));
  if (direct) return { mid: direct.mid, feeBps: direct.feeBps };
  const reverse = mids.get(protocolKey(target, tokenOut, tokenIn));
  if (!reverse || !Number.isFinite(reverse.mid) || reverse.mid <= 0) return null;
  return { mid: 1 / reverse.mid, feeBps: reverse.feeBps };
}

function reserveMid(
  tokenIn: string,
  tokenOut: string,
  token0: string,
  token1: string,
  reserve0: bigint,
  reserve1: bigint,
  feeBps: number,
): { mid: number; feeBps: number } | null {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  let reserveIn: bigint | null = null;
  let reserveOut: bigint | null = null;
  if (t0 === tokenIn && t1 === tokenOut) {
    reserveIn = reserve0;
    reserveOut = reserve1;
  } else if (t1 === tokenIn && t0 === tokenOut) {
    reserveIn = reserve1;
    reserveOut = reserve0;
  }
  if (reserveIn === null || reserveOut === null || reserveIn <= 0n || reserveOut <= 0n) return null;
  const mid = Number(reserveOut) / Number(reserveIn);
  return Number.isFinite(mid) && mid > 0 ? { mid, feeBps } : null;
}

function ringTokens(edges: TokenEdge[]): string[] {
  if (edges.length === 0) return [];
  return [edges[0].tokenIn.toLowerCase(), ...edges.map((edge) => edge.tokenOut.toLowerCase())];
}

function edgePoolIdentity(edge: TokenEdge): string {
  return (edge.poolId ?? edge.target).toLowerCase();
}

function protocolKey(target: string, tokenIn: string, tokenOut: string): string {
  return `${target.toLowerCase()}|${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}`;
}

function bestSolvedNet(reports: SolveReport[]): bigint | null {
  let best: bigint | null = null;
  for (const report of reports) {
    if (report.solved === null) continue;
    const net = BigInt(report.solved);
    if (best === null || net > best) best = net;
  }
  return best;
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

function lowerEdge(edge: TokenEdge): TokenEdge {
  return {
    ...edge,
    target: lowerAddress(edge.target),
    tokenIn: lowerAddress(edge.tokenIn),
    tokenOut: lowerAddress(edge.tokenOut),
    poolToken0: lowerOptionalAddress(edge.poolToken0),
    poolToken1: lowerOptionalAddress(edge.poolToken1),
    poolId: edge.poolId?.toLowerCase(),
    v4PoolKey: edge.v4PoolKey
      ? {
          currency0: lowerAddress(edge.v4PoolKey.currency0),
          currency1: lowerAddress(edge.v4PoolKey.currency1),
          fee: edge.v4PoolKey.fee,
          tickSpacing: edge.v4PoolKey.tickSpacing,
          hooks: lowerAddress(edge.v4PoolKey.hooks),
        }
      : undefined,
  };
}

function lowerOptionalAddress(value: string | undefined): string | undefined {
  return value === undefined ? undefined : lowerAddress(value);
}

function lowerAddress(value: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress.toLowerCase();
  return ethers.getAddress(value.toLowerCase()).toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function formatSpread(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? "<redacted>" : "";
    parsed.password = parsed.password ? "<redacted>" : "";
    const localHost = parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1";
    if (!localHost && parsed.pathname && parsed.pathname !== "/") {
      parsed.pathname = "/redacted";
    }
    if (parsed.search) parsed.search = "?<redacted>";
    return parsed.toString();
  } catch {
    return url.startsWith("http") ? "<rpc-url>" : url;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  secret?: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = secret ? msg.split(secret).join("<rpc-url>") : msg;
    throw new Error(`${label} failed: ${redacted}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class PinnedCallBackend implements StateBackend {
  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly blockNumber: number,
  ) {}

  async call(req: { to: string; data: string; from?: string }): Promise<string> {
    return this.provider.call({
      to: req.to,
      data: req.data,
      from: req.from,
      blockTag: this.blockNumber,
    });
  }

  async forkAt(): Promise<void> {
    this.unsupported("forkAt");
  }

  async forkAfterTx(): Promise<void> {
    this.unsupported("forkAfterTx");
  }

  async prepareVictimPostState(): Promise<never> {
    this.unsupported("prepareVictimPostState");
  }

  async applyRawTx(): Promise<never> {
    this.unsupported("applyRawTx");
  }

  async queueHistoricalRawTransactions(): Promise<never> {
    this.unsupported("queueHistoricalRawTransactions");
  }

  async snapshot(): Promise<never> {
    this.unsupported("snapshot");
  }

  async revert(): Promise<void> {
    this.unsupported("revert");
  }

  async send(): Promise<never> {
    this.unsupported("send");
  }

  async getGasUsed(): Promise<never> {
    this.unsupported("getGasUsed");
  }

  async getTokenBalance(): Promise<never> {
    this.unsupported("getTokenBalance");
  }

  private unsupported(method: string): never {
    throw new Error(`PinnedCallBackend.${method} unsupported`);
  }
}

main().catch((err) => {
  console.error(`blockscan-hunt FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
