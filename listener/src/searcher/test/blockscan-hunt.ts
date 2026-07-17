/**
 * Block-scan exemplar hunt harness.
 *
 * Mainnet-fork + dry-run only. Builds the real protocol-enriched graph at a
 * pinned block, scans it for standing dislocations, then fork-solves the top
 * ranked candidates on local Anvil state.
 */

import { createHash } from "node:crypto";
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
import {
  detectBlockScanOpportunities,
  estimateBlockScanRingSpreadBps,
  type ProtocolMid,
} from "../detector/blockscan-scanner.js";
import { buildExactBlockScanCurveMids } from "../detector/blockscan-curve-mids.js";
import {
  refineBlockScanCandidates,
  type BlockScanProbeDiagnostic,
} from "../detector/blockscan-candidate-refinement.js";
import {
  blockScanPassBudgetExceeded,
  resolveBlockScanHuntBudgets,
  selectedReplayOpportunityIndexes,
  solveForOpportunityIndex,
} from "./blockscan-hunt-selection.js";
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
import { metronomeSynthPoolIface, quote } from "../solver/quoter.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { evaluateEv } from "../ev-evaluator.js";
import { DEFAULT_BRIBE_BPS } from "../live-envelope.js";
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

type ProtocolClass = "erc4626" | "wsteth" | "psm" | "metronome" | "other";

type DiagnosticStopAfter = "graph" | "enumeration" | "refine" | "solve" | "sim" | "ev";

interface DiagnosticOptions {
  enabled: boolean;
  maxCandidates?: number;
  scanBudgetMs?: number;
  passBudgetMs?: number;
  topK?: number;
  stopAfter?: DiagnosticStopAfter;
}

const DIAGNOSTIC = parseDiagnosticArgs(process.argv.slice(2));

interface HuntConfig {
  rpcUrl: string;
  blockNumber: number;
  universePath: string;
  maxPools: number;
  maxHops: number;
  minSpreadBps: number;
  scanBudgetMs: number;
  passBudgetMs: number;
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
  deadlineHit: boolean;
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
  swapPath: Array<{ pool_id: string; direction: "0for1" | "1for0" }> | null;
  route: Array<{
    adapterId: string;
    slotKind: "swap" | "protocol";
    target: string;
    tokenIn: string;
    tokenOut: string;
    poolId?: string;
  }>;
}

interface SolveReport {
  opportunityIndex: number;
  ring: string[];
  pools: string[];
  spreadBps: number | null;
  planCount: number;
  solved: string | null;
  solveError: string | null;
  searchCenter: string | null;
  diagnosticSimulation?: {
    success: boolean;
    profitToken: string;
    grossProfit: string;
    gasUsed: string;
    netProfit: string;
    calldataHash: string;
    revertReason: string | null;
  };
  diagnosticEv?: {
    decision: "allow" | "below_ev_gate" | "unpriceable_profit_token" | "disabled";
    evGate: boolean;
    netEvWei: string;
    expectedProfitEth: string;
    gasCostEth: string;
    bidEth: string;
    minNetEth: string;
  };
}

let checks = 0;
let passed = 0;
let lastDiagnosticStep = 0;

