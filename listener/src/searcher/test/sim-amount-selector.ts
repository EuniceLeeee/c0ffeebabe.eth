import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSimAmountSelector, createTrialLimiter } from "../simulator/sim-amount-selector.js";

const plan: any = { opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n } },
  maxFlashAmount: 10000n };
const options: any = { strictSession: {}, deferPhase2Sim: true, gssMaxTries: 0,
  deadlineAtMs: Date.now() + 60000, finalSimTopN: 3 };

test("actual profit selects amount and hands top3 to independent final-sim caller", async () => {
  const calls: bigint[] = []; let deferred: any[] = [];
  const solver = createSimAmountSelector({ async evaluate(_plan, amount) {
    calls.push(amount);
    const profit = amount === 100n ? 999n : 1n;
    return { success: true, profit, value: { flashAmount: amount, netProfit: profit } as any };
  } });
  const selected = await solver.solve(plan, {} as any, { simulate() { throw Error("legacy probe used"); } } as any,
    { ...options, onDeferredCandidates: (values: any[]) => { deferred = values; } });
  assert.deepEqual(calls, [10n, 100n, 1000n, 10000n]);
  assert.equal(selected.flashAmount, 100n);
  assert.deepEqual(deferred.map(x => x.flashAmount), [100n, 10n, 1000n]);
});

test("source failure aborts selection without publishing candidates", async () => {
  const fault = new Error("source failed"); let handedOff = false;
  const solver = createSimAmountSelector({ async evaluate() { throw fault; } });
  await assert.rejects(solver.solve(plan, {} as any, {} as any,
    { ...options, onDeferredCandidates() { handedOff = true; } }), error => error === fault);
  assert.equal(handedOff, false);
});

test("nonpositive P stops and does not hand off a plan", async () => {
  let count = 0;
  const solver = createSimAmountSelector({ async evaluate() { count++; return { success: false, reason: "reverted" }; } });
  await assert.rejects(solver.solve(plan, {} as any, {} as any, options), /no positive executable/);
  assert.equal(count, 1);
});

test("shared limiter drains active work and cancels queued work without dispatch", async () => {
  const limiter = createTrialLimiter(1), controller = new AbortController();
  const control = { signal: controller.signal, deadlineAtMs: Date.now() + 5000 };
  let release!: () => void, active = 0, peak = 0, queuedRan = false;
  const first = limiter(control, async () => { peak = Math.max(peak, ++active);
    await new Promise<void>(r => { release = r; }); active--; });
  const queued = limiter(control, async () => { queuedRan = true; });
  const cancellation = new Error("cancelled");
  const rejected = assert.rejects(queued, e => e === cancellation);
  controller.abort(cancellation); await rejected;
  release(); await first;
  assert.equal(queuedRan, false); assert.equal(peak, 1); assert.equal(active, 0);
});

test("ordinary Blockscan live installs sim selection; compatibility callers and backrun retain Solver", () => {
  const loop = readFileSync(new URL("../blockscan-runtime-loop.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(loop, /this\.deps\.amountSelectorFactory\(\{ source: exactSource, workerIndex,/);
  assert.match(main, /amountSelectorFactory: createBlockScanLiveAmountSelectorFactory\(/);
  assert.match(main, /return \(\{ source, workerIndex, simulate \}\) => createBlockScanSimAmountSelector\(/);
  assert.match(main, /const solver = new AnvilSolver\(\)/);
  assert.match(main, /block-scan amount selection=sim/);
  assert.match(main, /main\(\)\.catch/);
});
