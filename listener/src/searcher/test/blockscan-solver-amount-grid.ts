import assert from "node:assert/strict";
import { test } from "node:test";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { resolveBlockScanSolverSearchConfig } from
  "../blockscan-solver-search-config.js";
import { AnvilSolver, type SolveOptions, type SolverTiming } from "../solver/solver.js";
import { EXECUTOR, makePlans, sharedSession } from "./blockscan-solver-quote-concurrency.js";
import { BlockScanFamilyAttributedError } from "../detector/blockscan-family-budget.js";

interface SearchCase {
  center?: bigint;
  cap?: bigint;
  lane?: "blockscan" | "swap" | "oracle";
  amountGrid?: SolveOptions["blockScanAmountGrid"];
  halfWidth?: number;
  profit?: bigint;
  floor?: bigint;
  includeGss?: boolean;
}

// Exercise the real Solver with issued exact handles and poisoned state I/O.
// Positive P opens the coarse grid; zero/negative P must stop before it.
async function observeSearch(input: SearchCase = {}) {
  const center = input.center ?? 10n;
  const profit = input.profit ?? 1n;
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
      return leg === 0 ? request.amountIn : request.amountIn +
        ((input.lane ?? "blockscan") === "blockscan" && profit <= 0n && request.amountIn !== center ? 1n : profit);
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
    quoteSafetyBps: 10000n, quoteProfitFloorBps: input.floor ?? 0n, timing,
  });
  if (input.cap !== undefined && input.cap <= 0n) {
    await assert.rejects(solve, /flash cap is zero/);
    assert.deepEqual(amounts, []);
  } else if (input.lane === "oracle" && input.cap === undefined) {
    await assert.rejects(solve, /oracle victim requires a live flash cap/);
    assert.deepEqual(amounts, []);
  } else if ((input.lane ?? "blockscan") === "blockscan" &&
      (center <= 0n || (input.cap !== undefined && center > input.cap))) {
    await assert.rejects(solve, /effective input missing or exceeds flash cap/);
    assert.deepEqual(amounts, []);
  } else if (profit > 0n) {
    const resolved = await solve;
    assert.deepEqual(simulated, [resolved.flashAmount], "final sim must precede success");
    assert.ok(timing.gssPoints >= 2 && timing.gssPoints <= 4, "GSS budget must stay bounded");
  } else {
    await assert.rejects(solve, /quotes completed but no profitable amount/);
    assert.equal(timing.gssPoints, 0, "non-positive quotes must not trigger GSS");
  }
  if (profit <= 0n) assert.deepEqual(simulated, []);
  assert.equal(timing.amountPoints, amounts.length);
  assert.equal(timing.hopExactCalls, amounts.length * 2);
  assert.equal(fixture.stats.calls, timing.hopExactCalls);
  return input.includeGss ? amounts : amounts.slice(0, amounts.length - timing.gssPoints);
}

test("blockscan stops at non-positive P even when larger inputs would be profitable", async () => {
  for (const amountGrid of ["multiples", "geometric"] as const) {
    for (const profit of [-1n, 0n]) {
      assert.deepEqual(await observeSearch({ profit, amountGrid, floor: 1000n }), [10n]);
    }
  }
});

test("blockscan defaults to P/10P/100P raw units", async () => {
  assert.deepEqual(await observeSearch(), [10n, 100n, 1000n]);
  for (const halfWidth of [0, 2, 16]) {
    assert.deepEqual(await observeSearch({ amountGrid: "multiples", halfWidth }),
      [10n, 100n, 1000n]);
  }
});

test("multiples retain raw bigint precision without token scaling", async () => {
  const center = 9_007_199_254_740_993n;
  assert.deepEqual(await observeSearch({ center }), [
    9_007_199_254_740_993n, 90_071_992_547_409_930n,
    900_719_925_474_099_300n,
  ]);
  assert.deepEqual(await observeSearch({ center: 1n }), [1n, 10n, 100n]);
});

test("multiples use the existing clamp and deduplicate capped amounts", async () => {
  for (const [cap, expected] of [
    [1000n, [10n, 100n, 1000n]],
    [150n, [10n, 100n, 150n]],
    [100n, [10n, 100n]],
    [75n, [10n, 75n]],
    [10n, [10n]],
    [7n, []],
    [1n, []],
  ] as const) {
    assert.deepEqual(await observeSearch({ cap }), expected);
  }
  for (const center of [0n, -10n]) {
    assert.deepEqual(await observeSearch({ center }), []);
  }
  await observeSearch({ cap: 0n });
  await observeSearch({ cap: -1n });
});

