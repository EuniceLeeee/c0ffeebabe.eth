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
      kind: "backrun-arb",
      startToken: weth,
      profitToken: weth,
      victimAmountIn: 35_000_000n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool,
          tokenIn: usdc,
          tokenOut: weth,
          amountIn: 35_000_000n,
          matchedAdapterId: "univ3-swap",
        },
      },
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

// Regression: an unbounded flash-swap-repay plan still needs a path-aware
// center. The victim amount is denominated in the final route token, not the
// flash token, so using it directly can collapse an earlier hop to zero.
async function testUnboundedReverseImpactCenter(): Promise<void> {
  const weth = "0x00000000000000000000000000000000000000a1";
  const ftx = "0x00000000000000000000000000000000000000a2";
  const kel = "0x00000000000000000000000000000000000000a3";
  const cel = "0x00000000000000000000000000000000000000a4";
  const pools = [1, 2, 3, 4].map((n) => `0x${n.toString(16).padStart(40, "0")}`);

  const plan = {
    opportunity: {
      kind: "backrun-arb",
      startToken: weth,
      profitToken: weth,
      victimAmountIn: 20n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool: pools[3],
          tokenIn: weth,
          tokenOut: cel,
          amountIn: 20n,
          matchedAdapterId: "univ2-swap",
        },
      },
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: pools[0], tokenIn: weth, tokenOut: ftx },
        { adapterId: "univ2-swap", target: pools[1], tokenIn: ftx, tokenOut: kel },
        { adapterId: "univ3-swap", target: pools[2], tokenIn: kel, tokenOut: cel },
        { adapterId: "univ2-swap", target: pools[3], tokenIn: cel, tokenOut: weth },
      ],
    },
    flashAdapterId: "univ2-flash",
  } as unknown as CandidatePlan;

  const center = await resolveSearchCenter(plan, weth, {} as StateBackend, {
    quoteSource: {
      quote: async (req) => {
        if (req.target === pools[3] && req.tokenIn === weth && req.tokenOut === cel) {
          return { amountOut: 1000n, latencyMs: 0 };
        }
        const multiplier = req.target === pools[0] ? 2n : req.target === pools[1] ? 3n : 5n;
        return { amountOut: req.amountIn * multiplier, latencyMs: 0 };
      },
    },
  });

  assert(center === 34n, `unbounded reverse center: expected 34, got ${center}`);
  console.log("[amtsearch] unbounded reverse-impact center: PASS");
}

async function testCrossDecimalReverseImpactCenter(): Promise<void> {
  const weth = "0x00000000000000000000000000000000000000b1";
  const usdc = "0x00000000000000000000000000000000000000b2";
  const firstPool = "0x0000000000000000000000000000000000000011";
  const impactPool = "0x0000000000000000000000000000000000000012";
  let prefixQuotes = 0;

  const plan = {
    opportunity: {
      kind: "backrun-arb",
      startToken: weth,
      profitToken: weth,
      victimAmountIn: 100_000_000_000_000_000n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool: impactPool,
          tokenIn: weth,
          tokenOut: usdc,
          amountIn: 100_000_000_000_000_000n,
          matchedAdapterId: "univ2-swap",
        },
      },
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: firstPool, tokenIn: weth, tokenOut: usdc },
        { adapterId: "univ2-swap", target: impactPool, tokenIn: usdc, tokenOut: weth },
      ],
    },
    flashAdapterId: "morpho-flash",
  } as unknown as CandidatePlan;

  const center = await resolveSearchCenter(plan, weth, {} as StateBackend, {
    quoteSource: {
      quote: async (req) => {
        if (req.target === impactPool && req.tokenIn === weth && req.tokenOut === usdc) {
          return { amountOut: 2_000_000n, latencyMs: 0 };
        }
        prefixQuotes++;
        return { amountOut: req.amountIn / 1_000_000_000_000n, latencyMs: 0 };
      },
    },
  });

  assert(center >= 2_000_000_000_000_000_000n, `cross-decimal center too small: ${center}`);
  assert(center < 2_001_000_000_000_000_000n, `cross-decimal center too large: ${center}`);
  assert(prefixQuotes > 0 && prefixQuotes < 24, `cross-decimal prefix quotes: ${prefixQuotes}`);
  console.log("[amtsearch] cross-decimal reverse-impact center: PASS");
}

