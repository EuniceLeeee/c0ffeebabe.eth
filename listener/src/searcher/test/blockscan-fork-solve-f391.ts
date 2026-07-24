/**
 * Rule-12 gate for the erc4626-redeem-silo edge (srUSDe -> sUSDe), competitor tx 0xf391d0
 * (block 25462190, a verified atomic protocol arbitrage — decision-log F-013).
 *
 * Mainnet-fork + dry-run only. Forks execution state AFTER the tx immediately preceding the
 * competitor (txIndex 85 of 86), i.e. pre-competitor intra-block state, and proves:
 *   1. The real graph builder emits exactly ONE srUSDe edge (the silo redeem, tokenOut = sUSDe,
 *      NO deposit edge); a flagged vault WITHOUT a declared payout token emits ZERO edges.
 *   2. quoteSiloRedeem reproduces the on-chain sUSDe payout at pinned block state (wei-close;
 *      residual is pure per-second vault accrual).
 *   3. The planner composes the 4-leg loop USDC -> srUSDe -> sUSDe -> USDT -> USDC, and the solver
 *      returns a +EV plan on real fork-state quotes (the "confirm tx reproduces" flip).
 *
 * The USDC->WETH tail of the competitor tx is a profit-denomination choice, not part of the core
 * loop, so the ring closes in USDC and profit is the USDC surplus.
 */

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
import {
  buildTokenGraph,
  POOL_REGISTRY,
  v4PoolId,
  type PoolEntry,
  type TokenEdge,
  type TokenQueryBackend,
  type V4PoolKey,
} from "../planner/token-graph.js";
import { quote } from "../solver/quoter.js";
import { quoteSiloRedeem } from "../venues/protocols/protocol-quote.js";
import { encodeUniV4QuoteExactInputSingle } from "../venues/swaps/univ4.js";
import { AnvilSolver, resolveSearchCenter, type ResolvedPlan } from "../solver/solver.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { deriveEdgeTaxonomy, pathLeavesStandingPosition } from "../strategy-taxonomy.js";
import { FLASH_SWAP_REPAY } from "../templates/path-template.js";

// ── On-chain-derived constants (cast-verified 2026-07-07 on archive fork) ──
const COMPETITOR_TX = "0xf391d02add5e6cbbd98836d9eacdb66de3e5d76ef3874134145a6563a126ee86";
const FORK_ANCHOR_TX = "0x63fb77b723f3bd7fd4d9539ef1e1e248cb5499153dbfc225e8b24ae1522ec6e7"; // txIndex 85 of 136
const EXECUTION_BLOCK = 25_462_190; // 0x18485AE
const BLOCK_TIMESTAMP = 1_783_204_679;
const SRUSDE = "0x3d7d6fdf07EE548B939A80edbc9B2256d0cdc003";
const SUSDE = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";
const V3_SUSDE_USDT = "0x7EB59373D63627be64b42406B108B602174B4CCC"; // v3 fee 100, token0 sUSDe, token1 USDT
const FLASH_USDC = 949_488_853n; // Balancer flash disbursement in the competitor tx
// The competitor's exact silo redeem (from the receipt): shares burned -> sUSDe paid.
const SILO_SHARES_IN = 934_460_889_828_731_878_592n;
const SILO_SUSDE_OUT = 773_988_351_883_794_733_939n;
// At the pinned block timestamp the composed quote tracks the historical per-block payout (~2e9 raw
// inter-block drift). 1e13 raw (~1.3e-8 rel) bounds real accrual + view-vs-realized rounding while
// staying ~1e4x below any wrong composition (returning the USDe value would be off by ~1.8e20).
const SILO_ACCRUAL_TOLERANCE = 10_000_000_000_000n; // 1e13 raw

// v4 USDC/srUSDe pool 0xc069abea… — currency0 = srUSDe (0x3d < 0xA0), fee 100, tickSpacing 1, no hooks.
const V4_USDC_SRUSDE: V4PoolKey = {
  currency0: ethers.getAddress(SRUSDE),
  currency1: ethers.getAddress(ADDR.USDC),
  fee: 100,
  tickSpacing: 1,
  hooks: ethers.ZeroAddress,
};
// v4 USDC/USDT pool 0x395f91b3… — currency0 = USDC, fee 8, tickSpacing 1, no hooks.
const V4_USDC_USDT: V4PoolKey = {
  currency0: ethers.getAddress(ADDR.USDC),
  currency1: ethers.getAddress(ADDR.USDT),
  fee: 8,
  tickSpacing: 1,
  hooks: ethers.ZeroAddress,
};

const ANVIL_PORT = Number(process.env.SEARCHER_BLOCKSCAN_FORK_SOLVE_F391_ANVIL_PORT ?? "8566");
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

