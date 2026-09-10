import assert from "node:assert/strict";
import { test } from "node:test";
import { runOrderedBlockScanPipeline } from "../blockscan-ordered-pipeline.js";
import { BlockScanPassTimeline } from "../blockscan-pass-timeline.js";
import { AnvilSolver, type ResolvedPlan, type SolverTiming } from "../solver/solver.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { canonical, EXECUTOR, makePlans, sharedSession } from "./blockscan-solver-quote-concurrency.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const defaults = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 5_000 });
function untilAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

test("ordered prefix reaches the consumer while a later solver is still pending", async () => {
  const releases = Array.from({ length: 3 }, () => deferred<number[]>());
  const consumed: number[] = [];
  let producerCompletion: boolean | undefined;
  const run = runOrderedBlockScanPipeline({
    ...defaults(), count: 3, workers: [0, 1, 2],
    produce: (index) => releases[index]!.promise,
    consume: async (index, values) => { assert.deepEqual(values, [index, index]); consumed.push(index); },
    onProducersSettled: (completed) => { producerCompletion = completed; },
  });
  releases[1]!.resolve([1, 1]);
  await turn();
  assert.deepEqual(consumed, [], "later plan must not overtake the first plan");
  releases[0]!.resolve([0, 0]);
  await turn();
  assert.deepEqual(consumed, [0, 1]);
  assert.equal(producerCompletion, undefined, "first simulation must not await all solvers");
  releases[2]!.resolve([2, 2]);
  await run;
  assert.deepEqual(consumed, [0, 1, 2]);
  assert.equal(producerCompletion, true);
});

test("empty/failed/skipped quote sets advance without changing fallback order", async () => {
  const sets = [[], [10, 11, 12], [], [30, 31]];
  const consumed: number[] = [];
  await runOrderedBlockScanPipeline({
    ...defaults(), count: sets.length, workers: [0, 1],
    produce: async (index) => sets[index]!,
    consume: async (_index, values) => { consumed.push(...values); },
  });
  assert.deepEqual(consumed, [10, 11, 12, 30, 31]);
  await runOrderedBlockScanPipeline({
    ...defaults(), count: 0, workers: [],
    produce: async () => { assert.fail("empty plan set produced work"); },
    consume: async () => { assert.fail("empty plan set consumed work"); },
  });
});

test("producer failure aborts sibling work and drains before returning", async () => {
  const failure = new Error("source mismatch");
  let drained = false;
  let completed: boolean | undefined;
  await assert.rejects(runOrderedBlockScanPipeline({
    ...defaults(), count: 2, workers: [0, 1],
    produce: async (index, _worker, signal) => {
      if (index === 0) { await turn(); throw failure; }
      try { return await untilAborted(signal); }
      finally { await turn(); drained = true; }
    },
    consume: async () => { assert.fail("failed prefix must not reach final sim"); },
    onProducersSettled: (value) => { completed = value; },
  }), (error) => error === failure);
  assert.equal(drained, true);
  assert.equal(completed, false);
});

