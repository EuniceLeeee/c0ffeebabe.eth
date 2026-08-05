/**
 * RethTransportScheduler tests: producer reserve must stay available while
 * exact/discovery fill the non-producer share.
 */

import { RethTransportScheduler } from "../reth-transport-scheduler.js";

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
