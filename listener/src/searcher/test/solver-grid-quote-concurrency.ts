import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AnvilSolver, type ResolvedPlan, type SolverTiming } from "../solver/solver.js";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";
import { BlockScanFamilyAttributedError, blockScanEdgeFamilyId } from "../detector/blockscan-family-budget.js";
import type { CandidatePlan } from "../planner/planner.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  EXECUTOR, canonical, makePlans, sharedSession, type FixtureExactInput, type FixtureExactHandle,
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
  gssFailureHop?: 0 | 1;
  gssFailureProbe?: 0 | 1;
  safetyBps?: bigint;
  finalists?: number;
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
  { name: "gss-pair-first-hop-domain", grid, mode: "ties", gssFailureHop: 0 },
  { name: "gss-pair-second-hop-domain", grid, mode: "ties", gssFailureHop: 1 },
  { name: "gss-c-domain-d-positive", grid, mode: "positive", gssFailureHop: 0, gssFailureProbe: 0 },
  { name: "gss-d-domain-c-positive", grid, mode: "positive", gssFailureHop: 1, gssFailureProbe: 1 },
  { name: "three-finalists-reuse", grid, mode: "positive", finalists: 3 },
  { name: "raw-output-safety-haircut", grid, mode: "positive", safetyBps: 9000n },
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

