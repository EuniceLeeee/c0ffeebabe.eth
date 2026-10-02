import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { measureLiveHead, parseLiveStageOptions } from "./live-stage.js";
import { scheduledFixture } from "./live-stage-test-fixture.js";
import type { AdapterRuntimeSnapshot } from "../src/searcher/adapter-runtime-coordinator.js";
import { cacheJson } from "./prerequisite-cache.js";

const head = { number: 100, hash: `0x${"ab".repeat(32)}` };
const snapshot = { sourceBlock: head.number, sourceBlockHash: head.hash, generation: 3,
  pricing: { effectiveMids: { complete: true, source: { ...head, generation: 3 } } } } as AdapterRuntimeSnapshot;

for (const stage of ["effective-update", "live-enumeration", "sim-amount"] as const)
test(`${stage}: cache stops serving before measured work, never changes live dispatch`, async () => {
  let phase = "prerequisite", time = 0;
  const observed: string[] = [];
  const measured = await measureLiveHead({ stage, head, budgetMs: 100, now: () => time,
    noteHead() { observed.push(`notification:${phase}`); }, latestPricing: () => snapshot.pricing,
    onMeasuredStageStart() { phase = "measured"; observed.push(`switch:${time}`); },
    ...scheduledFixture({ async runHead(_n, _r, d) {
      assert.equal(phase, stage === "effective-update" ? "measured" : "prerequisite");
      time = 50; d!.onSnapshot(snapshot);
      if (stage !== "effective-update") {
        assert.equal(phase, stage === "live-enumeration" ? "measured" : "prerequisite");
        time = 60; d!.onEnumeration({ outcome: "ran", opportunities: [] } as never);
        if (stage === "sim-amount") { d!.onSizingStart!(); assert.equal(phase, "measured"); }
      }
      time = 80; d!.onComplete({ outcome: "ran", reason: undefined, planned: 0, quotePositive: 0, atomicResults: [], totalMs: 80,
        timing: { stateMs: 50, enumerationMs: stage === "effective-update" ? 0 : 10, exactRefineMs: 0,
          plannerSolverMs: stage === "sim-amount" ? 15 : 0, finalSimMs: 0, evMs: 0 } });
    } }),
  });
  assert.equal(measured.metrics.status, "completed");
  assert.equal(measured.metrics.stageMs, stage === "effective-update" ? 80 : stage === "live-enumeration" ? 30 : 20);
  assert.equal(observed.filter(x => x.startsWith("switch:")).length, 1);
  assert.equal(observed.find(x => x.startsWith("switch:")), `switch:${stage === "effective-update" ? 0 : stage === "live-enumeration" ? 50 : 60}`);
});

test("startup never switches into measured mode, even on its snapshot callback", async () => {
  const measured = await measureLiveHead({ stage: "sim-amount", setup: true, head, budgetMs: 1000,
    noteHead() {}, latestPricing: () => snapshot.pricing,
    onMeasuredStageStart() { assert.fail("setup is not a measured stage"); },
    ...scheduledFixture({ async runHead(_n, _r, d) {
      d!.onSnapshot(snapshot); d!.onComplete({ outcome: "startup_warm", reason: undefined,
        planned: 0, quotePositive: 0, atomicResults: [], totalMs: 10,
        timing: { stateMs: 10, enumerationMs: 0, exactRefineMs: 0, plannerSolverMs: 0, finalSimMs: 0, evMs: 0 } });
    } }),
  });
  assert.equal(measured.metrics.status, "completed");
});

test("truncated enumeration retains its measured time but is not a completed sample", async () => {
  let now = 0;
  const result = await measureLiveHead({ stage: "live-enumeration", head, budgetMs: 1000, now: () => now,
    noteHead() {}, latestPricing: () => snapshot.pricing,
    ...scheduledFixture({ async runHead(_n, _r, d) {
      now = 10; d!.onSnapshot(snapshot); now = 20;
      d!.onEnumeration({ outcome: "budget_exceeded", opportunities: [] } as never);
      d!.onComplete({ outcome: "ran", reason: undefined, planned: 0, quotePositive: 0, atomicResults: [], totalMs: 20,
        timing: { stateMs: 10, enumerationMs: 10, exactRefineMs: 0, plannerSolverMs: 0, finalSimMs: 0, evMs: 0 } });
    } }),
  });
  assert.equal(result.metrics.status, "timeout"); assert.equal(result.metrics.stageMs, 10);
});

test("cache CLI is explicit, mutually exclusive, and never changes defaults", () => {
  const path = fileURLToPath(import.meta.url);
  const argv = ["--ready", path, "--heads", path, "--out", `${path}.unused`];
  assert.equal(parseLiveStageOptions(argv, "sim-amount")!.inputCache, undefined);
  assert.equal(parseLiveStageOptions(argv, "sim-amount")!.prepareCache, undefined);
  assert.equal(parseLiveStageOptions([...argv, "--prepare-cache", `${path}.cache`], "sim-amount")!.repetitions, 1);
  assert.throws(() => parseLiveStageOptions([...argv, "--prepare-cache", "a", "--input-cache", "b"], "sim-amount"), /choose/);
  assert.throws(() => parseLiveStageOptions([...argv, "--prepare-cache", "a", "--repetitions", "3"], "sim-amount"), /one repetition/);
  for (const stage of ["effective-update", "live-enumeration"] as const) {
    assert.throws(() => parseLiveStageOptions([...argv, "--prepare-cache", "a"], stage), /sim entry/);
    assert.throws(() => parseLiveStageOptions([...argv, "--sizing-budget-ms", "30000"], stage), /only applicable/);
  }
});

test("live enumeration launcher cannot select candidates or replace the production scheduler", () => {
  const source = readFileSync(new URL("./live-enumeration.ts", import.meta.url), "utf8");
  assert.match(source, /runLiveStageBenchmark\("live-enumeration"/);
  assert.doesNotMatch(source, /scanBlockState|detectProduction|runOrderedBlockScanPipeline|\.prepare\(|\.solve\(/);
});

test("real live config Map/BigInt values survive a portable manifest round-trip and bind compatibility", () => {
  const config = { pricedTokens: new Map([["0xasset", { maxBorrow: 1000n }]]), enabled: new Set(["b", "a"]) };
  const serialized = cacheJson(config);
  assert.equal(cacheJson(JSON.parse(serialized)), serialized);
  assert.notEqual(serialized, cacheJson({ ...config, pricedTokens: new Map([["0xasset", { maxBorrow: 999n }]]) }));
  assert.notEqual(serialized, cacheJson({ ...config, pricedTokens: new Map() }));
  assert.notEqual(cacheJson(1000n), cacheJson("1000n"));
});