function parseDiagnosticArgs(args: string[]): DiagnosticOptions {
  if (args.length === 0) return { enabled: false };
  const parsed: DiagnosticOptions = { enabled: false };
  for (let index = 0; index < args.length;) {
    const name = args[index++];
    if (name === "--diagnostic") {
      if (parsed.enabled) throw new Error("--diagnostic may appear only once");
      parsed.enabled = true;
      continue;
    }
    const value = args[index++];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires one value`);
    }
    if (name === "--max-candidates") {
      if (parsed.maxCandidates !== undefined) throw new Error(`${name} may appear only once`);
      parsed.maxCandidates = diagnosticPositiveInt(name, value);
    } else if (name === "--scan-budget-ms") {
      if (parsed.scanBudgetMs !== undefined) throw new Error(`${name} may appear only once`);
      parsed.scanBudgetMs = diagnosticPositiveInt(name, value);
    } else if (name === "--pass-budget-ms") {
      if (parsed.passBudgetMs !== undefined) throw new Error(`${name} may appear only once`);
      parsed.passBudgetMs = diagnosticPositiveInt(name, value);
    } else if (name === "--top-k") {
      if (parsed.topK !== undefined) throw new Error(`${name} may appear only once`);
      parsed.topK = diagnosticPositiveInt(name, value);
    } else if (name === "--stop-after") {
      if (parsed.stopAfter !== undefined) throw new Error(`${name} may appear only once`);
      if (!(["graph", "enumeration", "refine", "solve", "sim", "ev"] as string[]).includes(value)) {
        throw new Error("--stop-after must be graph|enumeration|refine|solve|sim|ev");
      }
      parsed.stopAfter = value as DiagnosticStopAfter;
    } else {
      throw new Error(`unsupported blockscan diagnostic option ${name}`);
    }
  }
  if (!parsed.enabled) {
    throw new Error("diagnostic options require --diagnostic");
  }
  return parsed;
}

function diagnosticPositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function emitDiagnostic(
  step: 1 | 2 | 3 | 4 | 5 | 6,
  stage: string,
  status: "pass" | "fail" | "reject" | "not_reached",
  details: Record<string, unknown>,
): void {
  if (!DIAGNOSTIC.enabled) return;
  lastDiagnosticStep = Math.max(lastDiagnosticStep, step);
  console.log(`SIX_STEP_DIAGNOSTIC=${JSON.stringify({ step, stage, status, ...details })}`);
}

function diagnosticStopsAfter(stage: DiagnosticStopAfter): boolean {
  return DIAGNOSTIC.enabled && DIAGNOSTIC.stopAfter === stage;
}

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
    // Production starts from code-owned protocol seeds, then admits the
    // file-backed universe. Keep the same precedence so stale file metadata
    // cannot replace a newer exact adapter classification in the replay.
    const pools = mergePoolRegistries(protocolPools, universePools);
    const rawEdges = await buildTokenGraph(graphBackend, pools);
    const edges = rawEdges.map(lowerEdge);
    const protocolEdges = edges.filter((edge) => edge.slotKind === "protocol");

    await check("graph has swap edges and protocol edges", () =>
      edges.length > 0 && protocolEdges.length > 0,
    );

    if (DIAGNOSTIC.enabled) {
      const expectedRoute = parseExpectedRoute(process.env.AB_EXPECTED_ROUTE_JSON ?? "");
      const missingEdges = expectedRoute.filter((expected) =>
        !edges.some((edge) => sameRouteStep(opportunityRoute([edge])[0], expected)),
      );
      const poolAdmission = describeExpectedPoolAdmission(
        expectedPoolIds(),
        universePools,
        protocolPools,
        edges,
      );
      emitDiagnostic(1, "graph", missingEdges.length === 0 ? "pass" : "fail", {
        graphEdges: edges.length,
        expectedEdges: expectedRoute.length,
        missingEdges,
        poolAdmission,
      });
      if (diagnosticStopsAfter("graph")) return;
      if (missingEdges.length > 0) return;
    }

    const warmCounts = await warmSwapState(provider, cache, cfg, edges);
    await check("v2/v3 state warm completed", () =>
      warmCounts.swapHops === 0 || warmCounts.chunks > 0,
    );

    const curveCounts = await warmCurves(callBackend, cache, cfg.blockNumber, edges);
    await check("curve warm pass accounted for every curve pool", () =>
      curveCounts.curveWarmed + curveCounts.curveFailed === uniqueCurvePools(edges).size,
    );

    const passDeadlineAtMs = Date.now() + cfg.passBudgetMs;
    console.log(
      `[blockscan-hunt] budgets scan=${cfg.scanBudgetMs}ms pass=${cfg.passBudgetMs}ms`,
    );

    const protocolMidResult = await buildProtocolMids(
      provider,
      callBackend,
      cfg.blockNumber,
      edges,
      passDeadlineAtMs,
    );
    requirePassBudget("protocol_mids", passDeadlineAtMs, protocolMidResult.deadlineHit);
    const exactCurveMidResult = await buildExactBlockScanCurveMids(
      provider,
      cfg.blockNumber,
      cache,
      edges,
      passDeadlineAtMs,
    );
    requirePassBudget("curve_mids", passDeadlineAtMs, exactCurveMidResult.deadlineHit);
    const protocolMids = new Map([
      ...protocolMidResult.mids,
      ...exactCurveMidResult.mids,
    ]);
    console.log(
      `[blockscan-hunt] exact curve mids attempted=${exactCurveMidResult.attempted} ` +
        `quoted=${exactCurveMidResult.quoted} failed=${exactCurveMidResult.failed} ` +
        `deadline=${exactCurveMidResult.deadlineHit ? 1 : 0}`,
    );
    await check("protocol mids cover erc4626, wsteth, psm, and metronome", () =>
      (protocolMidResult.classCounts.get("erc4626") ?? 0) > 0 &&
      (protocolMidResult.classCounts.get("wsteth") ?? 0) > 0 &&
      (protocolMidResult.classCounts.get("psm") ?? 0) > 0 &&
      (protocolMidResult.classCounts.get("metronome") ?? 0) > 0,
    );

    // Production treats code-owned protocol edges as admission guarantees outside
    // the scored DEX-edge budget. Older scanner versions ignore this forward-
    // compatible field; challengers that implement it must replay the same view.
    const pricedTokenLimits = pricedTokens();
    const scanCfg = {
      maxHops: cfg.maxHops,
      minSpreadBps: cfg.minSpreadBps,
      maxCandidates: cfg.maxCandidates,
      budgetMs: cfg.scanBudgetMs,
      pricedTokens: pricedTokenLimits,
      protocolMids,
      pinnedOutsideBudget: true,
    };
    const coarseMaxCandidates = Math.max(
      cfg.maxCandidates,
      envInt("HUNT_REFINE_CANDIDATES", 512),
    );
    const coarseScan = detectBlockScanOpportunities({
      edges,
      cache,
      sourceBlock: cfg.blockNumber,
      swapTouched: null,
      cfg: { ...scanCfg, maxCandidates: coarseMaxCandidates },
    });
    let diagnosticCoarseTarget: ExpectedReplayTarget | null = null;
    if (DIAGNOSTIC.enabled) {
      const coarseReports = coarseScan.opportunities.map((opp, index) =>
        describeOpportunity(index + 1, opp, cache, cfg.blockNumber, protocolMids),
      );
      diagnosticCoarseTarget = readExpectedReplayTarget(coarseReports);
      const found = (diagnosticCoarseTarget?.opportunityIndex ?? -1) >= 0;
      const rankComplete = coarseScan.outcome === "ran";
      const passBudgetExceeded = blockScanPassBudgetExceeded(passDeadlineAtMs, false);
      emitDiagnostic(
        2,
        "enumeration",
        passBudgetExceeded
          ? "not_reached"
          : found
            ? "pass"
            : rankComplete
              ? "fail"
              : "not_reached",
        {
          observedRank: found
            ? diagnosticCoarseTarget!.opportunityIndex + 1
            : null,
          rankComplete,
          candidatesSearched: coarseReports.length,
          candidateCap: coarseMaxCandidates,
          scannerOutcome: coarseScan.outcome,
          scannedPairs: coarseScan.scannedPairs,
          passBudgetExceeded,
          reason: passBudgetExceeded
            ? "pass_budget_exceeded"
            : !found && !rankComplete
              ? "scan_budget_exceeded_before_target"
              : !found
                ? "target_not_in_ranked_candidate_cap"
                : null,
        },
      );
      if (diagnosticStopsAfter("enumeration")) return;
      if (passBudgetExceeded || !found) return;
    }
    requirePassBudget("scan", passDeadlineAtMs);
    const probeDiagnostics = new Map<number, BlockScanProbeDiagnostic>();
    const diagnosticTargetIndex = diagnosticCoarseTarget?.opportunityIndex ?? -1;
    const refinement = await refineBlockScanCandidates(
      callBackend,
      coarseScan.opportunities,
      cfg.maxCandidates,
      passDeadlineAtMs,
      pricedTokenLimits,
      DIAGNOSTIC.enabled && diagnosticTargetIndex >= 0
        ? (probe) => {
            if (probe.index === diagnosticTargetIndex) probeDiagnostics.set(probe.index, probe);
          }
        : undefined,
    );
    const scan = { ...coarseScan, opportunities: refinement.opportunities };
    if (DIAGNOSTIC.enabled) {
      const refinedReports = scan.opportunities.map((opp, index) =>
        describeOpportunity(index + 1, opp, cache, cfg.blockNumber, protocolMids),
      );
      const refinedTarget = readExpectedReplayTarget(refinedReports);
      const refinedRank = (refinedTarget?.opportunityIndex ?? -1) >= 0
        ? refinedTarget!.opportunityIndex + 1
        : null;
      const targetProbe = probeDiagnostics.get(diagnosticTargetIndex);
      const probeStatus = targetProbe?.status
        ?? (diagnosticTargetIndex < 0 ? "not_enumerated" : "unprobed");
      const passBudgetExceeded = blockScanPassBudgetExceeded(
        passDeadlineAtMs,
        refinement.deadlineHit,
      );
      emitDiagnostic(
        3,
        "exact_quote_refine",
        passBudgetExceeded || probeStatus === "unprobed"
          ? "not_reached"
          : probeStatus === "positive" && refinedRank !== null
            ? "pass"
            : "fail",
        {
          refinedRank,
          probeStatus,
          probeMarginBps: targetProbe?.marginBps ?? null,
          retainedAsFallback: refinedRank !== null && probeStatus === "failed",
          reason: probeStatus === "positive" && refinedRank === null
            ? "positive_but_below_candidate_cap"
            : probeStatus === "failed"
              ? "exact_quote_failed"
              : probeStatus === "negative"
                ? "exact_quote_non_positive"
                : probeStatus === "not_enumerated"
                  ? "target_not_enumerated"
                  : null,
          selectedCandidates: refinedReports.length,
          attempted: refinement.attempted,
          positive: refinement.positive,
          negative: refinement.negative,
          failed: refinement.failed,
          deadlineHit: refinement.deadlineHit,
          passBudgetExceeded,
        },
      );
      if (diagnosticStopsAfter("refine")) return;
      if (passBudgetExceeded || probeStatus !== "positive" || refinedRank === null) return;
    }
    requirePassBudget("refine", passDeadlineAtMs, refinement.deadlineHit);
    console.log(
      `[blockscan-hunt] exact route probes attempted=${refinement.attempted} ` +
        `positive=${refinement.positive} negative=${refinement.negative} ` +
        `failed=${refinement.failed} deadline=${refinement.deadlineHit ? 1 : 0}`,
    );
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

    const expectedTarget = readExpectedReplayTarget(opportunityReports);
    const expectedOpportunityIndex = expectedTarget?.opportunityIndex ?? -1;
    const selectedByTopK = expectedOpportunityIndex >= 0
      && expectedOpportunityIndex < Math.min(cfg.topK, scan.opportunities.length);
    const forcedProbe = expectedOpportunityIndex >= 0 && !selectedByTopK;
    const solveIndexes = selectedReplayOpportunityIndexes(
      scan.opportunities.length,
      cfg.topK,
      expectedTarget?.opportunityIndex ?? null,
    );
    const solvedReports = await solveSelected(
      state,
      cache,
      cfg,
      scan.opportunities,
      protocolMids,
      solveIndexes,
    );
    await check("fork-solve top candidates recorded", () =>
      solvedReports.length === solveIndexes.length,
    );

    if (DIAGNOSTIC.enabled) {
      const expectedSolve = expectedTarget && expectedTarget.opportunityIndex >= 0
        ? solveForOpportunityIndex(solvedReports, expectedTarget.opportunityIndex)
        : null;
      const solveSucceeded = expectedSolve?.solved !== null
        && expectedSolve?.solved !== undefined
        && expectedSolve.solveError === null;
      emitDiagnostic(
        4,
        "planner_and_solver",
        solveSucceeded ? "pass" : "fail",
        {
          opportunityRank: expectedTarget && expectedTarget.opportunityIndex >= 0
            ? expectedTarget.opportunityIndex + 1
            : null,
          selectedByTopK,
          forcedProbe,
          selectionMode: selectedByTopK ? "top_k" : forcedProbe ? "forced_probe" : "not_found",
          planCount: expectedSolve?.planCount ?? 0,
          solveSucceeded,
          includesInternalFinalSim: true,
          searchCenter: expectedSolve?.searchCenter ?? null,
          error: expectedSolve?.solveError ?? (expectedTarget?.opportunityIndex === -1 ? "route_not_enumerated" : null),
        },
      );
      if (diagnosticStopsAfter("solve")) return;
      const simulation = expectedSolve?.diagnosticSimulation;
      emitDiagnostic(5, "resolved_plan_resim", simulation?.success ? "pass" : "fail", {
        ...(simulation ?? {
          success: false,
          netProfit: expectedSolve?.solved ?? null,
          error: expectedSolve?.solveError ?? "simulation_not_reached",
        }),
      });
      if (diagnosticStopsAfter("sim")) return;
      const ev = expectedSolve?.diagnosticEv;
      emitDiagnostic(6, "ev", ev?.decision === "allow"
        ? "pass"
        : ev?.decision === "disabled" || !ev
          ? "not_reached"
          : "reject", {
        ...(ev ?? { decision: null, error: "simulation_not_reached" }),
      });
      if (diagnosticStopsAfter("ev")) return;
    }

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
    emitProductionReplayResult(cfg, opportunityReports, solvedReports, expectedTarget);

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
  expectedTarget: ExpectedReplayTarget | null,
): void {
  if (!expectedTarget) return;
  const { expectedPools, expectedSwapPath, expectedRoute, opportunityIndex } = expectedTarget;
  const opportunity = opportunityIndex >= 0 ? opportunities[opportunityIndex] : null;
  const solve = opportunityIndex >= 0
    ? solveForOpportunityIndex(solved, opportunityIndex)
    : null;
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
    expected_swap_path: expectedSwapPath,
    matched_swap_path: opportunity?.swapPath ?? [],
    expected_route: expectedRoute,
    matched_route: opportunity?.route ?? [],
    has_protocol_edge: opportunity?.hasProtocolEdge ?? false,
    closed_route: closedRoute,
    final_sim_success: stage === "final_sim_success",
    net_profit_raw: solve?.solved ?? null,
  })}`);
}

