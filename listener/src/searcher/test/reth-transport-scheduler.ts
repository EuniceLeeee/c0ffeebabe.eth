/**
 * RethTransportScheduler tests: producer reserve must stay available while
 * exact/discovery fill the non-producer share.
 */

import { RethTransportScheduler } from "../reth-transport-scheduler.js";
import check from "node:assert/strict";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";
import type { RethTransportLoad, RethTransportRetryState } from "../reth-transport-scheduler.js";
import { createServer } from "node:http";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";

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
    const previousFlag = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    const clockDescriptor = Object.getOwnPropertyDescriptor(performance, "now");
    let now = 0, reads = 0;
    Object.defineProperty(performance, "now", { configurable: true, value: () => { reads++; return now; } });
    try {
      for (const flag of [undefined, "0", "1"]) {
        if (flag === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
        else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = flag;
        const scheduler = new RethTransportScheduler({ capacity: 1, producerReserved: 1 });
        now = 10; reads = 0;
        const result = scheduler.run("producer-bulk", new AbortController().signal, async lease => lease);
        // Grant is synchronous; the continuation cannot resume until this turn
        // yields. Changing the flag now must not mix admission measurements.
        now = 17; process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = flag === "1" ? "0" : "1";
        const lease = await result;
        check.equal(lease.queueWaitMs, 7);
        if (flag === "1") {
          check.equal(lease.permitWaitMs, 0);
          check.equal(lease.resumeDelayMs, 7);
          check.equal(reads, 3);
        } else {
          check.equal(Object.hasOwn(lease, "permitWaitMs"), false);
          check.equal(Object.hasOwn(lease, "resumeDelayMs"), false);
          check.equal(reads, 2, "disabled diagnostics must not sample grant time");
        }
        check.equal(scheduler.snapshot().activeTotal, 0);
      }
      process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "1";
      const scheduler = new RethTransportScheduler({ capacity: 1, producerReserved: 1 });
      const held = deferred<void>(), started = deferred<void>();
      now = 100;
      const owner = scheduler.run("producer-bulk", new AbortController().signal, () => {
        started.resolve(); return held.promise;
      });
      await started.promise;
      now = 110;
      const queued = scheduler.run("producer-bulk", new AbortController().signal, async lease => lease);
      check.equal(scheduler.snapshot().queuedByLane["producer-bulk"], 1);
      now = 140; held.resolve();
      // Existing owner's release grants the permit in the first microtask.
      // This later microtask runs before the admitted caller resumes.
      queueMicrotask(() => { now = 190; });
      const lease = await queued; await owner;
      check.equal(lease.permitWaitMs, 30);
      check.equal(lease.resumeDelayMs, 50);
      check.equal(lease.queueWaitMs, 80);
      check.equal(lease.permitWaitMs! + lease.resumeDelayMs!, lease.queueWaitMs);
      check.equal(scheduler.snapshot().activeTotal, 0);
      const cancelled = new AbortController();
      const neverRun = scheduler.run("producer-bulk", cancelled.signal, async () => check.fail("cancelled grant ran"));
      cancelled.abort(); await check.rejects(neverRun);
      check.equal(scheduler.snapshot().activeTotal, 0);
      console.log("[reth-transport-scheduler] diagnostic permit/resume split, disabled overhead and cancellation: PASS");
    } finally {
      if (clockDescriptor) Object.defineProperty(performance, "now", clockDescriptor);
      else Reflect.deleteProperty(performance, "now");
      if (previousFlag === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
      else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = previousFlag;
    }
  }
  {
    const previousFlag = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    const originalLog = console.log;
    const server = createServer(async (request, response) => {
      let text = ""; for await (const part of request) text += part;
      const payload = JSON.parse(text);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload.map((call: { id: number }) => ({ jsonrpc: "2.0", id: call.id, result: "0x01" }))));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      for (const mode of ["disabled", "enabled", "legacy-wrapper"] as const) {
        process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = mode === "disabled" ? "0" : "1";
        const rows: { tag: string; value: Record<string, number> }[] = [];
        console.log = (...args: unknown[]) => {
          const text = String(args[0]);
          const match = /^\[searcher\/(quote-batch-dispatch|quote-batch-timing)\] (.*)$/.exec(text);
          if (match) rows.push({ tag: match[1]!, value: JSON.parse(match[2]!) });
        };
        const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
        const transportScheduler: Pick<RethTransportScheduler, "run"> = mode === "legacy-wrapper" ? {
          run(lane, signal, work) {
            return scheduler.run(lane, signal, lease => {
              const { permitWaitMs: _permit, resumeDelayMs: _resume, ...legacy } = lease;
              return work(legacy);
            });
          },
        } : scheduler;
        const backend = new PinnedRethQuoteBackend(`http://127.0.0.1:${(server.address() as { port: number }).port}`,
          `0x${"ab".repeat(32)}`, { transportScheduler, maxBatchSize: 1, maxConcurrentBatches: 1,
            allowSingleCallFallback: false, deadlineAtMs: Date.now() + 2_000 });
        try {
          check.equal(await backend.call({ to: `0x${"11".repeat(20)}`, data: "0x12345678" }), "0x01");
          check.equal(rows.length, mode === "disabled" ? 0 : 2);
          for (const { value } of rows) {
            check.equal(typeof value.permitQueueWaitMs, "number", "legacy total stays present");
            if (mode === "enabled") {
              check(value.schedulerPermitWaitMs! >= 0 && value.schedulerResumeDelayMs! >= 0);
              check(Math.abs(value.schedulerPermitWaitMs! + value.schedulerResumeDelayMs! - value.permitQueueWaitMs!) < 1e-6);
            } else {
              check.equal(Object.hasOwn(value, "schedulerPermitWaitMs"), false);
              check.equal(Object.hasOwn(value, "schedulerResumeDelayMs"), false);
            }
          }
          check.equal(scheduler.snapshot().activeTotal, 0);
        } finally { await backend.closeAndDrain(); }
      }
    } finally {
      console.log = originalLog;
      if (previousFlag === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
      else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = previousFlag;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    console.log("[reth-transport-scheduler] quote diagnostics preserve totals, optional leases and disabled output: PASS");
  }
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
