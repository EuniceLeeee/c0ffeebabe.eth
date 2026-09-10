import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import {
  RevmSimClient,
  type RevmFatalReason,
  type RevmRequestControl,
  type RevmSourcePin,
  type StrictSimulateRequest,
} from "../revm-sim-client.js";
import {
  RevmStrictSourceOwner,
  type RevmStrictSourceIdentity,
} from "../revm-strict-source-owner.js";

const HASH = `0x${"ab".repeat(32)}`;
const ROOT = `0x${"bc".repeat(32)}`;
const PARENT = `0x${"cd".repeat(32)}`;
const ENDPOINT = "http://127.0.0.1:1/reviewed-endpoint";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const identity = (generation = 1): RevmStrictSourceIdentity => ({
  source: { number: 300, hash: HASH, generation }, chainId: 1, rpcUrl: ENDPOINT, stateRoot: ROOT,
});
const request = (input = identity()): StrictSimulateRequest => ({
  blockNumber: input.source.number, rpcUrl: input.rpcUrl,
  sourcePin: { chainId: input.chainId, blockHash: input.source.hash, stateRoot: input.stateRoot },
  from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, data: "0x",
});

// Real client framing, queue and terminal/drain behavior, but no spawned child,
// RPC, HTTP server or environment endpoint. Every child/pipe event is controlled.
class Pipes {
  readonly requests: Record<string, unknown>[] = [];
  readonly child = new EventEmitter() as ChildProcessByStdio<Writable, Readable, null>;
  readonly stdout = new PassThrough();
  kills = 0;
  constructor() {
    Object.defineProperties(this.child, {
      exitCode: { value: null }, signalCode: { value: null },
    });
    this.child.stdout = this.stdout;
    this.child.stdin = new Writable({ write: (chunk, _encoding, done) => {
      this.requests.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      done();
    } });
    this.child.kill = () => { this.kills++; return true; };
  }
  reply(index = 0, extra: Record<string, unknown> = {}) {
    const sent = this.requests[index]!;
    const pin = sent.sourcePin as RevmSourcePin | undefined;
    this.stdout.write(JSON.stringify({ epoch: sent.epoch, requestId: sent.requestId,
      ok: true, success: true, latencyMs: 0, output: "0x1234",
      ...(pin && extra.ok !== false ? { sourceAttestation: {
        kind: "node-attested", chainId: pin.chainId, blockNumber: sent.blockNumber,
        blockHash: pin.blockHash, stateRoot: pin.stateRoot ?? ROOT, parentHash: PARENT,
      } } : {}), ...extra }) + "\n");
  }
  close() {
    this.child.emit("exit", 0, null);
    this.child.stdin.destroy();
    this.stdout.destroy();
    this.child.emit("close", 0, null);
  }
}

class PipeClient extends RevmSimClient {
  starts = 0;
  readonly controls: (RevmRequestControl | undefined)[] = [];
  constructor(readonly pipes: Pipes, options: ConstructorParameters<typeof RevmSimClient>[0] = {}) {
    super({ executablePath: process.execPath, ...options });
  }
  protected spawnDaemon() { this.starts++; return this.pipes.child; }
  strictSimulate(input: StrictSimulateRequest, control?: RevmRequestControl) {
    this.controls.push(control);
    return super.strictSimulate(input, control);
  }
}

function harness(options: {
  timeoutMs?: number;
  onFatal?: (reason: RevmFatalReason) => void;
  onCreate?: (client: PipeClient, fatal: (reason: RevmFatalReason) => void) => void;
} = {}) {
  const clients: PipeClient[] = [];
  const callbacks: ((reason: RevmFatalReason) => void)[] = [];
  const fatals: RevmFatalReason[] = [];
  const owner = new RevmStrictSourceOwner({
    createClient({ onFatal }) {
      const client = new PipeClient(new Pipes(), { onFatal, timeoutMs: options.timeoutMs });
      clients.push(client); callbacks.push(onFatal);
      options.onCreate?.(client, onFatal);
      return client;
    },
    onFatal(reason) { fatals.push(reason); options.onFatal?.(reason); },
  });
  return { owner, clients, callbacks, fatals, async close() {
    const closing = owner.shutdown();
    await tick();
    clients.forEach(client => client.pipes.close());
    await closing;
  } };
}

