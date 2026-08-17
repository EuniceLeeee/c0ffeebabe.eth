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
import type {
  StateBackend,
} from "../../shared/state/state-backend.js";
import type { CandidatePlan } from "../planner/planner.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  BlockScanFamilyAttributedError,
} from "../detector/blockscan-family-budget.js";

const TEST_EXECUTOR = "0x00000000000000000000000000000000000000ee";

interface TestExactRequest {
  readonly adapterId: string;
  readonly target: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
}

function testStrictSession(
  plan: CandidatePlan,
  quote: (request: TestExactRequest) => Promise<bigint>,
  options: TestStrictSessionOptions = {},
): StrictProductionRuntimeSession {
  const pathEdges = [...(plan.tokenPath?.edges ?? [])];
  const victimEffect = plan.opportunity.kind === "backrun-arb"
    ? plan.opportunity.victimEffect
    : undefined;
  if (victimEffect?.kind === "swap") {
    const impact = victimEffect.impact;
    pathEdges.push({
      adapterId: impact.matchedAdapterId,
      target: impact.pool,
      tokenIn: impact.tokenIn,
      tokenOut: impact.tokenOut,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      ...(impact.poolId === undefined ? {} : { poolId: impact.poolId }),
    });
  }
  return testStrictSessionForEdges(pathEdges, quote, options);
}

interface TestStrictSessionOptions {
  readonly blocksPrefixInversion?: (edge: TokenEdge) => boolean;
  readonly buildFundingRoot?: (
    input: Parameters<StrictProductionRuntimeSession["buildFundingRoot"]>[0],
  ) => unknown;
}

