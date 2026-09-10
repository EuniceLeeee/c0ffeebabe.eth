import assert from "node:assert/strict";
import { test } from "node:test";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { resolveBlockScanSolverSearchConfig } from
  "../blockscan-solver-search-config.js";
import { AnvilSolver, type SolveOptions, type SolverTiming } from "../solver/solver.js";
import { EXECUTOR, makePlans, sharedSession } from "./blockscan-solver-quote-concurrency.js";

interface SearchCase {
  center?: bigint;
  cap?: bigint;
  lane?: "blockscan" | "swap" | "oracle";
  amountGrid?: SolveOptions["blockScanAmountGrid"];
  halfWidth?: number;
  profit?: bigint;
}

// Exercise the real Solver with issued exact handles and poisoned state I/O.
// Zero-profit quotes expose only the coarse grid, without GSS or final sim.
async function observeSearch(input: SearchCase = {}) {
  const center = input.center ?? 10n;
  const profit = input.profit ?? 0n;
  const plan = makePlans(1)[0]!;
  assert.equal(plan.opportunity.kind, "block-scan-arb");
  if (plan.opportunity.kind !== "block-scan-arb") throw new Error("invalid fixture");
  plan.opportunity.searchSeed.searchCenter = center;
  plan.maxFlashAmount = input.cap;
  if (input.lane === "swap" || input.lane === "oracle") {
    const first = plan.tokenPath.edges[0]!;
    plan.opportunity = {
      kind: "backrun-arb", victimTxHash: `0x${"11".repeat(32)}`, blockNumber: 1,
      affectedPools: [], affectedTokens: [], hints: {},
      startToken: first.tokenIn, profitToken: first.tokenIn, victimAmountIn: center,
      victimEffect: input.lane === "oracle"
        ? { kind: "oracle", descriptorId: "fixture-oracle", priceScope: [],
            affectedEdges: [], priceChanges: [], maxSearchHops: 2 }
        : { kind: "swap", impact: { pool: first.target, tokenIn: first.tokenIn,
            tokenOut: first.tokenOut, amountIn: center, matchedAdapterId: first.adapterId } },
    };
  }
  const amounts: bigint[] = [];
  const simulated: bigint[] = [];
  const timing: SolverTiming = {
    quoteMs: 0, planBuildMs: 0, simMs: 0, amountPoints: 0, gssPoints: 0, hopExactCalls: 0,
  };
  const fixture = sharedSession([plan], {
    async quote(request, leg) {
      if (leg === 0) amounts.push(request.amountIn);
      return leg === 0 ? request.amountIn : request.amountIn + profit;
    },
  });
  const noState = new Proxy({} as StateBackend, {
    get(_target, key) { throw new Error(`unexpected state I/O: ${String(key)}`); },
  });
  const solve = new AnvilSolver().solve(plan, noState, {
    executor: EXECUTOR,
    async simulate(resolved) {
      simulated.push(resolved.flashAmount);
      return { success: true, netProfit: profit };
    },
  }, {
    strictSession: fixture.session,
    blockScanAmountGrid: input.amountGrid,
    gridHalfWidth: input.halfWidth,
    gssMaxTries: 4, finalSimTopN: 1,
    quoteSafetyBps: 10000n, quoteProfitFloorBps: 0n, timing,
  });
  if (input.cap !== undefined && input.cap <= 0n) {
    await assert.rejects(solve, /flash cap is zero/);
    assert.deepEqual(amounts, []);
  } else if (input.lane === "oracle" && input.cap === undefined) {
    await assert.rejects(solve, /oracle victim requires a live flash cap/);
    assert.deepEqual(amounts, []);
  } else if (profit > 0n) {
    const resolved = await solve;
    assert.deepEqual(simulated, [resolved.flashAmount], "final sim must precede success");
    assert.equal(timing.gssPoints, 4, "configured GSS budget must stay unchanged");
  } else {
    await assert.rejects(solve, /quotes completed but no profitable amount/);
    assert.equal(timing.gssPoints, 0, "non-positive quotes must not trigger GSS");
  }
  if (profit <= 0n) assert.deepEqual(simulated, []);
  assert.equal(timing.amountPoints, amounts.length);
  assert.equal(timing.hopExactCalls, amounts.length * 2);
  assert.equal(fixture.stats.calls, timing.hopExactCalls);
  return amounts;
}

test("blockscan defaults to 10/50/100/150 raw units", async () => {
  assert.deepEqual(await observeSearch(), [10n, 50n, 100n, 150n]);
  for (const halfWidth of [0, 2, 16]) {
    assert.deepEqual(await observeSearch({ amountGrid: "multiples", halfWidth }),
      [10n, 50n, 100n, 150n]);
  }
});

test("multiples retain raw bigint precision without token scaling", async () => {
  const center = 9_007_199_254_740_993n;
  assert.deepEqual(await observeSearch({ center }), [
    9_007_199_254_740_993n, 45_035_996_273_704_965n,
    90_071_992_547_409_930n, 135_107_988_821_114_895n,
  ]);
  assert.deepEqual(await observeSearch({ center: 1n }), [1n, 5n, 10n, 15n]);
});

