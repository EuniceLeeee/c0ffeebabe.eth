/**
 * BS-3 fork solve gate for coffee tx 0xf2de7499 (DEFAULT), AND a parameterized
 * closed-loop fork gate ("loop-fork-gate") for ANY extracted CoffeeFixture.
 *
 * Mainnet-fork + dry-run only.
 *
 * DEFAULT (no --fixture / no SEARCHER_LOOP_FIXTURE_DIR): unchanged BS-3 regression
 * probe. Forks execution state after the prior in-block D166 rate update, builds the
 * committed block-scan loop fixture, then runs the planner and solver against real
 * fork-state quotes. `npm run searcher:blockscan-fork-solve` still runs this exact gate.
 *
 * PARAMETERIZED (`--fixture <path>` or SEARCHER_LOOP_FIXTURE_DIR=<dir>, alias
 * `npm run searcher:loop-fork-gate -- --fixture ...`): for each extracted fixture:
 *   - forkAfterTx(fixture.txHash) using the fixture's own executionBlock/txIndex.
 *   - Assertion A (edge-in-graph / false-green guard): every leg's pool must produce
 *     an edge in buildTokenGraph; a venue kind with no adapter (e.g. balancer-v1) fails
 *     with a clear "no adapter for kind X" message — the anti-false-green gate.
 *   - Assertion B (closed-loop execute): plan+solve the loop on the fork and assert net
 *     output >= expectedGrossWeiRealized * tolerance; a leg we cannot encode fails clearly.
 * The f2de7499-specific curve-rate checks run ONLY on the default fixture.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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
import {
  detectBlockScanOpportunities,
  type ProtocolMid,
} from "../detector/blockscan-scanner.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import { mergePoolRegistries } from "../active-pool-discovery.js";
import { filterLiveProtocolRegistry } from "../main.js";
import { loadPinnedWarmPools } from "../pinned-warm-pools.js";
import { TemplatePlanner } from "../planner/planner.js";
import {
  loadPoolUniverse,
  loadPoolUniverseGeneratedAt,
  poolRegistryKey,
} from "../pool-universe.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  v4PoolId,
  type PoolEntry,
  type TokenEdge,
  type TokenPath,
  type TokenQueryBackend,
  type V4PoolKey,
} from "../planner/token-graph.js";
import { attestPoolIdentities } from "../venues/identity.js";
import { PRODUCTION_IDENTITY_RESOLVERS } from "../venues/production-registry.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { quoteBalancerV3, quoteProtocolLeg } from "../solver/quoter.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { deriveEdgeTaxonomy, pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import { buildStrategyViews, hashTokenGraph } from "../strategy-views.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

const FIXTURE_URL = new URL("./fixtures/blockscan-coffee-f2de7499.json", import.meta.url);
const EXECUTION_STATE_TX =
  "0x82c315049171b73a30587e23fdbe52a810dc56e431fb17aaf91ef657882275d3";
const EXECUTION_BLOCK = 25_455_297;
const EXECUTION_TX_INDEX = 36;
const ANVIL_PORT = Number(process.env.SEARCHER_BLOCKSCAN_FORK_SOLVE_ANVIL_PORT ?? "8565");
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const D166 = "0xD166337499E176bbC38a1FBd113Ab144e5bd2Df7";

/** Loop-tolerance: solver sizing may differ from the competitor's, so accept >= 90% of realized. */
const LOOP_PROFIT_TOLERANCE_BPS = 9000n;

/** Extractor leg kind -> PoolEntry adapter. balancer-v1 intentionally ABSENT (no adapter). */
const LEG_KIND_TO_ADAPTER: Record<string, PoolEntry["adapter"] | undefined> = {
  univ2: "univ2",
  univ3: "univ3",
  univ4: "univ4",
  "dodo-v2": "dodo-v2",
  curve: "curve",
  erc4626: "erc4626",
  rocksolid: "rocksolid",
  "balancer-v3": "balancer-v3",
  "balancer-v1": undefined,
};

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

/** A leg as emitted by extract-loop-fixture.ts (superset of the hand-authored shapes). */
interface ExtractedLeg {
  seq: number;
  kind: "univ2" | "univ3" | "univ4" | "dodo-v2" | "curve" | "balancer-v1" | "erc4626" | "rocksolid" | "balancer-v3";
  poolId?: string;
  poolKey?: { recovered?: boolean } & Partial<FixtureV4PoolKey>;
  address?: string;
  pool?: string;
  token0?: string;
  token1?: string;
  tokenIn?: string;
  tokenOut?: string;
  zeroForOne?: boolean;
  soldId?: number;
  boughtId?: number;
  vault?: string;
  realized: { amountIn: string; amountOut: string };
}

const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
const WETH_ADDRESS = ADDR.WETH.toLowerCase();