async function measure(Solver: SolverClass, scenario: Scenario, pairParallel: boolean, reuse = false) {
  const plan = scenarioPlan(scenario);
  const timing = timingSink();
  const bps = scenario.debtBps ?? [0n];
  const allFail = scenario.mode === "domain" || scenario.mode === "first-hop-domain";
  const gssPerBps = scenario.mode === "negative" || allFail ? 0 : 4;
  const starts: Array<{ amount: bigint; bps: bigint; phase: string }> = [];
  const completed: bigint[] = [];
  const calls: string[] = [];
  const finalCalls: string[] = [];
  const issuedPhase = new WeakMap<object, string>();
  const built: string[] = [];
  const hopInputs = new Map<string, bigint>();
  const safetyBps = scenario.safetyBps ?? 10000n;
  const failures: string[] = [];
  const attributions: string[] = [];
  const gssCompleted = new Map<bigint, bigint[]>();
  const phases = new Map<string, { phase: string; index: number }>();
  const waves = { grid: 0, gss: 0, final: 0 };
  const ordinals = new Map<bigint, number>();
  const active = new Set<string>();
  let peak = 0;
  let pairPeak = 0;
  let firstHopFailures = 0;
  let builds = 0;
  let previousBps: bigint | undefined;
  let replies: Array<() => void> = [];
  const fixture = sharedSession([plan], {
    debtBps: scenario.debtBps,
    safetyBps,
    onExact(input, handle) {
      const debt = input.creditDebtBps ?? 0n;
      const amount = input.edge === plan.tokenPath.edges[0] ? input.amountIn
        : hopInputs.get(`${debt}:${input.amountIn}`)!;
      issuedPhase.set(handle, phases.get(`${debt}:${amount}`)!.phase);
    },
    onBuildExecution(input) {
      assert.ok(issuedPhase.has(input.exact), "build must consume the identical issued object");
      assert.equal(issuedPhase.get(input.exact) === "final", !reuse,
        "candidate must build with search handles; baseline must reissue finalists");
      assert.equal(input.minAmountOut, input.exact.amountOut * safetyBps / 10000n,
        "raw exact output and haircut execution minimum must stay distinct");
      built.push(canonical({ edge: input.edge, rawOutput: input.exact.amountOut, minimum: input.minAmountOut }));
    },
    onBuild() { assert.equal(active.size, 0, "build overlaps amount probes"); builds++; },
    async quote(input, leg) {
      const debt = input.creditDebtBps ?? 0n;
      const amount = leg === 0 ? input.amountIn : hopInputs.get(`${debt}:${input.amountIn}`)!;
      const key = `${debt}:${amount}`;
      if (leg === 0) {
        const ordinal = ordinals.get(debt) ?? 0;
        const phase = ordinal < scenario.grid.length ? "grid"
          : ordinal < scenario.grid.length + gssPerBps ? "gss" : "final";
        const index = ordinal - scenario.grid.length;
        const secondOfPair = phase === "gss" && index === 1 && pairParallel;
        if (phase !== "grid" || previousBps !== debt) {
          assert.equal(active.size, secondOfPair ? 1 : 0,
            "only initial c,d may overlap; later GSS/debt groups/final propagation stay serial");
        }
        assert.ok(!active.has(key), "same amount/debt probe overlapped itself");
        active.add(key);
        peak = Math.max(peak, active.size);
        if (phase === "gss" && index < 2) pairPeak = Math.max(pairPeak, active.size);
        phases.set(key, { phase, index });
        previousBps = debt;
        ordinals.set(debt, ordinal + 1);
        starts.push({ amount, bps: debt, phase });
      }
      const { phase, index } = phases.get(key)!;
      (phase === "final" ? finalCalls : calls).push(`${key}:hop${leg}`);
      const gssFailure = phase === "gss" && index < 2 && scenario.gssFailureHop === leg &&
        (scenario.gssFailureProbe === undefined || scenario.gssFailureProbe === index);
      // Final-hop replies are explicitly reversed within each event-loop batch.
      // This is deterministic even on loaded hosts; elapsed speed is not a gate.
      await new Promise<void>((done) => {
        replies.push(done);
        if (replies.length === 1) setImmediate(() => {
          const batch = replies;
          replies = [];
          waves[phase as keyof typeof waves]++;
          if (leg > 0 || scenario.mode === "first-hop-domain" ||
            (phase === "gss" && scenario.gssFailureHop === 0)) batch.reverse();
          batch.forEach((reply) => reply());
        });
      });
      if (leg === 0 && scenario.mode !== "first-hop-domain" && !gssFailure) {
        hopInputs.set(`${debt}:${amount * 2n * safetyBps / 10000n}`, amount);
        return amount * 2n;
      }
      active.delete(key);
      completed.push(amount);
      if (phase === "gss") {
        const done = gssCompleted.get(debt) ?? [];
        done.push(amount);
        gssCompleted.set(debt, done);
      }
      if (allFail || gssFailure || (scenario.mode === "mixed" && amount === 512n)) {
        if (leg === 0) firstHopFailures++;
        const message = `domain revert amount=${amount} debt=${debt}`;
        failures.push(message);
        const cause = Object.assign(new Error(message), { code: "CALL_EXCEPTION" });
        if (!gssFailure) throw cause; // Retain the original untyped-error wrapping controls.
        const error = new BlockScanFamilyAttributedError(blockScanEdgeFamilyId(input.edge),
          "amount propagation", cause);
        // Observe the real aggregation's ownership reads, not RPC receipt order.
        const familyId = error.familyId;
        Object.defineProperty(error, "familyId", { get() {
          attributions.push(`${key}:hop${leg}:${familyId}`);
          return familyId;
        } });
        throw error;
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
      strictSession: fixture.session, deferPhase2Sim: true, finalSimTopN: scenario.finalists ?? 6,
      blockScanAmountGrid: "geometric", // Compare scheduling, not the new amount policy.
      gridHalfWidth: scenario.halfWidth ?? 2, gssMaxTries: 4,
      quoteSafetyBps: safetyBps, quoteProfitFloorBps: scenario.floor ?? 0n, timing,
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
  assert.equal(finalCalls.length, reuse ? 0 : 2 * deferred.length, "only finalist reissuance may disappear");
  assert.equal(fixture.stats.calls, 2 * timing.amountPoints - firstHopFailures + finalCalls.length);
  assert.equal(built.length, 2 * deferred.length);
  assert.equal(starts.filter((x) => x.phase === "final").length, reuse ? 0 : deferred.length);
  assert.equal(builds, deferred.length * 3, "two leg fragments plus one funding root per plan");
  assert.equal(timing.simMs, 0);
  const shouldFail = allFail || (scenario.mode === "negative" && !scenario.floor);
  assert.equal(error !== null, shouldFail, `${scenario.name}: unexpected solve outcome`);
  assert.equal(callbackCount, shouldFail ? 0 : 1);
  for (const debt of bps) {
    assert.deepEqual(starts.filter((x) => x.bps === debt && x.phase === "grid").map((x) => x.amount),
      scenario.grid, `${scenario.name}: missing/reordered/cap-reduced grid`);
  }
  assert.equal(failures.length, bps.length * (allFail ? scenario.grid.length
    : scenario.mode === "mixed" ? 1 : scenario.gssFailureHop !== undefined
      ? scenario.gssFailureProbe === undefined ? 2 : 1 : 0));
  assert.equal(pairPeak, gssPerBps === 0 ? 0 : pairParallel ? 2 : 1);
  for (const debt of bps) {
    if (!gssPerBps) continue;
    const points = starts.filter((x) => x.bps === debt && x.phase === "gss").map((x) => x.amount);
    // A c-first failure can finish before d's dependent second hop. In all
    // equal-length paths, including two failures, explicitly require d first.
    const reversed = pairParallel && !(scenario.gssFailureHop === 0 && scenario.gssFailureProbe === 0);
    assert.deepEqual(gssCompleted.get(debt),
      reversed ? [points[1], points[0], ...points.slice(2)] : points,
      `${scenario.name}: initial-pair completion order / later serial GSS changed`);
  }
  return {
    peak, pairPeak, completed, waves, hopExactCalls: timing.hopExactCalls, finalists: deferred.length,
    equivalent: canonical({ returned, deferred, error, callbackCount,
      starts: starts.filter((x) => x.phase !== "final"), builds, built,
      calls: calls.sort(), failures: failures.sort(), attributions, logs,
      amountPoints: timing.amountPoints, gssPoints: timing.gssPoints, hopExactCalls: calls.length }),
  };
}

async function cancellation(Solver: SolverClass, mode: "abort" | "deadline", parallel: boolean,
  phase: "grid" | "gss" = "grid", heldLeg = 0) {
  const plan = makePlans(1)[0]!;
  const controller = new AbortController();
  const timing = timingSink();
  const held: Array<{ input: FixtureExactInput; leg: number; resolve: (amount: bigint) => void;
    reject: (error: Error) => void }> = [];
  const violations: string[] = [];
  let stopped = false;
  let calls = 0;
  let builds = 0;
  let candidates = 0;
  const fixture = sharedSession([plan], {
    onBuild() { builds++; if (stopped) violations.push("late build"); },
    async quote(input, leg) {
      calls++;
      if (stopped) violations.push("new probe/dependent hop after cancellation");
      if ((phase === "grid" || timing.gssPoints > 0) && leg === heldLeg) {
        return new Promise<bigint>((resolve, reject) => held.push({ input, leg, resolve, reject }));
      }
      await turn();
      return leg === 0 ? input.amountIn * 2n : input.amountIn / 2n + 7n;
    },
  });
  const deadlineAtMs = mode === "deadline" ? Date.now() + 250 : undefined;
  const solve = new Solver().solve(plan, noState, probe, {
    strictSession: fixture.session, deferPhase2Sim: true, finalSimTopN: 3,
    blockScanAmountGrid: "geometric",
    gridHalfWidth: 6, gssMaxTries: 4, quoteSafetyBps: 10_000n, quoteProfitFloorBps: 0n,
    signal: controller.signal, deadlineAtMs, timing,
    onDeferredCandidates() { candidates++; if (stopped) violations.push("late candidate"); },
  });
  // Observe rejection immediately, and bound this gate if orchestration fails to unwind.
  const settled = solve.then(() => "resolved", () => "rejected");
  const expectedHeld = parallel ? phase === "grid" ? 8 : 2 : 1;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const startedBy = Date.now() + 2000;
    while (held.length < expectedHeld && Date.now() < startedBy) await turn();
    assert.equal(held.length, expectedHeld, `${phase}/hop${heldLeg}: initial fan-out changed`);
    if (phase === "gss") {
      assert.equal(timing.amountPoints, 13 + expectedHeld, "cancellation must reach actual GSS after full grid");
      assert.equal(timing.gssPoints, expectedHeld);
    }
    stopped = true;
    if (mode === "abort") controller.abort(new Error("fixture new head"));
    assert.equal(await Promise.race([settled, new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("solver did not unwind cancellation")), 2000);
    })]), "rejected");
    assert.ok(held.every(({ input }) => input.control?.signal?.aborted), "nested quotes missed abort");
    const counts = canonical({ calls, builds, candidates, timing });
    // Noncooperative initial-pair replies arrive only after the solve rejects.
    held.forEach((item, i) => i % 2 === 0
      ? item.resolve(item.leg === 0 ? item.input.amountIn * 2n : item.input.amountIn / 2n + 7n)
      : item.reject(new Error("late domain rejection")));
    await turn();
    await turn();
    assert.equal(canonical({ calls, builds, candidates, timing }), counts, "late reply mutated settled solve");
    assert.deepEqual(violations, []);
    assert.equal(builds, 0);
    assert.equal(candidates, 0);
  } finally {
    clearTimeout(watchdog);
    controller.abort();
    held.forEach((item) => item.reject(new Error("fixture cleanup")));
    await settled;
  }
}