test("admission is lazy, bounded and generation-monotonic; accessor is read-only", async t => {
  const h = harness(); t.after(() => h.close());
  assert.equal(h.clients.length, 0);
  const admitted = h.owner.acquire(identity());
  await assert.rejects(h.owner.acquire(identity(2)), /occupied/);
  const lease = await admitted;
  assert.equal(h.clients.length, 1);
  assert.equal(h.clients[0]!.starts, 0);
  assert.equal(h.clients[0]!.isTerminal, false);
  assert.equal(Object.getOwnPropertyDescriptor(RevmSimClient.prototype, "isTerminal")?.set, undefined);
  assert(Object.isFrozen(lease));
  assert.equal("prepare" in lease, false);
  await assert.rejects(h.owner.acquire(identity(2)), /occupied/);
  await lease.closeAndDrain();
  assert.equal(h.clients[0]!.isTerminal, true);
  await assert.rejects(h.owner.acquire(identity()), /already admitted or retired/);
  await assert.rejects(h.owner.acquire({ ...identity(), rpcUrl: ENDPOINT + "/changed" }), /already admitted or retired/);
  await assert.rejects(lease.strictSimulate(request()), /closed/);
  const next = await h.owner.acquire(identity(2));
  assert.equal(h.clients.length, 2);
  assert.equal(next.source.generation, 2);
  assert.equal(h.clients[1]!.starts, 0, "new admission never replays an old request");
});

test("malformed or already-cancelled admission creates no client and exposes no endpoint", async t => {
  const h = harness(); t.after(() => h.close());
  for (const bad of [
    { ...identity(), source: { ...identity().source, number: -1 } },
    { ...identity(), source: { ...identity().source, hash: "bad" } },
    { ...identity(), source: { ...identity().source, generation: 1.5 } },
    { ...identity(), chainId: 0 }, { ...identity(), stateRoot: "bad" },
    { ...identity(), rpcUrl: "not-an-endpoint?credential=do-not-print" },
  ]) await assert.rejects(h.owner.acquire(bad), error => {
    assert(error instanceof Error);
    assert(!error.message.includes("credential"));
    return /invalid strict source/.test(error.message);
  });
  await assert.rejects(h.owner.acquire(identity(), { signal: AbortSignal.abort() }), /cancelled/);
  await assert.rejects(h.owner.acquire(identity(), { deadlineAtMs: Date.now() - 1 }), /deadline/);
  await assert.rejects(h.owner.acquire(identity(), { deadlineAtMs: NaN }), /deadline/);
  assert.equal(h.clients.length, 0);
  await h.owner.acquire(identity());
  assert.equal(h.clients.length, 1, "pre-admission rejection did not consume a generation");
});

test("source/endpoint snapshots are detached; mismatched and unpinned requests do zero I/O", async t => {
  const h = harness(); t.after(() => h.close());
  const input = { ...identity(), source: { ...identity().source, hash: HASH.toUpperCase().replace("0X", "0x") } };
  const pending = h.owner.acquire(input);
  input.source.hash = PARENT; input.source.generation = 99;
  input.rpcUrl = ENDPOINT + "/other"; input.stateRoot = PARENT;
  const lease = await pending;
  assert.deepEqual(lease.source, identity().source);
  assert(Object.isFrozen(lease.source)); assert(Object.isFrozen(lease.sourcePin));
  assert(!Object.isFrozen(input.source));
  for (const bad of [
    { ...request(), rpcUrl: ENDPOINT + "/other" }, { ...request(), rpcUrl: undefined },
    { ...request(), blockNumber: 301 }, { ...request(), sourcePin: undefined },
    { ...request(), sourcePin: { ...request().sourcePin!, chainId: 2 } },
    { ...request(), sourcePin: { ...request().sourcePin!, blockHash: PARENT } },
    { ...request(), sourcePin: { ...request().sourcePin!, stateRoot: PARENT } },
    { ...request(), sourcePin: { ...request().sourcePin!, stateRoot: undefined } },
  ]) await assert.rejects(lease.strictSimulate(bad), /escaped its source lease/);
  const c = h.clients[0]!;
  assert.equal(c.starts, 0); assert.equal(c.isTerminal, false);
  const result = lease.strictSimulate(request());
  c.pipes.reply(); assert.equal((await result).output, "0x1234");
  assert.equal(c.pipes.requests[0]!.rpcUrl, ENDPOINT);
});

for (const cancellation of ["abort", "deadline"] as const) {
  test(`queued request ${cancellation} leaves active and later requests healthy`, async t => {
    const h = harness(); t.after(() => h.close());
    const lease = await h.owner.acquire(identity()); const c = h.clients[0]!;
    const active = lease.strictSimulate(request());
    const control = new AbortController();
    const queued = assert.rejects(lease.strictSimulate(request(), cancellation === "abort"
      ? { signal: control.signal } : { deadlineAtMs: Date.now() + 30 }), /abort|time|deadline/);
    if (cancellation === "abort") control.abort();
    await queued;
    assert.equal(c.isTerminal, false); assert.equal(c.pipes.kills, 0);
    assert.equal(c.pipes.requests.length, 1);
    c.pipes.reply(); assert.equal((await active).success, true);
    const next = lease.strictSimulate(request()); c.pipes.reply(1);
    assert.equal((await next).success, true);
    assert.equal(h.clients.length, 1); assert.deepEqual(h.fatals, []);
  });
}

