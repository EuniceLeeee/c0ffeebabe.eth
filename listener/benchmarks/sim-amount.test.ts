import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { measureSimHead } from "./sim-amount.js";
import { BlockScanPassTimeline } from "../src/searcher/blockscan-pass-timeline.js";
import type { BlockScanRuntimeLoop } from "../src/searcher/blockscan-runtime-loop.js";
import type { AdapterRuntimeSnapshot } from "../src/searcher/adapter-runtime-coordinator.js";
import { scheduledFixture } from "./live-stage-test-fixture.js";
import { assertLiveStageMode, createBenchmarkRuntimeAbort, measureLiveHead, parseLiveStageOptions } from "./live-stage.js";

type Diagnostic = NonNullable<Parameters<BlockScanRuntimeLoop["runHead"]>[2]>;
const head = { number: 100, hash: `0x${"ab".repeat(32)}` };
function fixture() {
  const snapshot = { sourceBlock: head.number, sourceBlockHash: head.hash, generation: 3,
    pricing: { effectiveMids: { complete: true, source: { ...head, generation: 3 } } } } as AdapterRuntimeSnapshot;
  const timeline = new BlockScanPassTimeline(1);
  timeline.boundaries.planner_solver.status = "ran";
  const result: Parameters<Diagnostic["onComplete"]>[0] = { outcome: "ran", reason: undefined,
    timing: { stateMs: 50, enumerationMs: 10, exactRefineMs: 0, plannerSolverMs: 25, finalSimMs: 0, evMs: 0 },
    totalMs: 90, planned: 2, quotePositive: 1, atomicResults: [], detail: {
      stages: timeline.boundaries, plannerBuildMs: 3, solverWallMs: 22, solverPlans: 2,
      solverQuoteWorkers: 2, solverAmountPoints: 5, solverGssPoints: 0, solverHopExactCalls: 10, exactTransportDrainMs: 5,
    } };
  return { snapshot, result };
}

test("sim timing calls the same live runHead and keeps prerequisite cost separate, not erased", async () => {
  const { snapshot, result } = fixture(); let time = 0;
  const events: string[] = [];
  const measured = await measureSimHead({ head, budgetMs: 100, now: () => time,
    noteHead() { events.push("notification"); }, latestPricing: () => snapshot.pricing,
    ...scheduledFixture({ async runHead(n, received, d) {
      events.push("live"); assert.equal(n, 100); assert.equal(received.sourceHeadSeenAtMonotonicMs, 0);
      assert.equal(d!.through, "solver");
      time = 50; d!.onSnapshot(snapshot); time = 60;
      d!.onEnumeration({ outcome: "ran", opportunities: [] } as never);
      d!.onSizingStart!();
      time = 85; d!.onSolver!({ solverIndex: 0, opportunity: {} as never, maxFlashAmount: 100n,
        wallMs: 22, timing: { quoteMs: 12, planBuildMs: 1, simMs: 15, amountPoints: 1, gssPoints: 0, hopExactCalls: 2 },
        outcome: "no_opportunity", positiveCandidates: 0 });
      time = 90; d!.onComplete(result);
    } }),
  });
  assert.deepEqual(events, ["notification", "live"]);
  assert.equal(measured.metrics.totalMs, 90);
  assert.equal(measured.metrics.stageMs, 30, "native sizing plus final drain");
  assert.equal(measured.metrics.prerequisitesMs, 60);
  assert.equal(measured.metrics.live!.timing.plannerSolverMs, 25);
  assert.equal(measured.metrics.live!.detail!.solverWallMs, 22);
  assert.equal(measured.solvers[0]!.outcome, "no_opportunity", "negative results are not discarded");
  assert.equal(measured.metrics.status, "completed");
});

