import assert from "node:assert/strict";
import {
  createCoalescingPublicationChain,
  PublicationChainBacklogEvictionError,
  PublicationChainDeadlineError,
} from "../strict-live-publication-chain.js";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((ok) => { resolve = ok; });
  return { promise, resolve };
}

async function main(): Promise<void> {
  const order: string[] = [];
  const chain = createCoalescingPublicationChain();

  // Strict ordering: a slow first run must complete before the second starts.
  const firstGate = deferred();
  chain.enqueue(async () => {
    order.push("first:start");
    await firstGate.promise;
    order.push("first:end");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  chain.enqueue(async () => {
    order.push("second");
  });
  firstGate.resolve();
  await chain.idle();
  assert.deepEqual(order, ["first:start", "first:end", "second"]);

  // Coalescing: callbacks arriving while a run is in flight produce exactly
  // one rerun, not one run per callback.
  const gate = deferred();
  let runs = 0;
  const burst = createCoalescingPublicationChain();
  burst.enqueue(async () => {
    runs++;
    await gate.promise;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runs, 1, "the in-flight burst run has started");
  burst.enqueue(async () => { runs++; });
  burst.enqueue(async () => { runs++; });
  assert.equal(runs, 1, "burst callbacks must coalesce while in flight");
  gate.resolve();
  await burst.idle();
  assert.equal(runs, 2, "exactly one rerun after the in-flight run settles");

  // Error isolation: a failing run must not break the next queued run.
  const errors: unknown[] = [];
  const errorChain = createCoalescingPublicationChain((error) => {
    errors.push(error);
  });
  errorChain.enqueue(async () => { throw new Error("boom"); });
  await Promise.resolve();
  await Promise.resolve();
  errorChain.enqueue(async () => { order.push("after-error"); });
  await errorChain.idle();
  assert.equal(errors.length, 1);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second",
    "after-error",
  ]);

  // F3: producer FIFO, per-producer dedup, deadline, and backlog bound.
  const fifoOrder: string[] = [];
  const fifo = createCoalescingPublicationChain();
  fifo.enqueue(async () => { fifoOrder.push("a"); }, { producerKey: "a" });
  fifo.enqueue(async () => { fifoOrder.push("b"); }, { producerKey: "b" });
  await fifo.idle();
  assert.deepEqual(fifoOrder, ["a", "b"], "producers must run in FIFO order");

  const dedupeGate = deferred();
  let dedupeRuns = 0;
  const dedupe = createCoalescingPublicationChain();
  dedupe.enqueue(async () => {
    dedupeRuns++;
    await dedupeGate.promise;
  }, { producerKey: "producer" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(dedupeRuns, 1);
  dedupe.enqueue(async () => { dedupeRuns++; }, { producerKey: "producer" });
  dedupe.enqueue(async () => { dedupeRuns++; }, { producerKey: "producer" });
  dedupeGate.resolve();
  await dedupe.idle();
  assert.equal(dedupeRuns, 2, "re-enqueues for one producer coalesce to one rerun");

  const deadlineErrors: unknown[] = [];
  const deadlineChain = createCoalescingPublicationChain(
    (error) => { deadlineErrors.push(error); },
  );
  const slowGate = deferred();
  let continued = false;
  deadlineChain.enqueue(async () => { await slowGate.promise; }, {
    producerKey: "slow",
    deadlineMs: 30,
  });
  deadlineChain.enqueue(async () => { continued = true; }, {
    producerKey: "next",
  });
  await deadlineChain.idle();
  slowGate.resolve();
  assert.equal(deadlineErrors.length, 1);
  assert(
    deadlineErrors[0] instanceof PublicationChainDeadlineError,
    "an over-deadline run must be reported, not block the chain",
  );
  assert.equal(
    (deadlineErrors[0] as PublicationChainDeadlineError).producerKey,
    "slow",
  );
  assert(continued, "the chain must keep running after a deadline abort");

  const backlogErrors: unknown[] = [];
  const backlog = createCoalescingPublicationChain(
    (error) => { backlogErrors.push(error); },
    { maxBacklog: 2 },
  );
  const backlogGate = deferred();
  backlog.enqueue(async () => { await backlogGate.promise; }, {
    producerKey: "in-flight",
  });
  await Promise.resolve();
  await Promise.resolve();
  backlog.enqueue(async () => {}, { producerKey: "y" });
  backlog.enqueue(async () => {}, { producerKey: "z" });
  backlog.enqueue(async () => {}, { producerKey: "w" });
  assert.equal(backlog.backlogSize(), 3);
  backlogGate.resolve();
  await backlog.idle();
  assert.equal(backlog.evictions(), 1);
  assert.equal(backlogErrors.length, 1);
  assert(backlogErrors[0] instanceof PublicationChainBacklogEvictionError);
  assert.equal(
    (backlogErrors[0] as PublicationChainBacklogEvictionError).producerKey,
    "y",
    "the oldest pending producer must be evicted first",
  );
  assert.equal(backlog.backlogSize(), 0);

  console.log("strict-live-publication-chain PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