test("pre-cancelled requests and ordinary daemon failure do not retire a healthy lease", async t => {
  const h = harness(); t.after(() => h.close());
  const lease = await h.owner.acquire(identity()); const c = h.clients[0]!;
  await assert.rejects(lease.strictSimulate(request(), { signal: AbortSignal.abort() }), /cancelled/);
  await assert.rejects(lease.strictSimulate(request(), { deadlineAtMs: Date.now() - 1 }), /deadline/);
  assert.equal(c.starts, 0); assert.equal(c.isTerminal, false);
  const ordinary = assert.rejects(lease.strictSimulate(request()), /ordinary domain error/);
  c.pipes.reply(0, { ok: false, error: "ordinary domain error: aborted deadline" }); await ordinary;
  assert.equal(c.isTerminal, false); assert.equal(c.pipes.kills, 0);
  const success = lease.strictSimulate(request()); c.pipes.reply(1); await success;
  const reverted = lease.strictSimulate(request());
  c.pipes.reply(2, { success: false, revertReason: "revert: 0x1234" });
  assert.equal((await reverted).success, false);
  assert.equal(c.isTerminal, false); assert.equal(c.pipes.requests.length, 3);
});

for (const cancellation of ["source", "active-request", "active-deadline", "client-timeout"] as const) {
  test(`${cancellation} retires one source; replacement waits for child AND pipes`, async t => {
    const h = harness({ timeoutMs: cancellation === "client-timeout" ? 30 : 60_000 });
    t.after(() => h.close());
    const sourceControl = new AbortController();
    const lease = await h.owner.acquire(identity(), { signal: sourceControl.signal });
    const c = h.clients[0]!; const workControl = new AbortController();
    const active = assert.rejects(lease.strictSimulate(request(), cancellation === "active-deadline"
      ? { deadlineAtMs: Date.now() + 30 } : { signal: workControl.signal }));
    const queued = assert.rejects(lease.strictSimulate(request()));
    if (cancellation === "source") sourceControl.abort();
    if (cancellation === "active-request") workControl.abort();
    await Promise.all([active, queued]);
    assert.equal(c.isTerminal, true); assert.equal(c.pipes.requests.length, 1);
    assert.deepEqual(h.fatals, []);
    assert.equal(sourceControl.signal.aborted, cancellation === "source");
    c.pipes.reply(); // A late response cannot republish/reopen the old lease.
    await assert.rejects(lease.strictSimulate(request()));
    let replaced = false;
    const replacing = h.owner.acquire(identity(2)).then(next => { replaced = true; return next; });
    await tick(); assert.equal(h.clients.length, 1);
    c.pipes.child.emit("exit", null, "SIGTERM"); await tick();
    assert.equal(replaced, false);
    c.pipes.child.emit("close", null, "SIGTERM"); await tick();
    assert.equal(replaced, false, "terminal state and child close are not pipe drainage");
    c.pipes.stdout.destroy();
    const next = await replacing;
    assert.equal(h.clients.length, 2); assert.equal(h.clients[1]!.starts, 0);
    await assert.rejects(h.owner.acquire(identity()), /occupied|retired/);
    const success = next.strictSimulate(request(identity(2)));
    h.clients[1]!.pipes.reply(); assert.equal((await success).success, true);
    assert.equal(c.pipes.requests.length, 1, "old work was never replayed");
  });
}

test("source deadline/control are snapshotted; request deadline is bounded by the source", async t => {
  const h = harness(); t.after(() => h.close());
  const sourceControl = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 100 };
  const expected = sourceControl.deadlineAtMs;
  const lease = await h.owner.acquire(identity(), sourceControl); const c = h.clients[0]!;
  sourceControl.deadlineAtMs += 60_000;
  const pending = assert.rejects(lease.strictSimulate(request(), { deadlineAtMs: expected + 60_000 }));
  assert.equal(c.controls[0]!.deadlineAtMs, expected);
  await pending;
  assert.equal(c.isTerminal, true); assert.deepEqual(h.fatals, []);
});

