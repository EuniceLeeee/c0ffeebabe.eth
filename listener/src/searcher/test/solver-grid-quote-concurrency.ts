import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AnvilSolver, type ResolvedPlan, type SolverTiming } from "../solver/solver.js";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";
import type { CandidatePlan } from "../planner/planner.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  EXECUTOR, canonical, makePlans, sharedSession, type FixtureExactInput,
} from "./blockscan-solver-quote-concurrency.js";

type SolverClass = new () => Pick<AnvilSolver, "solve">;
interface Scenario {
  name: string;
  grid: readonly bigint[];
  halfWidth?: number;
  cap?: bigint;
  oracle?: boolean;
  debtBps?: readonly bigint[];
  mode: "ties" | "positive" | "negative" | "mixed" | "domain" | "first-hop-domain";
  floor?: bigint;
}
const grid = [256n, 512n, 1024n, 2048n, 4096n];
const scenarios: readonly Scenario[] = [
  { name: "ties", grid, mode: "ties" },
  { name: "positive", grid, mode: "positive" },
  { name: "negative", grid, mode: "negative" },
  { name: "floor-admitted-negative", grid, mode: "negative", floor: 100n },
  { name: "mixed-positive-negative-domain", grid, mode: "mixed" },
  { name: "all-domain-failures", grid, mode: "domain" },
  { name: "first-hop-domain-failures", grid, mode: "first-hop-domain" },
  { name: "multiple-debt-bps", grid, mode: "ties", debtBps: [11200n, 10400n, 10800n] },
  { name: "capped-grid", grid: [256n, 512n, 1024n, 1500n], mode: "ties", cap: 1500n },
  { name: "wide-grid", grid: Array.from({ length: 13 }, (_, i) => 16n << BigInt(i)),
    mode: "ties", halfWidth: 6 },
  { name: "oracle-capped-grid", grid: Array.from({ length: 21 }, (_, i) => 1n << BigInt(24 - i)),
    mode: "ties", oracle: true, cap: 1n << 24n },
];
const timingSink = (): SolverTiming => ({
  quoteMs: 0, planBuildMs: 0, simMs: 0, amountPoints: 0, gssPoints: 0, hopExactCalls: 0,
});
const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
const noState = new Proxy({} as StateBackend, {
  get(_target, key) {
    if (key === "simulateTokenToNativeDelta") return undefined;
    return () => { throw new Error(`unexpected state I/O: ${String(key)}`); };
  },
});
const probe = {
  executor: EXECUTOR,
  async simulate(): Promise<never> { throw new Error("quote-only solve invoked simulation"); },
};

function scenarioPlan(scenario: Scenario): CandidatePlan {
  const plan = makePlans(1)[0]!;
  plan.maxFlashAmount = scenario.cap;
  if (scenario.oracle) {
    plan.opportunity = {
      kind: "backrun-arb", victimTxHash: `0x${"11".repeat(32)}`, blockNumber: 1,
      affectedPools: [], affectedTokens: [],
      startToken: plan.opportunity.startToken, profitToken: plan.opportunity.profitToken,
      victimAmountIn: 0n, hints: {},
      victimEffect: { kind: "oracle", descriptorId: "fixture-oracle", priceScope: [],
        affectedEdges: [], priceChanges: [], maxSearchHops: 2 },
    };
  }
  return plan;
}