/** The generic extracted-fixture shape consumed by the parameterized loop-fork-gate path. */
interface ExtractedFixture {
  txHash: string;
  executionBlock: number;
  sourceBlock: number;
  txIndex: number;
  /** Optional exact in-block predecessor used to fork immediately before the competitor. */
  forkAfterTx?: string;
  flash: { venue: string; token: string; amount: string; fee: string };
  loopToken: string;
  legs: ExtractedLeg[];
  expectedGrossWeiRealized: string;
  /** Re-quote the pinned path on the fork state instead of replaying competitor leg amounts verbatim. */
  quoteExactPath?: boolean;
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

/**
 * DEFAULT BS-3 regression gate for coffee tx 0xf2de7499. Behavior is byte-identical to the
 * original harness — only reached when no --fixture / SEARCHER_LOOP_FIXTURE_DIR is provided.
 */
async function runDefaultF2de7499Gate(): Promise<void> {
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

// ─── Parameterized loop-fork-gate (Assertion A + B for any extracted fixture) ──

interface LoopGateArgs {
  fixturePaths: string[];
  productionUniversePath?: string;
}

/** Resolve --fixture <path> / SEARCHER_LOOP_FIXTURE_DIR into a concrete list of fixture files. */
function resolveLoopFixtures(): LoopGateArgs | null {
  const argv = process.argv.slice(2);
  const fixtureArgs: string[] = [];
  let productionUniversePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fixture") {
      const p = argv[++i];
      if (p) fixtureArgs.push(p);
    } else if (argv[i] === "--production-universe") {
      const p = argv[++i];
      if (p) productionUniversePath = resolve(p);
    }
  }
  const dir = process.env.SEARCHER_LOOP_FIXTURE_DIR;
  if (fixtureArgs.length === 0 && !dir) return null; // default -> f2de7499 gate

  const paths: string[] = [...fixtureArgs.map((p) => resolve(p))];
  if (dir) {
    const dirAbs = resolve(dir);
    if (existsSync(dirAbs) && statSync(dirAbs).isDirectory()) {
      for (const name of readdirSync(dirAbs).filter((n) => n.endsWith(".json")).sort()) {
        paths.push(resolve(dirAbs, name));
      }
    }
  }
  if (paths.length === 0) return null;
  return { fixturePaths: paths, productionUniversePath };
}

function loadExtractedFixture(path: string): ExtractedFixture {
  return JSON.parse(readFileSync(path, "utf8")) as ExtractedFixture;
}

/** Build a minimal PoolEntry for a leg so buildTokenGraph can attempt an edge. */
function poolEntryForLeg(leg: ExtractedLeg, adapter: PoolEntry["adapter"]): PoolEntry {
  const address = ethers.getAddress(leg.pool ?? leg.address ?? leg.vault ?? ethers.ZeroAddress);
  const entry: PoolEntry = { address, adapter };
  if ((adapter === "univ2" || adapter === "univ3" || adapter === "dodo-v2") && leg.token0 && leg.token1) {
    entry.token0 = ethers.getAddress(leg.token0);
    entry.token1 = ethers.getAddress(leg.token1);
  }
  if (adapter === "univ4" && leg.poolKey && leg.poolKey.currency0 && leg.poolKey.currency1) {
    entry.currency0 = leg.poolKey.currency0;
    entry.currency1 = leg.poolKey.currency1;
    entry.fee = leg.poolKey.fee;
    entry.tickSpacing = leg.poolKey.tickSpacing;
    entry.hooks = leg.poolKey.hooks;
    entry.poolId = leg.poolId;
    entry.fixedTokenIn = leg.tokenIn ? v4PoolEntryTokenForLeg(leg, leg.tokenIn) : undefined;
    entry.fixedTokenOut = leg.tokenOut ? v4PoolEntryTokenForLeg(leg, leg.tokenOut) : undefined;
  }
  if (adapter === "erc4626") {
    // Standard vault: graph emits deposit (asset->shares) + redeem (shares->asset). fixedTokenIn = asset().
    // Redeem leg is shares(vault)->asset, so the asset is the leg's tokenOut (redeem) or tokenIn (deposit).
    const isRedeem = leg.tokenIn && leg.tokenIn.toLowerCase() === address.toLowerCase();
    const asset = isRedeem ? leg.tokenOut : leg.tokenIn;
    if (asset) entry.fixedTokenIn = ethers.getAddress(asset);
  }
  if (adapter === "rocksolid") {
    if (leg.tokenIn) entry.fixedTokenIn = ethers.getAddress(leg.tokenIn);
    entry.fixedSlotKind = "protocol";
    entry.fixedProtocolAction = "wrap";
  }
  return entry;
}

