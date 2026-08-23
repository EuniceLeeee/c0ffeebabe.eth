import assert from "node:assert/strict";
import test from "node:test";
import {
  SharedWorkCache,
  SharedWorkRejected,
  assertSemanticWorkKey,
  canonicalWorkKeyHash,
  consumerLease,
} from "../src/index.ts";

const key = {
  ownerRef: "owner-a",
  provider: { provider: "rpc-a", backendEpoch: "epoch-1" },
  source: { chainId: "1", number: "100", hash: "hash-a", stateRoot: "state-a" },
  capabilityFingerprint: "cap-a",
  target: "manager-a",
  request: { manager: "manager-a", topic: "topic-a", lookback: 50, chunk: 100 },
};

test("complete provider/source and opaque request dimensions cannot collide", () => {
  const baseline = canonicalWorkKeyHash(key);
  assert.notEqual(
    canonicalWorkKeyHash({
      ...key,
      provider: { ...key.provider, backendEpoch: "epoch-2" },
    }),
    baseline,
  );
  assert.notEqual(
    canonicalWorkKeyHash({ ...key, source: { ...key.source, number: "101" } }),
    baseline,
  );
  assert.notEqual(
    canonicalWorkKeyHash({ ...key, source: { ...key.source, hash: "hash-b" } }),
    baseline,
  );
  assert.notEqual(
    canonicalWorkKeyHash({
      ...key,
      request: { ...key.request, manager: "manager-b" },
    }),
    baseline,
  );
  assert.notEqual(
    canonicalWorkKeyHash({
      ...key,
      request: { ...key.request, topic: "topic-b" },
    }),
    baseline,
  );
  assert.notEqual(
    canonicalWorkKeyHash({ ...key, request: { ...key.request, lookback: 51 } }),
    baseline,
  );
  assert.notEqual(
    canonicalWorkKeyHash({ ...key, request: { ...key.request, chunk: 101 } }),
    baseline,
  );
});
test("concurrent same-key calls build once and join the same result", async () => {
  const cache = new SharedWorkCache<typeof key, number>();
  let builds = 0;
  let finish!: (value: number) => void;
  const first = cache.getOrBuild(key, consumerLease("first"), async () => {
    builds += 1;
    return new Promise<number>((resolve) => {
      finish = resolve;
    });
  });
  const second = cache.getOrBuild(
    { ...key, request: { ...key.request } },
    consumerLease("second"),
    async () => {
      builds += 1;
      return 99;
    },
  );
  await Promise.resolve();
  assert.equal(builds, 1);
  finish(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.equal(cache.snapshot().settledEntries, 1);
});

test("failed physical build is removed and can be retried", async () => {
  const cache = new SharedWorkCache<typeof key, number>();
  let builds = 0;
  await assert.rejects(
    cache.getOrBuild(key, consumerLease("first"), async () => {
      builds += 1;
      throw new Error("transient");
    }),
  );
  assert.equal(cache.snapshot().inFlightEntries, 0);
  assert.equal(cache.snapshot().settledEntries, 0);
  assert.equal(
    await cache.getOrBuild(key, consumerLease("retry"), async () => {
      builds += 1;
      return 8;
    }),
    8,
  );
  assert.equal(builds, 2);
});

test("consumer abort detaches logically but physical work settles before inFlight clears", async () => {
  const cache = new SharedWorkCache<typeof key, number>();
  let finish!: (value: number) => void;
  let signal!: AbortSignal;
  const controller = new AbortController();
  const result = cache.getOrBuild(
    key,
    consumerLease("abort", { signal: controller.signal }),
    async (physicalSignal) => {
      signal = physicalSignal;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    },
  );
  await Promise.resolve();
  controller.abort("logical-cancel");
  await assert.rejects(result);
  assert.equal(signal.aborted, true);
  assert.equal(cache.snapshot().inFlightEntries, 1);
  finish(3);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cache.snapshot().inFlightEntries, 0);
});

test("incomplete semantic keys and unbound owner seeds are rejected", () => {
  assert.throws(
    () =>
      assertSemanticWorkKey({
        ownerRef: "owner-a",
        provider: key.provider,
        source: key.source,
        capabilityFingerprint: "cap-a",
        target: "target",
      }),
    /missing request/,
  );
  const cache = new SharedWorkCache<typeof key, number>();
  assert.throws(
    () => cache.seed(key, 1, { ownerRef: "different-owner" }),
    /does not bind/,
  );
  assert.throws(() => cache.seed(key, 1, undefined as never), /seed ownerRef/);
});

test("clear invalidates old consumers and permits a fresh generation", async () => {
  const cache = new SharedWorkCache<typeof key, number>();
  let builds = 0;
  const finishes: Array<(value: number) => void> = [];
  const first = cache.getOrBuild(key, consumerLease("first"), async () => {
    builds += 1;
    return new Promise<number>((resolve) => {
      finishes.push(resolve);
    });
  });
  await Promise.resolve();
  cache.clear();
  await assert.rejects(
    first,
    (error: unknown) =>
      error instanceof SharedWorkRejected &&
      error.kind === "rejected" &&
      error.code === "invalidated",
  );
  const second = cache.getOrBuild(key, consumerLease("second"), async () => {
    builds += 1;
    return 2;
  });
  assert.equal(await second, 2);
  assert.equal(builds, 2);
  finishes[0]?.(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cache.snapshot().settledEntries, 1);
});

test("settled hits still honor an already-aborted or expired consumer", async () => {
  const cache = new SharedWorkCache<typeof key, number>();
  await cache.getOrBuild(key, consumerLease("seed"), async () => 4);
  const aborted = new AbortController();
  aborted.abort("drop");
  await assert.rejects(
    cache.getOrBuild(
      key,
      consumerLease("aborted", { signal: aborted.signal }),
      async () => 5,
    ),
    (error: unknown) =>
      error instanceof SharedWorkRejected && error.code === "abort",
  );
  await assert.rejects(
    cache.getOrBuild(
      key,
      consumerLease("expired", { deadlineAtMs: 0 }),
      async () => 5,
    ),
    (error: unknown) =>
      error instanceof SharedWorkRejected && error.code === "deadline",
  );
});