for (const reason of [
  { kind: "rpc-throttle", category: "http429", httpStatus: 429 },
  { kind: "source-fault" }, { kind: "protocol-fault" },
] as const) {
  test(`${reason.kind} latches synchronously before consumer rejection and bars every replacement`, async t => {
    const order: string[] = [];
    let reentrant: Promise<unknown> | undefined;
    const h = harness({ onFatal: () => {
      order.push("fatal");
      reentrant = assert.rejects(h.owner.acquire(identity(2)), /fatal/);
      throw new Error("observer failed");
    } });
    t.after(() => h.close());
    const lease = await h.owner.acquire(identity()); const c = h.clients[0]!;
    const active = assert.rejects(lease.strictSimulate(request()).catch(error => { order.push("consumer"); throw error; }), /fatal/);
    const queued = assert.rejects(lease.strictSimulate(request()), /fatal/);
    if (reason.kind === "source-fault") c.pipes.reply(0, { sourceAttestation: undefined });
    else if (reason.kind === "protocol-fault") c.pipes.stdout.write("malformed-json\n");
    else c.pipes.reply(0, { fatal: reason });
    assert.deepEqual(order, ["fatal"]);
    await Promise.all([active, queued, reentrant]);
    h.callbacks[0]!(reason);
    assert.equal(h.fatals.length, 1);
    c.pipes.close(); await lease.closeAndDrain();
    await assert.rejects(h.owner.acquire(identity(3)), /fatal/);
    assert.equal(h.clients.length, 1); assert.equal(c.pipes.requests.length, 1);
    assert.deepEqual(order, ["fatal", "consumer"]);
  });
}

test("late fatal from a retired client shuts the successor, not just the obsolete lease", async t => {
  const h = harness(); t.after(() => h.close());
  const first = await h.owner.acquire(identity()); await first.closeAndDrain();
  const second = await h.owner.acquire(identity(2)); const c = h.clients[1]!;
  const active = assert.rejects(second.strictSimulate(request(identity(2))), /fatal/);
  h.callbacks[0]!({ kind: "source-fault" }); await active;
  assert.equal(c.isTerminal, true); assert.equal(h.fatals.length, 1);
  await assert.rejects(h.owner.acquire(identity(3)), /fatal/);
});

test("one waiting admission; cancelling it consumes generation but does not reopen the old slot", async t => {
  const h = harness(); t.after(() => h.close());
  const first = await h.owner.acquire(identity()); const c = h.clients[0]!;
  const succeeded = first.strictSimulate(request()); c.pipes.reply(); await succeeded;
  const draining = first.closeAndDrain();
  const abort = new AbortController();
  const waiting = assert.rejects(h.owner.acquire(identity(2), { signal: abort.signal }), /cancelled/);
  await assert.rejects(h.owner.acquire(identity(3)), /occupied/);
  abort.abort(); await waiting;
  assert.equal(h.clients.length, 1);
  c.pipes.close(); await draining;
  await assert.rejects(h.owner.acquire(identity(2)), /retired/);
  await h.owner.acquire(identity(3)); assert.equal(h.clients.length, 2);
});

test("shutdown joins current drainage and cancels waiting admission permanently", async () => {
  const h = harness();
  const first = await h.owner.acquire(identity()); const c = h.clients[0]!;
  const result = first.strictSimulate(request()); c.pipes.reply(); await result;
  const draining = first.closeAndDrain();
  const waiting = assert.rejects(h.owner.acquire(identity(2)), /shut down/);
  let done = false;
  const shutdown = h.owner.shutdown();
  assert.equal(h.owner.shutdown(), shutdown);
  void shutdown.then(() => { done = true; });
  await waiting; await tick(); assert.equal(done, false);
  await assert.rejects(h.owner.acquire(identity(3)), /shut down/);
  c.pipes.close(); await Promise.all([shutdown, draining]);
  assert.equal(done, true); assert.equal(h.clients.length, 1);
});

for (const action of ["acquire", "cancel", "shutdown", "fatal"] as const) {
  test(`factory reentrant ${action} cannot bypass reservation or lose a newly returned client`, async t => {
    let reentrant: Promise<unknown> | undefined;
    const source = new AbortController();
    const h = harness({ onCreate: (_client, fatal) => {
      if (action === "acquire") reentrant = assert.rejects(h.owner.acquire(identity(2)), /occupied/);
      if (action === "cancel") source.abort();
      if (action === "shutdown") reentrant = h.owner.shutdown();
      if (action === "fatal") fatal({ kind: "protocol-fault" });
    } });
    t.after(() => h.close());
    const acquired = h.owner.acquire(identity(), { signal: source.signal });
    if (action === "acquire") await acquired;
    else await assert.rejects(acquired, /cancelled|shut down|fatal/);
    await reentrant;
    assert.equal(h.clients.length, 1);
    assert.equal(h.clients[0]!.isTerminal, action !== "acquire");
    assert.equal(h.clients[0]!.starts, 0);
  });
}

