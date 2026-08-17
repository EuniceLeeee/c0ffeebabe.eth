/**
 * Rule-12 gate for a real oracle-triggered Metronome backrun.
 *
 * Production code knows only a generic oracle victim effect. This fixture pins
 * the trigger and coffee route so it can prove the full production path flips:
 * N-1 has no oracle effect and the route is non-positive; applying the raw
 * trigger changes concrete token-pair quotes, admits a generic opportunity,
 * and the normal planner/solver executes the conserving loop +gross.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { mergePoolRegistries } from "../active-pool-discovery.js";
import { BackrunDetector } from "../detector/detector.js";
import { filterLiveProtocolRegistry } from "../main.js";
import { TemplatePlanner, type CandidatePlan } from "../planner/planner.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenEdge,
  type TokenPath,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { loadPinnedWarmPools } from "../pinned-warm-pools.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { FlashLiquidityCache } from "../solver/flash-liquidity.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

const EXEMPLAR_TX_PREFIX = "0x4d1e4e51";
const TRIGGER_TX_HASH = "0x63e4e781e802ec9c54a47d52a65e30bf43df694b77cbb6bdc8ab7fe303f6bb25";
const FORK_BLOCK = 25_515_276;
const TARGET_BLOCK = FORK_BLOCK + 1;
const PRODUCTION_CANDIDATE_TRY_CAP = 6;
const ANVIL_PORT = Number(process.env.SEARCHER_BLOCKSCAN_FORK_SOLVE_METRONOME_ANVIL_PORT ?? "8567");
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const CURVE_MSETH_WETH = "0xa4c567c662349bec3d0fb94c4e7f85ba95e208e4";
const V3_USDT_WETH_500 = "0x4e68ccd3e89f51c3074ca5072bbac773960dfa36";
const V4_USDC_USDT_POOL_ID = "0x0fb0e40cec3bb23e13abc585958a93c796fbea56955e19a23727a716a0423239";

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
  const ok = await run();
  if (!ok) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`[metronome-oracle-backrun] ${name}: PASS`);
}

async function main(): Promise<void> {
  loadEnv();
  process.env.SEARCHER_DRY_RUN = "1";
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const state = new AnvilStateBackend(rpcUrl, ANVIL_URL, ANVIL_PORT);
  try {
    const latest = await provider.getBlockNumber();
    if (latest < FORK_BLOCK) throw new Error(`upstream latest block ${latest} < ${FORK_BLOCK}`);
    console.log(
      `[metronome-oracle-backrun] upstream=${redactRpcUrl(rpcUrl)} block=${FORK_BLOCK} ` +
        `exemplar=${EXEMPLAR_TX_PREFIX}`,
    );

    const prestate = tokenBackend(provider, FORK_BLOCK);
    const graph = await buildTokenGraph(prestate, productionRoutePools());
    await check("production graph contains the pinned six-leg fixture route", () =>
      expectedPath(graph) !== null,
    );

    await state.forkAt(FORK_BLOCK);
    const triggerRaw = await provider.send("eth_getRawTransactionByHash", [TRIGGER_TX_HASH]);
    if (typeof triggerRaw !== "string" || triggerRaw === "0x") {
      throw new Error(`raw trigger unavailable: ${TRIGGER_TX_HASH}`);
    }
    const trigger = ethers.Transaction.from(triggerRaw);
    if (!trigger.from || !trigger.to) throw new Error("trigger sender/target unavailable");

    const detector = new BackrunDetector();
    detector.setGraph(graph);
    detector.setTokenQuery(prestate);
    const event = {
      txHash: TRIGGER_TX_HASH,
      blockNumber: TARGET_BLOCK,
      rawTx: triggerRaw,
      from: trigger.from,
      nonce: trigger.nonce,
      to: trigger.to,
      input: trigger.data,
      logs: [],
      minProfit: 1n,
      victimState: "must-overlay" as const,
    };

    const noChange = await detector.detect(event, state);
    await check("N-1 vs N-1 produces no oracle victim effect", () => noChange.length === 0);

    const applied = await state.applyRawTx(triggerRaw);
    await check("real oracle transaction applies to the N-1 fork", () => same(applied, TRIGGER_TX_HASH));
    const opportunities = await detector.detect({
      ...event,
      victimState: "materialized",
    }, state);
    const opportunity = opportunities.find((candidate) => candidate.victimEffect.kind === "oracle");
    await check("post-victim quote delta admits a generic oracle opportunity", () => opportunity !== undefined);
    if (!opportunity || opportunity.victimEffect.kind !== "oracle") {
      throw new Error("oracle opportunity unavailable");
    }
    for (const change of opportunity.victimEffect.priceChanges) {
      console.log(
        `[metronome-oracle-backrun] price ${short(change.tokenIn)}->${short(change.tokenOut)} ` +
          `before=${change.beforeAmountOut} after=${change.afterAmountOut}`,
      );
    }
    await check("effect contains only token pairs whose quote changed", () =>
      opportunity.victimEffect.kind === "oracle" &&
      opportunity.victimEffect.priceChanges.length > 0 &&
      opportunity.victimEffect.priceChanges.every((change) =>
        change.beforeAmountOut !== change.afterAmountOut,
      ),
    );

    const planner = new TemplatePlanner();
    planner.setGraph(graph);
    planner.setMaxHops(3);
    planner.setMaxPoolsPerToken(8);
    planner.setMaxCandidates(20);
    const flashLiquidity = new FlashLiquidityCache(state.provider, [
      { adapterId: "morpho-flash", holder: ADDR.MORPHO },
      { adapterId: "balancer-flash", holder: ADDR.BALANCER_VAULT },
    ]);
    await flashLiquidity.refresh(unique(graph.flatMap((edge) => [edge.tokenIn, edge.tokenOut])));
    planner.setFlashLiquidity(flashLiquidity);
    const plans = await planner.plan(opportunity, [FLASH_SWAP_REPAY]);
    console.log(`[metronome-oracle-backrun] planner candidates=${plans.length}`);
    for (const [index, candidate] of plans.entries()) {
      console.log(`[metronome-oracle-backrun] candidate${index + 1} ${pathSummary(candidate.tokenPath)}`);
    }
    const expectedIndex = plans.findIndex((plan) => pathMatches(plan.tokenPath, EXPECTED_ROUTE));
    await check("generic planner ranks the pinned route inside the production solver cap", () =>
      expectedIndex >= 0 && expectedIndex < PRODUCTION_CANDIDATE_TRY_CAP,
    );
    if (expectedIndex < 0) {
      throw new Error(`expected route absent; candidates=${plans.map((plan) => pathSummary(plan.tokenPath)).join(" || ")}`);
    }
    const plan = plans[expectedIndex];
    console.log(`[metronome-oracle-backrun] candidate${expectedIndex + 1} ${pathSummary(plan.tokenPath)}`);

    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    const productionSolve = await solveInProductionOrder(state, plans);
    await check("production candidate order reaches a +gross plan before its cap", () =>
      productionSolve.index < PRODUCTION_CANDIDATE_TRY_CAP && productionSolve.solved.netProfit > 0n,
    );
    const solved = productionSolve.index === expectedIndex
      ? productionSolve.solved
      : await solveCandidate(state, plan);
    await check("normal solver executes the oracle-triggered loop +gross", () => solved.netProfit > 0n);
    const post = await propagateAmountsWithRawOutputs(plan.tokenPath, solved.flashAmount, state, {
      safetyBps: 10000n,
    });
    const postGross = post.amounts[post.amounts.length - 1] - solved.flashAmount;

    await state.forkAt(FORK_BLOCK);
    const pre = await propagateAmountsWithRawOutputs(plan.tokenPath, solved.flashAmount, state, {
      safetyBps: 10000n,
    });
    const preGross = pre.amounts[pre.amounts.length - 1] - solved.flashAmount;
    console.log(
      `[metronome-oracle-backrun] counterfactual flash=${solved.flashAmount} ` +
        `preGross=${preGross} postGross=${postGross} net=${solved.netProfit}`,
    );
    await check("same route and amount flip from non-positive at N-1 to positive post-victim", () =>
      preGross <= 0n && postGross > 0n,
    );

    console.log(
      `blockscan-fork-solve-metronome PASS (${passed}/${checks}) ` +
        `netProfit=${solved.netProfit} flashAmount=${solved.flashAmount}`,
    );
  } finally {
    state.stop();
    provider.destroy();
  }
}

async function solveInProductionOrder(
  state: AnvilStateBackend,
  plans: CandidatePlan[],
): Promise<{ index: number; solved: ResolvedPlan }> {
  const failures: string[] = [];
  for (let index = 0; index < Math.min(plans.length, PRODUCTION_CANDIDATE_TRY_CAP); index++) {
    try {
      const solved = await solveCandidate(state, plans[index], false);
      if (solved.netProfit > 0n) return { index, solved };
    } catch (err) {
      failures.push(`candidate${index + 1}=${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`no +gross plan inside production candidate cap: ${failures.join(" | ")}`);
}

async function solveCandidate(
  state: AnvilStateBackend,
  plan: CandidatePlan,
  traceFailure = true,
): Promise<ResolvedPlan> {
  const solver = new AnvilSolver();
  const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
  const center = await resolveSearchCenter(plan, plan.opportunity.startToken, state, {});
  try {
    const solved = await solver.solve(plan, state, simulator, {
      finalSimTopN: 6,
      gssMaxTries: 10,
      quoteProfitFloorBps: 0n,
      quoteSafetyBps: 10000n,
    });
    console.log(
      `[metronome-oracle-backrun] solve net=${solved.netProfit} center=${center} ` +
        `path=${pathSummary(plan.tokenPath)}`,
    );
    return solved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (traceFailure) await logFailedTrace(state, message);
    throw err;
  }
}

function productionRoutePools(): PoolEntry[] {
  const liveRegistry = filterLiveProtocolRegistry(POOL_REGISTRY, true);
  const committed = mergePoolRegistries(liveRegistry, loadPinnedWarmPools());
  const required = committed.filter((pool) =>
    same(pool.address, ADDR.METRONOME_SYNTH_POOL) ||
    same(pool.address, CURVE_MSETH_WETH) ||
    same(pool.address, V3_USDT_WETH_500) ||
    same(pool.address, ADDR.METRONOME_HGUSDC_ROUTER) ||
    pool.poolId?.toLowerCase() === V4_USDC_USDT_POOL_ID,
  );
  if (required.length !== 5) {
    throw new Error(`committed production inputs contain ${required.length}/5 fixture venues`);
  }
  return required;
}

function tokenBackend(provider: ethers.JsonRpcProvider, blockNumber: number): TokenQueryBackend {
  return {
    call: (req) => provider.call({
      to: req.to,
      data: req.data,
      blockTag: req.blockTag ?? blockNumber,
    }),
  };
}

function expectedPath(graph: TokenEdge[]): TokenEdge[] | null {
  const edges: TokenEdge[] = [];
  for (const spec of EXPECTED_ROUTE) {
    const edge = graph.find((candidate) => edgeMatches(candidate, spec));
    if (!edge) return null;
    edges.push(edge);
  }
  return edges;
}

function pathMatches(path: TokenPath, specs: readonly EdgeSpec[]): boolean {
  if (path.edges.length !== specs.length) return false;
  return specs.some((_spec, offset) =>
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

interface TraceCall {
  from?: string;
  to?: string;
  input?: string;
  output?: string;
  error?: string;
  revertReason?: string;
  calls?: TraceCall[];
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
    console.log(`[metronome-oracle-backrun] failed to trace ${txHash}: ${String(err)}`);
  }
}

function walkTrace(call: TraceCall, depth: number): void {
  if (call.error) {
    console.log(
      `[metronome-oracle-backrun] trace depth=${depth} to=${call.to ?? ""} ` +
        `selector=${call.input?.slice(0, 10) ?? ""} error=${call.error} ` +
        `reason=${call.revertReason ?? ""} output=${call.output ?? ""}`,
    );
  }
  for (const child of call.calls ?? []) walkTrace(child, depth + 1);
}

function pathSummary(path: TokenPath): string {
  return path.edges
    .map((edge) =>
      `${short(edge.tokenIn)}->${short(edge.tokenOut)}@${edge.adapterId}:` +
        `${short(edge.poolId ?? edge.target)}`,
    )
    .join(" | ");
}

function unique(values: string[]): string[] {
  return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];
}

function short(value: string): string {
  return value.slice(0, 10).toLowerCase();
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
    }
    if (parsed.pathname && parsed.pathname !== "/") parsed.pathname = "/***";
    if (parsed.search) parsed.search = "?***";
    return parsed.toString();
  } catch {
    return "<rpc-url>";
  }
}

main().catch((err) => {
  console.error(`blockscan-fork-solve-metronome FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
