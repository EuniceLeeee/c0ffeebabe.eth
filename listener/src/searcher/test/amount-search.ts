/**
 * Deterministic unit tests for the Stage-3a amount search (AC-3a.1 / AC-3a.2).
 * Pure in-memory — no RPC, no anvil. Sub-second.
 *
 *   AC-3a.1  grid victim-anchored geometric + GSS converges in ≤ maxTries evals.
 *   AC-3a.2  bid = profit * bps / 10000, capped below profit, 0 when profit<=0.
 */

import { geometricGrid, goldenSectionMaximize, bidAmount } from "../solver/amount-bounds.js";
import { AnvilSolver, resolveSearchCenter } from "../solver/solver.js";
import { propagateAmounts } from "../solver/amount-propagation.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { CandidatePlan } from "../planner/planner.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// ── AC-3a.1a: victim-anchored geometric grid ─────────────────────
function testGrid(): void {
  const grid = geometricGrid(1000n, 3);
  assert(grid.length === 7, `grid: expected 7 points, got ${grid.length}`);
  assert(grid[0] === 125n, `grid: low end should be v/8=125, got ${grid[0]}`);
  assert(grid.includes(1000n), `grid: must include the center, got ${grid.join(",")}`);
  assert(grid[grid.length - 1] === 8000n, `grid: high end should be v*8=8000, got ${grid[grid.length - 1]}`);
  // NOT an absolute fixed sweep — scales with the center.
  assert(geometricGrid(2000n, 3)[0] === 250n, "grid: must scale with center (victim-anchored)");
  console.log("[amtsearch] AC-3a.1a geometric grid (victim-anchored): PASS");
}

// ── AC-3a.1b: GSS converges to the peak within the eval cap ───────
async function testGss(): Promise<void> {
  // Unimodal concave profit: peak at K, linear falloff. Integer domain.
  const K = 5000n;
  const PEAK = 1_000_000n;
  let calls = 0;
  const evaluate = async (x: bigint): Promise<bigint> => {
    calls++;
    const v = PEAK - abs(x - K);
    return v > 0n ? v : 0n;
  };

  const maxTries = 12;
  const res = await goldenSectionMaximize(125n, 16000n, evaluate, { maxTries });
  assert(res.evals <= maxTries, `gss: evals ${res.evals} exceeded hard cap ${maxTries}`);
  assert(calls === res.evals, `gss: eval count mismatch (${calls} vs ${res.evals})`);
  assert(abs(res.x - K) < 200n, `gss: converged to ${res.x}, expected near ${K}`);
  console.log(`[amtsearch] AC-3a.1b GSS converge: PASS (x=${res.x}, evals=${res.evals})`);
}

// ── AC-3a.1c: grid → GSS integration (mirrors solver usage) ──────
async function testGridThenGss(): Promise<void> {
  const K = 5000n;
  const PEAK = 1_000_000n;
  const evaluate = async (x: bigint): Promise<bigint> => {
    const v = PEAK - abs(x - K);
    return v > 0n ? v : 0n;
  };

  // Stage 1: coarse grid anchored on victim size (≈2000).
  const grid = geometricGrid(2000n, 3); // [250..16000]
  let best = { x: grid[0], value: await evaluate(grid[0]) };
  for (const x of grid.slice(1)) {
    const v = await evaluate(x);
    if (v > best.value) best = { x, value: v };
  }
  // Stage 2: GSS refine around the best grid point.
  const refined = await goldenSectionMaximize(best.x / 2n, best.x * 2n, evaluate, { maxTries: 12 });
  const finalBest = refined.value > best.value ? refined : best;
  assert(abs(finalBest.x - K) < 200n, `grid+gss: converged to ${finalBest.x}, expected near ${K}`);
  console.log(`[amtsearch] AC-3a.1c grid→GSS integration: PASS (x=${finalBest.x})`);
}

