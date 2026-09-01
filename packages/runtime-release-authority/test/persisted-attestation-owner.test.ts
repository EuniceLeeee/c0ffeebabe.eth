import assert from "node:assert/strict";
import test from "node:test";
import { mapLimitReaped } from "../src/internal/persisted-attestation-owner.ts";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const failure of [new Error("worker-rejected"), "worker-aborted"] as const) {
  test(`persisted Attestation stops claims and reaps started workers after ${typeof failure === "string" ? "abort" : "rejection"}`, async () => {
    const started: number[] = [];
    const completed: number[] = [];
    const rejectGate = deferred();
    const siblingGate = deferred();
    let settled = false;
    const work = mapLimitReaped([0, 1, 2, 3, 4], 3, async value => {
      started.push(value);
      if (value === 0) {
        await rejectGate.promise;
        throw failure;
      }
      await siblingGate.promise;
      completed.push(value);
      return value;
    }).finally(() => { settled = true; });

    assert.deepEqual(started, [0, 1, 2]);
    rejectGate.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, "the owner must await siblings that were already started");
    assert.deepEqual(started, [0, 1, 2], "no worker may claim after the first failure");

    siblingGate.resolve();
    await assert.rejects(work, error => error === failure);
    assert.deepEqual(completed.sort(), [1, 2]);
    assert.deepEqual(started, [0, 1, 2]);
  });
}