/**
 * Assertion A — edge-in-graph / false-green guard. For EVERY leg, the leg's venue kind must map to an
 * adapter AND buildTokenGraph must emit an edge connecting the leg's tokenIn->tokenOut. A kind with no
 * adapter (e.g. balancer-v1) fails here with a clear message — the anti-false-green gate.
 */
async function assertEdgesInGraph(
  fixture: ExtractedFixture,
  backend: TokenQueryBackend,
): Promise<void> {
  for (const leg of fixture.legs) {
    const adapter = LEG_KIND_TO_ADAPTER[leg.kind];
    await check(
      `Assertion A: leg ${leg.seq} (${leg.kind}) produces an edge in the token graph`,
      async () => {
        if (!adapter) {
          console.error(
            `[blockscan-fork-solve]   -> NO ADAPTER for kind "${leg.kind}" (pool ${leg.pool ?? leg.address}); ` +
              "edge is absent — our system cannot route this leg. This is the anti-false-green RED.",
          );
          return false;
        }
        let edges: TokenEdge[] = [];
        try {
          const candidate = poolEntryForLeg(leg, adapter);
          const identity = await attestPoolIdentities(backend, [candidate], {
            identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
            seedEntries: POOL_REGISTRY,
          });
          if (identity.accepted.length !== 1) {
            const rejected = identity.rejected[0];
            console.error(
              `[blockscan-fork-solve]   -> venue identity rejected leg ${leg.seq} (${leg.kind}) ` +
                `pool=${candidate.address} reason=${rejected?.reason ?? "unknown"} ` +
                `venue=${rejected?.venueId ?? "unknown"} factory=${rejected?.factory ?? "unknown"}`,
            );
            return false;
          }
          edges = await buildTokenGraph(backend, identity.accepted);
        } catch (err) {
          console.error(
            `[blockscan-fork-solve]   -> buildTokenGraph threw for leg ${leg.seq} (${leg.kind}): ` +
              (err instanceof Error ? err.message : String(err)),
          );
          return false;
        }
        // A leg is covered iff some emitted edge matches its tokenIn->tokenOut direction (when known),
        // else any edge on the pool suffices.
        if (edges.length === 0) {
          console.error(`[blockscan-fork-solve]   -> zero edges emitted for leg ${leg.seq} (${leg.kind})`);
          return false;
        }
        if (leg.tokenIn && leg.tokenOut) {
          const wantIn = graphTokenForLeg(leg, leg.tokenIn);
          const wantOut = graphTokenForLeg(leg, leg.tokenOut);
          const want = (a: string, b: string) =>
            edges.some(
              (e) =>
                graphTokenForLeg(leg, e.tokenIn).toLowerCase() === a.toLowerCase() &&
                graphTokenForLeg(leg, e.tokenOut).toLowerCase() === b.toLowerCase(),
            );
          if (!want(wantIn, wantOut)) {
            console.error(
              `[blockscan-fork-solve]   -> no edge for direction ${leg.tokenIn} -> ${leg.tokenOut} ` +
                `(graph ${wantIn} -> ${wantOut}) on leg ${leg.seq}`,
            );
            return false;
          }
        }
        return true;
      },
    );
  }
}

/**
 * Assertion B — ADAPTER-ISOLATED fixed-path execute (flavor C). This is the adapter-acceptance gate:
 * a PASS here implies the adapters-under-test (encode + compose + execute) are correct on THIS loop.
 *
 * It takes the FIXED leg path straight from the fixture — exact pools, directions (zeroForOne), and each
 * leg's VERBATIM `realized.amountIn` (the competitor's on-chain sizing), plus the flashloan input amount.
 * It does NOT search for the path and does NOT let a solver re-size amountIn. Each leg is encoded through
 * ITS venue adapter (buildResolvedPlanFromPath -> the same encode path the live executor uses), and the
 * flash-wrapped loop executes in sequence on the forkAfterTx anvil state (BotVMSimulator). It asserts the
 * loop closes (final loopToken >= flash repay) with net surplus >= expectedGrossWeiRealized * tolerance.
 * No TemplatePlanner / AnvilSolver.solve — planner-find + solver-sizing are a SEPARATE integration concern
 * (Assertion C, opt-in via --with-solver / SEARCHER_LOOP_GATE_SOLVER=1) whose search noise would
 * false-negative a perfectly correct adapter. A FAIL here points cleanly at an adapter.
 */