function testStrictSessionForEdges(
  edges: readonly TokenEdge[],
  quote: (request: TestExactRequest) => Promise<bigint>,
  options: TestStrictSessionOptions = {},
): StrictProductionRuntimeSession {
  type ExactInput = Parameters<StrictProductionRuntimeSession["issueExact"]>[0];
  type ExactHandle = Awaited<ReturnType<StrictProductionRuntimeSession["issueExact"]>>;
  const issued = new WeakMap<object, ExactInput>();
  return Object.freeze({
    edges: Object.freeze([...edges]),
    blocksPrefixInversion: (edge: TokenEdge) =>
      options.blocksPrefixInversion?.(edge) ?? false,
    creditDebtBpsCandidates: () => Object.freeze([0n]),
    fundingActionIds: () => Object.freeze(["morpho-flash"]),
    async issueExact(input: ExactInput): Promise<ExactHandle> {
      const amountOut = await quote({
        adapterId: input.edge.adapterId,
        target: input.edge.target,
        tokenIn: input.edge.tokenIn,
        tokenOut: input.edge.tokenOut,
        amountIn: input.amountIn,
      });
      const handle = Object.freeze({ amountOut }) as ExactHandle;
      issued.set(handle as object, input);
      return handle;
    },
    buildExecution(input: Parameters<StrictProductionRuntimeSession["buildExecution"]>[0]) {
      const exact = issued.get(input.exact as object);
      if (exact === undefined || exact.edge !== input.edge) {
        throw new Error("test strict session rejected a foreign exact handle");
      }
      return Object.freeze({
        status: "resolved" as const,
        fragment: Object.freeze({
          requirements: Object.freeze([]),
          nodes: Object.freeze([Object.freeze({
            adapterId: input.edge.adapterId,
            target: input.edge.target,
            tokenIn: input.edge.tokenIn,
            tokenOut: input.edge.tokenOut,
            amount: exact.amountIn,
            params: Object.freeze({ minAmountOut: input.minAmountOut }),
            children: Object.freeze([]),
          })]),
        }),
      });
    },
    buildFundingRoot(
      input: Parameters<StrictProductionRuntimeSession["buildFundingRoot"]>[0],
    ) {
      if (options.buildFundingRoot !== undefined) {
        return options.buildFundingRoot(input);
      }
      return Object.freeze({
        adapterId: input.actionAdapterId,
        target: input.asset,
        tokenIn: input.asset,
        tokenOut: input.asset,
        amount: input.amount,
        params: Object.freeze({ minProfit: input.minProfit }),
        children: Object.freeze([...input.children]),
      });
    },
  }) as unknown as StrictProductionRuntimeSession;
}

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
    executor: TEST_EXECUTOR,
    strictSession: testStrictSession(plan, async (req) => {
        quoteCalls++;
        assert(req.adapterId === "univ3-swap", `center quote: adapter ${req.adapterId}`);
        assert(req.target === pool, `center quote: target ${req.target}`);
        assert(req.tokenIn === usdc, `center quote: tokenIn ${req.tokenIn}`);
        assert(req.tokenOut === weth, `center quote: tokenOut ${req.tokenOut}`);
        assert(req.amountIn === 35_000_000n, `center quote: amountIn ${req.amountIn}`);
        return quotedWeth;
    }),
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
    executor: TEST_EXECUTOR,
    strictSession: testStrictSession(plan, async (req) => {
        if (req.target === pools[3] && req.tokenIn === weth && req.tokenOut === cel) {
          return 1000n;
        }
        const multiplier = req.target === pools[0] ? 2n : req.target === pools[1] ? 3n : 5n;
        return req.amountIn * multiplier;
    }),
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
    executor: TEST_EXECUTOR,
    strictSession: testStrictSession(plan, async (req) => {
        if (req.target === impactPool && req.tokenIn === weth && req.tokenOut === usdc) {
          return 2_000_000n;
        }
        prefixQuotes++;
        return req.amountIn / 1_000_000_000_000n;
    }),
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
    executor: TEST_EXECUTOR,
    strictSession: testStrictSession(plan, async (req) =>
      req.target === impactPool && req.tokenIn === tokenA
          ? 1n
          : req.amountIn / 1_000_000_000_000n,
    ),
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
    executor: TEST_EXECUTOR,
    strictSession: testStrictSession(
      plan,
      async (req) => req.target === impactPool && req.tokenIn === tokenA
        ? 1000n
        : req.amountIn,
    ),
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
      strictSession: testStrictSession(plan, async (req) => {
          if (req.target === impactPool && req.tokenIn === tokenA) {
            return 1n;
          }
          if (req.target === prefixPool) {
            return req.amountIn / 1_000_000_000_000n;
          }
          return req.amountIn === 1n ? 1_500_000_000_000n : req.amountIn;
      }),
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
      executor: TEST_EXECUTOR,
      strictSession: testStrictSession(plan, async (req) => {
          if (req.target === pools[2] && req.tokenIn === tokenA) return 10n;
          if (req.target === pools[0]) {
            stop = true;
            return req.amountIn;
          }
          secondPrefixQuotes++;
          return req.amountIn;
      }),
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
    executor: TEST_EXECUTOR,
    strictSession: testStrictSession(
      plan,
      async () => {
        quotes++;
        throw new Error("parameterized prefix must be left to the debt-bps search");
      },
      { blocksPrefixInversion: (edge) => edge.adapterId === "fluid-vault" },
    ),
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
      executor: TEST_EXECUTOR,
      strictSession: testStrictSessionForEdges(
        [{
          adapterId: "univ2-swap",
          target: "0x0000000000000000000000000000000000000001",
          tokenIn: tokenA,
          tokenOut: tokenB,
          slotKind: "swap",
          ...deriveEdgeTaxonomy("swap"),
        }],
        async () => 1234n,
      ),
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
        strictSession: testStrictSession(plan, async (req) => req.amountIn * 2n),
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
      strictSession: testStrictSession(plan, async (req) => req.amountIn - 1n),
    },
  );

  assert(simulateCalls === 1, `quote floor: expected 1 sim, got ${simulateCalls}`);
  console.log("[amtsearch] quote profit floor admission: PASS");
}

