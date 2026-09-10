import assert from "node:assert/strict";
import { test } from "node:test";
import { createRevmStrictSourceSimulation } from "../revm-strict-source-simulation.js";
import { RevmFatalError, type DaemonResponse, type StrictSimulateRequest } from "../revm-sim-client.js";

const hash = `0x${"aa".repeat(32)}`, root = `0x${"bb".repeat(32)}`, parent = `0x${"cc".repeat(32)}`;
const actor = `0x${"11".repeat(20)}`, target = `0x${"22".repeat(20)}`;
const source = { number: 300, hash, generation: 5 };
const identity = { source, rpcUrl: "http://127.0.0.1:1", chainId: 1, stateRoot: root };
const invocation = () => ({ source: { ...source }, callerAuthority: { executor: actor },
  request: { id: "amount-quote", kind: "effect-delta-simulation" as const,
    call: { caller: { kind: "executor" as const }, to: target, data: "0x" },
    overrideIntent: { caller: { kind: "executor" as const } }, observe: ["return-data" as const] } });
function success(request: StrictSimulateRequest): DaemonResponse {
  return { ok: true, success: true, output: "0x1234", gasUsed: "1", latencyMs: 0,
    sourceAttestation: { kind: "node-attested", chainId: 1, blockNumber: request.blockNumber,
      blockHash: hash, stateRoot: root, parentHash: parent },
    strict: { outcome: { kind: "Success", phase: "main", output: "0x1234" }, executionGasUsed: "1",
      nativeDeltas: [], tokenDeltas: [], totalSupplyDeltas: [], logs: [] } };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function harness(options: {
  control?: { signal?: AbortSignal; deadlineAtMs?: number };
  run?: (request: StrictSimulateRequest) => Promise<DaemonResponse>;
  drain?: () => Promise<void>;
  fatal?: () => void;
} = {}) {
  let creates = 0, dispatches = 0, drains = 0, fatals = 0;
  const context = createRevmStrictSourceSimulation({ identity, control: options.control, executionGasLimit: 100,
    createClient() {
      creates++;
      return { isTerminal: false, async strictSimulate(request) {
        dispatches++; return options.run ? options.run(request) : success(request);
      }, async closeAndDrain() { drains++; await options.drain?.(); } };
    }, onFatal() { fatals++; options.fatal?.(); } });
  return { context, counts: () => ({ creates, dispatches, drains, fatals }) };
}

test("one source work slot admits lazily once across quotes, closes once", async () => {
  const h = harness();
  assert.equal(h.counts().creates, 0);
  await h.context.transport.simulate(invocation());
  await h.context.transport.simulate(invocation());
  assert.deepEqual(h.counts(), { creates: 1, dispatches: 2, drains: 0, fatals: 0 });
  await Promise.all([h.context.closeAndDrain(), h.context.closeAndDrain()]);
  await assert.rejects(h.context.transport.simulate(invocation()));
  assert.deepEqual(h.counts(), { creates: 1, dispatches: 2, drains: 1, fatals: 0 });
});

test("closing an unused context cannot admit its first quote", async () => {
  const h = harness(); await h.context.closeAndDrain();
  await assert.rejects(h.context.transport.simulate(invocation()));
  assert.equal(h.counts().creates, 0);
});

test("source and source deadline are captured before the first quote", async () => {
  const mutableIdentity = { ...identity, source: { ...source } };
  const control = { deadlineAtMs: Date.now() + 30_000 };
  let creates = 0;
  const context = createRevmStrictSourceSimulation({ identity: mutableIdentity, control, executionGasLimit: 100,
    createClient() { creates++; return { isTerminal: false,
      async strictSimulate(request, captured) {
        assert.equal(request.rpcUrl, identity.rpcUrl); assert.equal(request.blockNumber, source.number);
        assert.equal(captured!.deadlineAtMs! > Date.now(), true); return success(request);
      }, async closeAndDrain() {} }; }, onFatal() { assert.fail("unexpected fatal"); } });
  mutableIdentity.source.number++; mutableIdentity.rpcUrl = "http://127.0.0.1:2"; control.deadlineAtMs = 1;
  try { await context.transport.simulate(invocation()); assert.equal(creates, 1); }
  finally { await context.closeAndDrain(); }
});

test("source cancellation bars future quotes; a quote abort does not replace a source", async () => {
  const sourceControl = new AbortController(), quote = new AbortController();
  const h = harness({ control: { signal: sourceControl.signal } });
  quote.abort(); await assert.rejects(h.context.transport.simulate({ ...invocation(), control: { signal: quote.signal } }));
  assert.equal(h.counts().creates, 0);
  await h.context.transport.simulate(invocation()); sourceControl.abort();
  await assert.rejects(h.context.transport.simulate(invocation()));
  await assert.rejects(h.context.transport.simulate(invocation()));
  await h.context.closeAndDrain(); assert.equal(h.counts().creates, 1);
});

test("failed first admission remains failed with zero clients", async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness({ control: { signal: controller.signal } });
  await assert.rejects(h.context.transport.simulate(invocation()));
  await assert.rejects(h.context.transport.simulate(invocation()));
  await h.context.closeAndDrain(); assert.equal(h.counts().creates, 0);
});

test("wrong source stops this context before admission and cannot reenter", async () => {
  let reentered: Promise<unknown> | undefined;
  const h = harness({ fatal() { reentered = h.context.transport.simulate(invocation()).catch(() => {}); } });
  await assert.rejects(h.context.transport.simulate({ ...invocation(), source: { ...source, generation: 6 } }), RevmFatalError);
  await reentered; await h.context.closeAndDrain();
  assert.deepEqual(h.counts(), { creates: 0, dispatches: 0, drains: 0, fatals: 1 });
});

test("close joins outstanding work and physical drainage, without replacement", async () => {
  const entered = deferred<void>(), finish = deferred<void>(), drain = deferred<void>();
  const h = harness({ async run(request) { entered.resolve(); await finish.promise; return success(request); },
    drain: () => drain.promise });
  const pending = h.context.transport.simulate(invocation());
  const rejected = assert.rejects(pending); await entered.promise;
  let closed = false; const closing = h.context.closeAndDrain().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  drain.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  finish.resolve(); await rejected; await closing;
  assert.deepEqual(h.counts(), { creates: 1, dispatches: 1, drains: 1, fatals: 0 });
});

test("fatal before close stops the context once and never touches an unrelated one", async () => {
  const h = harness({ run: async () => { throw new RevmFatalError({ kind: "rpc-throttle", category: "http429", httpStatus: 429 }); } });
  const unrelated = harness();
  await assert.rejects(h.context.transport.simulate(invocation()), RevmFatalError);
  await assert.rejects(h.context.transport.simulate(invocation()), RevmFatalError);
  await unrelated.context.transport.simulate(invocation());
  assert.equal(h.counts().fatals, 1); assert.equal(h.counts().creates, 1);
  assert.equal(unrelated.counts().drains, 0);
  await Promise.all([h.context.closeAndDrain(), unrelated.context.closeAndDrain()]);
});
