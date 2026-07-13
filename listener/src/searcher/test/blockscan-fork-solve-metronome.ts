/**
 * Rule-12 gate for Metronome Synth swaps, grounded in coffee's Metronome block
 * family (exemplar prefix 0x4d1e4e51, block 25515277).
 *
 * Mainnet-fork + dry-run only. Forks pre-tx at block 25515276 and proves:
 *   1. The real graph builder emits Metronome synth protocol edges from the
 *      pinned Pool via doesSyntheticTokenExist (no global Metronome scan).
 *   2. quoteSwapOut(msETH, msBTC, 1e18) is called on the Pool and returns a
 *      positive quote at the pinned block.
 *   3. The committed graph contains coffee's exact USDC round-trip, including
 *      the authorized Metronome hgUSDC exit router.
 *   4. Applying the real oracle transaction changes that route from non-positive
 *      to positive, and the normal planner/solver executes it +gross. This gate
 *      deliberately constructs the opportunity from fixture edges; oracle
 *      classification/admission is a separate production change and gate.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { AnvilStateBackend, type StateBackend } from "../../shared/state/state-backend.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenPath,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { mergePoolRegistries } from "../active-pool-discovery.js";
import { loadPinnedWarmPools } from "../pinned-warm-pools.js";
import { quoteMetronomeSynthSwap } from "../solver/quoter.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

const EXEMPLAR_TX_PREFIX = "0x4d1e4e51";
const SECONDARY_TX_PREFIX = "0x3eb1f2ff";
const TRIGGER_TX_HASH = "0x63e4e781e802ec9c54a47d52a65e30bf43df694b77cbb6bdc8ab7fe303f6bb25";
const FORK_BLOCK = 25_515_276; // pre-tx state for block 25515277
const ANVIL_PORT = Number(process.env.SEARCHER_BLOCKSCAN_FORK_SOLVE_METRONOME_ANVIL_PORT ?? "8567");
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const WAD = 10n ** 18n;

// Trace-derived route for 0x4d1e4e51:
// USDC -> USDT -> WETH -> msETH -> msBTC -> msUSD -> (router: frxUSD) -> USDC.
const CURVE_MSETH_WETH = "0xa4c567c662349bec3d0fb94c4e7f85ba95e208e4";
const V3_USDT_WETH_500 = "0x4e68ccd3e89f51c3074ca5072bbac773960dfa36";
const V4_USDC_USDT_POOL_ID = "0x0fb0e40cec3bb23e13abc585958a93c796fbea56955e19a23727a716a0423239";
const SEARCH_CENTER_USDC = 122_474_539_338n; // exact Balancer flash amount in 0x4d1e4e51

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
    console.error(`[metronome-fork-solve] ${name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!ok) {
    console.error(`[metronome-fork-solve] ${name}: FAIL`);
    throw new Error(name);
  }
  passed += 1;
  console.log(`[metronome-fork-solve] ${name}: PASS`);
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      `SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required for archive fork of ` +
        `${EXEMPLAR_TX_PREFIX}/${SECONDARY_TX_PREFIX} at pre-tx block ${FORK_BLOCK}.`,
    );
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const state = new AnvilStateBackend(rpcUrl, ANVIL_URL, ANVIL_PORT);
  try {
    const latest = await provider.getBlockNumber();
    if (latest < FORK_BLOCK) {
      throw new Error(`upstream latest block ${latest} is before required block ${FORK_BLOCK}`);
    }

    console.log(
      `[metronome-fork-solve] upstream=${redactRpcUrl(rpcUrl)} block=${FORK_BLOCK} ` +
        `exemplar=${EXEMPLAR_TX_PREFIX} secondary=${SECONDARY_TX_PREFIX}`,
    );

    const backend = tokenBackend(provider, FORK_BLOCK);
    const edges = await buildTokenGraph(backend, productionRoutePools());
    const metronomeEdges = edges.filter((edge) => edge.adapterId === "metronome-synth-swap");
    await check("graph emits all ordered msETH/msBTC/msUSD Metronome edges", () =>
      metronomeEdges.length === 6 &&
      hasEdge(metronomeEdges, ADDR.MSETH, ADDR.MSBTC) &&
      hasEdge(metronomeEdges, ADDR.MSBTC, ADDR.MSUSD) &&
      hasEdge(metronomeEdges, ADDR.MSUSD, ADDR.MSETH),
    );

    const quoteBackend = stateLikeProvider(provider, FORK_BLOCK);
    const oneEthQuote = await quoteMetronomeSynthSwap(
      quoteBackend,
      ADDR.METRONOME_SYNTH_POOL,
      ADDR.MSETH,
      ADDR.MSBTC,
      WAD,
    );
    console.log(`[metronome-fork-solve] quoteSwapOut msETH->msBTC 1e18 = ${oneEthQuote}`);
    await check("quoteSwapOut(msETH, msBTC, 1e18) returns positive amountOut", () => oneEthQuote > 0n);

    const opportunity = buildFixtureOpportunity(edges);
    await check("committed graph contains the exact coffee USDC round-trip", () => opportunity !== null);
    if (!opportunity) throw new Error("production Metronome opportunity unavailable");
    console.log(`[metronome-fork-solve] candidate1 ${pathSummary({ edges: opportunity.seedEdges })}`);

    console.log(`[metronome-fork-solve] fork block=${FORK_BLOCK} anvil=${ANVIL_URL}`);
    await state.forkAt(FORK_BLOCK);
    const triggerRaw = await provider.send("eth_getRawTransactionByHash", [TRIGGER_TX_HASH]);
    if (typeof triggerRaw !== "string" || triggerRaw === "0x") {
      throw new Error(`raw trigger transaction unavailable: ${TRIGGER_TX_HASH}`);
    }
    const appliedTrigger = await state.applyRawTx(triggerRaw);
    await check("index-0 oracle update replays before the exact route", () =>
      appliedTrigger.toLowerCase() === TRIGGER_TX_HASH,
    );
    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    const propagated = await propagateAmountsWithRawOutputs(
      { edges: opportunity.seedEdges },
      SEARCH_CENTER_USDC,
      state,
      { safetyBps: 10000n },
    );
    for (const [index, edge] of opportunity.seedEdges.entries()) {
      console.log(
        `[metronome-fork-solve] quote leg${index + 1} ${short(edge.tokenIn)}->${short(edge.tokenOut)} ` +
          `in=${propagated.amounts[index]} out=${propagated.rawOutputs[index]}`,
      );
    }
    const solved = await solveFirstPositive(state, opportunity);
    await check("Metronome-containing loop executes +gross on fork", () => solved.netProfit > 0n);

    await state.forkAt(FORK_BLOCK);
    await state.applyRawTx(triggerRaw);
    const post = await propagateAmountsWithRawOutputs(
      { edges: opportunity.seedEdges },
      solved.flashAmount,
      state,
      { safetyBps: 10000n },
    );
    const postGross = post.amounts[post.amounts.length - 1] - solved.flashAmount;

    await state.forkAt(FORK_BLOCK);
    const pre = await propagateAmountsWithRawOutputs(
      { edges: opportunity.seedEdges },
      solved.flashAmount,
      state,
      { safetyBps: 10000n },
    );
    const preGross = pre.amounts[pre.amounts.length - 1] - solved.flashAmount;
    console.log(
      `[metronome-fork-solve] counterfactual flash=${solved.flashAmount} ` +
        `preGross=${preGross} postGross=${postGross}`,
    );
    await check("same route and amount flip from non-positive before the oracle update to positive after it", () =>
      preGross <= 0n && postGross > 0n,
    );

    console.log(
      `blockscan-fork-solve-metronome PASS (${passed}/${checks}) — ` +
        `netProfit=${solved.netProfit} flashAmount=${solved.flashAmount}`,
    );
  } finally {
    state.stop();
    provider.destroy();
  }
}

function productionRoutePools(): PoolEntry[] {
  const committed = mergePoolRegistries(POOL_REGISTRY, loadPinnedWarmPools());
  const required = committed.filter((pool) =>
    same(pool.address, ADDR.METRONOME_SYNTH_POOL) ||
    same(pool.address, CURVE_MSETH_WETH) ||
    same(pool.address, V3_USDT_WETH_500) ||
    same(pool.address, ADDR.METRONOME_HGUSDC_ROUTER) ||
    pool.poolId?.toLowerCase() === V4_USDC_USDT_POOL_ID,
  );
  if (required.length !== 5) {
    throw new Error(`committed production inputs contain ${required.length}/5 Metronome route venues`);
  }
  return required;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface EdgeSpec {
  adapterId: string;
  tokenIn: string;
  tokenOut: string;
  target?: string;
  poolId?: string;
}

const EXPECTED_ROUTE: readonly EdgeSpec[] = [
  { adapterId: "univ4-unlock", tokenIn: ADDR.USDC, tokenOut: ADDR.USDT, poolId: V4_USDC_USDT_POOL_ID },
  { adapterId: "univ3-swap", tokenIn: ADDR.USDT, tokenOut: ADDR.WETH, target: V3_USDT_WETH_500 },
  { adapterId: "curve-exchange-plain", tokenIn: ADDR.WETH, tokenOut: ADDR.MSETH, target: CURVE_MSETH_WETH },
  { adapterId: "metronome-synth-swap", tokenIn: ADDR.MSETH, tokenOut: ADDR.MSBTC, target: ADDR.METRONOME_SYNTH_POOL },
  { adapterId: "metronome-synth-swap", tokenIn: ADDR.MSBTC, tokenOut: ADDR.MSUSD, target: ADDR.METRONOME_SYNTH_POOL },
  { adapterId: "metronome-hgusdc-exit", tokenIn: ADDR.MSUSD, tokenOut: ADDR.USDC, target: ADDR.METRONOME_HGUSDC_ROUTER },
];

function buildFixtureOpportunity(graph: TokenEdge[]): BlockScanOpportunity | null {
  const seedEdges: TokenEdge[] = [];
  for (const spec of EXPECTED_ROUTE) {
    const edge = graph.find((candidate) =>
      candidate.adapterId === spec.adapterId &&
      same(candidate.tokenIn, spec.tokenIn) &&
      same(candidate.tokenOut, spec.tokenOut) &&
      (!spec.target || same(candidate.target, spec.target)) &&
      (!spec.poolId || same(candidate.poolId ?? "", spec.poolId)),
    );
    if (!edge) return null;
    seedEdges.push(edge);
  }
  const ring = canonicalTokenRing(seedEdges.map((edge) => edge.tokenIn));
  return {
    kind: "block-scan-arb",
    sourceBlock: FORK_BLOCK,
    stateBlock: FORK_BLOCK,
    cycleId: ring.join("|"),
    cycleFingerprint: cycleFingerprint(FORK_BLOCK, ring),
    seedEdges,
    flashToken: ethers.getAddress(ADDR.USDC),
    searchSeed: {
      startToken: ethers.getAddress(ADDR.USDC),
      searchCenter: SEARCH_CENTER_USDC,
      maxInput: 500_000n * 10n ** 6n,
    },
    leavesStandingPosition: pathLeavesStandingPosition(seedEdges),
    affectedPools: unique(seedEdges.map((edge) => edge.poolId ?? edge.target)),
    affectedTokens: ring,
  };
}

function unique(values: string[]): string[] {
  return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];
}

function tokenBackend(provider: ethers.JsonRpcProvider, blockNumber: number): TokenQueryBackend {
  return {
    call: (req) => provider.call({ to: req.to, data: req.data, blockTag: blockNumber }),
  };
}

function stateLikeProvider(provider: ethers.JsonRpcProvider, blockNumber: number): StateBackend {
  return {
    async call(req: { to: string; data: string }): Promise<string> {
      return provider.call({ to: req.to, data: req.data, blockTag: blockNumber });
    },
  } as unknown as StateBackend;
}

async function solveFirstPositive(
  state: AnvilStateBackend,
  opportunity: BlockScanOpportunity,
): Promise<ResolvedPlan> {
  const planner = new TemplatePlanner();
  const solver = new AnvilSolver();
  const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
  const path: TokenPath = { edges: opportunity.seedEdges };
  planner.setGraph(opportunity.seedEdges);
  const plans = await planner.planBlockScanFromSeedEdges(opportunity, [FLASH_SWAP_REPAY]);
  if (plans.length === 0) throw new Error("planner returned no candidate plans");
  try {
    const center = await resolveSearchCenter(plans[0], opportunity.flashToken, state, {});
    const solved = await solver.solve(plans[0], state, simulator, {
      finalSimTopN: 4,
      gssMaxTries: 8,
      quoteProfitFloorBps: 0n,
      quoteSafetyBps: 10000n,
    });
    console.log(
      `[metronome-fork-solve] solve candidate1: net=${solved.netProfit} ` +
        `center=${center} path=${pathSummary(path)}`,
    );
    if (solved.netProfit > 0n) return solved;
    throw new Error(`non-positive net ${solved.netProfit}`);
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    await logFailedTrace(state, lastError);
    throw new Error(
      `no Metronome candidate executed +gross on fork; last=${lastError} path=${pathSummary(path)}`,
    );
  }
}

async function logFailedTrace(state: AnvilStateBackend, message: string): Promise<void> {
  const txHash = message.match(/transaction reverted:\s*(0x[0-9a-fA-F]{64})/)?.[1];
  if (!txHash) return;
  try {
    const trace = await state.provider.send("debug_traceTransaction", [
      txHash,
      { tracer: "callTracer", tracerConfig: { withLog: false } },
    ]) as TraceCall;
    walkTrace(trace, 0);
  } catch (err) {
    console.log(`[metronome-fork-solve] failed to trace ${txHash}: ${String(err)}`);
  }
}

interface TraceCall {
  from?: string;
  to?: string;
  input?: string;
  output?: string;
  error?: string;
  revertReason?: string;
  calls?: TraceCall[];
}

function walkTrace(call: TraceCall, depth: number): void {
  const target = call.to?.toLowerCase() ?? "";
  const relevant = call.error !== undefined ||
    target === ADDR.METRONOME_HGUSDC_ROUTER.toLowerCase() ||
    target === ADDR.CURVE_MSUSD_FRXUSD.toLowerCase() ||
    target === ADDR.HGUSDC.toLowerCase();
  if (relevant) {
    console.log(
      `[metronome-fork-solve] trace depth=${depth} from=${call.from ?? ""} to=${call.to ?? ""} ` +
        `selector=${call.input?.slice(0, 10) ?? ""} input=${call.input ?? ""} ` +
        `error=${call.error ?? ""} reason=${call.revertReason ?? ""} output=${call.output ?? ""}`,
    );
  }
  for (const child of call.calls ?? []) walkTrace(child, depth + 1);
}

function hasEdge(edges: TokenEdge[], tokenIn: string, tokenOut: string): boolean {
  return edges.some((edge) => sameAddress(edge.tokenIn, tokenIn) && sameAddress(edge.tokenOut, tokenOut));
}

function edgePoolIdentity(edge: TokenEdge): string {
  return (edge.poolId ?? edge.target).toLowerCase();
}

function pathSummary(path: TokenPath): string {
  return path.edges
    .map((edge) =>
      `${short(edge.tokenIn)}->${short(edge.tokenOut)}@${edge.adapterId}:${short(edgePoolIdentity(edge))}`,
    )
    .join(" | ");
}

function short(value: string): string {
  return value.slice(0, 10).toLowerCase();
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
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

main().catch((err) => {
  console.error(`blockscan-fork-solve-metronome FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
