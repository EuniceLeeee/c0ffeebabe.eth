/**
 * BS-3 fork solve gate for coffee tx 0xf2de7499.
 *
 * Mainnet-fork + dry-run only. Forks execution state after the prior in-block
 * D166 rate update, builds the committed block-scan loop fixture, then runs the
 * planner and solver against real fork-state quotes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import { TemplatePlanner } from "../planner/planner.js";
import { v4PoolId, type TokenEdge, type V4PoolKey } from "../planner/token-graph.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { deriveEdgeTaxonomy, pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

const FIXTURE_URL = new URL("./fixtures/blockscan-coffee-f2de7499.json", import.meta.url);
const EXECUTION_STATE_TX =
  "0x82c315049171b73a30587e23fdbe52a810dc56e431fb17aaf91ef657882275d3";
const EXECUTION_BLOCK = 25_455_297;
const EXECUTION_TX_INDEX = 36;
const ANVIL_PORT = Number(process.env.SEARCHER_BLOCKSCAN_FORK_SOLVE_ANVIL_PORT ?? "8565");
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const D166 = "0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7";

interface FixtureV4PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

interface FixtureV4Leg {
  seq: number;
  kind: "univ4";
  poolId: string;
  poolKey: FixtureV4PoolKey;
}

interface FixtureCurveLeg {
  seq: number;
  kind: "curve";
  pool: string;
  soldId: number;
  boughtId: number;
  preState: {
    variant: "stableswap-ng";
    balances: string[];
    ratesAtSourceBoundary: string[];
    ratesAtExecution: string[];
  };
}

interface FixtureProfitLeg {
  seq: number;
  kind: "univ2";
  role: string;
}

interface CoffeeFixture {
  txHash: string;
  executionBlock: number;
  sourceBlock: number;
  txIndex: number;
  flash: {
    token: string;
    amount: string;
  };
  loopToken: string;
  legs: [FixtureV4Leg, FixtureV4Leg, FixtureCurveLeg, FixtureProfitLeg];
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
    console.error(`[blockscan-fork-solve] ${name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!ok) {
    console.error(`[blockscan-fork-solve] ${name}: FAIL`);
    throw new Error(name);
  }
  passed += 1;
  console.log(`[blockscan-fork-solve] ${name}: PASS`);
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required for archive fork " +
        `${EXECUTION_STATE_TX} (block ${EXECUTION_BLOCK}, txIndex ${EXECUTION_TX_INDEX}).`,
    );
  }

  const fixture = loadFixture();
  const state = new AnvilStateBackend(rpcUrl, ANVIL_URL, ANVIL_PORT);
  const upstream = new ethers.JsonRpcProvider(rpcUrl);

  try {
    const latest = await withTimeout(
      upstream.getBlockNumber(),
      30_000,
      `upstream RPC preflight ${redactRpcUrl(rpcUrl)}`,
      rpcUrl,
    );
    if (latest < EXECUTION_BLOCK) {
      throw new Error(`upstream latest block ${latest} is before required block ${EXECUTION_BLOCK}`);
    }

    await check("fixture is the coffee execution-state target", () =>
      fixture.txHash.toLowerCase().startsWith("0xf2de7499") &&
      fixture.executionBlock === EXECUTION_BLOCK &&
      fixture.txIndex === EXECUTION_TX_INDEX + 1,
    );

    console.log(
      `[blockscan-fork-solve] fork upstream=${redactRpcUrl(rpcUrl)} ` +
        `afterTx=${EXECUTION_STATE_TX} anvil=${ANVIL_URL}`,
    );
    await state.forkAfterTx(EXECUTION_STATE_TX);

    // --fork-transaction-hash anchors state AFTER the given tx within its block;
    // anvil reports the current head as the PARENT (EXECUTION_BLOCK-1) with the
    // pre-index txs applied as an overlay. So accept parent-or-exec; the load-
    // bearing correctness check is that the intra-block D166 oracle update IS in
    // effect (execution rate), which the next assertion pins directly.
    const forkBlock = await state.provider.getBlockNumber();
    await check("fork anchored at execution state (parent-or-exec block)", () =>
      forkBlock === EXECUTION_BLOCK || forkBlock === EXECUTION_BLOCK - 1,
    );
    // FINDING (verified on the fork): the D166 stored_rate that made coffee +EV is
    // NOT present in any pre-coffee state. On forkAfterTx(txIndex 36) the curve pool
    // still holds the STALE boundary rate; the +3.7bps bump to the execution rate is
    // applied by the stableswap-ng pool refreshing stored_rates at coffee's OWN swap
    // (the only curve interaction in the block). So the loop is view-quotable as −EV
    // here — f2de7499's profit is a swap-time stored_rate refresh, not a standing
    // dislocation, and is un-capturable by pre-coffee fork view-quotes. This harness
    // pins that non-viability deterministically (stops re-attempts on this exemplar).
    const curveBoundaryRate = BigInt(fixture.legs[2].preState.ratesAtSourceBoundary[1]);
    const curveExecRate = BigInt(fixture.legs[2].preState.ratesAtExecution[1]);
    const storedRates = await state.provider.call({
      to: ethers.getAddress(fixture.legs[2].pool),
      data: "0xfd0684b1", // stored_rates()
    });
    const forkRate1 = (ethers.AbiCoder.defaultAbiCoder().decode(["uint256[]"], storedRates)[0] as bigint[])[1];
    await check("pre-coffee fork carries the STALE boundary D166 rate (refresh is at swap-time)", () =>
      forkRate1 === curveBoundaryRate && forkRate1 !== curveExecRate,
    );

    const seedEdges = buildSeedEdges(fixture);
    const opp = buildOpportunity(fixture, seedEdges);
    await check("closed loop excludes profit-conversion leg", () =>
      opp.seedEdges.length === 3 &&
      opp.seedEdges.every((edge) => edge.adapterId !== "univ2-swap") &&
      opp.seedEdges[0].tokenIn.toLowerCase() === fixture.flash.token.toLowerCase() &&
      opp.seedEdges[2].tokenOut.toLowerCase() === fixture.flash.token.toLowerCase(),
    );
    await check("opportunity carries no standing-position marker", () =>
      !opp.leavesStandingPosition && opp.seedEdges.every((edge) => !edge.leavesStandingPosition),
    );

    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    const planner = new TemplatePlanner();
    planner.setGraph(seedEdges);
    const templates = [FLASH_SWAP_REPAY];
    const plans = await planner.planBlockScanFromSeedEdges(opp, templates);
    await check("candidate_plans > 0", () => plans.length > 0);

    const center = await resolveSearchCenter(plans[0], opp.flashToken, state, {});
    await check("search center comes from searchSeed.searchCenter", () =>
      center === opp.searchSeed.searchCenter && center > 8n,
    );

    await check("plan startToken is the USDC flash token", () =>
      plans[0].opportunity.startToken.toLowerCase() === ADDR.USDC.toLowerCase(),
    );

    // The solver runs the real quote/size path on the fork. On this exemplar the
    // pre-coffee view-quoted loop is −EV (curve get_dy < flash), so an EV-honest
    // solver must NOT return a +EV plan: either no solved plan, or netProfit ≤ 0.
    // (If a future run ever flips this to +EV it means the stored_rate-refresh
    // modeling landed — that is the signal to promote this exemplar.)
    const solver = new AnvilSolver();
    const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
    let solved: ResolvedPlan | null = null;
    let solveError: string | null = null;
    try {
      solved = await solver.solve(plans[0], state, simulator, {
        finalSimTopN: 3,
        gssMaxTries: 8,
        quoteProfitFloorBps: 0n,
        quoteSafetyBps: 10000n,
      });
    } catch (err) {
      solveError = err instanceof Error ? err.message : String(err);
    }
    console.log(
      `[blockscan-fork-solve] solver outcome: ${
        solved ? `netProfit=${solved.netProfit}` : `no plan (${solveError ?? "null"})`
      }`,
    );
    await check("EV-honest: pre-coffee fork yields NO +EV plan for this exemplar", () =>
      solved === null || solved.netProfit <= 0n,
    );

    console.log(`blockscan-fork-solve PASS (${passed}/${checks}) — exemplar viability probe`);
  } finally {
    state.stop();
    upstream.destroy();
  }
}

function loadFixture(): CoffeeFixture {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as CoffeeFixture;
}

function buildSeedEdges(fixture: CoffeeFixture): TokenEdge[] {
  const [leg1, leg2, leg3] = fixture.legs;
  if (leg1.kind !== "univ4" || leg2.kind !== "univ4" || leg3.kind !== "curve") {
    throw new Error("fixture closed-loop legs must be univ4, univ4, curve");
  }
  const curvePreState = leg3.preState;
  if (
    curvePreState.variant !== "stableswap-ng" ||
    curvePreState.balances.length !== 2 ||
    curvePreState.ratesAtExecution.length !== 2 ||
    leg3.soldId !== 1 ||
    leg3.boughtId !== 0
  ) {
    throw new Error("fixture curve leg missing captured stableswap-ng execution-rate state");
  }

  return [
    v4Edge(leg1, ADDR.USDC, ADDR.USDT),
    v4Edge(leg2, ADDR.USDT, D166),
    {
      adapterId: "curve-exchange-plain",
      target: ethers.getAddress(leg3.pool),
      tokenIn: D166,
      tokenOut: ADDR.USDC,
      slotKind: "swap",
      curveI: leg3.soldId,
      curveJ: leg3.boughtId,
      ...deriveEdgeTaxonomy("swap"),
      score: 100,
    },
  ];
}

function v4Edge(leg: FixtureV4Leg, tokenIn: string, tokenOut: string): TokenEdge {
  const key = poolKey(leg.poolKey);
  const actualPoolId = v4PoolId(key);
  if (actualPoolId !== leg.poolId.toLowerCase()) {
    throw new Error(`fixture v4 leg ${leg.seq} poolId mismatch: ${actualPoolId} != ${leg.poolId}`);
  }
  return {
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    v4PoolKey: key,
    poolId: actualPoolId,
    nativeCurrency0: key.currency0 === ethers.ZeroAddress,
    nativeCurrency1: key.currency1 === ethers.ZeroAddress,
    ...deriveEdgeTaxonomy("swap"),
    score: 100,
  };
}

function poolKey(input: FixtureV4PoolKey): V4PoolKey {
  return {
    currency0: normalizeAddress(input.currency0),
    currency1: normalizeAddress(input.currency1),
    fee: input.fee,
    tickSpacing: input.tickSpacing,
    hooks: normalizeAddress(input.hooks),
  };
}

function buildOpportunity(fixture: CoffeeFixture, seedEdges: TokenEdge[]): BlockScanOpportunity {
  const flashToken = normalizeAddress(fixture.flash.token);
  const ring = ringTokensWithoutRepeat(seedEdges);
  return {
    kind: "block-scan-arb",
    sourceBlock: fixture.sourceBlock,
    stateBlock: fixture.executionBlock,
    cycleId: canonicalTokenRing(ring).join("|"),
    cycleFingerprint: cycleFingerprint(fixture.sourceBlock, ring),
    seedEdges,
    flashToken,
    searchSeed: {
      startToken: flashToken,
      searchCenter: BigInt(fixture.flash.amount),
      maxInput: BigInt(fixture.flash.amount),
    },
    leavesStandingPosition: pathLeavesStandingPosition(seedEdges),
    affectedPools: uniqueAddresses(seedEdges.map((edge) => edge.target)),
    affectedTokens: canonicalTokenRing(ring),
  };
}

function ringTokensWithoutRepeat(edges: TokenEdge[]): string[] {
  if (edges.length === 0) return [];
  return [
    edges[0].tokenIn,
    ...edges.slice(0, -1).map((edge) => edge.tokenOut),
  ];
}

function normalizeAddress(value: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  // getAddress rejects a mis-checksummed literal; normalize from lowercase so
  // fixture/constant casing never matters.
  return ethers.getAddress(value.toLowerCase());
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
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

main().catch((err) => {
  console.error(`blockscan-fork-solve FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
