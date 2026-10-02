import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { measureSimHead } from "./sim-amount.js";
import { BlockScanPassTimeline } from "../src/searcher/blockscan-pass-timeline.js";
import type { BlockScanRuntimeLoop } from "../src/searcher/blockscan-runtime-loop.js";
import type { AdapterRuntimeSnapshot } from "../src/searcher/adapter-runtime-coordinator.js";
import { scheduledFixture } from "./live-stage-test-fixture.js";
import { assertLiveStageMode, createBenchmarkRuntimeAbort } from "./live-stage.js";

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