interface ExpectedReplayTarget {
  expectedPools: string[];
  expectedSwapPath: OpportunityReport["swapPath"];
  expectedRoute: OpportunityReport["route"];
  opportunityIndex: number;
}

function expectedPoolIds(): string[] {
  return (process.env.AB_EXPECTED_POOL_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function describeExpectedPoolAdmission(
  expectedPools: readonly string[],
  universePools: readonly PoolEntry[],
  protocolPools: readonly PoolEntry[],
  edges: readonly TokenEdge[],
): Array<Record<string, unknown>> {
  return expectedPools.map((expectedPool) => {
    const protocolPool = protocolPools.find((pool) => poolEntryMatches(pool, expectedPool));
    const universePool = universePools.find((pool) => poolEntryMatches(pool, expectedPool));
    const sourcePool = protocolPool ?? universePool;
    const activity = sourcePool as (PoolEntry & { swapCount30d?: number }) | undefined;
    const graphEdgeCount = edges.filter((edge) => edgePoolIdentity(edge) === expectedPool).length;
    return {
      pool: expectedPool,
      source: protocolPool ? "protocol_registry" : universePool ? "generated_universe" : "missing",
      adapter: sourcePool?.adapter ?? null,
      score: sourcePool?.score ?? null,
      swapCount30d: activity?.swapCount30d ?? null,
      graphEdgeCount,
      admittedToGraph: graphEdgeCount > 0,
    };
  });
}

function poolEntryMatches(pool: PoolEntry, expectedPool: string): boolean {
  return pool.address.toLowerCase() === expectedPool
    || pool.poolId?.toLowerCase() === expectedPool;
}

function readExpectedReplayTarget(
  opportunities: OpportunityReport[],
): ExpectedReplayTarget | null {
  const expectedPools = expectedPoolIds();
  if (expectedPools.length === 0) return null;
  const expectedSwapPath = parseExpectedSwapPath(process.env.AB_EXPECTED_SWAP_PATH_JSON ?? "");
  const expectedRoute = parseExpectedRoute(process.env.AB_EXPECTED_ROUTE_JSON ?? "");
  const expectedProtocol = process.env.AB_EXPECTED_ROUTE_SCOPE === "dex-permissionless-protocol";
  const opportunityIndex = opportunities.findIndex((entry) =>
    entry.swapPath !== null
    && JSON.stringify(entry.swapPath) === JSON.stringify(expectedSwapPath)
    && JSON.stringify(entry.route) === JSON.stringify(expectedRoute)
    && entry.hasProtocolEdge === expectedProtocol);
  return { expectedPools, expectedSwapPath, expectedRoute, opportunityIndex };
}

function readConfig(rpcUrl: string, blockNumber: number): HuntConfig {
  void rpcUrl;
  const anvilPort = envInt("SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT", 8566);
  const budgets = resolveBlockScanHuntBudgets(process.env);
  return {
    rpcUrl,
    blockNumber,
    universePath: process.env.HUNT_UNIVERSE_PATH ?? DEFAULT_POOL_UNIVERSE_PATH,
    maxPools: envInt("HUNT_MAX_POOLS", 1500),
    maxHops: envInt("HUNT_MAX_HOPS", 4),
    minSpreadBps: envInt("HUNT_MIN_SPREAD_BPS", 10),
    scanBudgetMs: DIAGNOSTIC.scanBudgetMs ?? budgets.scanBudgetMs,
    passBudgetMs: DIAGNOSTIC.passBudgetMs ?? budgets.passBudgetMs,
    maxCandidates: DIAGNOSTIC.maxCandidates ?? envInt("HUNT_MAX_CANDIDATES", 16),
    topK: DIAGNOSTIC.topK ?? envInt("HUNT_TOP_K", 3),
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

function requirePassBudget(stage: string, deadlineAtMs: number, deadlineHit = false): void {
  if (!blockScanPassBudgetExceeded(deadlineAtMs, deadlineHit)) return;
  throw new Error(`blockscan pass budget exceeded at ${stage}`);
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
    if (edge.slotKind !== "swap" || !isLocallyModelledCurve(edge.adapterId)) continue;
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
  let externalSwapFailed = 0;
  let externalSwapMids = 0;
  let deadlineHit = false;

  // Externally quoted swap edges have no local-cache fallback. Price them
  // before the larger protocol set so a valid route is not hidden by harness
  // iteration order. Dispatch remains production-owned through quote().
  for (const edge of edges) {
    if (Date.now() >= deadlineAtMs) {
      deadlineHit = true;
      break;
    }
    if (!isExternallyQuotedSwap(edge)) continue;
    try {
      const tokenInDec = await tokenDecimals(provider, blockNumber, edge.tokenIn, decimals);
      const oneIn = 10n ** BigInt(tokenInDec);
      const mid = await readDispatchedMid(state, edge, oneIn);
      if (!Number.isFinite(mid) || mid <= 0) continue;
      mids.set(protocolKey(edge.target, edge.tokenIn, edge.tokenOut), {
        mid,
        feeBps: 0,
        depthIn: oneIn * 10_000n,
      });
      externalSwapMids++;
    } catch (err) {
      externalSwapFailed++;
      console.log(
        `[blockscan-hunt] external swap mid failed adapter=${edge.adapterId} target=${edge.target} ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!deadlineHit) {
    const protocolEdges = edges
      .filter((edge) => classifyProtocol(edge) !== null)
      .sort((a, b) => protocolMidPriority(a) - protocolMidPriority(b));
    for (const edge of protocolEdges) {
      if (Date.now() >= deadlineAtMs) {
        deadlineHit = true;
        break;
      }
      const protocolClass = classifyProtocol(edge);
      if (!protocolClass) continue;
      try {
        const tokenInDec = await tokenDecimals(provider, blockNumber, edge.tokenIn, decimals);
        const oneIn = 10n ** BigInt(tokenInDec);
        const mid = await readProtocolMid(provider, state, blockNumber, edge, oneIn);
        if (!Number.isFinite(mid) || mid <= 0) continue;
        // Crude rank/size proxy only. The fork solver truth-checks executable
        // sizes, so this depth value is not load-bearing.
        mids.set(protocolKey(edge.target, edge.tokenIn, edge.tokenOut), {
          mid,
          feeBps: 0,
          depthIn: oneIn * 10_000n,
        });
        classCounts.set(protocolClass, (classCounts.get(protocolClass) ?? 0) + 1);
      } catch (err) {
        console.log(
          `[blockscan-hunt] protocol mid failed adapter=${edge.adapterId} target=${edge.target} ` +
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
      `other=${classCounts.get("other") ?? 0} ` +
      `externalSwap=${externalSwapMids} externalSwapFailed=${externalSwapFailed} ` +
      `deadline=${deadlineHit ? 1 : 0}`,
  );
  return { mids, classCounts, deadlineHit };
}

function isExternallyQuotedSwap(edge: TokenEdge): boolean {
  return edge.slotKind === "swap" && edge.adapterId !== "univ2-swap"
    && edge.adapterId !== "univ3-swap" && edge.adapterId !== "univ4-unlock"
    && !isLocallyModelledCurve(edge.adapterId);
}

function isLocallyModelledCurve(adapterId: string): boolean {
  return adapterId === "curve-exchange" || adapterId === "curve-exchange-nr"
    || adapterId === "curve-exchange-plain" || adapterId === "curve-exchange-received-uint";
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
  return edge.slotKind === "protocol" ? "other" : null;
}

function protocolMidPriority(edge: TokenEdge): number {
  const kind = classifyProtocol(edge);
  if (kind === "other" || kind === "psm") return 0;
  if (kind === "metronome" || kind === "wsteth") return 1;
  return 2;
}

async function readProtocolMid(
  provider: ethers.JsonRpcProvider,
  state: StateBackend,
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
  return readDispatchedMid(state, edge, oneIn);
}

async function readDispatchedMid(
  state: StateBackend,
  edge: TokenEdge,
  oneIn: bigint,
): Promise<number> {
  const out = await quote(
    edge.adapterId,
    edge.target,
    edge.tokenIn,
    edge.tokenOut,
    oneIn,
    state,
    undefined,
    edge.v4PoolKey,
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

async function solveSelected(
  state: AnvilStateBackend,
  cache: PoolStateCache,
  cfg: HuntConfig,
  opportunities: BlockScanOpportunity[],
  protocolMids: ReadonlyMap<string, ProtocolMid>,
  opportunityIndexes: readonly number[],
): Promise<SolveReport[]> {
  if (opportunityIndexes.length === 0) return [];

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

  for (const opportunityIndex of opportunityIndexes) {
    const opp = opportunities[opportunityIndex];
    const spreadBps = estimateBlockScanRingSpreadBps(
      cache,
      cfg.blockNumber,
      opp.seedEdges,
      protocolMids,
    );
    let planCount = 0;
    let solved: ResolvedPlan | null = null;
    let solveError: string | null = null;
    let searchCenter: string | null = null;
    let diagnosticSimulation: SolveReport["diagnosticSimulation"];
    let diagnosticEv: SolveReport["diagnosticEv"];
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
    if (DIAGNOSTIC.enabled && solved) {
      const simulation = await simulator.simulate(solved);
      diagnosticSimulation = {
        success: simulation.success,
        profitToken: simulation.profitToken.toLowerCase(),
        grossProfit: simulation.grossProfit.toString(),
        gasUsed: simulation.gasUsed.toString(),
        netProfit: simulation.netProfit.toString(),
        calldataHash: createHash("sha256").update(simulation.calldata).digest("hex"),
        revertReason: simulation.revertReason ?? null,
      };
      if (simulation.success) {
        const minNetEth = BigInt(process.env.SEARCHER_MIN_NET_ETH ?? "0");
        const evGate = process.env.SEARCHER_EV_GATE === "1";
        const evaluation = await evaluateEv(
          state.provider,
          simulation.profitToken,
          simulation.netProfit,
          simulation.gasUsed,
          {
            ethUsd: Number(process.env.SEARCHER_ETH_USD ?? "3500"),
            profitHaircutBps: Number(process.env.SEARCHER_PROFIT_HAIRCUT_BPS ?? "2000"),
            defaultGasUsed: Number(process.env.SEARCHER_BACKRUN_GAS_USED ?? "12000000"),
            gasBufferMultX10: Number(process.env.SEARCHER_GAS_BUFFER_MULT_X10 ?? "20"),
            evGate,
            bribeAllAboveGas: process.env.SEARCHER_BRIBE_ALL_ABOVE_GAS === "1",
            bribeBps: Number(process.env.SEARCHER_BRIBE_BPS ?? DEFAULT_BRIBE_BPS.toString()),
          },
        );
        diagnosticEv = {
          decision: !evGate
            ? "disabled"
            : !evaluation.valuationAvailable
              ? "unpriceable_profit_token"
              : evaluation.netEvWei < minNetEth
                ? "below_ev_gate"
                : "allow",
          evGate,
          netEvWei: evaluation.netEvWei.toString(),
          expectedProfitEth: evaluation.expectedProfitEth.toString(),
          gasCostEth: evaluation.gasCostEth.toString(),
          bidEth: evaluation.bidEth.toString(),
          minNetEth: minNetEth.toString(),
        };
      }
    }
    const report = {
      opportunityIndex,
      ring: ringTokens(opp.seedEdges),
      pools: uniqueStrings(opp.seedEdges.map(edgePoolIdentity)),
      spreadBps,
      planCount,
      solved: solved ? solved.netProfit.toString() : null,
      solveError,
      searchCenter,
      ...(diagnosticSimulation ? { diagnosticSimulation } : {}),
      ...(diagnosticEv ? { diagnosticEv } : {}),
    };
    reports.push(report);
    console.log(
      `[blockscan-hunt] solve rank=${opportunityIndex + 1} planCount=${planCount} ` +
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
    spreadBps: estimateBlockScanRingSpreadBps(cache, blockNumber, opp.seedEdges, protocolMids),
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
    swapPath: opportunitySwapPath(opp.seedEdges),
    route: opportunityRoute(opp.seedEdges),
  };
}

function parseExpectedRoute(value: string): OpportunityReport["route"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AB_EXPECTED_ROUTE_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 8 || parsed.some((step) => {
    const edge = step as Record<string, unknown>;
    return typeof edge.adapterId !== "string"
      || (edge.slotKind !== "swap" && edge.slotKind !== "protocol")
      || typeof edge.target !== "string"
      || typeof edge.tokenIn !== "string"
      || typeof edge.tokenOut !== "string"
      || (edge.poolId !== undefined && typeof edge.poolId !== "string");
  })) {
    throw new Error("AB_EXPECTED_ROUTE_JSON must contain 2..8 complete ordered route edges");
  }
  return parsed.map((step) => {
    const edge = step as OpportunityReport["route"][number];
    return {
      adapterId: edge.adapterId,
      slotKind: edge.slotKind,
      target: edge.target.toLowerCase(),
      tokenIn: edge.tokenIn.toLowerCase(),
      tokenOut: edge.tokenOut.toLowerCase(),
      ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
    };
  });
}

function opportunityRoute(edges: TokenEdge[]): OpportunityReport["route"] {
  return edges.map((edge) => ({
    adapterId: edge.adapterId,
    slotKind: edge.slotKind === "protocol" ? "protocol" : "swap",
    target: edge.target.toLowerCase(),
    tokenIn: edge.tokenIn.toLowerCase(),
    tokenOut: edge.tokenOut.toLowerCase(),
    ...(edge.poolId ? { poolId: edge.poolId.toLowerCase() } : {}),
  }));
}

function sameRouteStep(
  actual: OpportunityReport["route"][number],
  expected: OpportunityReport["route"][number],
): boolean {
  return actual.adapterId === expected.adapterId
    && actual.slotKind === expected.slotKind
    && actual.target === expected.target
    && actual.tokenIn === expected.tokenIn
    && actual.tokenOut === expected.tokenOut
    && (expected.poolId === undefined || actual.poolId === expected.poolId);
}

function parseExpectedSwapPath(value: string): Array<{ pool_id: string; direction: "0for1" | "1for0" }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("AB_EXPECTED_SWAP_PATH_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((step) => {
    const entry = step as { pool_id?: unknown; direction?: unknown };
    return typeof entry?.pool_id !== "string"
      || (entry.direction !== "0for1" && entry.direction !== "1for0");
  })) {
    throw new Error("AB_EXPECTED_SWAP_PATH_JSON must contain ordered pool_id/direction steps");
  }
  return parsed.map((step) => {
    const entry = step as { pool_id: string; direction: "0for1" | "1for0" };
    return { pool_id: entry.pool_id.toLowerCase(), direction: entry.direction };
  });
}

function opportunitySwapPath(
  edges: TokenEdge[],
): Array<{ pool_id: string; direction: "0for1" | "1for0" }> | null {
  const result: Array<{ pool_id: string; direction: "0for1" | "1for0" }> = [];
  for (const edge of edges) {
    if (edge.slotKind !== "swap") continue;
    const direction = edgeSwapDirection(edge);
    if (!direction) return null;
    result.push({ pool_id: edgePoolIdentity(edge), direction });
  }
  return result;
}

function edgeSwapDirection(edge: TokenEdge): "0for1" | "1for0" | null {
  if (edge.curveI !== undefined && edge.curveJ !== undefined) {
    return edge.curveI < edge.curveJ ? "0for1" : "1for0";
  }
  const token0 = (edge.nativeCurrency0 ? ADDR.WETH : edge.poolToken0)?.toLowerCase();
  const token1 = (edge.nativeCurrency1 ? ADDR.WETH : edge.poolToken1)?.toLowerCase();
  const tokenIn = edge.tokenIn.toLowerCase();
  const tokenOut = edge.tokenOut.toLowerCase();
  if (token0 && token1) {
    if (tokenIn === token0 && tokenOut === token1) return "0for1";
    if (tokenIn === token1 && tokenOut === token0) return "1for0";
  }
  if (edge.adapterId.toLowerCase().includes("balancer")) {
    return tokenIn < tokenOut ? "0for1" : "1for0";
  }
  return null;
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
  const message = err instanceof Error ? err.message : String(err);
  if (DIAGNOSTIC.enabled && lastDiagnosticStep < 6) {
    const nextStep = Math.max(1, Math.min(6, lastDiagnosticStep + 1)) as 1 | 2 | 3 | 4 | 5 | 6;
    emitDiagnostic(nextStep, "execution_error", "fail", {
      afterStep: lastDiagnosticStep,
      error: message.replace(/https?:\/\/[^\s]+/g, "<rpc-url>").slice(0, 500),
    });
  }
  console.error(`blockscan-hunt FAIL: ${message}`);
  process.exit(1);
});
