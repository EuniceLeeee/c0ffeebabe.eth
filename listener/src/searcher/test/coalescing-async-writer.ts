import assert from "node:assert/strict";
import { CoalescingAsyncWriter } from
  "../coalescing-async-writer.js";

await keepsOnlyLatestPendingValue();
await flushReportsFailureAndAllowsRetry();
await pendingSuccessDoesNotHideEarlierFailure();

console.log("[coalescing-async-writer] latest-pending/flush: PASS (3/3)");

async function keepsOnlyLatestPendingValue(): Promise<void> {
  const first = deferred();
  const runs: number[] = [];
  const writer = new CoalescingAsyncWriter<number>(
    0,
    async (value) => {
      runs.push(value);
      if (value === 1) await first.promise;
    },
  );
  writer.schedule(1);
  await waitFor(() => writer.telemetry().active);
  writer.schedule(2);
  writer.schedule(3);
  first.resolve();
  await writer.flush();
  assert.deepEqual(runs, [1, 3]);
  assert.deepEqual(writer.telemetry(), {
    scheduled: 3,
    started: 2,
    completed: 2,
    failed: 0,
    coalesced: 1,
    active: false,
    pending: false,
  });
}

async function flushReportsFailureAndAllowsRetry(): Promise<void> {
  const errors: string[] = [];
  const runs: number[] = [];
  const writer = new CoalescingAsyncWriter<number>(
    10_000,
    async (value) => {
      runs.push(value);
      if (value === 1) throw new Error("disk full");
    },
    (error) => errors.push(
      error instanceof Error ? error.message : String(error),
    ),
  );
  writer.schedule(1);
  await assert.rejects(writer.flush(), /disk full/);
  writer.schedule(2);
  await writer.flush();
  assert.deepEqual(runs, [1, 2]);
  assert.deepEqual(errors, ["disk full"]);
}

async function pendingSuccessDoesNotHideEarlierFailure(): Promise<void> {
  const releaseFailure = deferred();
  const runs: number[] = [];
  const writer = new CoalescingAsyncWriter<number>(
    0,
    async (value) => {
      runs.push(value);
      if (value !== 1) return;
      await releaseFailure.promise;
      throw new Error("first write failed");
    },
  );
  writer.schedule(1);
  await waitFor(() => writer.telemetry().active);
  writer.schedule(2);
  releaseFailure.resolve();
  await assert.rejects(
    writer.flush(),
    /first write failed/,
    "a successful latest write must not make shutdown forget an earlier failure",
  );
  assert.deepEqual(runs, [1, 2]);
  assert.equal(writer.telemetry().completed, 1);
  assert.equal(writer.telemetry().failed, 1);
  await writer.flush();
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
