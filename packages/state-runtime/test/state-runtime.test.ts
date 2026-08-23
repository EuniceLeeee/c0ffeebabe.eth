import assert from "node:assert/strict";
import test from "node:test";
import {
  StateRuntime,
  StateRuntimeError,
  type StateReadBackendResult,
  type StateReadRequest,
} from "../src/index.ts";

const base: StateReadRequest = {
  requestId: "read-1",
  ownerRef: "state-owner",
  provider: { provider: "rpc", backendEpoch: "epoch" },
  source: {
    chainId: "1",
    number: "200",
    hash: "hash-200",
    stateRoot: "state-200",
  },
  target: "opaque-target",
  calldata: "0x1234",
  storageKey: "0x01",
  requestCodec: "codec-v1",
  instanceRef: "opaque-instance",
  stateSchema: "state-schema-v1",
  interpreterFingerprint: "interpreter-v1",
  parameters: { manager: "manager", topic: "topic", lookback: 50, chunk: 100 },
  callerMode: "impersonated-call-frame",
  observeAccounts: ["account-a", "account-b"],
};

test("same source-bound read coalesces despite different request ids", async () => {
  let reads = 0;
  let finish!: (value: unknown) => void;
  const runtime = new StateRuntime({
    sourceFence: () => undefined,
    backend: {
      read: async ({ request }): Promise<StateReadBackendResult<unknown>> => {
        reads += 1;
        return new Promise<StateReadBackendResult<unknown>>((resolve) => {
          finish = (value) => resolve(value as StateReadBackendResult<unknown>);
        });
      },
    },
  });
  const first = runtime.read(base);
  const second = runtime.read({ ...base, requestId: "read-2" });
  await Promise.resolve();
  assert.equal(reads, 1);
  finish({ source: base.source, raw: { value: "raw" } });
  const values = await Promise.all([first, second]);
  assert.deepEqual(
    values.map((value) => value.raw),
    [{ value: "raw" }, { value: "raw" }],
  );
  assert.equal(runtime.snapshot().settledEntries, 1);
});

test("backend source mismatch is retryable stale, never a prior-source fallback", async () => {
  const runtime = new StateRuntime({
    sourceFence: () => undefined,
    backend: {
      read: async (): Promise<StateReadBackendResult<unknown>> => ({
        source: { ...base.source, number: "199" },
        raw: { value: "stale" },
      }),
    },
  });
  await assert.rejects(
    runtime.read(base),
    (error: unknown) =>
      error instanceof StateRuntimeError && error.code === "source-stale",
  );
});

test("caller mode and observe accounts remain part of the complete read key", async () => {
  const runtime = new StateRuntime({
    sourceFence: () => undefined,
    backend: {
      read: async ({ request }): Promise<StateReadBackendResult<unknown>> => ({
        source: request.source,
        raw: request.parameters,
      }),
    },
  });
  const frame = await runtime.read(base);
  const topLevel = await runtime.read({
    ...base,
    requestId: "read-3",
    callerMode: "top-level",
  });
  const changedAccounts = await runtime.read({
    ...base,
    requestId: "read-4",
    observeAccounts: ["account-a"],
  });
  assert.deepEqual(frame.raw, base.parameters);
  assert.deepEqual(topLevel.raw, base.parameters);
  assert.deepEqual(changedAccounts.raw, base.parameters);
  assert.equal(runtime.snapshot().stats.physicalBuilds, 3);
});

test("owner batch port receives each unique source-bound key once and duplicates are restored", async () => {
  let batches = 0;
  const runtime = new StateRuntime({
    sourceFence: () => undefined,
    backend: {
      read: async ({ request }): Promise<StateReadBackendResult<unknown>> => ({
        source: request.source,
        raw: request.target,
      }),
      readBatch: async ({
        requests,
      }): Promise<readonly StateReadBackendResult<unknown>[]> => {
        batches += 1;
        return requests.map((request) => ({
          source: request.source,
          raw: request.target,
        }));
      },
    },
  });
  const values = await runtime.readBatch([
    base,
    { ...base, requestId: "duplicate-request" },
    { ...base, requestId: "different", target: "other-target" },
  ]);
  assert.equal(batches, 1);
  assert.deepEqual(
    values.map((value) => value.raw),
    ["opaque-target", "opaque-target", "other-target"],
  );
});

test("batch shares physical work while isolating consumer cancellation and fences after settlement", async () => {
  const firstAbort = new AbortController();
  let finish!: (value: readonly StateReadBackendResult<unknown>[]) => void;
  let fenceCalls = 0;
  const runtime = new StateRuntime({
    sourceFence: () => {
      fenceCalls += 1;
    },
    backend: {
      read: async ({ request }): Promise<StateReadBackendResult<unknown>> => ({
        source: request.source,
        raw: request.target,
      }),
      readBatch: async (): Promise<
        readonly StateReadBackendResult<unknown>[]
      > =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const first = runtime.readBatch([
    { ...base, requestId: "batch-a", target: "a", signal: firstAbort.signal },
    { ...base, requestId: "batch-b", target: "b" },
  ]);
  await Promise.resolve();
  firstAbort.abort("drop-a");
  finish([
    { source: base.source, raw: "a" },
    { source: base.source, raw: "b" },
  ]);
  await assert.rejects(first);
  const second = await runtime.read({
    ...base,
    requestId: "batch-c",
    target: "b",
  });
  assert.equal(second.raw, "b");
  assert.equal(fenceCalls >= 4, true);
});

test("malformed state envelopes return typed invalid-request errors", async () => {
  const runtime = new StateRuntime({
    sourceFence: () => undefined,
    backend: {
      read: async ({ request }): Promise<StateReadBackendResult<unknown>> => ({
        source: request.source,
        raw: null,
      }),
    },
  });
  await assert.rejects(
    runtime.read({ ...base, extra: true } as never),
    (error: unknown) =>
      error instanceof StateRuntimeError &&
      error.code === "invalid-request" &&
      error.retryClass === "invalid-program",
  );
  await assert.rejects(
    runtime.read({ ...base, source: { ...base.source, extra: true } } as never),
    (error: unknown) =>
      error instanceof StateRuntimeError && error.code === "invalid-request",
  );
});