test("timed out selection keeps native partial stage/route results; not labelled completed", async () => {
  const { snapshot, result } = fixture(); let time = 0;
  const measured = await measureSimHead({ head, budgetMs: 80, now: () => time, noteHead() {}, latestPricing: () => snapshot.pricing,
    ...scheduledFixture({ async runHead(_n, _r, d) {
      time = 50; d!.onSnapshot(snapshot); time = 60; d!.onSizingStart!(); time = 90;
      d!.onComplete({ ...result, outcome: "budget_exceeded", reason: "https://rpc.invalid/synthetic-secret" });
    } }),
  });
  assert.equal(measured.metrics.status, "timeout");
  assert.equal(measured.metrics.stageMs, 30);
  assert(!JSON.stringify(measured.metrics).includes("synthetic-secret"));
});

test("upstream failure cannot masquerade as zero-millisecond sim sample", async () => {
  const { result } = fixture(); result.detail!.stages.planner_solver.status = "not-run";
  const measured = await measureSimHead({ head, budgetMs: 100, noteHead() {}, latestPricing() {},
    ...scheduledFixture({ async runHead(_n, _r, d) { d!.onComplete({ ...result, outcome: "stale_state" }); } }),
  });
  assert.equal(measured.metrics.status, "failed");
  assert.equal(measured.metrics.stageMs, null);
});