test("consumer failure cancels and drains outstanding solvers", async () => {
  const failure = new Error("final sim source revoked");
  let drained = false;
  await assert.rejects(runOrderedBlockScanPipeline({
    ...defaults(), count: 2, workers: [0, 1],
    produce: async (index, _worker, signal) => {
      if (index === 0) return 0;
      try { return await untilAborted(signal); }
      finally { await turn(); drained = true; }
    },
    consume: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(drained, true);
});

test("new head cancels the consumer and prevents buffered/unclaimed work from running", async () => {
  const controller = new AbortController();
  const failure = new Error("new head");
  const entered = deferred();
  const seen: number[] = [];
  const run = runOrderedBlockScanPipeline({
    ...defaults(), signal: controller.signal, count: 10, workers: [0, 1],
    produce: async (index) => index,
    consume: async (index, _value, signal) => {
      seen.push(index); entered.resolve();
      await untilAborted(signal);
    },
  });
  await entered.promise;
  controller.abort(failure);
  await assert.rejects(run, (error) => error === failure);
  assert.deepEqual(seen, [0]);
});

test("deadline wakes a waiting prefix and joins cancellation cleanup", async () => {
  let drained = false;
  await assert.rejects(runOrderedBlockScanPipeline({
    ...defaults(), deadlineAtMs: Date.now() + 20, count: 1, workers: [0],
    produce: async (_index, _worker, signal) => {
      try { return await untilAborted(signal); }
      finally { await turn(); drained = true; }
    },
    consume: async () => { assert.fail("timed-out quote must not be consumed"); },
  }), /deadline elapsed/);
  assert.equal(drained, true);
});

test("pre-cancelled source issues no work; observer failure is not an unhandled rejection", async () => {
  const controller = new AbortController();
  controller.abort(new Error("old source"));
  await assert.rejects(runOrderedBlockScanPipeline({
    ...defaults(), signal: controller.signal, count: 1, workers: [0],
    produce: async () => { assert.fail("old source work"); },
    consume: async () => { assert.fail("old source result"); },
  }), /old source/);
  await assert.rejects(runOrderedBlockScanPipeline({
    ...defaults(), count: 1, workers: [0], produce: async () => 1,
    consume: async () => {}, onProducersSettled: () => { throw new Error("observer failed"); },
  }), /observer failed/);
});

test("actual Solver keeps exact propagation, grid/GSS sizing and finalist bytes", async () => {
  const plans = makePlans(6);
  const run = async (pipelined: boolean) => {
    const fixture = sharedSession(plans);
    const results: unknown[] = [];
    const produce = async (index: number, solver: AnvilSolver, signal: AbortSignal) => {
      const timing: SolverTiming = { quoteMs: 0, planBuildMs: 0, simMs: 0, amountPoints: 0, gssPoints: 0, hopExactCalls: 0 };
      let finalists: readonly ResolvedPlan[] = [];
      const solved = await solver.solve(plans[index]!, {
        async call() { throw new Error("fixture must use the strict session"); },
      } as unknown as StateBackend, {
        executor: EXECUTOR, async simulate() { throw new Error("unexpected quote-phase simulation"); },
      }, {
        deferPhase2Sim: true, finalSimTopN: 3, gridHalfWidth: 2, gssMaxTries: 4,
        quoteSafetyBps: 10_000n, quoteProfitFloorBps: 0n, strictSession: fixture.session,
        signal, timing, onDeferredCandidates: (values) => { finalists = values; },
      });
      assert.equal(timing.amountPoints, 8);
      assert.equal(timing.gssPoints, 4);
      assert.equal(timing.hopExactCalls, 16);
      assert.equal(timing.simMs, 0);
      const selected = finalists.length ? finalists : [solved];
      assert.equal(selected.length, 3);
      return selected;
    };
    if (pipelined) {
      await runOrderedBlockScanPipeline({
        ...defaults(), count: plans.length, workers: [new AnvilSolver(), new AnvilSolver()],
        produce, consume: async (index, values) => { results.push({ index, values }); },
      });
    } else {
      const all = await Promise.all(plans.map((_plan, index) => produce(index, new AnvilSolver(), defaults().signal)));
      all.forEach((values, index) => results.push({ index, values }));
    }
    return { results: canonical(results), calls: fixture.stats.calls };
  };
  assert.deepEqual(await run(true), await run(false));
});

test("atomic stage times remain independent when EV finishes before all solvers", () => {
  const now = Date.now();
  const timeline = new BlockScanPassTimeline(now - 1_000);
  timeline.begin("planner_solver", { atMs: now - 900, atPerf: performance.now() - 900 });
  timeline.mergeAtomic("final_sim", now - 800, now - 700, 100);
  timeline.mergeAtomic("ev", now - 700, now - 650, 50);
  timeline.finish("planner_solver");
  assert.equal(timeline.boundaries.final_sim.cumulative_ms, 300);
  assert.equal(timeline.boundaries.ev.cumulative_ms, 350);
  assert.equal(timeline.timing.finalSimMs, 100);
  assert.ok(timeline.boundaries.planner_solver.cumulative_ms! >= 1_000);
  assert.ok(timeline.boundaries.ev.finished_at_ms! < timeline.boundaries.planner_solver.finished_at_ms!);
});