async function assertClosedLoopExecutes(
  fixture: ExtractedFixture,
  state: AnvilStateBackend,
  productionUniversePath?: string,
): Promise<void> {
  // Every loop leg must be adapter-backed; if not, seed-building fails clearly before any execution.
  await check("Assertion B: every loop leg is encodable via its venue adapter", () => {
    for (const leg of fixture.legs) {
      if (!LEG_KIND_TO_ADAPTER[leg.kind]) {
        console.error(
          `[blockscan-fork-solve]   -> cannot encode leg ${leg.seq}: no adapter for kind "${leg.kind}"`,
        );
        return false;
      }
    }
    return true;
  });

  const seedEdges = buildExtractedSeedEdges(fixture);
  const path: TokenPath = { edges: seedEdges };
  const flashToken = ethers.getAddress(fixture.flash.token);
  const flashAmount = BigInt(fixture.flash.amount);
  const expected = BigInt(fixture.expectedGrossWeiRealized);
  const floor = (expected * LOOP_PROFIT_TOLERANCE_BPS) / 10000n;

  await check("Assertion B: WETH-aliased seed path composes and closes in the flash token", () =>
    seedEdges.length > 0 &&
    seedEdges[0].tokenIn.toLowerCase() === flashToken.toLowerCase() &&
    seedEdges[seedEdges.length - 1].tokenOut.toLowerCase() === flashToken.toLowerCase() &&
    seedEdges.every((edge, i) =>
      i === 0 || seedEdges[i - 1].tokenOut.toLowerCase() === edge.tokenIn.toLowerCase(),
    ),
  );

  await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);

  // By default use FIXED amounts straight from the fixture. A fixture can opt into quoteExactPath when
  // the acceptance target is today's adapter quote+encode behavior on the pinned state rather than the
  // competitor's internal per-leg sizing. buildResolvedPlanFromPath wants length = edges + 1.
  let amounts: bigint[] = [
    ...fixture.legs.map((leg) => BigInt(leg.realized.amountIn)),
    BigInt(fixture.legs[fixture.legs.length - 1].realized.amountOut),
  ];
  let rawOutputs = fixture.legs.map((leg) => BigInt(leg.realized.amountOut));
  if (fixture.quoteExactPath) {
    const propagated = await propagateAmountsWithRawOutputs(path, flashAmount, state, {
      safetyBps: 10000n,
    });
    amounts = propagated.amounts;
    rawOutputs = propagated.rawOutputs;
  }
  console.log(
    `[blockscan-fork-solve] Assertion B ${fixture.quoteExactPath ? "re-quoted" : "fixed realized"} amounts: ` +
      `[${amounts.join(", ")}] ` +
      `(flash=${flashAmount}, expected surplus>=${floor})`,
  );

  // Encode the fixed path via the adapter path (approves/transfers + assert-balance + flash wrapper).
  const root = await buildResolvedPlanFromPath(
    path,
    flashToken,
    flashAmount,
    amounts,
    DEFAULT_SEARCHER_EXECUTOR,
    state,
    floor > 0n ? floor : 1n,
    flashAdapterIdForVenue(fixture.flash.venue),
    rawOutputs,
  );
  const plan: ResolvedPlan = {
    root,
    netProfit: 0n,
    profitToken: flashToken,
    flashAmount,
    templateName: "loop-fork-gate-fixed-path",
  };

  const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
  const sim = await simulator.simulate(plan);
  console.log(
    `[blockscan-fork-solve] Assertion B execute: success=${sim.success} grossProfit=${sim.grossProfit} ` +
      `(expected ${expected}, floor ${floor})${sim.revertReason ? ` revert=${sim.revertReason}` : ""}`,
  );
  await check(
    "Assertion B: fixed-path adapter-encoded loop executes and closes >= expectedGrossWeiRealized * tolerance",
    () => sim.success && sim.grossProfit >= floor,
  );

  // Assertion C (OPTIONAL, opt-in): planner-find + solver-sizing integration. Off by default because its
  // search noise false-negatives a correct adapter; a FAIL here is an integration concern, not the adapter.
  const withSolver =
    process.env.SEARCHER_LOOP_GATE_SOLVER === "1" || process.argv.slice(2).includes("--with-solver");
  if (withSolver) {
    const detected = fixture.legs.some((leg) => leg.kind === "rocksolid") &&
      fixture.legs.some((leg) => leg.kind === "balancer-v3")
      ? await detectRocksolidBalancerV3Opportunity(
          fixture,
          seedEdges,
          state,
          productionUniversePath,
        )
      : null;
    if (detected) {
      await check("Assertion C: production scanner admits the repeated-token low-spread ring", () =>
        detected.seedEdges.map((edge) => edge.adapterId).join(",") ===
          seedEdges.map((edge) => edge.adapterId).join(","),
      );
    }
    const opp = detected ?? buildExtractedOpportunity(fixture, seedEdges);
    const planner = new TemplatePlanner();
    planner.setGraph(seedEdges);
    const plans = await planner.planBlockScanFromSeedEdges(opp, [FLASH_SWAP_REPAY]);
    await check("Assertion C (solver, optional): planner composes candidate_plans > 0", () => plans.length > 0);
    const solver = new AnvilSolver();
    let solved: ResolvedPlan | null = null;
    let solveError: string | null = null;
    try {
      solved = await solver.solve(plans[0], state, simulator, {
        finalSimTopN: 3,
        gssMaxTries: 8,
        quoteProfitFloorBps: 0n,
        // Block-scan production intentionally quotes exact amounts, then runs the
        // terminal BotVM simulation before submission (main.ts solvePlanned).
        quoteSafetyBps: 10000n,
      });
    } catch (err) {
      solveError = err instanceof Error ? err.message : String(err);
    }
    console.log(
      `[blockscan-fork-solve] Assertion C (solver, optional) outcome: ${
        solved ? `netProfit=${solved.netProfit}` : `no plan (${solveError ?? "null"})`
      }`,
    );
    await check("Assertion C (solver, optional): solver net output >= expectedGrossWeiRealized * tolerance", () =>
      solved !== null && solved.netProfit >= floor,
    );
  }
}

