import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBlockScanLiveStageSettings } from "../main.js";
import { RethTransportScheduler, type RethTransportRetryState } from "../reth-transport-scheduler.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";

test("explicit shared cap preserves all search and local batching settings", () => {
  const base = resolveBlockScanLiveStageSettings({});
  const serial = resolveBlockScanLiveStageSettings({ SEARCHER_RPC_TRANSPORT_MAX_CONCURRENCY: "1" });
  assert.equal(base.transport.capacity, 20); assert.equal(base.transport.producerReserved, 4);
  assert.equal(serial.transport.capacity, 1); assert.equal(serial.transport.producerReserved, 1);
  assert.deepEqual({ ...serial, transport: base.transport }, base);
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "21"]) {
    assert.throws(() => resolveBlockScanLiveStageSettings({ SEARCHER_RPC_TRANSPORT_MAX_CONCURRENCY: value }));
  }
  for (const value of ["2.5", "NaN", "Infinity"]) {
    assert.throws(() => resolveBlockScanLiveStageSettings({ SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY: value,
      SEARCHER_RPC_TRANSPORT_MAX_CONCURRENCY: "1" }));
  }
});

test("one physical permit serves every lane, keeps priority and drains cancellation", async () => {
  const scheduler = new RethTransportScheduler({ capacity: 1, producerReserved: 1 });
  const signal = new AbortController().signal, order: string[] = [];
  let release!: () => void;
  const held = scheduler.run("exact", signal, async () => { await new Promise<void>(r => { release = r; }); });
  await new Promise(r => setImmediate(r));
  const run = (lane: "producer-bulk" | "producer-critical" | "exact" | "discovery") =>
    scheduler.run(lane, signal, async lease => { assert.equal(lease.activeTotal, 1); order.push(lane); });
  const jobs = [run("discovery"), run("exact"), run("producer-bulk"), run("producer-critical")];
  const abort = new AbortController();
  const cancelled = scheduler.run("producer-critical", abort.signal, async () => assert.fail("cancelled work dispatched"));
  abort.abort(); await assert.rejects(cancelled);
  release(); await Promise.all([held, ...jobs]);
  assert.deepEqual(order, ["producer-critical", "producer-bulk", "exact", "discovery"]);
  assert.equal(scheduler.snapshot().activeTotal, 0);
  assert.equal(scheduler.completeStartup(), true); assert.equal(scheduler.snapshot().capacity, 1);
});

test("only failed envelopes shrink; single-item retries remain bounded", async () => {
  const scheduler = new RethTransportScheduler({ capacity: 1, producerReserved: 1,
    maxRetriesAtOne: 2, retryDelayMs: 1, maxRetryDelayMs: 8 });
  const load = await scheduler.run("producer-bulk", new AbortController().signal, async lease => lease.load!);
  const items: RethTransportRetryState[] = [{}, {}];
  const throttle = Object.assign(new Error("throughput capacity exceeded"), { code: 429 });
  for (const expected of [64, 16, 4]) {
    const attempt = load.limits(64, 16, items);
    assert.equal(attempt.concurrency, 1); assert.equal(attempt.batchSize, expected);
    assert.equal(load.retry(throttle, items, attempt), true);
    assert.equal(items[0].transportRetriesAtOne, undefined);
  }
  assert.equal(load.limits(64, 16, items).batchSize, 1);
  assert.equal(load.retry(throttle, items, load.limits(64, 16, items)), true);
  assert.equal(load.retry(throttle, items, load.limits(64, 16, items)), true);
  assert.equal(load.retry(throttle, items, load.limits(64, 16, items)), false);
  assert.deepEqual(load.limits(64, 16), { version: 0, batchSize: 64, concurrency: 1 });
  assert(load.retryDelayMs(items) <= 8);
  const timeoutItems: RethTransportRetryState[] = [{}, {}];
  assert.equal(load.retry(new StateCallAbortedError("wire", "timeout"), timeoutItems, load.limits(64, 16)), true);
  assert.equal(load.limits(64, 16, timeoutItems).batchSize, 32);
  for (const error of [Object.assign(new Error("monthly quota exhausted"), { code: 429 }),
    Object.assign(new Error("execution reverted: rate limit"), { code: 3, data: "0xbeef" }),
    new StateCallAbortedError("expired", "deadline")]) {
    assert.equal(load.retry(error, [{}], load.limits(64, 16)), false);
  }
});
