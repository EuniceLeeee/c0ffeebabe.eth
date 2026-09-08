import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  AnvilStateBackend,
  StateCallAbortedError,
} from "../../shared/state/state-backend.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

interface ForkTestSeam {
  proc: ChildProcess | null;
  spawnForkAt(
    blockNumber: number,
    signal?: AbortSignal,
  ): Promise<void>;
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls = 0;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killCalls += 1;
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    queueMicrotask(() => this.emit("exit", null, this.signalCode));
    return true;
  }
}

const reset = deferred<unknown>();
const fakeProcess = new FakeChildProcess();
let resetCalls = 0;
let providerDestroyCalls = 0;
const backend = new AnvilStateBackend(
  "http://archive.invalid",
  "http://127.0.0.1:65534",
  65534,
);
backend.provider = {
  send(method: string): Promise<unknown> {
    assert.equal(method, "anvil_reset");
    resetCalls += 1;
    return reset.promise;
  },
  destroy(): void {
    providerDestroyCalls += 1;
  },
} as unknown as typeof backend.provider;

const seam = backend as unknown as ForkTestSeam;
seam.proc = fakeProcess as unknown as ChildProcess;
const spawnBlocks: number[] = [];
let successorStartedAt = 0;
seam.spawnForkAt = async (blockNumber, signal) => {
  assert.equal(
    signal?.aborted,
    false,
    "the successor must receive a live generation signal",
  );
  successorStartedAt = Date.now();
  spawnBlocks.push(blockNumber);
};

const cancelledGeneration = new AbortController();
const oldFork = backend.forkAt(100, {
  signal: cancelledGeneration.signal,
});
await waitUntil(() => resetCalls === 1, 250);

// Queue the successor before cancelling the old generation. It must remain
// behind forkAt's ownership barrier until the cancelled reset fully settles.
const successorFork = backend.forkAt(101);
await turn();
assert.deepEqual(
  spawnBlocks,
  [],
  "a successor must not overlap the old non-cooperative reset",
);

const abortedAt = Date.now();
cancelledGeneration.abort(new Error("head superseded"));
await assert.rejects(
  oldFork,
  (error: unknown) =>
    error instanceof StateCallAbortedError &&
    error.kind === "signal" &&
    error.code === "STATE_CALL_ABORTED",
  "a superseded fork generation must reject with typed cancellation",
);
assert(
  Date.now() - abortedAt < 500,
  "forkAt cancellation must not wait for a non-cooperative reset promise",
);
await successorFork;

assert.equal(fakeProcess.killCalls, 1, "cancellation must reap the old Anvil");
assert.equal(
  providerDestroyCalls,
  1,
  "cancellation must destroy the old provider transport",
);
assert.deepEqual(
  spawnBlocks,
  [101],
  "only the serialized successor may spawn a replacement fork",
);
assert(
  successorStartedAt >= abortedAt,
  "the successor must not start before old-generation cancellation",
);

// A late result from the abandoned reset must remain observed but inert. In
// particular it cannot enter forkAt's fallback-spawn path after the successor.
reset.resolve(null);
await turn();
await turn();
assert.deepEqual(
  spawnBlocks,
  [101],
  "a late reset completion must not respawn the cancelled generation",
);

await assert.rejects(
  backend.forkAt(102, { deadlineAtMs: Date.now() - 1 }),
  (error: unknown) =>
    error instanceof StateCallAbortedError &&
    error.kind === "deadline",
  "an already-expired deadline must reject before reset/spawn I/O",
);
assert.deepEqual(
  spawnBlocks,
  [101],
  "an expired fork deadline must not start a replacement process",
);

// send() itself has multiple awaits. A late transaction response must not
// continue mining through the backend's newly installed successor provider.
{
  const sent = deferred<string>();
  const methods: string[] = [];
  let destroyed = false;
  const original = {
    async getBalance() { return 10n ** 24n; },
    async send(method: string) {
      if (destroyed) throw new Error("old provider destroyed");
      methods.push(method);
      if (method === "eth_sendTransaction") return sent.promise;
      return true;
    },
    destroy() { destroyed = true; },
  };
  const pendingBackend = new AnvilStateBackend("http://archive.invalid");
  pendingBackend.provider.destroy();
  pendingBackend.provider = original as unknown as typeof pendingBackend.provider;
  const pending = pendingBackend.send({ from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, data: "0x" });
  await waitUntil(() => methods.includes("eth_sendTransaction"), 250);
  original.destroy();
  let successorCalls = 0;
  pendingBackend.provider = {
    async send() { successorCalls++; throw new Error("successor touched"); },
  } as unknown as typeof pendingBackend.provider;
  sent.resolve(`0x${"ab".repeat(32)}`);
  await assert.rejects(pending, /old provider destroyed/);
  assert.equal(successorCalls, 0, "late send must stay on its destroyed original provider");
}

console.log("state-backend-fork-cancellation PASS");

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadlineAtMs = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadlineAtMs) {
      throw new Error("timed out waiting for fork reset to start");
    }
    await turn();
  }
}