async function detectRocksolidBalancerV3Opportunity(
  fixture: ExtractedFixture,
  expectedEdges: TokenEdge[],
  state: AnvilStateBackend,
  productionUniversePath?: string,
): Promise<BlockScanOpportunity | null> {
  const blockNumber = fixture.executionBlock;
  const cache = new PoolStateCache();
  let edges = expectedEdges;
  if (productionUniversePath) {
    const universeTopN = Number(process.env.SEARCHER_POOL_UNIVERSE_TOP_N ?? "20000");
    const blockscanViewMaxPools = Number(process.env.SEARCHER_BLOCKSCAN_VIEW_MAX_POOLS ?? "6000");
    const liveRegistry = filterLiveProtocolRegistry(POOL_REGISTRY, true);
    await check("Assertion C: production protocol admission includes RockSolid", () =>
      liveRegistry.some((pool) => pool.adapter === "rocksolid"),
    );

    const rawUniverse = loadPoolUniverse(productionUniversePath, { maxPools: 0, minScore: 0 });
    const rawTopUniverse = loadPoolUniverse(productionUniversePath, {
      maxPools: universeTopN,
      minScore: 0,
    });
    const rawPinned = loadPinnedWarmPools();
    const [universeIdentity, pinnedIdentity] = await Promise.all([
      attestPoolIdentities(state.provider, rawUniverse, {
        identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
        seedEntries: liveRegistry,
      }),
      attestPoolIdentities(state.provider, rawPinned, {
        identityRegistry: PRODUCTION_IDENTITY_RESOLVERS,
        seedEntries: liveRegistry,
      }),
    ]);
    const topUniverseKeys = new Set(rawTopUniverse.map(poolRegistryKey));
    const topUniverse = universeIdentity.accepted.filter((pool) =>
      topUniverseKeys.has(poolRegistryKey(pool)),
    );
    const basePools = mergePoolRegistries(
      mergePoolRegistries(liveRegistry, pinnedIdentity.accepted),
      topUniverse,
    );
    const strategyViews = buildStrategyViews(basePools, universeIdentity.accepted, [], {
      blockscanMaxPools: blockscanViewMaxPools,
      poolUniverseGeneratedAt: loadPoolUniverseGeneratedAt(productionUniversePath),
    });
    const backend: TokenQueryBackend = {
      call: (req) => state.call(req),
      getLogs: (req) => state.provider.send("eth_getLogs", [req]),
    };
    edges = await buildTokenGraph(backend, strategyViews.blockscan);
    console.log(
      `[blockscan-fork-solve] Assertion C production universe: ` +
        `raw=${rawUniverse.length} accepted=${universeIdentity.accepted.length} ` +
        `rejected=${universeIdentity.rejected.length} view=${strategyViews.blockscan.length} ` +
        `edges=${edges.length} graphHash=${hashTokenGraph(edges)} path=${productionUniversePath}`,
    );
    await check("Assertion C: full production graph contains every expected route edge", () =>
      expectedEdges.every((expected) => edges.some((edge) => sameRouteEdge(edge, expected))),
    );
  }
  const v3Iface = new ethers.Interface([
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function tickSpacing() view returns (int24)",
    "function liquidity() view returns (uint128)",
    "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  ]);
  const v3Pools = [...new Set(
    expectedEdges
      .filter((edge) => edge.adapterId === "univ3-swap")
      .map((edge) => edge.target.toLowerCase()),
  )];
  for (const pool of v3Pools) {
    const call = async (fn: string): Promise<ethers.Result> => {
      const raw = await state.call({ to: pool, data: v3Iface.encodeFunctionData(fn) });
      return v3Iface.decodeFunctionResult(fn, raw);
    };
    const [token0, token1, fee, tickSpacing, liquidity, slot0] = await Promise.all([
      call("token0"),
      call("token1"),
      call("fee"),
      call("tickSpacing"),
      call("liquidity"),
      call("slot0"),
    ]);
    cache.seedV3Ticks({
      pool,
      token0: String(token0[0]),
      token1: String(token1[0]),
      fee: BigInt(fee[0]),
      tickSpacing: Number(tickSpacing[0]),
      tickBitmap: new Map(),
      ticks: new Map(),
      blockNumber,
    });
    cache.seedV3Live({
      pool,
      sqrtPriceX96: BigInt(slot0[0]),
      tick: Number(slot0[1]),
      liquidity: BigInt(liquidity[0]),
      blockNumber,
    });
  }

  const protocolMids = new Map<string, ProtocolMid>();
  for (let i = 0; i < expectedEdges.length; i++) {
    const edge = expectedEdges[i];
    if (edge.adapterId !== "rocksolid-sync-deposit" && edge.adapterId !== "balancer-v3-unlock") {
      continue;
    }
    const amountIn = BigInt(fixture.legs[i].realized.amountIn);
    const amountOut = edge.adapterId === "rocksolid-sync-deposit"
      ? await quoteProtocolLeg(state, edge.target, edge.adapterId, amountIn)
      : await quoteBalancerV3(state, edge.target, edge.tokenIn, edge.tokenOut, amountIn);
    protocolMids.set(
      `${edge.target.toLowerCase()}|${edge.tokenIn.toLowerCase()}|${edge.tokenOut.toLowerCase()}`,
      {
        mid: Number(amountOut) / Number(amountIn),
        feeBps: 0,
        depthIn: amountIn * 10n,
      },
    );
  }

  const flashToken = ethers.getAddress(fixture.flash.token).toLowerCase();
  const pricedTokens = productionUniversePath
    ? new Map([
        [ADDR.WETH.toLowerCase(), { maxBorrow: 2_000n * 10n ** 18n }],
        [ADDR.USDC.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
        [ADDR.USDT.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 6n }],
        [ADDR.DAI.toLowerCase(), { maxBorrow: 5_000_000n * 10n ** 18n }],
      ])
    : new Map([[flashToken, { maxBorrow: BigInt(fixture.flash.amount) * 2n }]]);
  const scan = detectBlockScanOpportunities({
    edges,
    cache,
    sourceBlock: blockNumber,
    swapTouched: null,
    cfg: {
      maxHops: Number(process.env.SEARCHER_BLOCKSCAN_MAX_HOPS ?? "4"),
      minSpreadBps: Number(process.env.SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS ?? "0"),
      maxCandidates: Number(process.env.SEARCHER_BLOCKSCAN_MAX_CANDIDATES ?? "8"),
      budgetMs: Number(process.env.SEARCHER_BLOCKSCAN_SCAN_BUDGET_MS ?? "1500"),
      pricedTokens,
      protocolMids,
    },
  });
  return scan.opportunities.find(
    (opp) =>
      opp.seedEdges.length === expectedEdges.length &&
      opp.seedEdges.every((edge, index) => sameRouteEdge(edge, expectedEdges[index])),
  ) ?? null;
}

function sameRouteEdge(a: TokenEdge, b: TokenEdge): boolean {
  return a.adapterId === b.adapterId &&
    a.target.toLowerCase() === b.target.toLowerCase() &&
    a.tokenIn.toLowerCase() === b.tokenIn.toLowerCase() &&
    a.tokenOut.toLowerCase() === b.tokenOut.toLowerCase();
}

/** Map the fixture's flash venue to the plan-builder's flash adapter id. */
function flashAdapterIdForVenue(venue: string): string {
  if (venue === "balancer-v2") return "balancer-flash";
  // Aave/others are not yet declared in FLASH_PROVIDER_DESCRIPTORS; fail clearly at build time.
  throw new Error(`no flash adapter wired for venue "${venue}" (plan-builder supports balancer-flash/morpho-flash)`);
}

/**
 * Build seed edges from the fixture legs IN LOG ORDER, one edge per leg.
 *
 * LIMITATION (v1): this assumes the legs form a single LINEAR ring (leg[i].tokenOut == leg[i+1].tokenIn),
 * which holds for straight-line loops (the YETI/dc52761f/f2de7499 shapes). A BRANCHED/DAG loop — where
 * the bot splits the flash across sub-paths that re-converge (e.g. the sfrxETH tx 0x8756ba5c: a USDC-
 * anchored 5-leg chain plus a separate USDT<->WETH profit sweep) — is NOT a single linear ring, so the
 * fixed log-order amounts array won't be balance-consistent and Assertion B will (correctly) revert at
 * execution. Composing branched loops is a follow-up (needs a per-token flow DAG, not a linear chain).
 */
function buildExtractedSeedEdges(fixture: ExtractedFixture): TokenEdge[] {
  const edges: TokenEdge[] = [];
  for (const leg of fixture.legs) {
    const adapter = LEG_KIND_TO_ADAPTER[leg.kind];
    if (!adapter) throw new Error(`leg ${leg.seq}: no adapter for kind ${leg.kind}`);
    if (!leg.tokenIn || !leg.tokenOut) {
      throw new Error(`leg ${leg.seq} (${leg.kind}) missing tokenIn/tokenOut for seed edge`);
    }
    const tokenIn = graphTokenForLeg(leg, leg.tokenIn);
    const tokenOut = graphTokenForLeg(leg, leg.tokenOut);
    if (leg.kind === "curve") {
      edges.push({
        adapterId: "curve-exchange-plain",
        target: ethers.getAddress(leg.pool ?? leg.address!),
        tokenIn,
        tokenOut,
        slotKind: "swap",
        curveI: leg.soldId,
        curveJ: leg.boughtId,
        ...deriveEdgeTaxonomy("swap"),
        score: 100,
      });
    } else if (leg.kind === "univ4") {
      if (!leg.poolKey?.currency0) {
        throw new Error(`leg ${leg.seq} univ4 poolKey unrecovered — cannot build seed edge (v1 TODO)`);
      }
      const key: V4PoolKey = {
        currency0: normalizeAddress(leg.poolKey.currency0),
        currency1: normalizeAddress(leg.poolKey.currency1!),
        fee: leg.poolKey.fee!,
        tickSpacing: leg.poolKey.tickSpacing!,
        hooks: normalizeAddress(leg.poolKey.hooks!),
      };
      edges.push({
        adapterId: "univ4-unlock",
        target: ADDR.UNISWAP_V4_POOL_MANAGER,
        tokenIn,
        tokenOut,
        slotKind: "swap",
        v4PoolKey: key,
        poolId: v4PoolId(key),
        nativeCurrency0: key.currency0 === ethers.ZeroAddress,
        nativeCurrency1: key.currency1 === ethers.ZeroAddress,
        ...deriveEdgeTaxonomy("swap"),
        score: 100,
      });
    } else if (leg.kind === "erc4626") {
      // Standard vault redeem (shares->asset) or deposit (asset->shares); direction from tokenIn == vault.
      const vault = ethers.getAddress(leg.vault ?? leg.address!);
      const isRedeem = tokenIn.toLowerCase() === vault.toLowerCase();
      edges.push({
        adapterId: isRedeem ? "erc4626-redeem" : "erc4626-deposit",
        target: vault,
        tokenIn,
        tokenOut,
        slotKind: "protocol",
        protocolAction: isRedeem ? "redeem" : "wrap",
        ...deriveEdgeTaxonomy("protocol", isRedeem ? "redeem" : "wrap"),
        score: 100,
      });
    } else if (leg.kind === "rocksolid") {
      edges.push({
        adapterId: "rocksolid-sync-deposit",
        target: ethers.getAddress(leg.vault ?? leg.address!),
        tokenIn,
        tokenOut,
        slotKind: "protocol",
        protocolAction: "wrap",
        ...deriveEdgeTaxonomy("protocol", "wrap"),
        score: 100,
      });
    } else if (leg.kind === "balancer-v3") {
      edges.push({
        adapterId: "balancer-v3-unlock",
        target: ethers.getAddress(leg.pool ?? leg.address!),
        tokenIn,
        tokenOut,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
        score: 100,
      });
    } else if (leg.kind === "dodo-v2") {
      if (!leg.token0 || !leg.token1) {
        throw new Error(`leg ${leg.seq} dodo-v2 missing base/quote token order`);
      }
      edges.push({
        adapterId: "dodo-v2-swap",
        target: ethers.getAddress(leg.pool ?? leg.address!),
        tokenIn,
        tokenOut,
        slotKind: "swap",
        poolToken0: ethers.getAddress(leg.token0),
        poolToken1: ethers.getAddress(leg.token1),
        ...deriveEdgeTaxonomy("swap"),
        score: 100,
      });
    } else {
      // univ2 / univ3
      edges.push({
        adapterId: adapter === "univ3" ? "univ3-swap" : "univ2-swap",
        target: ethers.getAddress(leg.pool ?? leg.address!),
        tokenIn,
        tokenOut,
        slotKind: "swap",
        poolToken0: leg.token0 ? ethers.getAddress(leg.token0) : undefined,
        poolToken1: leg.token1 ? ethers.getAddress(leg.token1) : undefined,
        ...deriveEdgeTaxonomy("swap"),
        score: 100,
      });
    }
  }
  return edges;
}

/** Harness-side view of a fixture token: native v4 currency composes as WETH in the graph/plan path. */
function graphTokenForLeg(leg: ExtractedLeg, token: string): string {
  const normalized = normalizeAddress(token);
  if (leg.kind === "univ4" && isNativeCurrencyV4Leg(leg) && normalized.toLowerCase() === ZERO_ADDRESS) {
    return ethers.getAddress(ADDR.WETH);
  }
  return normalized;
}

/** buildTokenGraph still takes raw PoolKey currencies, so an already-aliased WETH fixture token maps back. */
function v4PoolEntryTokenForLeg(leg: ExtractedLeg, token: string): string {
  const normalized = normalizeAddress(token);
  if (leg.kind !== "univ4" || !isNativeCurrencyV4Leg(leg) || normalized.toLowerCase() !== WETH_ADDRESS) {
    return normalized;
  }
  const c0 = normalizeAddress(leg.poolKey!.currency0!);
  const c1 = normalizeAddress(leg.poolKey!.currency1!);
  if ((c0.toLowerCase() === ZERO_ADDRESS && c1.toLowerCase() !== WETH_ADDRESS) ||
    (c1.toLowerCase() === ZERO_ADDRESS && c0.toLowerCase() !== WETH_ADDRESS)) {
    return ethers.ZeroAddress;
  }
  return normalized;
}

function isNativeCurrencyV4Leg(leg: ExtractedLeg): boolean {
  if (leg.kind !== "univ4" || !leg.poolKey?.currency0 || !leg.poolKey.currency1) return false;
  return isZeroAddress(leg.poolKey.currency0) || isZeroAddress(leg.poolKey.currency1);
}

function isZeroAddress(value: string): boolean {
  return normalizeAddress(value).toLowerCase() === ZERO_ADDRESS;
}

function buildExtractedOpportunity(fixture: ExtractedFixture, seedEdges: TokenEdge[]): BlockScanOpportunity {
  const flashToken = ethers.getAddress(fixture.flash.token);
  const ring = seedEdges.length === 0 ? [] : [seedEdges[0].tokenIn, ...seedEdges.slice(0, -1).map((e) => e.tokenOut)];
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
      maxInput: (BigInt(fixture.flash.amount) * 3n) / 2n,
    },
    leavesStandingPosition: pathLeavesStandingPosition(seedEdges),
    affectedPools: [...new Set(seedEdges.map((e) => e.target.toLowerCase()))].map((a) => ethers.getAddress(a)),
    affectedTokens: canonicalTokenRing(ring),
  };
}