test("a reused client cannot masquerade as a new generation", async () => {
  const client = new PipeClient(new Pipes());
  const fatals: RevmFatalReason[] = [];
  const owner = new RevmStrictSourceOwner({ createClient: () => client, onFatal: reason => { fatals.push(reason); } });
  const first = await owner.acquire(identity()); await first.closeAndDrain();
  await assert.rejects(owner.acquire(identity(2)), /protocol-fault/);
  assert.deepEqual(fatals, [{ kind: "protocol-fault" }]);
  await assert.rejects(owner.acquire(identity(3)), /fatal/);
  await owner.shutdown();
});

test("source cancellation leaves an unrelated prepared client alone", async t => {
  const h = harness(); t.after(() => h.close());
  const unrelated = new PipeClient(new Pipes());
  t.after(async () => { const drain = unrelated.closeAndDrain(); unrelated.pipes.close(); await drain; });
  const prepared = unrelated.prepare({ blockNumber: 300 });
  const source = new AbortController();
  const lease = await h.owner.acquire(identity(), { signal: source.signal });
  const cancelled = assert.rejects(lease.strictSimulate(request()));
  source.abort(); await cancelled;
  assert.equal(unrelated.isTerminal, false); assert.equal(unrelated.pipes.kills, 0);
  unrelated.pipes.reply(); assert.equal((await prepared).ok, true);
});

test("idle source cancellation closes without a request or global fatal", async t => {
  const h = harness(); t.after(() => h.close());
  const source = new AbortController();
  const lease = await h.owner.acquire(identity(), { signal: source.signal });
  source.abort(); await lease.closeAndDrain();
  assert.equal(h.clients[0]!.isTerminal, true);
  assert.equal(h.clients[0]!.starts, 0); assert.deepEqual(h.fatals, []);
  await h.owner.acquire(identity(2));
});

test("cancellation after admission but before factory consumes the generation without creating a client", async t => {
  const h = harness(); t.after(() => h.close());
  const source = new AbortController();
  const cancelled = assert.rejects(h.owner.acquire(identity(), { signal: source.signal }), /cancelled/);
  source.abort(); await cancelled;
  assert.equal(h.clients.length, 0);
  await assert.rejects(h.owner.acquire(identity()), /retired/);
  await h.owner.acquire(identity(2)); assert.equal(h.clients.length, 1);
});

test("failed drainage is a permanent safety fault, never replacement permission", async () => {
  const fatals: RevmFatalReason[] = [];
  let creations = 0;
  const owner = new RevmStrictSourceOwner({
    createClient: () => {
      creations++;
      return { isTerminal: false,
        strictSimulate: async () => ({ ok: true, success: true, latencyMs: 0 }),
        closeAndDrain: async () => { throw new Error("incomplete drainage"); },
      };
    },
    onFatal: reason => { fatals.push(reason); },
  });
  const lease = await owner.acquire(identity());
  await assert.rejects(lease.closeAndDrain(), /drain failed/);
  await assert.rejects(owner.acquire(identity(2)), /fatal/);
  await assert.rejects(owner.shutdown(), /drain failed/);
  assert.equal(creations, 1); assert.deepEqual(fatals, [{ kind: "protocol-fault" }]);
});

test("source cancellation rejects promptly but replacement also joins outstanding client settlement", async () => {
  let settle!: (value: { ok: boolean; success: boolean; latencyMs: number }) => void;
  const pending = new Promise<{ ok: boolean; success: boolean; latencyMs: number }>(resolve => { settle = resolve; });
  let closePipes!: () => void;
  const pipes = new Promise<void>(resolve => { closePipes = resolve; });
  let creations = 0;
  const owner = new RevmStrictSourceOwner({
    createClient: () => {
      creations++;
      return { isTerminal: false, strictSimulate: () => pending, closeAndDrain: () => pipes };
    }, onFatal: () => assert.fail("expected source cancellation is not fatal"),
  });
  const source = new AbortController();
  const lease = await owner.acquire(identity(), { signal: source.signal });
  const cancelled = assert.rejects(lease.strictSimulate(request()), /cancelled/);
  source.abort(); await cancelled;
  const replacement = owner.acquire(identity(2));
  closePipes(); await tick(); assert.equal(creations, 1);
  settle({ ok: true, success: true, latencyMs: 0 });
  await replacement; assert.equal(creations, 2);
  await owner.shutdown();
});