test("entrypoints stay thin: no benchmark-owned dispatch, quote propagation, or candidate selection", () => {
  for (const name of ["sim-amount", "effective-update"]) {
    const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8");
    assert.match(source, /runLiveStageBenchmark/);
    assert.doesNotMatch(source, /runOrderedBlockScanPipeline|createTrialLimiter|propagateAmounts|\.prepare\(|\.solve\(/);
  }
  const source = readFileSync(new URL("./live-stage.ts", import.meta.url), "utf8");
  assert.match(source, /input\.loop\.schedule/);
  assert.match(source, /input\.loop\.waitForIdle/);
  assert.doesNotMatch(source, /input\.loop\.runHead/);
  assert.match(source, /createBlockScanLiveAmountSelectorFactory/);
  assert.match(source, /resolveBlockScanLiveStageSettings/);
  assert.doesNotMatch(source, /runOrderedBlockScanPipeline|createTrialLimiter|propagateAmounts|\.prepare\(|\.solve\(/);
});

test("runtime shutdown in repetition one does not cancel repetition two; external interrupt still does", () => {
  const parent = new AbortController(), first = createBenchmarkRuntimeAbort(parent.signal);
  first.controller.abort(new Error("runtime shutdown")); first.detach();
  assert.equal(parent.signal.aborted, false);
  const second = createBenchmarkRuntimeAbort(parent.signal);
  assert.equal(second.controller.signal.aborted, false);
  const reason = new Error("experiment interrupted"); parent.abort(reason);
  assert.equal(second.controller.signal.reason, reason); second.detach();
  const late = createBenchmarkRuntimeAbort(parent.signal);
  assert.equal(late.controller.signal.reason, reason); late.detach();
});

test("benchmark mode admission uses live's 0/1 spelling, never treats false as an accepted override", () => {
  for (const key of ["SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK", "SEARCHER_BLOCKSCAN_EXACT_REFINE_ENABLED"]) {
    for (const value of [undefined, "0"]) assert.doesNotThrow(() => assertLiveStageMode({ [key]: value }));
    for (const value of ["false", "true", "", "no", "1"]) assert.throws(() => assertLiveStageMode({ [key]: value }));
  }
});

for (const independent of [false, true]) test(`long prerequisites and sizing budgets are reported separately (independent=${independent})`, async () => {
  const { snapshot, result } = fixture(); let time = 0;
  const measured = await measureSimHead({ head, budgetMs: 60_000, sizingBudgetMs: independent ? 30_000 : undefined,
    now: () => time, noteHead() {}, latestPricing: () => snapshot.pricing,
    ...scheduledFixture({ async runHead(_n, _r, d) {
      assert.equal(d!.sizingBudgetMs, independent ? 30_000 : undefined);
      time = 59_000; d!.onSnapshot(snapshot); d!.onSizingStart!();
      time = 88_000; d!.onComplete(result);
    } }),
  });
  assert.equal(measured.metrics.status, independent ? "completed" : "timeout");
  assert.equal(measured.metrics.prerequisitesMs, 59_000);
  assert.equal(measured.metrics.stageMs, 29_000);
  assert.equal(measured.metrics.totalMs, 88_000);
  assert.deepEqual(measured.metrics.budgets, { sharedPassBudgetMs: independent ? null : 60_000,
    prerequisiteBudgetMs: independent ? 60_000 : null, sizingBudgetMs: independent ? 30_000 : null });
});

for (const phase of ["prerequisites", "sizing", "drain", "parent-abort", "new-head"] as const)
test(`independent budgets retain ${phase} classification`, async () => {
  const { snapshot, result } = fixture(); let time = 0;
  const abort = new AbortController();
  const measured = await measureSimHead({ head, budgetMs: 60_000, sizingBudgetMs: 30_000, signal: abort.signal,
    now: () => time, noteHead() {}, latestPricing: () => snapshot.pricing,
    ...scheduledFixture({ async runHead(_n, _r, d) {
      time = 59_000; d!.onSnapshot(snapshot);
      if (phase === "prerequisites") { time = 60_000; d!.onComplete({ ...result, outcome: "budget_exceeded" }); return; }
      d!.onSizingStart!(); time = phase === "sizing" ? 89_000 : 60_000;
      if (phase === "parent-abort") abort.abort(new Error("fixture parent interrupt"));
      d!.onComplete({ ...result, ...(phase === "new-head" ? { outcome: "stale_state", reason: "source_head_superseded" } : {}) });
      if (phase === "drain") time = 89_000;
    } }),
  });
  assert.equal(measured.metrics.status, phase === "parent-abort" || phase === "new-head" ? "aborted" : "timeout");
  assert.equal(measured.metrics.stageMs, phase === "prerequisites" ? null : phase === "sizing" || phase === "drain" ? 30_000 : 1_000);
});

test("independent sizing rejects effective/setup and non-finite, nonpositive or unbounded budgets before scheduling", async () => {
  for (const overrides of [{ stage: "effective-update" as const }, { setup: true },
    ...[NaN, Infinity, -1, 0, 3_600_001].map(sizingBudgetMs => ({ sizingBudgetMs }))]) {
    await assert.rejects(measureLiveHead({ stage: "sim-amount", head, budgetMs: 60_000, sizingBudgetMs: 30_000,
      noteHead() { assert.fail("invalid mode must not reach notification"); }, latestPricing() {},
      setDiagnostic() { assert.fail("invalid mode must not install a diagnostic"); },
      loop: { schedule() { assert.fail("invalid mode must not schedule"); }, async waitForIdle() {} }, ...overrides }), /sizingBudgetMs/);
  }
});

test("CLI keeps sizing opt-in and bounded, rejects it for effective, and preserves the planned separate budgets", () => {
  const path = fileURLToPath(import.meta.url);
  const argv = ["--ready", path, "--heads", path, "--out", `${path}.unused`];
  assert.equal(parseLiveStageOptions(argv, "sim-amount")!.sizingBudgetMs, undefined);
  const args = parseLiveStageOptions([...argv, "--block-budget-ms", "60000", "--sizing-budget-ms", "30000",
    "--setup-budget-ms", "900000", "--repetitions", "3"], "sim-amount")!;
  assert.equal(args.blockBudgetMs, 60_000); assert.equal(args.sizingBudgetMs, 30_000);
  assert.equal(args.setupBudgetMs, 900_000); assert.equal(args.repetitions, 3);
  assert.throws(() => parseLiveStageOptions([...argv, "--sizing-budget-ms", "30000"], "effective-update"), /only applicable/);
  for (const value of ["NaN", "Infinity", "-1", "0", "30000.5", "3600001"]) {
    assert.throws(() => parseLiveStageOptions([...argv, `--sizing-budget-ms=${value}`], "sim-amount"), /invalid benchmark integer/);
  }
});
