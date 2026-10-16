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