// ── AC-3a.3 (unit): GSS honors an external stop signal (deadline) ─
async function testGssShouldStop(): Promise<void> {
  const K = 5000n;
  const PEAK = 1_000_000n;
  let calls = 0;
  // Stop after the 2 upfront evals + 1 loop step: proves the deadline can cut
  // the search short well before maxTries, returning the best seen so far.
  const evaluate = async (x: bigint): Promise<bigint> => {
    calls++;
    const v = PEAK - abs(x - K);
    return v > 0n ? v : 0n;
  };
  const res = await goldenSectionMaximize(125n, 16000n, evaluate, {
    maxTries: 12,
    shouldStop: () => calls >= 3,
  });
  assert(res.evals <= 4, `gss/stop: expected early stop (<=4 evals), got ${res.evals}`);
  assert(calls === res.evals, `gss/stop: eval count mismatch (${calls} vs ${res.evals})`);
  console.log(`[amtsearch] AC-3a.3 GSS shouldStop (deadline): PASS (evals=${res.evals})`);
}

// ── AC-3a.2: bid math ────────────────────────────────────────────
function testBid(): void {
  assert(bidAmount(1000n, 9000n) === 900n, `bid: 1000*0.9 should be 900, got ${bidAmount(1000n, 9000n)}`);
  assert(bidAmount(0n) === 0n, "bid: profit<=0 must bid 0");
  assert(bidAmount(-5n) === 0n, "bid: negative profit must bid 0");
  assert(bidAmount(1000n, 9000n) < 1000n, "bid: must be strictly below profit");
  assert(bidAmount(1000n, 10000n) === 999n, "bid: 100% must be capped to profit-1");
  console.log("[amtsearch] AC-3a.2 bid math: PASS");
}

// ── Regression: victim amount units must be normalized to flash token ─
async function testSearchCenterTokenNormalization(): Promise<void> {
  const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const weth = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const pool = "0x0000000000000000000000000000000000000001";
  const quotedWeth = 17_500_000_000_000_000n;
  let quoteCalls = 0;

  const plan = {
    opportunity: {
      startToken: weth,
      profitToken: weth,
      victimAmountIn: 35_000_000n,
      hints: {
        impact: {
          pool,
          tokenIn: usdc,
          tokenOut: weth,
          matchedAdapterId: "univ3-swap",
        },
      },
    },
  } as unknown as Parameters<typeof resolveSearchCenter>[0];

  const center = await resolveSearchCenter(plan, weth, {} as StateBackend, {
    quoteSource: {
      quote: async (req) => {
        quoteCalls++;
        assert(req.adapterId === "univ3-swap", `center quote: adapter ${req.adapterId}`);
        assert(req.target === pool, `center quote: target ${req.target}`);
        assert(req.tokenIn === usdc, `center quote: tokenIn ${req.tokenIn}`);
        assert(req.tokenOut === weth, `center quote: tokenOut ${req.tokenOut}`);
        assert(req.amountIn === 35_000_000n, `center quote: amountIn ${req.amountIn}`);
        return { amountOut: quotedWeth, latencyMs: 0 };
      },
    },
  });

  assert(quoteCalls === 1, `center quote: expected one call, got ${quoteCalls}`);
  assert(center === quotedWeth, `center quote: expected ${quotedWeth}, got ${center}`);
  console.log("[amtsearch] center token normalization: PASS");
}

// ── Regression: default quote propagation should not haircut execution amounts ─
async function testDefaultSafetyHasNoHaircut(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000aa";
  const tokenB = "0x00000000000000000000000000000000000000bb";
  const amounts = await propagateAmounts(
    {
      edges: [{
        adapterId: "univ2-swap",
        target: "0x0000000000000000000000000000000000000001",
        tokenIn: tokenA,
        tokenOut: tokenB,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
      }],
    },
    1000n,
    {} as StateBackend,
    {
      quoteSource: {
        quote: async () => ({ amountOut: 1234n, latencyMs: 0 }),
      },
    },
  );

  assert(amounts[1] === 1234n, `safety: expected no haircut, got ${amounts[1]}`);
  console.log("[amtsearch] default quote safety no haircut: PASS");
}