// Keep the real queue/memo behavior: counting logical issueExact calls alone
// misses cold identical reads amplified by independent amount concurrency.
async function transportReuse(Solver: SolverClass, positive = false, pairParallel = false, reuse = false): Promise<number[]> {
  const plan = makePlans(1)[0]!;
  const backend = new PinnedRethQuoteBackend("http://offline.invalid", `0x${"ab".repeat(32)}`);
  const transport = backend as unknown as {
    flushBatch(items: unknown[]): Promise<void>;
    resolveItem(item: unknown, value: string): void;
  };
  let itemsSent = 0;
  let ordinal = 0;
  let pairActive = 0;
  let pairPeak = 0;
  let pairOverlaps = 0;
  const phaseByAmount = new Map<bigint, number>();
  transport.flushBatch = async (items) => {
    itemsSent += items.length;
    await turn();
    for (const item of items) transport.resolveItem(item, "0x01");
  };
  const fixture = sharedSession([plan], {
    async quote(input, leg) {
      const amount = leg === 0 ? input.amountIn : input.amountIn / 2n;
      if (leg === 0) phaseByAmount.set(amount, ordinal++);
      const index = phaseByAmount.get(amount)!;
      const gss = index >= 5 && index < 9;
      const pair = index === 5 || index === 6;
      const before = itemsSent;
      if (pair) {
        if (pairActive > 0) pairOverlaps++;
        pairPeak = Math.max(pairPeak, ++pairActive);
      }
      // Separate GSS calldata ensures the initial pair hits COLD shared keys,
      // not the completed grid memo; later GSS/finalists and warm runs reuse.
      await backend.call({ to: input.edge.target, data: gss ? "0x18160ddd" : "0x0902f1ac" }, input.control);
      if (pair) {
        pairActive--;
        assert.ok(itemsSent - before <= 1, "identical initial-pair hop amplified transport items");
      }
      return leg === 0 ? input.amountIn * 2n : input.amountIn / 2n + (positive ? 7n : -1n);
    },
    onBuild() { assert.ok(positive, "negative transport fixture built a plan"); },
  });
  const counts: number[] = [];
  try {
    for (const _cache of ["cold", "warm"]) {
      const before = itemsSent;
      const timing = timingSink();
      ordinal = 0;
      phaseByAmount.clear();
      const solve = new Solver().solve(plan, noState, probe, {
        strictSession: fixture.session, blockScanAmountGrid: "geometric", gridHalfWidth: 2, gssMaxTries: 4,
        quoteSafetyBps: 10_000n, quoteProfitFloorBps: 0n, timing,
        deferPhase2Sim: true, finalSimTopN: 1,
      });
      if (positive) assert.ok(await solve);
      else await assert.rejects(solve, /no profitable plan/);
      assert.equal(timing.amountPoints, positive ? 9 : 5);
      assert.equal(timing.gssPoints, positive ? 4 : 0);
      assert.equal(timing.hopExactCalls, positive ? reuse ? 18 : 20 : 10);
      counts.push(itemsSent - before);
    }
    assert.equal(pairPeak, positive ? pairParallel ? 2 : 1 : 0);
    assert.equal(pairOverlaps, positive && pairParallel ? 4 : 0, "both cold/warm GSS hops must overlap");
  } finally {
    await backend.closeAndDrain();
  }
  return counts;
}

