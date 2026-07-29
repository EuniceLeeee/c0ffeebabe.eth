import assert from "node:assert/strict";
import { LatestHeadScheduler } from "../latest-head-scheduler.js";

await coalescesToNewestWithOneWorker();
await rerunsSameHeadForNewRevision();
await continuesAfterWorkerFailure();
await shutdownDropsPendingAndDrainsActive();

console.log("[latest-head-scheduler] newest-head/draining shutdown: PASS");

async function rerunsSameHeadForNewRevision(): Promise<void> {
  const first = deferred();
  const runs: Array<{ block: number; revision: number }> = [];
  const scheduler = new LatestHeadScheduler(
    async (block, observation) => {
      runs.push({ block, revision: observation.revision ?? 0 });
      if (runs.length === 1) await first.promise;
    },
  );
  scheduler.schedule(150);
  await waitFor(() => runs.length === 1);
  scheduler.scheduleRevision(150, 1, {
    sourceHeadSeenAtMs: Date.now(),
    sourceHeadSeenAtMonotonicMs: performance.now(),
  });
  scheduler.scheduleRevision(150, 1, {
    sourceHeadSeenAtMs: Date.now(),
    sourceHeadSeenAtMonotonicMs: performance.now(),
  });
  first.resolve();
  await waitFor(() => scheduler.telemetry().active === null);
  assert.deepEqual(runs, [
    { block: 150, revision: 0 },
    { block: 150, revision: 1 },
  ]);

  scheduler.scheduleRevision(151, 1, {
    sourceHeadSeenAtMs: Date.now(),
    sourceHeadSeenAtMonotonicMs: performance.now(),
  });
  scheduler.schedule(151);
  await waitFor(() => scheduler.telemetry().active === null);
  assert.deepEqual(
    runs.at(-1),
    { block: 151, revision: 1 },
    "evidence arriving before the ordinary head must become one combined pass",
  );
  assert.throws(
    () => scheduler.scheduleRevision(151, 0, {
      sourceHeadSeenAtMs: Date.now(),
      sourceHeadSeenAtMonotonicMs: performance.now(),
    }),
    /invalid scheduled head revision/,
  );
}

