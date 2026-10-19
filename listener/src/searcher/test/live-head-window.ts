import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveHeadWindow, parseLiveMaxNewHeads } from "../live-head-window.js";
import { BlockScanRuntimeLoop } from "../blockscan-runtime-loop.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PendingEvidenceTaskScheduler, PendingEvidenceAdmissionQueue } from "../pending-evidence-admission-queue.js";

const observation = (number: number, source: "http" | "ws" = "http", hash?: string) =>
  ({ number, source, hash, observedAtMs: number * 1000, observedAtMonotonicMs: number * 10 });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

test("live window excludes seed, deduplicates feeds, closes after delivering head 250, and observes 251 only", async () => {
  const events: Record<string, unknown>[] = [];
  const scheduled: number[] = [];
  let closes = 0;
  const window = new LiveHeadWindow(1000, 250, (event) => events.push(event), () => {
    assert.equal(scheduled.length, 250);
    closes++;
  });
  window.observe(observation(1000), () => assert.fail("seed admitted"));
  for (let number = 1001; number <= 1250; number++) {
    window.observe(observation(number), () => scheduled.push(number));
    window.observe(observation(number, "ws", `hash-${number}`), () => assert.fail("duplicate admitted"));
  }
  assert.equal(closes, 1);
  assert.equal(window.closed, true);
  assert.deepEqual(scheduled, Array.from({ length: 250 }, (_, index) => 1001 + index));
  window.observe(observation(1251), () => assert.fail("251 admitted"));
  await window.nextHead;
  window.observe(observation(1252), () => assert.fail("252 admitted"));
  assert.equal(events.filter((event) => event.event === "next_head").length, 1);
  assert.equal(events.find((event) => event.event === "next_head")?.observedAtMs, 1251000);
});

test("gaps, reorgs, and failed scheduled heads do not extend the requested observation count", () => {
  const events: Record<string, unknown>[] = [];
  const scheduled: number[] = [];
  const window = new LiveHeadWindow(10, 2, (event) => events.push(event), () => {});
  window.observe(observation(11, "ws", "a"), () => scheduled.push(11));
  window.observe(observation(11, "ws", "b"), () => assert.fail("reorg counted twice"));
  // A pass may subsequently fail; admission is independent of pass outcome.
  window.observe(observation(14), () => scheduled.push(14));
  assert.deepEqual(scheduled, [11, 14]);
  assert.equal(window.closed, true);
  assert.deepEqual(events.find((event) => event.event === "gap"), {
    event: "gap", ...observation(14), count: 1, limit: 2, seed: 10, from: 12, to: 13,
  });
  assert.equal(events.find((event) => event.event === "reorg")?.previousHash, "a");
});

test("head limit rejects invalid input and defaults to the unchanged unbounded path", () => {
  assert.equal(parseLiveMaxNewHeads(undefined), 0);
  assert.equal(parseLiveMaxNewHeads("0"), 0);
  assert.equal(parseLiveMaxNewHeads("250"), 250);
  for (const value of ["-1", "1.5", "250x", "", "01", "9007199254740992"]) {
    assert.throws(() => parseLiveMaxNewHeads(value));
  }
});

test("production idle join retains coarse pricing successor and its publication tail", async () => {
  const first = deferred();
  const successor = deferred();
  let schedulerJoins = 0;
  const loop = Object.create(BlockScanRuntimeLoop.prototype) as BlockScanRuntimeLoop;
  const internal = loop as unknown as { scheduler: { waitForIdle: () => Promise<void> }; coarsePricingActive: Promise<void> | null };
  internal.scheduler = { waitForIdle: async () => { schedulerJoins++; } };
  internal.coarsePricingActive = first.promise.finally(() => {
    internal.coarsePricingActive = successor.promise.finally(() => { internal.coarsePricingActive = null; });
  });
  let drained = false;
  const join = loop.waitForIdle().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false);
  first.resolve();
  await turn();
  assert.equal(drained, false, "successor publication must remain in the measured drain");
  successor.resolve();
  await join;
  assert.equal(drained, true);
  assert.ok(schedulerJoins >= 3);
});

test("production mempool intake abort wakes an empty queue and drains already started transaction reads", async () => {
  // Run the unchanged production generator body with only transport/RPC dependencies replaced.
  const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  const start = main.indexOf("async function* localFirehoseMempoolHints(");
  const end = main.indexOf("\ninterface StandardMempoolConnection", start);
  assert.ok(start >= 0 && end > start);
  const code = ts.transpileModule(main.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const rpc = deferred();
  const logs: string[] = [];
  const socket = new EventTarget() as EventTarget & { close(): void };
  socket.close = () => socket.dispatchEvent(new Event("close"));
  const generate = runInNewContext(`${code}; localFirehoseMempoolHints`, {
    process: { env: {} }, console: { log: (line: string) => logs.push(line) }, performance,
    PendingEvidenceTaskScheduler, PendingEvidenceAdmissionQueue,
    PendingEvidenceHeadSnapshot: class {},
    connectStandardMempool: async () => ({ ws: socket, pendingSubscriptionId: "pending", headSubscriptionId: "head" }),
    parseWsJson: JSON.parse, isRecord: (value: unknown) => value !== null && typeof value === "object",
    TX_HASH_RE: /^0x[0-9a-f]{64}$/,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    withTimeout: (value: Promise<unknown>) => value,
    createPendingEvidenceSession: () => ({ candidateFamilyIds: [] }),
    rawTxByHash: async () => "0x01",
  });
  const abort = new AbortController();
  const generator = generate("ws://fixture.invalid", {
    getTransaction: async () => { await rpc.promise; return { hash: `0x${"ab".repeat(32)}`, to: "fixture" }; },
  }, () => true, { familyIds: [] }, 100, 1, new Set(), { pendingReceived: 0 }, undefined, abort.signal);
  let finished = false;
  const next = generator.next().then((value: { done: boolean }) => { finished = true; return value; });
  await turn();
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    method: "eth_subscription", params: { subscription: "pending", result: `0x${"ab".repeat(32)}` },
  }) }));
  await turn();
  abort.abort();
  await turn();
  assert.equal(finished, false, "in-flight RPC remains part of drain");
  rpc.resolve();
  assert.equal((await next).done, true);
  assert.equal(logs.filter((line) => line.includes('"event":"mempool_drained"')).length, 1);
  assert.ok(logs.some((line) => line.includes('"inFlight":1')));
});