async function testMinimalNonZeroReverseImpactCenter(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000d1";
  const tokenB = "0x00000000000000000000000000000000000000d2";
  const prefixPool = "0x0000000000000000000000000000000000000031";
  const impactPool = "0x0000000000000000000000000000000000000032";
  const plan = {
    opportunity: {
      kind: "backrun-arb",
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool: impactPool,
          tokenIn: tokenA,
          tokenOut: tokenB,
          amountIn: 1n,
          matchedAdapterId: "univ2-swap",
        },
      },
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: prefixPool, tokenIn: tokenA, tokenOut: tokenB },
        { adapterId: "univ2-swap", target: impactPool, tokenIn: tokenB, tokenOut: tokenA },
      ],
    },
    flashAdapterId: "morpho-flash",
  } as unknown as CandidatePlan;

  const center = await resolveSearchCenter(plan, tokenA, {} as StateBackend, {
    quoteSource: {
      quote: async (req) => ({
        amountOut: req.target === impactPool && req.tokenIn === tokenA
          ? 1n
          : req.amountIn / 1_000_000_000_000n,
        latencyMs: 0,
      }),
    },
  });

  assert(center >= 1_000_000_000_000n, `minimal nonzero center too small: ${center}`);
  assert(center < 2_000_000_000_000n, `minimal nonzero center too large: ${center}`);
  console.log("[amtsearch] minimal nonzero reverse-impact center: PASS");
}

async function testBoundedCenterFallsBackToCap(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000e1";
  const tokenB = "0x00000000000000000000000000000000000000e2";
  const prefixPool = "0x0000000000000000000000000000000000000041";
  const impactPool = "0x0000000000000000000000000000000000000042";
  const plan = {
    opportunity: {
      kind: "backrun-arb",
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool: impactPool,
          tokenIn: tokenA,
          tokenOut: tokenB,
          amountIn: 1n,
          matchedAdapterId: "univ2-swap",
        },
      },
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: prefixPool, tokenIn: tokenA, tokenOut: tokenB },
        { adapterId: "univ2-swap", target: impactPool, tokenIn: tokenB, tokenOut: tokenA },
      ],
    },
    flashAdapterId: "morpho-flash",
    maxFlashAmount: 100n,
  } as unknown as CandidatePlan;

  const center = await resolveSearchCenter(plan, tokenA, {} as StateBackend, {
    quoteSource: {
      quote: async (req) => ({
        amountOut: req.target === impactPool && req.tokenIn === tokenA ? 1000n : req.amountIn,
        latencyMs: 0,
      }),
    },
  });

  assert(center === 100n, `bounded reverse-impact center: ${center}`);
  console.log("[amtsearch] bounded reverse-impact center uses cap: PASS");
}

async function testMinimalNonZeroCenterFindsProfit(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000e3";
  const tokenB = "0x00000000000000000000000000000000000000e4";
  const prefixPool = "0x0000000000000000000000000000000000000043";
  const impactPool = "0x0000000000000000000000000000000000000044";
  const plan: CandidatePlan = {
    templateName: "flash-swap-repay",
    root: {} as CandidatePlan["root"],
    opportunity: {
      kind: "backrun-arb",
      victimTxHash: "0xminimal-nonzero",
      blockNumber: 1,
      affectedPools: [impactPool],
      affectedTokens: [tokenA, tokenB],
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool: impactPool,
          tokenIn: tokenA,
          tokenOut: tokenB,
          amountIn: 1n,
          matchedAdapterId: "univ2-swap",
        },
      },
      targetNetProfit: 1n,
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: prefixPool, tokenIn: tokenA, tokenOut: tokenB, slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
        { adapterId: "univ2-swap", target: impactPool, tokenIn: tokenB, tokenOut: tokenA, slotKind: "swap", ...deriveEdgeTaxonomy("swap") },
      ],
    },
    flashAdapterIds: ["morpho-flash"],
    flashAdapterId: "morpho-flash",
  };

  let simulatedAmount = 0n;
  const result = await new AnvilSolver().solve(
    plan,
    {} as StateBackend,
    {
      executor: "0x00000000000000000000000000000000000000ee",
      simulate: async (resolved) => {
        simulatedAmount = resolved.flashAmount;
        return { success: true, netProfit: 1n };
      },
    },
    {
      finalSimTopN: 1,
      quoteSafetyBps: 10000n,
      quoteSource: {
        quote: async (req) => {
          if (req.target === impactPool && req.tokenIn === tokenA) {
            return { amountOut: 1n, latencyMs: 0 };
          }
          if (req.target === prefixPool) {
            return { amountOut: req.amountIn / 1_000_000_000_000n, latencyMs: 0 };
          }
          return {
            amountOut: req.amountIn === 1n ? 1_500_000_000_000n : req.amountIn,
            latencyMs: 0,
          };
        },
      },
    },
  );

  assert(simulatedAmount >= 1_000_000_000_000n, `minimal nonzero solve amount too small: ${simulatedAmount}`);
  assert(simulatedAmount < 2_000_000_000_000n, `minimal nonzero solve amount too large: ${simulatedAmount}`);
  assert(result.flashAmount === simulatedAmount, "minimal nonzero solver returned a different amount");
  console.log("[amtsearch] minimal nonzero center reaches profitable solver point: PASS");
}