// Run the real non-deferred construction/final-simulation path, including
// funding-build rejection, failed sims and fallback to the third finalist.
async function finalFallbacks(Solver: SolverClass, reuse: boolean,
  mode: "fallback" | "build-domain" | "sim-domain") {
  const plan = makePlans(1)[0]!;
  const timing = timingSink();
  const funding = ["fixture-build-fail", "fixture-sim-fail", "morpho-flash"];
  const handles = new WeakMap<FixtureExactHandle, { input: FixtureExactInput; search: boolean }>();
  const searched: string[] = [], built: string[] = [], roots: string[] = [], simulated: string[] = [];
  const fundingLookups: Array<bigint | undefined> = [];
  let searchEnded = false;
  let finalist = 0;
  const fixture = sharedSession([plan], {
    onExact(input, handle) {
      handles.set(handle, { input, search: !searchEnded });
      if (!searchEnded) searched.push(canonical([input.edge.target, input.amountIn, handle.amountOut]));
    },
    onBuildExecution(input) {
      const issued = handles.get(input.exact);
      assert.ok(issued, "construction replaced an issued handle");
      assert.equal(issued.search, reuse);
      built.push(canonical([issued.input.edge, issued.input.amountIn, input.exact.amountOut, input.minAmountOut]));
    },
  });
  const session = Object.freeze({
    ...fixture.session,
    fundingActionIds(_asset: string, amount?: bigint) {
      searchEnded = true;
      fundingLookups.push(amount);
      if (amount !== undefined) finalist++;
      return funding;
    },
    buildFundingRoot(input: Parameters<typeof fixture.session.buildFundingRoot>[0]) {
      roots.push(canonical(input));
      if (mode === "build-domain" || (mode === "fallback" && input.actionAdapterId === funding[0])) {
        throw new BlockScanFamilyAttributedError("fixture-funding", "funding root",
          new Error(`fixture funding failure ${input.amount}`));
      }
      return fixture.session.buildFundingRoot(input);
    },
  }) as unknown as typeof fixture.session;
  let returned: ResolvedPlan | undefined;
  let error: unknown = null;
  const logs: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => { logs.push(args.join(" ")); };
    returned = await new Solver().solve(plan, noState, {
      executor: EXECUTOR,
      async simulate(candidate) {
        simulated.push(canonical(candidate));
        return mode === "fallback" && finalist === 3 && candidate.root.adapterId === funding[2]
          ? { success: true, netProfit: 11n }
          : { success: false, netProfit: 0n, revertReason: "fixture final simulation rejection" };
      },
    }, {
      strictSession: session, blockScanAmountGrid: "geometric", gridHalfWidth: 2, gssMaxTries: 4, finalSimTopN: 3,
      quoteSafetyBps: 10000n, quoteProfitFloorBps: 0n, timing,
      onDeferredCandidates() { assert.fail("full simulation path deferred candidates"); },
    });
  } catch (caught) {
    const failure = caught as Error & { familyId?: string };
    error = { name: failure.name, message: failure.message, familyId: failure.familyId };
  } finally {
    console.log = originalLog;
  }
  assert.equal(timing.amountPoints, 9);
  assert.equal(timing.gssPoints, 4);
  assert.equal(timing.hopExactCalls, reuse ? 18 : 24);
  assert.equal(fixture.stats.calls, timing.hopExactCalls);
  assert.equal(searched.length, 18);
  assert.equal(finalist, 3);
  assert.equal(built.length, 18, "all nine funding alternatives must still build both legs");
  assert.equal(roots.length, 9);
  assert.equal(simulated.length, mode === "build-domain" ? 0 : mode === "fallback" ? 6 : 9);
  assert.equal(error === null, mode === "fallback");
  if (mode === "build-domain") assert.equal((error as { familyId: string }).familyId, "fixture-funding");
  return canonical({ returned, error, searched: searched.sort(), built, roots, simulated, fundingLookups, logs });
}