test("post-warm window arms at highest observed head and counts only later unique heads", async () => {
  const events: Record<string, unknown>[] = [], scheduled: number[] = [];
  let closes = 0;
  const window = new LiveHeadWindow(1000, 3, e => events.push(e), () => { closes++; },
    { waitForWarmup: true, warmupMaxMs: 60_000 });
  try {
    window.observe(observation(1005, "http", "a"), () => scheduled.push(1005));
    window.observe(observation(1003), () => scheduled.push(1003));
    window.observe(observation(1005, "ws", "b"), () => assert.fail("warm duplicate scheduled"));
    assert.equal(events.filter(e => e.event === "head").length, 0, "warmup must not consume the measurement head count");
    assert.equal(window.waitingForWarmup, true);
    assert.equal(window.armAfterWarmup(), true);
    assert.equal(events.find(e => e.event === "measurement_armed")?.measurementSeed, 1005);
    assert.equal(window.armAfterWarmup(), false, "later/reorg warm must not reset an armed window");
    window.observe(observation(1004), () => assert.fail("late warm head backfilled measurement"));
    window.observe(observation(1006), () => scheduled.push(1006));
    window.observe(observation(1006, "ws", "c"), () => assert.fail("duplicate counted"));
    window.observe(observation(1008), () => scheduled.push(1008));
    window.observe(observation(1007), () => { assert.equal(closes, 0); scheduled.push(1007); });
    assert.equal(closes, 1);
    assert.deepEqual(scheduled, [1005, 1003, 1006, 1008, 1007]);
    assert.deepEqual(events.filter(e => e.event === "head").map(e => e.number), [1006, 1008, 1007]);
    window.observe(observation(1009), () => assert.fail("next head scheduled"));
    await window.nextHead;
  } finally { window.dispose?.(); }
});

test("warmup head guard delivers its last head before synchronous failed close, never arms at limit", () => {
  const events: Record<string, unknown>[] = [], scheduled: number[] = [];
  let closes = 0;
  const window = new LiveHeadWindow(10, 2, e => events.push(e), () => { closes++; },
    { waitForWarmup: true, warmupMaxMs: 60_000 });
  window.observe(observation(11), () => scheduled.push(11));
  window.observe(observation(12), () => {
    assert.equal(closes, 0); scheduled.push(12);
    assert.equal(window.armAfterWarmup(), false, "publication at the guard boundary cannot race admission");
  });
  assert.deepEqual(scheduled, [11, 12]); assert.equal(closes, 1);
  assert.equal(window.closed, true); assert.equal(window.waitingForWarmup, true);
  assert.equal(window.warmupFailure, "head-limit");
  assert.equal(events.filter(e => e.event === "measurement_armed").length, 0);
  assert.equal(events.filter(e => e.event === "input_closed").length, 1);
});

test("fixed warmup wall guard closes even when no further heads arrive", async () => {
  let closes = 0;
  const window = new LiveHeadWindow(10, 250, () => {}, () => { closes++; },
    { waitForWarmup: true, warmupMaxMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(window.closed, true); assert.equal(window.warmupFailure, "deadline");
  assert.equal(closes, 1); assert.equal(window.armAfterWarmup(), false);
});

test("arming checks the absolute warmup deadline before a delayed timer can fire", () => {
  // Execute the actual class with a stalled timer and an independently advanced monotonic clock.
  const source = readFileSync(new URL("../live-head-window.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source.replaceAll("export ", ""),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let now = 10, closes = 0;
  const Window = runInNewContext(`${code}; LiveHeadWindow`, {
    performance: { now: () => now }, Date, setTimeout: () => ({ unref() {} }), clearTimeout() {},
  });
  const window = new Window(10, 250, () => {}, () => { closes++; }, { waitForWarmup: true, warmupMaxMs: 100 });
  now = 110;
  assert.equal(window.armAfterWarmup(), false);
  assert.equal(closes, 1); assert.equal(window.warmupFailure, "deadline");
});

test("arming or disposing cancels only the warmup wall timer", async () => {
  for (const arm of [true, false]) {
    let closes = 0;
    const window = new LiveHeadWindow(10, 2, () => {}, () => { closes++; },
      { waitForWarmup: true, warmupMaxMs: 10 });
    if (arm) assert.equal(window.armAfterWarmup(), true); else window.dispose();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(closes, 0);
    if (arm) {
      window.observe(observation(11), () => {}); window.observe(observation(12), () => {});
      assert.equal(closes, 1, "measurement still has its original exact head limit");
    }
  }
  for (const warmupMaxMs of [0, -1, NaN, 1.5, 2_147_483_648]) {
    assert.throws(() => new LiveHeadWindow(10, 2, () => {}, () => {}, { waitForWarmup: true, warmupMaxMs }));
  }
});
