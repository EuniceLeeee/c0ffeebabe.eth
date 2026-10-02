import assert from "node:assert/strict";
import test from "node:test";
import { measureEffectiveHead, parseHeads, assertEffectivePublication, withoutProductionConsole } from "./effective-update.js";
import type { AdapterRuntimeSnapshot } from "../src/searcher/adapter-runtime-coordinator.js";
import type { BlockScanRuntimeLoop } from "../src/searcher/blockscan-runtime-loop.js";
import { scheduledFixture } from "./live-stage-test-fixture.js";

const hash = `0x${"ab".repeat(32)}`, head = { number: 100, hash };
type Diagnostic = NonNullable<Parameters<BlockScanRuntimeLoop["runHead"]>[2]>;
const result = (outcome = "ran"): Parameters<Diagnostic["onComplete"]>[0] => ({ outcome, reason: undefined,
  timing: { stateMs: 60, enumerationMs: 0, exactRefineMs: 0, plannerSolverMs: 0, finalSimMs: 0, evMs: 0 }, totalMs: 65,
  planned: 0, quotePositive: 0, atomicResults: [] });
function snapshot() {
  return { sourceBlock: head.number, sourceBlockHash: hash, generation: 3,
    pricing: { effectiveMids: { complete: true, source: { ...head, generation: 3 } } } } as AdapterRuntimeSnapshot;
}

test("measures actual runHead from notification through its drain; excludes preceding setup", async () => {
  let clock = 9000;
  const price = snapshot(), events: string[] = [];
  const measured = await measureEffectiveHead({ head, budgetMs: 100, now: () => clock,
    noteHead() { events.push("notification"); clock += 1; }, latestPricing: () => price.pricing,
    ...scheduledFixture({ async runHead(number, received, diagnostic) {
      assert.equal(number, 100); assert.equal(received.sourceHeadSeenAtMonotonicMs, 9000);
      assert.equal(diagnostic!.through, "prices"); events.push("live-runHead");
      clock += 60; diagnostic!.onSnapshot(price); clock += 4; diagnostic!.onComplete(result());
    } }),
  });
  assert.deepEqual(events, ["notification", "live-runHead"]);
  assert.equal(measured.metrics.status, "completed");
  assert.equal(measured.metrics.publicationReadyMs, 61);
  assert.equal(measured.metrics.totalMs, 65);
  assert.equal(measured.metrics.live?.timing.stateMs, 60);
});

test("startup allows the production startup branch to settle; not an incremental measurement", async () => {
  const price = snapshot();
  const measured = await measureEffectiveHead({ head, setup: true, budgetMs: 1000, noteHead() {}, latestPricing: () => price.pricing,
    ...scheduledFixture({ async runHead(_number, _received, d) {
      assert.equal(d!.through, "enumerate"); d!.onSnapshot(price); d!.onComplete(result("startup_warm"));
    } }),
  });
  assert.equal(measured.metrics.status, "completed");
});

test("publication within budget followed by over-budget drain is not completion", async () => {
  let clock = 0;
  const price = snapshot();
  const measured = await measureEffectiveHead({ head, budgetMs: 100, now: () => clock, noteHead() {}, latestPricing: () => price.pricing,
    ...scheduledFixture({ async runHead(_number, _received, d) { clock = 90; d!.onSnapshot(price); clock = 110; d!.onComplete(result()); } }),
  });
  assert.equal(measured.metrics.publicationReadyMs, 90);
  assert.equal(measured.metrics.totalMs, 110);
  assert.equal(measured.metrics.status, "timeout");
});

test("no terminal publication, wrong head, downstream execution, and unexpected enumeration fail", async () => {
  for (const failure of ["missing", "wrong-head", "downstream", "enumeration", "source-fault"]) {
    const price = snapshot();
    const measured = await measureEffectiveHead({ head, budgetMs: 1000, noteHead() {}, latestPricing: () => price.pricing,
      ...scheduledFixture({ async runHead(_n, _r, d) {
        if (failure === "missing") return;
        if (failure === "enumeration") d!.onEnumeration({} as never);
        if (failure === "source-fault") throw new Error("https://private.rpc/synthetic-secret");
        d!.onSnapshot(failure === "wrong-head" ? { ...price, sourceBlock: 99 } : price);
        d!.onComplete({ ...result(), planned: failure === "downstream" ? 1 : 0 });
      } }),
    });
    assert.equal(measured.metrics.status, "failed", failure);
    assert(!JSON.stringify(measured.metrics).includes("synthetic-secret"));
  }
});

test("requires complete current-source atomic effective publication, never just returned bytes", () => {
  const price = snapshot();
  assert.doesNotThrow(() => assertEffectivePublication(price, price.pricing, head));
  assert.throws(() => assertEffectivePublication(price, { ...price.pricing }, head), /atomic publication/);
  const incomplete = { ...price, pricing: { ...price.pricing, effectiveMids: { ...price.pricing.effectiveMids!, complete: false } } };
  assert.throws(() => assertEffectivePublication(incomplete, incomplete.pricing, head), /effective build incomplete/);
  const stale = { ...price, generation: 4 };
  assert.throws(() => assertEffectivePublication(stale, stale.pricing, head));
});

test("production console is suppressed locally including failures, then restored", async () => {
  const original = console.error;
  let writes = 0;
  console.error = () => { writes++; };
  const intercepted = console.error;
  try {
    await assert.rejects(withoutProductionConsole(async () => { console.error("synthetic-secret"); throw new Error("failure"); }));
    assert.equal(writes, 0);
    assert.equal(console.error, intercepted);
  } finally { console.error = original; }
});

test("notification cohort cannot repeat blocks or skip transitions", () => {
  assert.deepEqual(parseHeads([head, { ...head, number: 101 }]), [head, { ...head, number: 101 }]);
  for (const bad of [[], [head, head], [head, { ...head, number: 102 }], [{ ...head, hash: "0x123" }], [{ ...head, forcedRoute: "x" }]])
    assert.throws(() => parseHeads(bad));
});