async function testDeferredPhasePreservesTopNFallbacks(): Promise<void> {
  const tokenA = "0x00000000000000000000000000000000000000c1";
  const tokenB = "0x00000000000000000000000000000000000000c2";
  const pool = "0x00000000000000000000000000000000000000c3";
  const plan: CandidatePlan = {
    templateName: "flash-swap-repay",
    root: {} as CandidatePlan["root"],
    opportunity: {
      kind: "backrun-arb",
      victimTxHash: "0xdeferred-topn",
      blockNumber: 1,
      affectedPools: [pool],
      affectedTokens: [tokenA, tokenB],
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1_000n,
      victimEffect: {
        kind: "swap",
        impact: {
          pool,
          tokenIn: tokenA,
          tokenOut: tokenB,
          amountIn: 1_000n,
          matchedAdapterId: "univ2-swap",
        },
      },
      targetNetProfit: 1n,
      hints: {},
    },
    tokenPath: {
      edges: [{
        adapterId: "univ2-swap",
        target: pool,
        tokenIn: tokenA,
        tokenOut: tokenB,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
      }],
    },
    flashAdapterIds: ["morpho-flash"],
    flashAdapterId: "morpho-flash",
  };
  let simulateCalls = 0;
  let deferred: readonly Awaited<ReturnType<AnvilSolver["solve"]>>[] = [];
  const returned = await new AnvilSolver().solve(
    plan,
    {} as StateBackend,
    {
      executor: "0x00000000000000000000000000000000000000ee",
      simulate: async () => {
        simulateCalls++;
        return { success: false, netProfit: 0n };
      },
    },
    {
      deferPhase2Sim: true,
      finalSimTopN: 3,
      gridHalfWidth: 2,
      gssMaxTries: 3,
      quoteSafetyBps: 10000n,
      strictSession: testStrictSession(plan, async (req) => req.amountIn * 2n),
      onDeferredCandidates: (candidates) => {
        deferred = candidates;
      },
    },
  );

  assert(simulateCalls === 0, "deferred phase must not run final sim");
  assert(deferred.length === 3, `deferred phase must preserve top-3, got ${deferred.length}`);
  assert(
    new Set(deferred.map((candidate) => candidate.flashAmount.toString())).size === 3,
    "deferred phase must preserve distinct fallback amounts",
  );
  assert(returned === deferred[0], "deferred return must retain ranked candidate zero");
  console.log("[amtsearch] deferred phase preserves top-N final-sim fallbacks: PASS");
}

async function testSolverPreservesTypedLegOwner(): Promise<void> {
  const tokenA = "0x0000000000000000000000000000000000000a01";
  const tokenB = "0x0000000000000000000000000000000000000a02";
  const badFamily = "bad-family-edge";
  const plan = {
    templateName: "flash-swap-repay",
    root: {},
    opportunity: {
      kind: "block-scan-arb",
      sourceBlock: 1,
      stateBlock: 1,
      cycleId: "typed-owner",
      cycleFingerprint: "typed-owner",
      seedEdges: [],
      flashToken: tokenA,
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1_024n,
      searchSeed: {
        startToken: tokenA,
        searchCenter: 1_024n,
        maxInput: 1_024n,
      },
      leavesStandingPosition: false,
      hints: {},
      affectedPools: [],
      affectedTokens: [tokenA, tokenB],
    },
    tokenPath: {
      edges: [{
        adapterId: badFamily,
        target: "0x0000000000000000000000000000000000000b01",
        tokenIn: tokenA,
        tokenOut: tokenB,
        slotKind: "swap",
        ...deriveEdgeTaxonomy("swap"),
      }],
    },
    flashAdapterIds: ["morpho-flash"],
    flashAdapterId: "morpho-flash",
  } as unknown as CandidatePlan;
  let caught: unknown;
  try {
    await new AnvilSolver().solve(
      plan,
      {} as StateBackend,
      {
        executor: "0x00000000000000000000000000000000000000ee",
        simulate: async () => ({ success: false, netProfit: 0n }),
      },
      {
        gridHalfWidth: 1,
        gssMaxTries: 1,
        quoteSafetyBps: 10000n,
        strictSession: testStrictSession(plan, async () => {
          throw new Error("typed owner exact failure");
        }),
      },
    );
  } catch (error) {
    caught = error;
  }
  assert(
    caught instanceof BlockScanFamilyAttributedError &&
      caught.familyId === badFamily,
    "solver terminal error must preserve a consistently failing leg owner",
  );
  console.log("[amtsearch] solver preserves typed per-leg family owner: PASS");
}