test("explicit geometric fallback preserves width, cap and integer dedup", async () => {
  assert.deepEqual(await observeSearch({ amountGrid: "geometric" }),
    [10n, 1n, 2n, 5n, 20n, 40n, 80n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", halfWidth: 2 }),
    [10n, 2n, 5n, 20n, 40n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", halfWidth: 0 }), [10n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", halfWidth: 2, cap: 12n }),
    [10n, 2n, 5n, 12n]);
  assert.deepEqual(await observeSearch({ amountGrid: "geometric", center: 3n, cap: 2n }), []);
});

test("blockscan grid option does not alter swap backrun or oracle searches", async () => {
  for (const amountGrid of [undefined, "multiples", "geometric"] as const) {
    assert.deepEqual(await observeSearch({ lane: "swap", amountGrid, profit: 0n }),
      [1n, 2n, 5n, 10n, 20n, 40n, 80n]);
    assert.deepEqual(await observeSearch({ lane: "swap", amountGrid, halfWidth: 2, cap: 12n, profit: 0n }),
      [2n, 5n, 10n, 12n]);
    assert.deepEqual(await observeSearch({ lane: "oracle", amountGrid, cap: 150n, halfWidth: 0, profit: 0n }),
      [150n, 75n, 37n, 18n, 9n, 4n, 2n, 1n]);
    await observeSearch({ lane: "oracle", amountGrid });
  }
});

test("multiples retain GSS bracket, evaluation budget and mandatory final sim", async () => {
  assert.deepEqual(await observeSearch({ profit: 1n, includeGss: true }),
    [10n, 100n, 1000n, 11n, 14n, 9n, 8n]);
});

test("P's complete route must finish positive before any other amount starts", async () => {
  const plan = makePlans(1)[0]!;
  const amounts: bigint[] = [];
  let release!: () => void;
  let atSecondHop!: () => void;
  const reached = new Promise<void>(resolve => { atSecondHop = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let gated = false;
  const fixture = sharedSession([plan], { async quote(request, leg) {
    if (leg === 0) amounts.push(request.amountIn);
    if (leg === 1 && !gated) { gated = true; atSecondHop(); await held; }
    return leg === 0 ? request.amountIn : request.amountIn + 1n;
  } });
  const solve = new AnvilSolver().solve(plan, {} as StateBackend, {
    executor: EXECUTOR, async simulate() { assert.fail("deferred search must not simulate"); },
  }, { strictSession: fixture.session, deferPhase2Sim: true, quoteSafetyBps: 10000n, gssMaxTries: 4 });
  await reached;
  try { assert.deepEqual(amounts, [1024n]); } finally { release(); }
  await solve;
  assert.deepEqual(amounts.slice(0, 3), [1024n, 10240n, 102400n]);
});

test("P failure preserves revert/RPC/timeout evidence and issues no larger amounts", async () => {
  for (const error of [
    Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" }),
    Object.assign(new Error("rate limited"), { code: 429 }),
    Object.assign(new Error("request timeout"), { code: "TIMEOUT" }),
  ]) {
    const plan = makePlans(1)[0]!;
    let calls = 0;
    const fixture = sharedSession([plan], { async quote() { calls++; throw error; },
      onBuild() { assert.fail("failed P cannot build execution"); } });
    await assert.rejects(new AnvilSolver().solve(plan, {} as StateBackend, {
      executor: EXECUTOR, async simulate() { assert.fail("failed P cannot simulate"); },
    }, { strictSession: fixture.session }), (caught: unknown) => {
      assert.equal(caught instanceof BlockScanFamilyAttributedError ? caught.failureCause : caught, error);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("100 non-positive routes consume only their P quotes", async () => {
  const plans = makePlans(100);
  const fixture = sharedSession(plans, { async quote(request) { return request.amountIn; },
    onBuild() { assert.fail("non-positive P cannot build execution"); } });
  for (const plan of plans) {
    await assert.rejects(new AnvilSolver().solve(plan, {} as StateBackend, {
      executor: EXECUTOR, async simulate() { assert.fail("non-positive P cannot simulate"); },
    }, { strictSession: fixture.session, quoteSafetyBps: 10000n, quoteProfitFloorBps: 100n }),
    /quote search 1 pts/);
  }
  assert.equal(fixture.stats.calls, 200, "100 two-hop P quotes, not 800 grid leg quotes");
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
    assert.equal(calls, 1, "unresolved P must not launch any other amount");
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
    quoteToleranceRawUnits: 0n,
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