async function runLoopForkGate(args: LoopGateArgs): Promise<void> {
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required for the loop-fork-gate archive fork.");
  }
  console.log(`[blockscan-fork-solve] loop-fork-gate over ${args.fixturePaths.length} fixture(s)`);

  for (const path of args.fixturePaths) {
    const fixture = loadExtractedFixture(path);
    console.log(
      `[blockscan-fork-solve] --- fixture ${path} tx=${fixture.txHash} block=${fixture.executionBlock} ` +
        `legs=${fixture.legs.map((l) => l.kind).join(",")} ---`,
    );
    const upstream = new ethers.JsonRpcProvider(rpcUrl);
    const state = new AnvilStateBackend(rpcUrl, ANVIL_URL, ANVIL_PORT);
    try {
      const latest = await withTimeout(
        upstream.getBlockNumber(),
        30_000,
        `upstream RPC preflight ${redactRpcUrl(rpcUrl)}`,
        rpcUrl,
      );
      if (latest < fixture.executionBlock) {
        throw new Error(`upstream latest block ${latest} is before required block ${fixture.executionBlock}`);
      }

      // Assertion A does NOT need the fork (pure graph emission from pinned metadata / latest reads),
      // so run it first — a missing adapter RED-flags before we pay for a fork. buildTokenGraph only
      // needs `call`; wrap the provider in a minimal TokenQueryBackend (its getLogs types differ).
      const graphBackend: TokenQueryBackend = {
        call: (req) => upstream.call(req as ethers.TransactionRequest),
      };
      await assertEdgesInGraph(fixture, graphBackend);

      const forkAfterTx = fixture.forkAfterTx ?? fixture.txHash;
      console.log(`[blockscan-fork-solve] forkAfterTx ${forkAfterTx} anvil=${ANVIL_URL}`);
      await state.forkAfterTx(forkAfterTx);
      await assertClosedLoopExecutes(fixture, state, args.productionUniversePath);
    } finally {
      state.stop();
      upstream.destroy();
    }
  }

  console.log(`blockscan-fork-solve (loop-fork-gate) PASS (${passed}/${checks})`);
}

async function main(): Promise<void> {
  loadEnv();
  const loopArgs = resolveLoopFixtures();
  if (loopArgs) {
    await runLoopForkGate(loopArgs);
    return;
  }
  await runDefaultF2de7499Gate();
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