async function coalescesToNewestWithOneWorker(): Promise<void> {
  const gates = new Map<number, ReturnType<typeof deferred>>();
  const runs: number[] = [];
  const observations = new Map<number, {
    sourceHeadSeenAtMs: number;
    sourceHeadSeenAtMonotonicMs: number;
  }>();
  let active = 0;
  let maxActive = 0;
  const dropped: Array<{ blockNumber: number; reason: string }> = [];
  const scheduler = new LatestHeadScheduler(
    async (blockNumber, observation) => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs.push(blockNumber);
      observations.set(blockNumber, observation);
      const gate = deferred();
      gates.set(blockNumber, gate);
      await gate.promise;
      active--;
    },
    undefined,
    (head) => {
      dropped.push({ blockNumber: head.blockNumber, reason: head.reason });
    },
  );

  assert.throws(() => scheduler.schedule(-1), /invalid scheduled head/);
  assert.throws(() => scheduler.schedule(1.5), /invalid scheduled head/);
  assert.throws(
    () => scheduler.schedule(1, {
      sourceHeadSeenAtMs: Number.NaN,
      sourceHeadSeenAtMonotonicMs: 1,
    }),
    /invalid source-head observation/,
  );

  scheduler.schedule(100, {
    sourceHeadSeenAtMs: 1_000,
    sourceHeadSeenAtMonotonicMs: 100,
  });
  await waitFor(() => gates.has(100));
  scheduler.schedule(101, {
    sourceHeadSeenAtMs: 1_010,
    sourceHeadSeenAtMonotonicMs: 110,
  });
  scheduler.schedule(102, {
    sourceHeadSeenAtMs: 1_020,
    sourceHeadSeenAtMonotonicMs: 120,
  });
  scheduler.schedule(101);
  scheduler.schedule(99);
  assert.deepEqual(runs, [100]);
  assert.equal(scheduler.telemetry().pending, 102);

  gates.get(100)!.resolve();
  await waitFor(() => gates.has(102));
  assert.deepEqual(runs, [100, 102]);
  assert.deepEqual(observations.get(100), {
    sourceHeadSeenAtMs: 1_000,
    sourceHeadSeenAtMonotonicMs: 100,
  });
  assert.deepEqual(observations.get(102), {
    sourceHeadSeenAtMs: 1_020,
    sourceHeadSeenAtMonotonicMs: 120,
  });
  scheduler.schedule(103);
  scheduler.schedule(105);
  scheduler.schedule(104);
  assert.equal(scheduler.telemetry().pending, 105);

  gates.get(102)!.resolve();
  await waitFor(() => gates.has(105));
  assert.deepEqual(runs, [100, 102, 105]);
  gates.get(105)!.resolve();
  await waitFor(() => scheduler.telemetry().active === null);

  assert.equal(maxActive, 1);
  assert.deepEqual(runs, [100, 102, 105]);
  assert.deepEqual(scheduler.telemetry(), {
    submitted: 8,
    started: 3,
    completed: 3,
    coalesced: 5,
    latestSubmitted: 105,
    active: null,
    pending: null,
  });

  scheduler.schedule(104);
  await waitFor(() => scheduler.telemetry().submitted === 9);
  assert.deepEqual(runs, [100, 102, 105]);
  assert.equal(scheduler.telemetry().coalesced, 6);
  assert.equal(scheduler.telemetry().latestSubmitted, 105);
  assert.deepEqual(dropped, [
    { blockNumber: 101, reason: "scheduler_coalesced" },
    { blockNumber: 103, reason: "scheduler_coalesced" },
  ]);
}

async function continuesAfterWorkerFailure(): Promise<void> {
  const runs: number[] = [];
  const errors: Array<{ blockNumber: number; message: string }> = [];
  const completedSecond = deferred();
  const scheduler = new LatestHeadScheduler(
    async (blockNumber) => {
      runs.push(blockNumber);
      if (blockNumber === 200) throw new Error("boom");
      completedSecond.resolve();
    },
    (blockNumber, error) => {
      errors.push({
        blockNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  );
  scheduler.schedule(200);
  scheduler.schedule(201);
  await completedSecond.promise;
  await waitFor(() => scheduler.telemetry().active === null);
  assert.deepEqual(runs, [200, 201]);
  assert.deepEqual(errors, [{ blockNumber: 200, message: "boom" }]);
  assert.equal(scheduler.telemetry().completed, 2);
}

async function shutdownDropsPendingAndDrainsActive(): Promise<void> {
  const activeGate = deferred();
  const runs: number[] = [];
  const dropped: Array<{ blockNumber: number; reason: string }> = [];
  const scheduler = new LatestHeadScheduler(
    async (blockNumber) => {
      runs.push(blockNumber);
      await activeGate.promise;
    },
    undefined,
    (head) => {
      dropped.push({ blockNumber: head.blockNumber, reason: head.reason });
    },
  );
  scheduler.schedule(300);
  await waitFor(() => scheduler.telemetry().active === 300);
  scheduler.schedule(301);

  let settled = false;
  const shutdown = scheduler.shutdown().then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "shutdown must wait for the active head");
  assert.equal(
    scheduler.telemetry().pending,
    null,
    "shutdown must discard a not-yet-started pending head",
  );

  scheduler.schedule(302);
  activeGate.resolve();
  await shutdown;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    runs,
    [300],
    "neither the pending nor a post-shutdown head may start",
  );
  assert.equal(scheduler.telemetry().active, null);
  assert.equal(scheduler.telemetry().submitted, 2);
  assert.deepEqual(dropped, [{
    blockNumber: 301,
    reason: "shutdown_pending_dropped",
  }]);
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("scheduler test condition did not settle");
}