async function solveLocalHandles() {
  const plan = makePlans(1)[0]!;
  const solver = new AnvilSolver();
  let generation = 0;
  let built = 0;
  const issued = new WeakMap<FixtureExactHandle, number>();
  const fixture = sharedSession([plan], {
    onExact(_input, handle) { issued.set(handle, generation); },
    onBuildExecution(input) {
      assert.equal(issued.get(input.exact), generation, "same solver/session reused a previous solve's handle");
      built++;
    },
  });
  let prior: string | undefined;
  for (generation = 1; generation <= 2; generation++) {
    const before = fixture.stats.calls;
    const timing = timingSink();
    const result = await solver.solve(plan, noState, probe, {
      strictSession: fixture.session, blockScanAmountGrid: "geometric", gridHalfWidth: 2, gssMaxTries: 4, finalSimTopN: 3,
      quoteSafetyBps: 10000n, quoteProfitFloorBps: 0n, deferPhase2Sim: true, timing,
      onDeferredCandidates(candidates) { assert.equal(candidates.length, 3); },
    });
    assert.equal(fixture.stats.calls - before, 18, "each solve must issue its own full search");
    if (prior) assert.equal(canonical(result), prior);
    prior = canonical(result);
  }
  assert.equal(built, 12);
}

async function constructionCancellation(Solver: SolverClass, boundary: "search-end" | "before-build") {
  const plan = makePlans(1)[0]!;
  const controller = new AbortController();
  const timing = timingSink();
  let builds = 0, candidates = 0;
  const fixture = sharedSession([plan], { onBuild() { builds++; } });
  const session = Object.freeze({
    ...fixture.session,
    fundingActionIds(_asset: string, amount?: bigint) {
      if ((boundary === "search-end") === (amount === undefined)) {
        assert.equal(timing.amountPoints, 9);
        assert.equal(timing.gssPoints, 4);
        controller.abort(new Error(`fixture cancellation ${boundary}`));
      }
      return ["morpho-flash"];
    },
  }) as unknown as typeof fixture.session;
  try {
    await assert.rejects(new Solver().solve(plan, noState, probe, {
      strictSession: session, blockScanAmountGrid: "geometric", gridHalfWidth: 2, gssMaxTries: 4, finalSimTopN: 3,
      quoteSafetyBps: 10000n, quoteProfitFloorBps: 0n, deferPhase2Sim: true,
      signal: controller.signal, timing, onDeferredCandidates() { candidates++; },
    }), /abort|deadline/);
    assert.equal(controller.signal.aborted, true);
    const counts = canonical({ calls: fixture.stats.calls, timing });
    await turn();
    await turn();
    assert.equal(canonical({ calls: fixture.stats.calls, timing }), counts, "cancelled construction progressed late");
    assert.equal(builds, 0);
    assert.equal(candidates, 0);
  } finally {
    controller.abort();
  }
}