async function measure(Solver: SolverClass, scenario: Scenario) {
  const plan = scenarioPlan(scenario);
  const timing = timingSink();
  const bps = scenario.debtBps ?? [0n];
  const allFail = scenario.mode === "domain" || scenario.mode === "first-hop-domain";
  const gssPerBps = scenario.mode === "negative" || allFail ? 0 : 4;
  const starts: Array<{ amount: bigint; bps: bigint; phase: string }> = [];
  const completed: bigint[] = [];
  const calls: string[] = [];
  const failures: string[] = [];
  const ordinals = new Map<bigint, number>();
  const active = new Set<string>();
  let peak = 0;
  let builds = 0;
  let previousBps: bigint | undefined;
  let replies: Array<() => void> = [];
  const fixture = sharedSession([plan], {
    debtBps: scenario.debtBps,
    onBuild() { assert.equal(active.size, 0, "build overlaps amount probes"); builds++; },
    async quote(input, leg) {
      const debt = input.creditDebtBps ?? 0n;
      const amount = leg === 0 ? input.amountIn : input.amountIn / 2n;
      const key = `${debt}:${amount}`;
      if (leg === 0) {
        const ordinal = ordinals.get(debt) ?? 0;
        const phase = ordinal < scenario.grid.length ? "grid"
          : ordinal < scenario.grid.length + gssPerBps ? "gss" : "final";
        if (phase !== "grid" || previousBps !== debt) {
          assert.equal(active.size, 0, "GSS, debt-BPS groups and final propagation must stay sequential");
        }
        assert.ok(!active.has(key), "same amount/debt probe overlapped itself");
        active.add(key);
        peak = Math.max(peak, active.size);
        previousBps = debt;
        ordinals.set(debt, ordinal + 1);
        starts.push({ amount, bps: debt, phase });
      }
      calls.push(`${key}:hop${leg}`);
      // Final-hop replies are explicitly reversed within each event-loop batch.
      // This is deterministic even on loaded hosts; elapsed speed is not a gate.
      await new Promise<void>((done) => {
        replies.push(done);
        if (replies.length === 1) setImmediate(() => {
          const batch = replies;
          replies = [];
          if (leg > 0 || scenario.mode === "first-hop-domain") batch.reverse();
          batch.forEach((reply) => reply());
        });
      });
      if (leg === 0 && scenario.mode !== "first-hop-domain") return amount * 2n;
      active.delete(key);
      completed.push(amount);
      if (allFail || (scenario.mode === "mixed" && amount === 512n)) {
        const message = `domain revert amount=${amount} debt=${debt}`;
        failures.push(message);
        throw Object.assign(new Error(message), { code: "CALL_EXCEPTION" });
      }
      const profit = scenario.mode === "negative" || (scenario.mode === "mixed" && amount === 1024n)
        ? -1n : scenario.mode === "positive" ? amount / 4n : 7n;
      return amount + profit;
    },
  });
  let deferred: readonly ResolvedPlan[] = [];
  let returned: ResolvedPlan | undefined;
  let error: unknown = null;
  let callbackCount = 0;
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => { logs.push(args.join(" ")); };
    returned = await new Solver().solve(plan, noState, probe, {
      strictSession: fixture.session, deferPhase2Sim: true, finalSimTopN: 6,
      gridHalfWidth: scenario.halfWidth ?? 2, gssMaxTries: 4,
      quoteSafetyBps: 10_000n, quoteProfitFloorBps: scenario.floor ?? 0n, timing,
      onDeferredCandidates(value) { callbackCount++; deferred = value; },
    });
  } catch (caught) {
    const failure = caught as Error & { familyId?: string };
    error = { name: failure.name, message: failure.message, familyId: failure.familyId };
  } finally {
    console.log = originalLog;
  }
  assert.equal(active.size, 0);
  assert.equal(timing.amountPoints, bps.length * (scenario.grid.length + gssPerBps), scenario.name);
  assert.equal(timing.gssPoints, bps.length * gssPerBps, scenario.name);
  assert.equal(timing.hopExactCalls, fixture.stats.calls);
  assert.equal(fixture.stats.calls, scenario.mode === "first-hop-domain"
    ? timing.amountPoints : 2 * (timing.amountPoints + deferred.length));
  assert.equal(builds, deferred.length * 3, "two leg fragments plus one funding root per plan");
  assert.equal(timing.simMs, 0);
  const shouldFail = allFail || (scenario.mode === "negative" && !scenario.floor);
  assert.equal(error !== null, shouldFail, `${scenario.name}: unexpected solve outcome`);
  assert.equal(callbackCount, shouldFail ? 0 : 1);
  for (const debt of bps) {
    assert.deepEqual(starts.filter((x) => x.bps === debt && x.phase === "grid").map((x) => x.amount),
      scenario.grid, `${scenario.name}: missing/reordered/cap-reduced grid`);
  }
  assert.equal(failures.length, allFail ? scenario.grid.length
    : scenario.mode === "mixed" ? 1 : 0);
  return {
    peak, completed,
    equivalent: canonical({ returned, deferred, error, callbackCount, starts, builds,
      calls: calls.sort(), failures: failures.sort(), logs,
      amountPoints: timing.amountPoints, gssPoints: timing.gssPoints, hopExactCalls: timing.hopExactCalls }),
  };
}

