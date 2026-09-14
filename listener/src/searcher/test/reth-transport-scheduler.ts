/**
 * RethTransportScheduler tests: producer reserve must stay available while
 * exact/discovery fill the non-producer share.
 */

import { RethTransportScheduler } from "../reth-transport-scheduler.js";
import check from "node:assert/strict";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";
import type { RethTransportLoad, RethTransportRetryState } from "../reth-transport-scheduler.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function run(): Promise<void> {
  for (const initial of [{ batchSize: 128, concurrency: 4 }, { batchSize: 75, concurrency: 7 }]) {
    const scheduler = new RethTransportScheduler({ capacity: 8, producerReserved: 4, retryDelayMs: 1 });
    const load = await scheduler.run("producer-bulk", new AbortController().signal, async lease => lease.load!);
    const limits = () => load.limits(initial.batchSize, initial.concurrency);
    const startupAttempt = limits();
    const timeout = new StateCallAbortedError("wire", "timeout");
    check.equal(load.retry(timeout, [{}], startupAttempt), true);
    check.equal(limits().batchSize, Math.floor(initial.batchSize / 2));
    check.equal(scheduler.completeStartup(), true);
    check.deepEqual(limits(), { version: 2, ...initial }, "restore configured values, not hardcoded 128/4");
    check.equal(load.retryDelayMs(), 0);
    check.equal(scheduler.snapshot().capacity, 8);
    check.equal(scheduler.snapshot().producerReserved, 4);
    check.equal(scheduler.snapshot().reductionLevel, 0);
    check.equal(load.retry(timeout, [{}], startupAttempt), true, "old lane may retry without poisoning steady limits");
    check.deepEqual(limits(), { version: 2, ...initial });
    check.equal(load.retryDelayMs(), 0, "late startup failure cannot restore its cooldown");
    const steadyAttempt = limits();
    check.equal(load.retry(Object.assign(new Error("throttled"), { code: 429 }), [{}], steadyAttempt), true);
    check.equal(limits().batchSize, Math.floor(initial.batchSize / 2));
    check.equal(limits().concurrency, Math.floor(initial.concurrency / 2));
    const steadyLimits = limits();
    for (let block = 0; block < 3; block++) {
      check.equal(scheduler.completeStartup(), false, "transition must be one-shot, not per block");
      const next = await scheduler.run("producer-critical", new AbortController().signal, async lease => lease.load!);
      check.equal(next, load, "startup and steady must share one scheduler authority");
      check.deepEqual(limits(), steadyLimits, "steady reduction must survive new scopes/blocks");
    }
    check.equal(load.retry(timeout, [{}], steadyAttempt), true);
    check.deepEqual(limits(), steadyLimits, "same steady failure wave still lowers once");
  }
  {
    const scheduler = new RethTransportScheduler({ capacity: 4, producerReserved: 2 });
    const load = await scheduler.run("exact", new AbortController().signal, async lease => lease.load!);
    const oldAttempt = load.limits(128, 4);
    check.equal(scheduler.completeStartup(), true, "normal startup also consumes the one-shot transition");
    check.deepEqual(load.limits(128, 4), { version: 1, batchSize: 128, concurrency: 4 });
    check.equal(load.retry(new StateCallAbortedError("old wire", "timeout"), [{}], oldAttempt), true);
    check.equal(scheduler.snapshot().reductionLevel, 0);
    check.equal(scheduler.completeStartup(), false);
    console.log("[reth-transport-scheduler] startup reset, stale-attempt fence, persistent steady throttling: PASS");
  }
  {
    const scheduler = new RethTransportScheduler({ capacity: 4, producerReserved: 2, retryDelayMs: 10_000 });
    const release = deferred<void>(), admitted = deferred<RethTransportLoad>();
    const running = scheduler.run("exact", new AbortController().signal, async lease => {
      admitted.resolve(lease.load!); await release.promise;
    });
    const load = await admitted.promise;
    load.retry(new StateCallAbortedError("startup wire", "timeout"), [{}], load.limits(128, 4));
    const cancel = new AbortController();
    const cancelled = scheduler.run("discovery", cancel.signal, async () => check.fail("cancelled request ran"));
    cancel.abort(); await check.rejects(cancelled);
    const secondRelease = deferred<void>(), secondStarted = deferred<void>();
    const second = scheduler.run("exact", new AbortController().signal, async () => {
      secondStarted.resolve(); await secondRelease.promise;
    });
    check.equal(scheduler.snapshot().queuedByLane.exact, 1);
    scheduler.completeStartup();
    await secondStarted.promise;
    check.equal(scheduler.snapshot().activeTotal, 2, "reset must preserve held permits");
    let extraStarted = false;
    const extra = scheduler.run("discovery", new AbortController().signal, async () => { extraStarted = true; });
    await new Promise(resolve => setImmediate(resolve));
    check.equal(extraStarted, false, "restoration must preserve the producer reserve");
    await scheduler.run("producer-critical", new AbortController().signal, async () => {});
    check.equal(scheduler.snapshot().activeTotal, 2);
    release.resolve(); secondRelease.resolve(); await Promise.all([running, second, extra]);
    check.equal(scheduler.snapshot().activeTotal, 0);
    check.deepEqual(scheduler.snapshot().queuedByLane, { "producer-critical": 0, "producer-bulk": 0, exact: 0, discovery: 0 });
    console.log("[reth-transport-scheduler] startup reset clears cooldown, preserves permits/reserve/queues: PASS");
  }
  {
    const scheduler = new RethTransportScheduler({ capacity: 8, producerReserved: 4, retryDelayMs: 5 });
    const load = await scheduler.run("exact", new AbortController().signal, async lease => lease.load!);
    const first = load.limits(128, 4);
    const states: RethTransportRetryState[] = [{}];
    check.equal(load.retry(new StateCallAbortedError("wire", "timeout"), states, first), true);
    check.deepEqual(load.limits(128, 4), { version: 1, batchSize: 64, concurrency: 2 });
    check.equal(scheduler.snapshot().capacity, 4);
    check.equal(scheduler.snapshot().producerReserved, 2);
    const throttle = Object.assign(new Error("throttled"), { code: 429 });
    check.equal(load.retry(throttle, [{}], first), true);
    check.equal(scheduler.snapshot().reductionVersion, 1, "old in-flight sibling cascaded reduction");
    check.equal(load.retry(throttle, states, load.limits(128, 4)), true);
    check.equal(load.limits(128, 4).concurrency, 1);
    for (let n = 1; n <= 3; n++) {
      check.equal(load.retry(Object.assign(new Error("socket"), { code: "ETIMEDOUT" }), states, load.limits(128, 4)), true);
      check.equal(states[0].transportRetriesAtOne, n);
    }
    check.equal(load.retry(throttle, states, load.limits(128, 4)), false);
    check.equal(scheduler.snapshot().capacity, 2, "keep a producer slot plus residual admission");
    check.equal(scheduler.snapshot().producerReserved, 1);
    const successor = await scheduler.run("producer-critical", new AbortController().signal, async lease => lease.load!);
    check.equal(successor, load, "new scope did not inherit shared authority");
    console.log("[reth-transport-scheduler] shared timeout/429 tier, reservation, bounded retry: PASS");
  }
  {
    const scheduler = new RethTransportScheduler({ capacity: 4, producerReserved: 1, retryDelayMs: 5 });
    const load = await scheduler.run("exact", new AbortController().signal, async lease => lease.load!);
    const errors = [new StateCallAbortedError("expired", "deadline"), new StateCallAbortedError("head superseded", "signal"),
      new DOMException("timeout wording", "AbortError"), new Error("transport timeout"),
      Object.assign(new Error("execution reverted: timeout 429"), { code: 3, data: "0xbeef" }),
      Object.assign(new Error("monthly quota exhausted"), { code: 429 }),
      Object.assign(new Error("hash is not currently canonical"), { code: -32000 })];
    for (const error of errors) check.equal(load.retry(error, [{}], load.limits(128, 4)), false);
    check.equal(scheduler.snapshot().reductionVersion, 0);
    await check.rejects(scheduler.run("exact", new AbortController().signal, async () => {
      throw new StateCallAbortedError("logical group timeout", "timeout");
    }));
    check.equal(scheduler.snapshot().reductionVersion, 0, "run alone must not treat logical group failures as physical");
    const caller = new AbortController();
    let ran = false;
    const immediate = scheduler.run("exact", caller.signal, async () => { ran = true; });
    caller.abort(new Error("cancel after grant, before callback"));
    await check.rejects(immediate);
    check.equal(ran, false); check.equal(scheduler.snapshot().activeTotal, 0);
    console.log("[reth-transport-scheduler] negative classifications and grant/cancel race: PASS");
  }
  {
    const scheduler = new RethTransportScheduler({ capacity: 4, producerReserved: 2, retryDelayMs: 30 });
    let load!: RethTransportLoad;
    const release = deferred<void>(), admitted = deferred<void>();
    const running = scheduler.run("exact", new AbortController().signal, async lease => {
      load = lease.load!; admitted.resolve(); await release.promise;
    });
    await admitted.promise;
    const before = Date.now();
    check.equal(load.retry(new StateCallAbortedError("wire", "timeout"), [{}], load.limits(128, 4)), true);
    const cancel = new AbortController();
    const waiting = scheduler.run("producer-critical", cancel.signal, async () => check.fail("cancelled queued work ran"));
    const next = scheduler.run("discovery", new AbortController().signal, async () => {
      check.ok(Date.now() - before >= 25, "queued work bypassed shared cooldown");
    });
    cancel.abort(); await check.rejects(waiting);
    check.equal(scheduler.snapshot().activeTotal, 1, "load reduction released running physical work");
    release.resolve(); await Promise.all([running, next]);
    check.equal(scheduler.snapshot().activeTotal, 0);
    check.deepEqual(scheduler.snapshot().queuedByLane, { "producer-critical": 0, "producer-bulk": 0, exact: 0, discovery: 0 });
    console.log("[reth-transport-scheduler] physical preservation, shared cooldown, cancellation drain: PASS");
  }
  {
    // capacity 4, producer reserve 2 -> exact+discovery share 2 slots.
    const scheduler = new RethTransportScheduler({
      capacity: 4,
      producerReserved: 2,
    });
    const exactBlockers = [
      deferred<void>(),
      deferred<void>(),
      deferred<void>(),
    ];
    const exactStarted = Array.from({ length: 3 }, () => deferred<void>());
    const exactRuns = exactBlockers.map((blocker, index) =>
      scheduler.run(
        "exact",
        new AbortController().signal,
        () => {
          exactStarted[index].resolve();
          return blocker.promise;
        },
      ),
    );
    await Promise.all(
      exactStarted.slice(0, 2).map((entry) => entry.promise),
    );

    const producerLease = deferred<number>();
    const producerWaitMs = await new Promise<number>((resolve) => {
      void scheduler
        .run(
          "producer-bulk",
          new AbortController().signal,
          ({ queueWaitMs }) => {
            producerLease.resolve(queueWaitMs);
            resolve(queueWaitMs);
            return Promise.resolve();
          },
        )
        .catch((error) => {
          throw error;
        });
    });
    assert(
      producerWaitMs < 50,
      `producer must acquire immediately while exact is active (wait=${producerWaitMs}ms)`,
    );

    let thirdQueued = true;
    const thirdSignal = new AbortController().signal;
    const thirdExact = scheduler.run(
      "exact",
      thirdSignal,
      () => {
        thirdQueued = false;
        return Promise.resolve();
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert(
      thirdQueued,
      "third exact run must queue while non-producer share is full",
    );

    exactBlockers[0].resolve();
    exactBlockers[1].resolve();
    await Promise.all(exactRuns.slice(0, 2));
    await thirdExact;
    assert(!thirdQueued, "third exact must run after a permit frees");
    await producerLease.promise;
    exactBlockers[2].resolve();
    await exactRuns[2];
    console.log("[reth-transport-scheduler] producer reserve: PASS");
  }

  {
    const scheduler = new RethTransportScheduler({
      capacity: 4,
      producerReserved: 2,
    });
    const blocker1 = deferred<void>();
    const blocker2 = deferred<void>();
    const started1 = deferred<void>();
    const started2 = deferred<void>();
    const run1 = scheduler.run(
      "exact",
      new AbortController().signal,
      () => {
        started1.resolve();
        return blocker1.promise;
      },
    );
    const run2 = scheduler.run(
      "exact",
      new AbortController().signal,
      () => {
        started2.resolve();
        return blocker2.promise;
      },
    );
    await Promise.all([started1.promise, started2.promise]);
    const controller = new AbortController();
    const queued = scheduler.run(
      "exact",
      controller.signal,
      () => Promise.resolve("unexpected"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("scheduler abort"));
    let rejected = false;
    await queued.catch(() => {
      rejected = true;
    });
    assert(rejected, "queued exact waiter must reject on abort");
    const snapshot = scheduler.snapshot();
    assert(
      snapshot.queuedByLane.exact === 0 &&
        snapshot.activeTotal === 2 &&
        snapshot.activeByLane.exact === 2,
      "aborted waiter must leave no queue residue; running permits stay intact",
    );
    blocker1.resolve();
    blocker2.resolve();
    await Promise.all([run1, run2]);
    console.log("[reth-transport-scheduler] abort cleanup: PASS");
  }
}

run().then(
  () => {
    console.log("reth-transport-scheduler PASS");
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
