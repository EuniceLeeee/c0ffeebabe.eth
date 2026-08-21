import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonicalSource,
  type CanonicalHeader,
} from "../src/index.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;

function provider(initial: CanonicalHeader) {
  let head = initial;
  let transportFailure = false;
  return {
    source: new CanonicalSource({
      async getLatestHeader() {
        if (transportFailure) throw new Error("rpc unavailable");
        return head;
      },
      async getHeader(number) {
        if (transportFailure) throw new Error("rpc unavailable");
        return head.number === number ? head : null;
      },
    }),
    setHead(next: CanonicalHeader) { head = next; },
    failTransport() { transportFailure = true; },
  };
}

test("freezes number/hash/stateRoot and validates the exact source fence", async () => {
  const harness = provider({ number: "100", hash: hash("1"), stateRoot: hash("2") });
  const view = await harness.source.freezeView();
  assert.deepEqual(view, { number: "100", hash: hash("1"), stateRoot: hash("2") });
  assert.equal(Object.isFrozen(view), true);
  assert.equal((await harness.source.checkStillCanonical(view)).ok, true);
  assert.equal(await harness.source.ageInBlocks(view), "0");
  assert.deepEqual(harness.source.recentObservationRange(view), ["51", "100"]);
});

test("same-height hash and state-root mutations are fail-closed", async () => {
  const harness = provider({ number: "5", hash: hash("1"), stateRoot: hash("2") });
  const view = await harness.source.freezeView();
  harness.setHead({ number: "5", hash: hash("3"), stateRoot: hash("2") });
  const hashMismatch = await harness.source.checkStillCanonical(view);
  assert.equal(hashMismatch.ok, false);
  if (!hashMismatch.ok) assert.equal(hashMismatch.reason, "hash-mismatch");
  harness.setHead({ number: "5", hash: hash("1"), stateRoot: hash("4") });
  const stateMismatch = await harness.source.checkStillCanonical(view);
  assert.equal(stateMismatch.ok, false);
  if (!stateMismatch.ok) assert.equal(stateMismatch.reason, "state-root-mismatch");
  await assert.rejects(() => harness.source.assertStillCanonical(view), /state-root-mismatch/);
});

test("transport failure is retryable and does not become a terminal reorg", async () => {
  const harness = provider({ number: "9", hash: hash("1"), stateRoot: hash("2") });
  const view = await harness.source.freezeView();
  harness.failTransport();
  const result = await harness.source.checkStillCanonical(view);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "transport");
    assert.equal(result.retryable, true);
  }
  await assert.rejects(
    () => harness.source.assertStillCanonical(view),
    (error: unknown) => error instanceof Error && "retryable" in error && error.retryable === true,
  );
});

test("fence lease is invalidated by the explicit reorg journal epoch", async () => {
  const harness = provider({ number: "20", hash: hash("1"), stateRoot: hash("2") });
  const view = await harness.source.freezeView();
  const lease = await harness.source.acquireFence(view);
  harness.source.notifyReorg();
  const result = await harness.source.validateFenceLease(lease);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.retryable, false);
});