async function testReverseImpactDeadlineBetweenPrefixHops(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000f1";
  const tokenB = "0x00000000000000000000000000000000000000f2";
  const tokenC = "0x00000000000000000000000000000000000000f3";
  const pools = [0x51, 0x52, 0x53].map((n) => `0x${n.toString(16).padStart(40, "0")}`);
  let stop = false;
  let secondPrefixQuotes = 0;
  const plan = {
    opportunity: {
      kind: "backrun-arb",
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool: pools[2],
          tokenIn: tokenA,
          tokenOut: tokenC,
          amountIn: 1n,
          matchedAdapterId: "univ2-swap",
        },
      },
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "univ2-swap", target: pools[0], tokenIn: tokenA, tokenOut: tokenB },
        { adapterId: "univ2-swap", target: pools[1], tokenIn: tokenB, tokenOut: tokenC },
        { adapterId: "univ2-swap", target: pools[2], tokenIn: tokenC, tokenOut: tokenA },
      ],
    },
    flashAdapterId: "morpho-flash",
  } as unknown as CandidatePlan;

  let message = "";
  try {
    await resolveSearchCenter(plan, tokenA, {} as StateBackend, {
      shouldStop: () => stop,
      quoteSource: {
        quote: async (req) => {
          if (req.target === pools[2] && req.tokenIn === tokenA) return { amountOut: 10n, latencyMs: 0 };
          if (req.target === pools[0]) {
            stop = true;
            return { amountOut: req.amountIn, latencyMs: 0 };
          }
          secondPrefixQuotes++;
          return { amountOut: req.amountIn, latencyMs: 0 };
        },
      },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message.includes("deadline reached"), `deadline propagation message: ${message}`);
  assert(secondPrefixQuotes === 0, `deadline quoted later prefix hops: ${secondPrefixQuotes}`);
  console.log("[amtsearch] reverse-impact deadline between prefix hops: PASS");
}

async function testParameterizedPrefixKeepsDebtSearch(): Promise<void> {
  const weth = "0x00000000000000000000000000000000000000c1";
  const debt = "0x00000000000000000000000000000000000000c2";
  const vault = "0x0000000000000000000000000000000000000021";
  const impactPool = "0x0000000000000000000000000000000000000022";
  let quotes = 0;
  const plan = {
    opportunity: {
      kind: "backrun-arb",
      startToken: weth,
      profitToken: weth,
      victimAmountIn: 123_456n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool: impactPool,
          tokenIn: weth,
          tokenOut: debt,
          amountIn: 123_456n,
          matchedAdapterId: "univ2-swap",
        },
      },
      hints: {},
    },
    tokenPath: {
      edges: [
        { adapterId: "fluid-vault", target: vault, tokenIn: weth, tokenOut: debt },
        { adapterId: "univ2-swap", target: impactPool, tokenIn: debt, tokenOut: weth },
      ],
    },
    flashAdapterId: "morpho-flash",
  } as unknown as CandidatePlan;

  const center = await resolveSearchCenter(plan, weth, {} as StateBackend, {
    quoteSource: {
      quote: async () => {
        quotes++;
        throw new Error("parameterized prefix must be left to the debt-bps search");
      },
    },
  });

  assert(center === 123_456n, `parameterized prefix center: ${center}`);
  assert(quotes === 0, `parameterized prefix unexpectedly quoted ${quotes} times`);
  console.log("[amtsearch] parameterized prefix fallback: PASS");
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
      victimEffect: {
        kind: "swap",
        impact: {
          pool: pool1,
          tokenIn: tokenA,
          tokenOut: tokenB,
          amountIn: 1000n,
          matchedAdapterId: "univ2-swap",
        },
      },
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
      victimEffect: {
        kind: "swap",
        impact: {
          pool,
          tokenIn: tokenA,
          tokenOut: tokenB,
          amountIn: 1000n,
          matchedAdapterId: "univ2-swap",
        },
      },
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
  await testUnboundedReverseImpactCenter();
  await testCrossDecimalReverseImpactCenter();
  await testMinimalNonZeroReverseImpactCenter();
  await testBoundedCenterFallsBackToCap();
  await testMinimalNonZeroCenterFindsProfit();
  await testReverseImpactDeadlineBetweenPrefixHops();
  await testParameterizedPrefixKeepsDebtSearch();
  await testDefaultSafetyHasNoHaircut();
  await testSolverUsesUnifiedDefaultSafety();
  await testQuoteProfitFloorAdmitsNearMiss();
  console.log("amount-search PASS (16/16)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
