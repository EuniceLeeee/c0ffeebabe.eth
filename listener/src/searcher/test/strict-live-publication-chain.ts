import assert from "node:assert/strict";
import {
  createCoalescingPublicationChain,
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

  console.log("strict-live-publication-chain PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