test("multiples use the existing clamp and deduplicate capped amounts", async () => {
  for (const [cap, expected] of [
    [150n, [10n, 50n, 100n, 150n]],
    [100n, [10n, 50n, 100n]],
    [75n, [10n, 50n, 75n]],
    [10n, [10n]],
    [7n, [7n]],
    [1n, [1n]],
  ] as const) {
    assert.deepEqual(await observeSearch({ cap }), expected);
  }
  for (const center of [0n, -10n]) {
    assert.deepEqual(await observeSearch({ center }), [1n, 5n, 10n, 15n]);
  }
  await observeSearch({ cap: 0n });
  await observeSearch({ cap: -1n });
});

test("explicit geometric fallback preserves width, cap and integer dedup", async () => {
  assert.deepEqual(await observeSearch({ amountGrid: "geometric" }),
    [1n, 2n, 5n, 10n, 20n, 40n, 80n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", halfWidth: 2 }),
    [2n, 5n, 10n, 20n, 40n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", halfWidth: 0 }), [10n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", halfWidth: 2, cap: 12n }),
    [2n, 5n, 10n, 12n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", center: 3n, cap: 2n }), [1n, 2n]);
});

test("blockscan grid option does not alter swap backrun or oracle searches", async () => {
  for (const amountGrid of [undefined, "multiples", "geometric"] as const) {
    assert.deepEqual(await observeSearch({ lane: "swap", amountGrid }),
      [1n, 2n, 5n, 10n, 20n, 40n, 80n]);
    assert.deepEqual(await observeSearch({ lane: "swap", amountGrid, halfWidth: 2, cap: 12n }),
      [2n, 5n, 10n, 12n]);
    assert.deepEqual(await observeSearch({ lane: "oracle", amountGrid, cap: 150n, halfWidth: 0 }),
      [150n, 75n, 37n, 18n, 9n, 4n, 2n, 1n]);
    await observeSearch({ lane: "oracle", amountGrid });
  }
});

test("multiples retain GSS bracket, evaluation budget and mandatory final sim", async () => {
  assert.deepEqual(await observeSearch({ profit: 1n }),
    [10n, 50n, 100n, 150n, 11n, 14n, 9n, 8n]);
});

for (const mode of ["caller abort", "deadline"] as const) {
  test(`multiples stop never-settling quotes on ${mode}`, { timeout: 2000 }, async () => {
    const plan = makePlans(1)[0]!;
    const controller = new AbortController();
    let calls = 0;
    let builds = 0;
    let sims = 0;
    const fixture = sharedSession([plan], {
      onBuild() { builds++; },
      async quote() {
        calls++;
        if (mode === "caller abort") queueMicrotask(() => controller.abort());
        return new Promise<bigint>(() => undefined);
      },
    });
    const noState = {
      async call() { throw new Error("unexpected state I/O"); },
    } as unknown as StateBackend;
    await assert.rejects(new AnvilSolver().solve(plan, noState, {
      executor: EXECUTOR,
      async simulate() { sims++; return { success: true, netProfit: 1n }; },
    }, {
      strictSession: fixture.session,
      signal: controller.signal,
      ...(mode === "deadline" ? { deadlineMs: 25 } : {}),
      quoteSafetyBps: 10000n, quoteProfitFloorBps: 0n,
    }), mode === "caller abort" ? /aborted by caller/ : /deadline reached/);
    assert.ok(calls > 0 && calls <= 4, "only the coarse multiples may be issued");
    const stoppedCalls = calls;
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(calls, stoppedCalls, "cancelled solver must not issue more quotes");
    assert.equal(builds, 0);
    assert.equal(sims, 0);
  });
}

test("config defaults to multiples and accepts only the two exact mode names", () => {
  const defaults = resolveBlockScanSolverSearchConfig({});
  assert.deepEqual(defaults, {
    amountGrid: "multiples", gridHalfWidth: 2, gssMaxTries: 4, quoteConcurrency: 16,
  });
  assert.equal(Object.isFrozen(defaults), true);
  for (const amountGrid of ["multiples", "geometric"] as const) {
    assert.equal(resolveBlockScanSolverSearchConfig({
      SEARCHER_BLOCKSCAN_SOLVER_AMOUNT_GRID: amountGrid,
    }).amountGrid, amountGrid);
  }
  for (const raw of ["", "MULTIPLES", "Geometric", " multiples", "geometric ", "constant9", "0"]) {
    assert.throws(() => resolveBlockScanSolverSearchConfig({
      SEARCHER_BLOCKSCAN_SOLVER_AMOUNT_GRID: raw,
    }), /SEARCHER_BLOCKSCAN_SOLVER_AMOUNT_GRID must be multiples or geometric/);
  }
});