async function cancellation(Solver: SolverClass, mode: "abort" | "deadline", parallel: boolean) {
  const plan = makePlans(1)[0]!;
  const controller = new AbortController();
  const timing = timingSink();
  const held: Array<{ input: FixtureExactInput; resolve: (amount: bigint) => void;
    reject: (error: Error) => void }> = [];
  const violations: string[] = [];
  let stopped = false;
  let calls = 0;
  let builds = 0;
  let candidates = 0;
  const fixture = sharedSession([plan], {
    onBuild() { builds++; if (stopped) violations.push("late build"); },
    quote(input, leg) {
      calls++;
      if (stopped || leg !== 0) violations.push("new probe/dependent hop after cancellation");
      return new Promise<bigint>((resolve, reject) => held.push({ input, resolve, reject }));
    },
  });
  const deadlineAtMs = mode === "deadline" ? Date.now() + 100 : undefined;
  const solve = new Solver().solve(plan, noState, probe, {
    strictSession: fixture.session, deferPhase2Sim: true, finalSimTopN: 3,
    gridHalfWidth: 6, gssMaxTries: 4, quoteSafetyBps: 10_000n, quoteProfitFloorBps: 0n,
    signal: controller.signal, deadlineAtMs, timing,
    onDeferredCandidates() { candidates++; if (stopped) violations.push("late candidate"); },
  });
  // Observe rejection immediately, and bound this gate if orchestration fails to unwind.
  const settled = solve.then(() => "resolved", () => "rejected");
  const startedBy = Date.now() + 2000;
  while (held.length < (parallel ? 8 : 1) && Date.now() < startedBy) await turn();
  assert.equal(held.length, parallel ? 8 : 1, "initial amount fan-out changed");
  stopped = true;
  if (mode === "abort") controller.abort(new Error("fixture new head"));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await Promise.race([settled, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("solver did not unwind cancellation")), 2000);
    })]), "rejected");
  } finally {
    clearTimeout(watchdog);
  }
  assert.ok(held.every(({ input }) => input.control?.signal?.aborted), "nested quotes missed abort");
  const counts = canonical({ calls, builds, candidates, timing });
  // Alternate late successes and rejections, including an ignored non-cooperative quote.
  held.forEach((item, i) => i % 2 === 0 ? item.resolve(item.input.amountIn * 2n)
    : item.reject(new Error("late domain rejection")));
  await turn();
  await turn();
  assert.equal(canonical({ calls, builds, candidates, timing }), counts, "late reply mutated settled solve");
  assert.deepEqual(violations, []);
  assert.equal(builds, 0);
  assert.equal(candidates, 0);
}

// Keep the real queue/memo behavior: counting logical issueExact calls alone
// misses cold identical reads amplified by independent amount concurrency.
async function transportReuse(Solver: SolverClass): Promise<number[]> {
  const plan = makePlans(1)[0]!;
  const backend = new PinnedRethQuoteBackend("http://offline.invalid", `0x${"ab".repeat(32)}`);
  const transport = backend as unknown as {
    flushBatch(items: unknown[]): Promise<void>;
    resolveItem(item: unknown, value: string): void;
  };
  let itemsSent = 0;
  transport.flushBatch = async (items) => {
    itemsSent += items.length;
    await turn();
    for (const item of items) transport.resolveItem(item, "0x01");
  };
  const fixture = sharedSession([plan], {
    async quote(input, leg) {
      await backend.call({ to: input.edge.target, data: "0x0902f1ac" }, input.control);
      return leg === 0 ? input.amountIn * 2n : input.amountIn / 2n - 1n;
    },
    onBuild() { assert.fail("negative transport fixture built a plan"); },
  });
  const counts: number[] = [];
  try {
    for (const _cache of ["cold", "warm"]) {
      const before = itemsSent;
      const timing = timingSink();
      await assert.rejects(new Solver().solve(plan, noState, probe, {
        strictSession: fixture.session, gridHalfWidth: 2, gssMaxTries: 4,
        quoteSafetyBps: 10_000n, quoteProfitFloorBps: 0n, timing,
      }), /no profitable plan/);
      assert.equal(timing.amountPoints, 5);
      assert.equal(timing.hopExactCalls, 10);
      counts.push(itemsSent - before);
    }
  } finally {
    await backend.closeAndDrain();
  }
  return counts;
}

const args = process.argv.slice(2);
assert.equal(args.length, 2, "usage: solver-grid-quote-concurrency.ts --baseline-solver <module.mts>");
assert.equal(args[0], "--baseline-solver");
const baselineUrl = pathToFileURL(resolve(args[1]!)).href;
const { AnvilSolver: BaselineSolver } = await import(baselineUrl) as { AnvilSolver: SolverClass };
assert.equal(typeof BaselineSolver, "function", "baseline must export AnvilSolver");
assert.notEqual(BaselineSolver, AnvilSolver, "baseline cannot be the candidate module");
assert.deepEqual(await transportReuse(BaselineSolver), [2, 0]);
assert.deepEqual(await transportReuse(AnvilSolver), [2, 0]);
console.log("solver-grid-quote-concurrency cold/warm transport items PASS (2/0, unchanged)");
for (const scenario of scenarios) {
  const baseline = await measure(BaselineSolver, scenario);
  const candidate = await measure(AnvilSolver, scenario);
  assert.equal(candidate.equivalent, baseline.equivalent, `${scenario.name}: baseline behavior diverged`);
  assert.equal(baseline.peak, 1, "baseline is not the serial solver");
  assert.equal(candidate.peak, Math.min(8, scenario.grid.length), "grid cap must be exactly eight");
  assert.notDeepEqual(candidate.completed.slice(0, scenario.grid.length),
    baseline.completed.slice(0, scenario.grid.length), "fixture did not force out-of-order replies");
  console.log(`solver-grid-quote-concurrency ${scenario.name} PASS (peak=${candidate.peak})`);
}
for (const mode of ["abort", "deadline"] as const) {
  await cancellation(BaselineSolver, mode, false);
  await cancellation(AnvilSolver, mode, true);
}
console.log("solver-grid-quote-concurrency PASS (11 equivalence cases; baseline/candidate abort + deadline)");
