import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runBackrunCandidatePipeline } from "../backrun-candidate-pipeline.js";
import { resolveLiveBackrunSettings } from "../backrun-live-policy.js";
import { AnvilSolver, type ResolvedPlan, type Solver } from "../solver/solver.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { CandidatePlan } from "../planner/planner.js";
import { canonical, EXECUTOR, makePlans, sharedSession } from "./blockscan-solver-quote-concurrency.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function abortWait(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function setup(count = 3) {
  const plans: CandidatePlan[] = makePlans(count).map(plan => ({
    ...plan,
    opportunity: {
      kind: "backrun-arb", victimTxHash: `0x${"ab".repeat(32)}`, blockNumber: 1,
      startToken: plan.opportunity.startToken, profitToken: plan.opportunity.profitToken,
      victimAmountIn: plan.opportunity.victimAmountIn,
      affectedPools: plan.tokenPath.edges.map(edge => edge.target),
      affectedTokens: [plan.tokenPath.edges[0]!.tokenIn, plan.tokenPath.edges[0]!.tokenOut],
      hints: {}, victimEffect: { kind: "swap", impact: {
        pool: `0x${"34".repeat(20)}`, matchedAdapterId: "univ2-swap",
        tokenIn: plan.opportunity.startToken, tokenOut: plan.tokenPath.edges[0]!.tokenOut,
        amountIn: plan.opportunity.victimAmountIn,
      } },
    },
  }));
  return {
    plans, maxCandidates: 0, concurrency: 2,
    state: { async call() { throw new Error("quotes must use pinned strict session"); } } as unknown as StateBackend, executor: EXECUTOR,
    solverDeadlineMs: 5000, deadlineAtMs: Date.now() + 5000,
    signal: new AbortController().signal, options: {}, onQuoteStart: () => {},
  };
}
const resolved = (amount: bigint) => ({ flashAmount: amount } as ResolvedPlan);

test("backrun shares blockscan scheduling: bounded parallel quotes, ordered serial consumer and full finalists", async () => {
  const input = setup(4);
  const gates = input.plans.map(() => latch());
  const starts: number[] = [], consumed: number[] = [];
  let active = 0, peak = 0, activeConsumers = 0;
  const solver: Solver = { async solve(plan, _state, probe, opts) {
    const index = input.plans.indexOf(plan);
    starts.push(index); active++; peak = Math.max(peak, active);
    assert.equal(opts!.deferPhase2Sim, true);
    assert.equal(opts!.deadlineAtMs, input.deadlineAtMs);
    await assert.rejects(probe.simulate(resolved(1n)), /cannot simulate/);
    await gates[index]!.promise; active--;
    const values = [resolved(BigInt(index + 1)), resolved(BigInt(index + 11))];
    opts!.onDeferredCandidates!(values); return values[0]!;
  } };
  const running = runBackrunCandidatePipeline({ ...input, solver,
    consume: async (_plan, result, index) => {
      activeConsumers++; assert.equal(activeConsumers, 1);
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.finalists.map(v => v.flashAmount), [BigInt(index + 1), BigInt(index + 11)]);
      consumed.push(index); await turn(); activeConsumers--;
    },
  });
  await turn(); assert.deepEqual(starts, [0, 1]);
  gates[1]!.resolve(); await turn(); assert.deepEqual(consumed, []);
  gates[0]!.resolve(); await turn(); await turn();
  assert.deepEqual(consumed, [0, 1]);
  assert.equal(active, 2, "later quotes overlap earlier final simulation");
  gates[2]!.resolve(); gates[3]!.resolve();
  assert.equal(await running, true); assert.equal(peak, 2);
  assert.deepEqual(consumed, [0, 1, 2, 3]);
});

test("route quote failure preserves later candidates and cap applies before starting work", async () => {
  const input = setup(4), starts: number[] = [], outcomes: boolean[] = [];
  await runBackrunCandidatePipeline({ ...input, maxCandidates: 2,
    solver: { async solve(plan) { if (plan === input.plans[0]) throw new Error("route reverted"); return resolved(1n); } },
    onQuoteStart: index => { starts.push(index); },
    consume: async (_plan, result) => { outcomes.push(result.ok); },
  });
  assert.deepEqual(starts, [0, 1]); assert.deepEqual(outcomes, [false, true]);
});

test("early submission stops buffered candidates and drains other quote workers", async () => {
  const input = setup(3); let drained = false; const consumed: number[] = [];
  const finished = await runBackrunCandidatePipeline({ ...input,
    solver: { async solve(plan, _state, _probe, opts) {
      if (plan === input.plans[0]) { await turn(); return resolved(1n); }
      try { return await abortWait(opts!.signal!); }
      finally { await turn(); drained = true; }
    } },
    consume: async (_plan, _result, index) => { consumed.push(index); return false; },
  });
  assert.equal(finished, false); assert.equal(drained, true); assert.deepEqual(consumed, [0]);
});