const args = process.argv.slice(2);
const baselineGssParallel = args.includes("--baseline-gss-parallel");
const baselineGridParallel = baselineGssParallel || args.includes("--baseline-grid-parallel");
for (const flag of ["--baseline-grid-parallel", "--baseline-gss-parallel"]) {
  if (args.includes(flag)) args.splice(args.indexOf(flag), 1);
}
assert.equal(args.length, 2,
  "usage: solver-grid-quote-concurrency.ts --baseline-solver <module.mts> [--baseline-grid-parallel|--baseline-gss-parallel]");
assert.equal(args[0], "--baseline-solver");
const baselineUrl = pathToFileURL(resolve(args[1]!)).href;
const { AnvilSolver: BaselineSolver } = await import(baselineUrl) as { AnvilSolver: SolverClass };
assert.equal(typeof BaselineSolver, "function", "baseline must export AnvilSolver");
assert.notEqual(BaselineSolver, AnvilSolver, "baseline cannot be the candidate module");
assert.deepEqual(await transportReuse(BaselineSolver), [2, 0]);
assert.deepEqual(await transportReuse(AnvilSolver), [2, 0]);
console.log("solver-grid-quote-concurrency cold/warm transport items PASS (2/0, unchanged)");
assert.deepEqual(await transportReuse(BaselineSolver, true, baselineGssParallel), [4, 0]);
assert.deepEqual(await transportReuse(AnvilSolver, true, true, true), [4, 0]);
console.log("solver-grid-quote-concurrency positive GSS cold-pair sharing PASS (4/0 total, unchanged)");
for (const scenario of scenarios) {
  const baseline = await measure(BaselineSolver, scenario, baselineGssParallel);
  const candidate = await measure(AnvilSolver, scenario, true, true);
  assert.equal(candidate.equivalent, baseline.equivalent, `${scenario.name}: baseline behavior diverged`);
  assert.equal(baseline.peak, baselineGridParallel ? Math.min(8, scenario.grid.length) : 1,
    "baseline grid concurrency differs from explicit runner option");
  assert.equal(candidate.peak, Math.min(8, scenario.grid.length), "grid cap must be exactly eight");
  if (!baselineGridParallel) assert.notDeepEqual(candidate.completed.slice(0, scenario.grid.length),
    baseline.completed.slice(0, scenario.grid.length), "fixture did not force out-of-order grid replies");
  else assert.deepEqual(candidate.completed.slice(0, scenario.grid.length),
    baseline.completed.slice(0, scenario.grid.length), "incremental patch changed grid reply order");
  const groups = scenario.debtBps?.length ?? 1;
  const savedWaves = candidate.pairPeak && !baselineGssParallel ? groups * (scenario.gssFailureHop === 0 ? 1 : 2) : 0;
  assert.equal(baseline.waves.gss - candidate.waves.gss, savedWaves,
    "same GSS probes must save exactly the initial pair's dependent hop waves");
  assert.equal(baseline.waves.final, 2 * baseline.finalists);
  assert.equal(candidate.waves.final, 0, "finalists must not reissue quotes");
  assert.equal(baseline.hopExactCalls - candidate.hopExactCalls, 2 * candidate.finalists);
  if (baselineGridParallel) assert.equal(baseline.waves.grid, candidate.waves.grid, "grid work changed");
  console.log(`solver-grid-quote-concurrency ${scenario.name} PASS ` +
    `(grid peak=${candidate.peak}, pair=${baseline.pairPeak}->${candidate.pairPeak}, ` +
    `GSS waves=${baseline.waves.gss}->${candidate.waves.gss}, ` +
    `calls=${baseline.hopExactCalls}->${candidate.hopExactCalls})`);
}
for (const mode of ["abort", "deadline"] as const) {
  await cancellation(BaselineSolver, mode, baselineGridParallel);
  await cancellation(AnvilSolver, mode, true);
  for (const leg of [0, 1]) {
    await cancellation(BaselineSolver, mode, baselineGssParallel, "gss", leg);
    await cancellation(AnvilSolver, mode, true, "gss", leg);
  }
}
for (const mode of ["fallback", "build-domain", "sim-domain"] as const) {
  assert.equal(await finalFallbacks(AnvilSolver, true, mode), await finalFallbacks(BaselineSolver, false, mode),
    `${mode}: full simulation/funding fallback behavior changed`);
  console.log(`solver-grid-quote-concurrency full-sim ${mode} PASS (24->18 calls, same nine funding builds)`);
}
await solveLocalHandles();
for (const boundary of ["search-end", "before-build"] as const) {
  await constructionCancellation(BaselineSolver, boundary);
  await constructionCancellation(AnvilSolver, boundary);
}
console.log(`solver-grid-quote-concurrency PASS (${scenarios.length} equivalence cases; ` +
  "12 grid/GSS + 4 construction cancellation cases; 3 full-sim/funding cases; solve-local handles; cold/warm transport)");