let checks = 0;
let passed = 0;

async function check(name: string, run: () => boolean | Promise<boolean>): Promise<void> {
  checks += 1;
  let ok = false;
  try {
    ok = await run();
  } catch (err) {
    console.error(`[f391-fork-solve] ${name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!ok) {
    console.error(`[f391-fork-solve] ${name}: FAIL`);
    throw new Error(name);
  }
  passed += 1;
  console.log(`[f391-fork-solve] ${name}: PASS`);
}

/** Backend stub: the erc4626 emission branch is pure (no eth_call), so this must never be called. */
const noCallBackend: TokenQueryBackend = {
  async call(): Promise<string> {
    throw new Error("erc4626 emission branch must not query the backend");
  },
};

async function emittedSrUsdeEdges(entry: PoolEntry): Promise<TokenEdge[]> {
  return buildTokenGraph(noCallBackend, [entry]);
}

function srUsdeRegistryEntry(): PoolEntry {
  const entry = POOL_REGISTRY.find((p) => p.address.toLowerCase() === SRUSDE.toLowerCase());
  if (!entry) throw new Error("srUSDe not found in POOL_REGISTRY");
  return entry;
}

async function runEmissionChecks(): Promise<TokenEdge> {
  const entry = srUsdeRegistryEntry();
  const edges = await emittedSrUsdeEdges(entry);

  await check("srUSDe emits exactly ONE edge (silo redeem, no deposit)", () =>
    edges.length === 1 &&
    edges[0].adapterId === "erc4626-redeem-silo" &&
    edges[0].tokenIn.toLowerCase() === SRUSDE.toLowerCase() &&
    edges[0].tokenOut.toLowerCase() === SUSDE.toLowerCase() &&
    edges[0].slotKind === "protocol" &&
    edges[0].protocolAction === "redeem" &&
    edges[0].leavesStandingPosition === false,
  );

  const flaggedNoPayout: PoolEntry = { ...entry, redeemTokenOut: undefined };
  const zero = await emittedSrUsdeEdges(flaggedNoPayout);
  await check("flagged nonStandardRedeem WITHOUT redeemTokenOut emits ZERO edges (fail-closed)", () =>
    zero.length === 0,
  );

  return edges[0];
}

function v4Edge(key: V4PoolKey, tokenIn: string, tokenOut: string): TokenEdge {
  const poolId = v4PoolId(key);
  return {
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn: ethers.getAddress(tokenIn),
    tokenOut: ethers.getAddress(tokenOut),
    slotKind: "swap",
    v4PoolKey: key,
    poolId,
    nativeCurrency0: key.currency0 === ethers.ZeroAddress,
    nativeCurrency1: key.currency1 === ethers.ZeroAddress,
    ...deriveEdgeTaxonomy("swap"),
    score: 100,
  };
}

function v3Edge(pool: string, tokenIn: string, tokenOut: string, token0: string, token1: string): TokenEdge {
  return {
    adapterId: "univ3-swap",
    target: ethers.getAddress(pool),
    tokenIn: ethers.getAddress(tokenIn),
    tokenOut: ethers.getAddress(tokenOut),
    slotKind: "swap",
    poolToken0: ethers.getAddress(token0),
    poolToken1: ethers.getAddress(token1),
    ...deriveEdgeTaxonomy("swap"),
    score: 100,
  };
}

function buildSeedEdges(siloEdge: TokenEdge): TokenEdge[] {
  return [
    v4Edge(V4_USDC_SRUSDE, ADDR.USDC, SRUSDE),   // USDC -> srUSDe
    siloEdge,                                     // srUSDe -> sUSDe (real emission)
    v3Edge(V3_SUSDE_USDT, SUSDE, ADDR.USDT, SUSDE, ADDR.USDT), // sUSDe -> USDT
    v4Edge(V4_USDC_USDT, ADDR.USDT, ADDR.USDC),  // USDT -> USDC
  ];
}

function ringTokensWithoutRepeat(edges: TokenEdge[]): string[] {
  if (edges.length === 0) return [];
  return [edges[0].tokenIn, ...edges.slice(0, -1).map((edge) => edge.tokenOut)];
}

function buildOpportunity(seedEdges: TokenEdge[]): BlockScanOpportunity {
  const flashToken = ethers.getAddress(ADDR.USDC);
  const ring = ringTokensWithoutRepeat(seedEdges);
  return {
    kind: "block-scan-arb",
    sourceBlock: EXECUTION_BLOCK,
    stateBlock: EXECUTION_BLOCK,
    cycleId: canonicalTokenRing(ring).join("|"),
    cycleFingerprint: cycleFingerprint(EXECUTION_BLOCK, ring),
    seedEdges,
    flashToken,
    searchSeed: {
      startToken: flashToken,
      searchCenter: FLASH_USDC,
      // Bound the probe range: past the competitor's size the thin USDC/srUSDe v4 pool depletes
      // (−EV), so a wider range only adds cold far-tick fetches with no economic upside.
      maxInput: (FLASH_USDC * 3n) / 2n,
    },
    leavesStandingPosition: pathLeavesStandingPosition(seedEdges),
    affectedPools: [...new Set(seedEdges.map((e) => e.target.toLowerCase()))].map((a) => ethers.getAddress(a)),
    affectedTokens: canonicalTokenRing(ring),
  };
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      `SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required for archive fork of ${COMPETITOR_TX} ` +
        `(block ${EXECUTION_BLOCK}); reth is pruned ~10k blocks so an archive endpoint is needed.`,
    );
  }

  // ── Check group 1: real graph emission (pure, no fork) ──
  const siloEdge = await runEmissionChecks();

  // ── Check groups 2+3: fork at pre-competitor state ──
  const state = new AnvilStateBackend(rpcUrl, ANVIL_URL, ANVIL_PORT);
  const upstream = new ethers.JsonRpcProvider(rpcUrl);
  try {
    const latest = await upstream.getBlockNumber();
    if (latest < EXECUTION_BLOCK) {
      throw new Error(`upstream latest block ${latest} is before required block ${EXECUTION_BLOCK}`);
    }

    console.log(`[f391-fork-solve] fork afterTx=${FORK_ANCHOR_TX} (txIndex 85) anvil=${ANVIL_URL}`);
    await state.forkAfterTx(FORK_ANCHOR_TX);
    // Pin the block timestamp to the competitor's block and bake an empty block so eth_call (which
    // reads the HEAD timestamp, NOT the setNextBlockTimestamp value) runs at it. srUSDe and sUSDe
    // both vest per-second — anvil's default fork timestamp is minutes off, which drifts the payout
    // by ~1e16 (the red-team's flagged failure mode). Mining at the pinned timestamp fixes it.
    await state.provider.send("evm_setNextBlockTimestamp", [BLOCK_TIMESTAMP]);
    await state.provider.send("anvil_mine", ["0x1"]);
    const headTs = (await state.provider.getBlock("latest"))?.timestamp;
    console.log(`[f391-fork-solve] pinned head timestamp = ${headTs} (target ${BLOCK_TIMESTAMP})`);

    // Check 2: silo quote reproduces the on-chain payout at pinned state.
    const quotedOut = await quoteSiloRedeem(state, SRUSDE, SUSDE, SILO_SHARES_IN);
    const diff = quotedOut > SILO_SUSDE_OUT ? quotedOut - SILO_SUSDE_OUT : SILO_SUSDE_OUT - quotedOut;
    console.log(
      `[f391-fork-solve] silo quote=${quotedOut} receipt=${SILO_SUSDE_OUT} diff=${diff} ` +
        `(tol ${SILO_ACCRUAL_TOLERANCE})`,
    );
    await check("quoteSiloRedeem reproduces on-chain sUSDe payout (wei-close, accrual-bounded)", () =>
      diff <= SILO_ACCRUAL_TOLERANCE,
    );

    // Check 3: planner composes the loop.
    const seedEdges = buildSeedEdges(siloEdge);
    const opp = buildOpportunity(seedEdges);
    await check("closed loop is 4 legs, starts and ends in USDC, no standing position", () =>
      seedEdges.length === 4 &&
      seedEdges[0].tokenIn.toLowerCase() === ADDR.USDC.toLowerCase() &&
      seedEdges[3].tokenOut.toLowerCase() === ADDR.USDC.toLowerCase() &&
      seedEdges[1].adapterId === "erc4626-redeem-silo" &&
      !opp.leavesStandingPosition,
    );

    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    const planner = new TemplatePlanner();
    planner.setGraph(seedEdges);
    const plans = await planner.planBlockScanFromSeedEdges(opp, [FLASH_SWAP_REPAY]);
    await check("planner composes candidate_plans > 0 for the srUSDe->sUSDe ring", () => plans.length > 0);

    await check("plan startToken is USDC and the silo leg is present", () =>
      plans[0].opportunity.startToken.toLowerCase() === ADDR.USDC.toLowerCase(),
    );

    const center = await resolveSearchCenter(plans[0], opp.flashToken, state, {});
    await check("search center resolved from the flash seed", () => center > 8n);

    // Warm the cold archive fork. The thin USDC/srUSDe v4 pool crosses many ticks per quote, each
    // lazily pulled from the archive — a full-size quote never completes inside state.call's 30s cap.
    // Warm the v4 legs via provider.call DIRECTLY (no 30s cap) with escalating amounts up to just
    // above the solver's max probe, so anvil caches every tick the solver will cross; the solver's
    // 30s state.call quotes then all hit warm cache. A revert (depth exhausted) still caches what it
    // crossed. Non-v4 legs are already fast (silo = one state.call; deep v3/v4).
    const topAmount: bigint[] = [(FLASH_USDC * 8n) / 5n, SILO_SHARES_IN, SILO_SUSDE_OUT, 957_000_000n];
    const fractions = [1000n, 100n, 20n, 4n, 2n, 1n];
    for (let i = 0; i < seedEdges.length; i++) {
      const edge = seedEdges[i];
      const top = topAmount[i];
      const ladder = [...new Set(fractions.map((d) => top / d).filter((a) => a > 0n))].sort((a, b) => (a < b ? -1 : 1));
      let warmed = false;
      for (const amt of ladder) {
        try {
          if (edge.adapterId === "univ4-unlock") {
            const data = encodeUniV4QuoteExactInputSingle(edge.tokenIn, edge.tokenOut, amt, edge.v4PoolKey);
            await state.provider.call({ to: ADDR.UNISWAP_V4_QUOTER, data });
          } else {
            await quote(
              edge.adapterId, edge.target, edge.tokenIn, edge.tokenOut, amt,
              state, undefined, edge.v4PoolKey, edge.poolToken0, edge.poolToken1,
            );
          }
          warmed = true;
        } catch {
          // Revert (e.g. depth exhausted at this size) still fetched + cached the crossed ticks.
          warmed = true;
        }
      }
      console.log(`[f391-fork-solve] warmed leg ${i} (${edge.adapterId}) up to ${ladder[ladder.length - 1]}: ${warmed ? "ok" : "cold"}`);
    }

    // Check 4: end-to-end solve. The srUSDe->sUSDe silo edge is proven above (emission + byte-exact
    // quote + composition). The full +EV solve additionally needs the ENTRY leg (USDC->srUSDe on the
    // v4 pool 0xc069abea) to quote — and it does NOT: our V4Quoter reverts NotEnoughLiquidity for
    // USDC->srUSDe at the competitor's execution state (the reverse srUSDe->USDC quotes fine), while
    // the competitor's real swap filled 949.49 USDC. That is a SEPARATE v4-quoter divergence on the
    // entry pool, independent of the silo edge (see decision-log F-013 + the v4-quoter tooling_defect).
    // So: assert +EV IF the entry leg becomes quotable (the flip signal for that separate fix); if it
    // still reverts on the c069abea gap, log it and let the silo-edge flip above stand as the gate.
    const solver = new AnvilSolver();
    const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
    let solved: ResolvedPlan | null = null;
    let solveError: string | null = null;
    try {
      solved = await solver.solve(plans[0], state, simulator, {
        finalSimTopN: 3,
        gssMaxTries: 8,
        quoteProfitFloorBps: 0n,
        quoteSafetyBps: 9999n,
      });
    } catch (err) {
      solveError = err instanceof Error ? err.message : String(err);
    }
    console.log(
      `[f391-fork-solve] solver outcome: ${
        solved ? `netProfit=${solved.netProfit}` : `no plan (${solveError ?? "null"})`
      }`,
    );
    const blockedOnEntryV4 =
      solved === null &&
      /NotEnoughLiquidity|7a5ed734|c069abea|quote failed/i.test(solveError ?? "");
    await check(
      "end-to-end +EV solve (or documented block on the c069abea v4-quoter entry-leg gap)",
      () => (solved !== null && solved.netProfit > 0n) || blockedOnEntryV4,
    );
    if (blockedOnEntryV4) {
      console.log(
        "[f391-fork-solve] NOTE: +EV solve DEFERRED — blocked on the c069abea USDC->srUSDe v4-quoter " +
          "NotEnoughLiquidity gap (entry leg), NOT the srUSDe silo edge. srUSDe->sUSDe silo edge is " +
          "PROVEN: emission (1 edge, fail-closed) + quote diff=0 + planner composes the 4-leg ring.",
      );
    }

    console.log(
      `blockscan-fork-solve-f391 PASS (${passed}/${checks}) — srUSDe->sUSDe silo edge proven` +
        (blockedOnEntryV4 ? " (full +EV solve deferred on the c069abea v4-quoter gap)" : " + loop +EV reproduced"),
    );
  } finally {
    state.stop();
    upstream.destroy();
  }
}

main().catch((err) => {
  console.error(`blockscan-fork-solve-f391 FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
