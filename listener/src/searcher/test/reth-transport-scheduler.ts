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
    const states: RethTransportRetryState[] = [{}, {}];
    const limits = () => load.limits(initial.batchSize, initial.concurrency, states);
    const original = limits();
    const timeout = new StateCallAbortedError("wire", "timeout");
    check.equal(load.retry(timeout, states, original), true);
    check.equal(limits().batchSize, Math.floor(initial.batchSize / 2));
    check.equal(limits().concurrency, Math.floor(initial.concurrency / 2));
    check.equal(states[0]!.transportRetryBatch, states[1]!.transportRetryBatch);
    check.deepEqual(load.limits(initial.batchSize, initial.concurrency), {version:0, ...initial},
      "a fresh envelope must not inherit another envelope's tier");
    check.equal(load.retryDelayMs(), 0);
    check.equal(load.retryDelayMs(states), 1);
    check.equal(scheduler.snapshot().capacity, 8);
    check.equal(scheduler.snapshot().producerReserved, 4);
    const tier = limits();
    check.equal(load.retry(timeout, states, original), true);
    check.deepEqual(limits(), tier, "same failed group/version must not lower twice");
    const unrelated: RethTransportRetryState[] = [{}];
    check.equal(load.retry(timeout, unrelated, load.limits(initial.batchSize, initial.concurrency)), true);
    check.notEqual(unrelated[0]!.transportRetryBatch, states[0]!.transportRetryBatch);
    check.equal(scheduler.completeStartup(), true);
    check.equal(scheduler.completeStartup(), false);
    check.deepEqual(limits(), tier, "lifecycle notification cannot reset a failed batch's retry budget");
    const successor = await scheduler.run("producer-critical", new AbortController().signal, async lease => lease.load!);
    check.equal(successor, load);
    check.deepEqual(successor.limits(initial.batchSize, initial.concurrency), {version:0, ...initial});
  }
  {
    const scheduler = new RethTransportScheduler({ capacity: 8, producerReserved: 4, retryDelayMs: 5 });
    const load = await scheduler.run("exact", new AbortController().signal, async lease => lease.load!);
    const states: RethTransportRetryState[] = [{}];
    const limits = () => load.limits(128, 4, states);
    const throttle = Object.assign(new Error("throttled"), {code:429});
    check.equal(load.retry(new StateCallAbortedError("wire", "timeout"), states, limits()), true);
    check.equal(load.retry(throttle, states, limits()), true);
    check.equal(limits().concurrency, 1);
    for(let n=1;n<=3;n++) {
      check.equal(load.retry(throttle, states, limits()), true);
      check.equal(states[0]!.transportRetriesAtOne, n);
    }
    check.equal(load.retry(throttle, states, limits()), false);
    check.equal(scheduler.snapshot().capacity, 8);
    check.equal(scheduler.snapshot().producerReserved, 4);
    check.deepEqual(load.limits(128,4), {version:0,batchSize:128,concurrency:4});
    console.log("[reth-transport-scheduler] batch-local timeout/429 tier and bounded retry: PASS");
  }
  {
    const scheduler = new RethTransportScheduler({ capacity:4, producerReserved:2,retryDelayMs:10_000 });
    const load = await scheduler.run("exact",new AbortController().signal, async lease=>lease.load!);
    const states: RethTransportRetryState[] = [{}];
    check.equal(load.retry(new StateCallAbortedError("wire","timeout"),states,load.limits(128,4)),true);
    const held = deferred<void>();
    const blockers = [0,1].map(()=>scheduler.run("exact",new AbortController().signal,()=>held.promise));
    await new Promise(resolve=>setImmediate(resolve));
    const cancel = new AbortController();
    const cancelled = scheduler.run("discovery",cancel.signal,async()=>check.fail("cancelled request ran"));
    cancel.abort();await check.rejects(cancelled);
    await scheduler.run("producer-critical",new AbortController().signal,async()=>{});
    check.equal(scheduler.snapshot().activeTotal,2,"batch backoff must not freeze fresh permits or release held ones");
    held.resolve();await Promise.all(blockers);
    check.equal(scheduler.snapshot().activeTotal,0);
  }
  {
    const scheduler = new RethTransportScheduler({capacity:4,producerReserved:1});
    const load = await scheduler.run("exact",new AbortController().signal,async lease=>lease.load!);
    const errors = [new StateCallAbortedError("expired","deadline"),new StateCallAbortedError("head superseded","signal"),
      new DOMException("timeout wording","AbortError"),new Error("transport timeout"),
      Object.assign(new Error("execution reverted: timeout 429"),{code:3,data:"0xbeef"}),
      Object.assign(new Error("monthly quota exhausted"),{code:429}),
      Object.assign(new Error("hash is not currently canonical"),{code:-32000})];
    for(const error of errors) {
      const states: RethTransportRetryState[]=[{}];
      check.equal(load.retry(error,states,load.limits(128,4)),false);
      check.equal(states[0]!.transportRetryBatch,undefined);
    }
    const caller=new AbortController();let ran=false;
    const immediate=scheduler.run("exact",caller.signal,async()=>{ran=true;});
    caller.abort();await check.rejects(immediate);
    check.equal(ran,false);check.equal(scheduler.snapshot().activeTotal,0);
    console.log("[reth-transport-scheduler] classifications and cancellation remain fail-closed: PASS");
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