// ── Regression: solver should score and build with the same 1bp slack ─
async function testSolverUsesUnifiedDefaultSafety(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000aa";
  const tokenB = "0x00000000000000000000000000000000000000bb";
  const pool1 = "0x0000000000000000000000000000000000000001";
  const pool2 = "0x0000000000000000000000000000000000000002";
  let simulateCalls = 0;
  const previousSafety = process.env.SEARCHER_QUOTE_SAFETY_BPS;
  delete process.env.SEARCHER_QUOTE_SAFETY_BPS;

  const plan: CandidatePlan = {
    templateName: "flash-swap-repay",
    root: {} as CandidatePlan["root"],
    opportunity: {
      kind: "backrun-arb",
      victimTxHash: "0xamountsearch",
      blockNumber: 1,
      affectedPools: [pool1],
      affectedTokens: [tokenA, tokenB],
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1000n,
      targetNetProfit: 1n,
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: pool1, tokenIn: tokenA, tokenOut: tokenB, slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
        { adapterId: "univ2-swap", target: pool2, tokenIn: tokenB, tokenOut: tokenA, slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
      ],
    },
    flashAdapterIds: ["morpho-flash"],
    flashAdapterId: "morpho-flash",
  };

  const solver = new AnvilSolver();
  try {
    await solver.solve(
      plan,
      {} as StateBackend,
      {
        executor: "0x00000000000000000000000000000000000000ee",
        simulate: async (resolved) => {
          simulateCalls++;
          const swaps = resolved.root.children.filter((node) => node.adapterId === "univ2-swap");
          assert(swaps.length === 2, `safety: expected 2 swap nodes, got ${swaps.length}`);
          assert(typeof swaps[0].amount === "bigint", "safety: first swap amount must be resolved");
          assert(typeof swaps[1].amount === "bigint", "safety: second swap amount must be resolved");
          const firstInput = swaps[0].amount as bigint;
          const secondInput = swaps[1].amount as bigint;
          const exactSecondInput = firstInput * 2n;
          const safetySecondInput = (exactSecondInput * 9999n) / 10000n;
          assert(
            secondInput === safetySecondInput,
            `safety: expected ${safetySecondInput}, got ${secondInput}`,
          );
          assert(secondInput < exactSecondInput, "safety: build amounts should include 1bp slack");
          return { success: true, netProfit: 1n };
        },
      },
      {
        gridHalfWidth: 0,
        finalSimTopN: 1,
        gssMaxTries: 3,
        quoteSource: {
          quote: async (req) => ({ amountOut: req.amountIn * 2n, latencyMs: 0 }),
        },
      },
    );
  } finally {
    if (previousSafety === undefined) delete process.env.SEARCHER_QUOTE_SAFETY_BPS;
    else process.env.SEARCHER_QUOTE_SAFETY_BPS = previousSafety;
  }

  assert(simulateCalls === 1, `safety: expected 1 sim, got ${simulateCalls}`);
  console.log("[amtsearch] unified default solver safety: PASS");
}

// ── Diagnostic mode: near-miss quote floor admits candidates to phase-2 sim ─
async function testQuoteProfitFloorAdmitsNearMiss(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000aa";
  const tokenB = "0x00000000000000000000000000000000000000bb";
  const pool = "0x0000000000000000000000000000000000000001";
  let simulateCalls = 0;

  const plan: CandidatePlan = {
    templateName: "flash-swap-repay",
    root: {} as CandidatePlan["root"],
    opportunity: {
      kind: "backrun-arb",
      victimTxHash: "0xamountfloor",
      blockNumber: 1,
      affectedPools: [pool],
      affectedTokens: [tokenA, tokenB],
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1000n,
      targetNetProfit: 1n,
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: pool, tokenIn: tokenA, tokenOut: tokenB, slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
      ],
    },
    flashAdapterIds: ["morpho-flash"],
    flashAdapterId: "morpho-flash",
  };

  const solver = new AnvilSolver();
  await solver.solve(
    plan,
    {} as StateBackend,
    {
      executor: "0x00000000000000000000000000000000000000ee",
      simulate: async () => {
        simulateCalls++;
        return { success: true, netProfit: 1n };
      },
    },
    {
      gridHalfWidth: 0,
      finalSimTopN: 1,
      quoteSafetyBps: 10000n,
      quoteProfitFloorBps: 20n,
      quoteSource: {
        quote: async (req) => ({ amountOut: req.amountIn - 1n, latencyMs: 0 }),
      },
    },
  );

  assert(simulateCalls === 1, `quote floor: expected 1 sim, got ${simulateCalls}`);
  console.log("[amtsearch] quote profit floor admission: PASS");
}

async function main(): Promise<void> {
  testGrid();
  await testGss();
  await testGridThenGss();
  await testGssShouldStop();
  testBid();
  await testSearchCenterTokenNormalization();
  await testDefaultSafetyHasNoHaircut();
  await testSolverUsesUnifiedDefaultSafety();
  await testQuoteProfitFloorAdmitsNearMiss();
  console.log("amount-search PASS (9/9)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