async function testSolverAbsoluteDeadlineAbortsNeverSettlingStrictExact(): Promise<void> {
  const plan = deadlineRegressionPlan("never-exact");
  const startedAt = Date.now();
  let message = "";
  try {
    await new AnvilSolver().solve(
      plan,
      {
        call: async () => {
          throw new Error("strict exact test unexpectedly touched StateBackend");
        },
      } as unknown as StateBackend,
      {
        executor: "0x00000000000000000000000000000000000000ee",
        simulate: async () => ({ success: false, netProfit: 0n }),
      },
      {
        deadlineAtMs: startedAt + 60,
        gridHalfWidth: 0,
        gssMaxTries: 1,
        quoteSafetyBps: 10000n,
        strictSession: testStrictSession(
          plan,
          async () => await new Promise<bigint>(() => undefined),
        ),
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  const elapsedMs = Date.now() - startedAt;
  assert(/absolute deadline reached/.test(message), `absolute deadline error: ${message}`);
  assert(elapsedMs < 500, `never-settling strict exact held solver for ${elapsedMs}ms`);
  console.log("[amtsearch] absolute deadline aborts never-settling strict exact: PASS");
}

async function testSolverCallerAbortStopsNeverSettlingStrictFundingRoot(): Promise<void> {
  const plan = deadlineRegressionPlan("never-funding-root");
  let quoteCalls = 0;
  let fundingRootStarted = false;
  const strictSession = testStrictSession(
    plan,
    async (request) => {
      quoteCalls++;
      return request.amountIn * 2n;
    },
    {
      buildFundingRoot: () => {
        fundingRootStarted = true;
        return new Promise(() => undefined);
      },
    },
  );

  const controller = new AbortController();
  const abortTimer = setTimeout(
    () => controller.abort(new Error("focused solver cancellation")),
    200,
  );
  const startedAt = Date.now();
  let message = "";
  try {
    await new AnvilSolver().solve(
      plan,
      {
        call: async () => {
          throw new Error("family quote unexpectedly touched state");
        },
      } as unknown as StateBackend,
      {
        executor: "0x00000000000000000000000000000000000000ee",
        simulate: async () => ({ success: false, netProfit: 0n }),
      },
      {
        signal: controller.signal,
        gridHalfWidth: 0,
        gssMaxTries: 1,
        finalSimTopN: 1,
        quoteSafetyBps: 10000n,
        strictSession,
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(abortTimer);
  }

  const elapsedMs = Date.now() - startedAt;
  assert(
    fundingRootStarted,
    `never-settling strict Funding root promise was not reached ` +
      `(quotes=${quoteCalls}, error=${message})`,
  );
  assert(/aborted by caller/.test(message), `caller abort error: ${message}`);
  assert(elapsedMs < 1_000, `never-settling strict Funding root held solver for ${elapsedMs}ms`);
  console.log("[amtsearch] caller abort stops never-settling strict Funding root: PASS");
}

function deadlineRegressionPlan(cycleId: string): CandidatePlan {
  const tokenA = "0x0000000000000000000000000000000000000d01";
  const tokenB = "0x0000000000000000000000000000000000000d02";
  return {
    templateName: "flash-swap-repay",
    root: {} as CandidatePlan["root"],
    opportunity: {
      kind: "block-scan-arb",
      sourceBlock: 1,
      stateBlock: 1,
      cycleId,
      cycleFingerprint: cycleId,
      seedEdges: [],
      flashToken: tokenA,
      startToken: tokenA,
      profitToken: tokenA,
      victimAmountIn: 1_024n,
      searchSeed: {
        startToken: tokenA,
        searchCenter: 1_024n,
        maxInput: 1_024n,
      },
      leavesStandingPosition: false,
      hints: {},
      affectedPools: [],
      affectedTokens: [tokenA, tokenB],
    },
    tokenPath: {
      edges: [
        {
          adapterId: "univ2-swap",
          target: "0x0000000000000000000000000000000000000e01",
          tokenIn: tokenA,
          tokenOut: tokenB,
          slotKind: "swap",
          ...deriveEdgeTaxonomy("swap"),
        },
        {
          adapterId: "univ2-swap",
          target: "0x0000000000000000000000000000000000000e02",
          tokenIn: tokenB,
          tokenOut: tokenA,
          slotKind: "swap",
          ...deriveEdgeTaxonomy("swap"),
        },
      ],
    },
    flashAdapterIds: ["morpho-flash"],
    flashAdapterId: "morpho-flash",
  };
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
  await testDeferredPhasePreservesTopNFallbacks();
  await testSolverPreservesTypedLegOwner();
  await testSolverAbsoluteDeadlineAbortsNeverSettlingStrictExact();
  await testSolverCallerAbortStopsNeverSettlingStrictFundingRoot();
  console.log("amount-search PASS (20/20)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