test("deadline/source cancellation prevents buffered simulation and drains producers", async () => {
  for (const byDeadline of [false, true]) {
    const controller = new AbortController(), entered = latch(); let drained = false;
    const running = runBackrunCandidatePipeline({ ...setup(2),
      signal: controller.signal, deadlineAtMs: Date.now() + (byDeadline ? 25 : 5000),
      solver: { async solve(_plan, _state, _probe, opts) {
        entered.resolve();
        try { return await abortWait(opts!.signal!); }
        finally { await turn(); drained = true; }
      } },
      consume: async () => { assert.fail("cancelled source reached sim"); },
    });
    await entered.promise; if (!byDeadline) controller.abort(new Error("source replaced"));
    await assert.rejects(running, byDeadline ? /deadline/ : /source replaced/);
    assert.equal(drained, true);
  }
});

test("real Solver: parallel and serial scheduling preserve every amount and compiled plan", async () => {
  const run = async (concurrency: number) => {
    const input = setup(4), fixture = sharedSession(input.plans), output: unknown[] = [];
    await runBackrunCandidatePipeline({ ...input, concurrency, solver: new AnvilSolver(),
      options: { strictSession: fixture.session, gssMaxTries: 4, finalSimTopN: 3,
        gridHalfWidth: 2,
        quoteSafetyBps: 10000n, quoteProfitFloorBps: 0n },
      consume: async (_plan, result, index) => {
        if (!result.ok) throw result.error;
        if (result.ok) output.push({ index, finalists: result.finalists });
      },
    });
    return { output: canonical(output), calls: fixture.stats.calls };
  };
  assert.deepEqual(await run(1), await run(4));
});

test("live policy and main wiring use quote-only scheduling, not a historical-only branch", () => {
  assert.equal(resolveLiveBackrunSettings({}).execution.solverQuoteConcurrency, 16);
  assert.equal(resolveLiveBackrunSettings({ SEARCHER_BACKRUN_SOLVER_QUOTE_CONCURRENCY: "2" }).execution.solverQuoteConcurrency, 2);
  for (const value of ["0", "65", "NaN", "1.5"]) {
    assert.throws(() => resolveLiveBackrunSettings({ SEARCHER_BACKRUN_SOLVER_QUOTE_CONCURRENCY: value }));
  }
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const body = main.slice(main.indexOf("async function processOpportunities("), main.indexOf("async function readUncachedLatestBlock("));
  assert.match(body, /await runBackrunCandidatePipeline\(/);
  assert.doesNotMatch(body, /ctx\.solver\.solve\(/);
  assert.match(body, /for \(const resolved of quoted\.finalists\)/);
  assert.match(body, /await ctx\.liveBackend\.finalVerify\(resolved\)/);
  assert.match(body, /await evaluateEv\(/);
  assert.match(body, /quoteToleranceRawUnits: ctx\.config\.quoteToleranceRawUnits/);
});

test("live backrun raw-unit policy retains nominal amounts and uses only minimum-output tolerance", async () => {
  const results: unknown[] = [];
  for (const enabled of ["0", "1"]) {
    const input = setup(1);
    const policy = resolveLiveBackrunSettings({ SEARCHER_BACKRUN_QUOTE_TOLERANCE_ENABLED: enabled,
      SEARCHER_QUOTE_SAFETY_BPS: "9999", SEARCHER_QUOTE_PROFIT_FLOOR_BPS: "0" }).execution;
    const fixture = sharedSession(input.plans, { toleranceRawUnits: policy.quoteToleranceRawUnits });
    await runBackrunCandidatePipeline({ ...input, solver: new AnvilSolver(),
      options: { strictSession: fixture.session, gssMaxTries: 4, finalSimTopN: 1,
        quoteSafetyBps: policy.quoteSafetyBps, quoteToleranceRawUnits: policy.quoteToleranceRawUnits,
        quoteProfitFloorBps: policy.quoteProfitFloorBps },
      consume: async (_plan, result) => {
        if (!result.ok) throw result.error;
        const chosen = result.finalists[0]!;
        results.push({ amount: chosen.flashAmount, nominalProfit: chosen.netProfit });
        assert.equal(chosen.root.children.some(c => c.adapterId === "actual-amount-flow"), false);
        const legs = chosen.root.children;
        assert.equal(legs[0]!.params.minAmountOut,
          legs[1]!.amount - policy.quoteToleranceRawUnits);
        assert.equal(legs[1]!.params.minAmountOut,
          chosen.flashAmount + chosen.netProfit - policy.quoteToleranceRawUnits);
      },
    });
  }
  assert.deepEqual(results[0], results[1], "tolerance must not pre-discount or alter the sizing objective");
});
