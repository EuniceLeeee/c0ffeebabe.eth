import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RevmFatalError, RevmSimClient, type RevmFatalReason } from "../revm-sim-client.js";
import { ETHEREUM_BLOCK_ACTIVITY_PROFILE } from "../../shared/state/ethereum-block-activity.js";

// No network, binaries, environment endpoints or filesystem fixtures. The
// production framing/lifecycle runs against controlled pipes and child events.
class Fixture {
  readonly requests: Record<string, any>[] = [];
  readonly child = new EventEmitter() as ReturnType<typeof spawn>;
  readonly stdout = new PassThrough();
  kills = 0;
  writesFail = false;
  constructor() {
    Object.defineProperties(this.child, {
      exitCode: { value: null, configurable: true },
      signalCode: { value: null, configurable: true },
    });
    this.child.stdout = this.stdout;
    this.child.stdin = new Writable({ write: (chunk, _encoding, done) => {
      this.requests.push(JSON.parse(chunk.toString()));
      done(this.writesFail ? new Error("fixture write failure") : undefined);
    } });
    this.child.kill = () => { this.kills++; return true; };
  }
  reply(index = 0, changes: Record<string, unknown> = {}) {
    const { epoch, requestId } = this.requests[index]!;
    this.stdout.write(JSON.stringify({ epoch, requestId, ok: true,
      success: true, latencyMs: 0, ...changes }) + "\n");
  }
  close() {
    this.child.emit("exit", 0, null);
    this.child.stdin!.destroy();
    this.stdout.destroy();
    this.child.emit("close", 0, null);
  }
}

class FixtureClient extends RevmSimClient {
  starts = 0;
  constructor(readonly fixture: Fixture, options: ConstructorParameters<typeof RevmSimClient>[0] = {}) {
    super({ executablePath: process.execPath, ...options });
  }
  protected spawnDaemon(): any { this.starts++; return this.fixture.child; }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const prepared = { owner: "owner", executor: "executor", calldata: "0x", profitToken: "token" };

const PIN_HASH = `0x${"11".repeat(32)}`;
const PIN_ROOT = `0x${"22".repeat(32)}`;
const PIN_PARENT = `0x${"33".repeat(32)}`;
const pinnedRequest = () => ({ blockNumber: 300, from: `0x${"aa".repeat(20)}`,
  to: `0x${"bb".repeat(20)}`, data: "0x", rpcUrl: "http://127.0.0.1:1",
  sourcePin: { chainId: 1, blockHash: PIN_HASH, stateRoot: PIN_ROOT } });
const attestation = () => ({ kind: "node-attested" as const, chainId: 1, blockNumber: 300,
  blockHash: PIN_HASH, stateRoot: PIN_ROOT, parentHash: PIN_PARENT });

test("pinned request shape rejects before spawn, never downgrades to legacy", async () => {
  const f = new Fixture(); const c = new FixtureClient(f);
  for (const sourcePin of [null, {}, { chainId: 1 }, { blockHash: PIN_HASH },
    { chainId: 1, blockHash: "0x1234" }, { chainId: 1, blockHash: PIN_HASH, stateRoot: "bad" },
    { chainId: 1, blockHash: PIN_HASH, extra: true }]) {
    await assert.rejects(c.strictSimulate({ ...pinnedRequest(), sourcePin } as any), /pin/i);
  }
  assert.equal(c.starts, 0); await c.closeAndDrain();
});

for (const bad of [undefined, { ...attestation(), blockHash: PIN_PARENT },
  { ...attestation(), stateRoot: PIN_PARENT }, { ...attestation(), blockNumber: 301 }]) {
  test(`pinned response refuses absent/mismatched attestation ${JSON.stringify(bad)}`, async () => {
    const f = new Fixture(); const c = new FixtureClient(f);
    const p = assert.rejects(c.strictSimulate(pinnedRequest()), /source|attest|protocol/);
    f.reply(0, { sourceAttestation: bad }); await p;
    f.close(); await c.closeAndDrain();
  });
}

test("pin and attestation detach from inputs; legacy cannot gain attestation", async () => {
  const f = new Fixture(); const c = new FixtureClient(f); const req = pinnedRequest();
  const p = c.strictSimulate(req); req.sourcePin.blockHash = PIN_PARENT;
  f.reply(0, { sourceAttestation: attestation() });
  const r = await p;
  assert.equal(f.requests[0]!.sourcePin.blockHash, PIN_HASH);
  assert.equal(Object.isFrozen(r.sourceAttestation), true);
  const legacy = assert.rejects(c.strictSimulate({ blockNumber: 300, from: req.from, to: req.to, data: "0x" }), /attest|protocol/);
  f.reply(1, { sourceAttestation: attestation() }); await legacy;
  f.close(); await c.closeAndDrain();
});

test("one physical request; IDs and detached queued payloads cover every API", async () => {
  const f = new Fixture(); const c = new FixtureClient(f);
  const req = { blockNumber: 1, prewarmCalls: [{ from: "a", to: "b", calldata: "0x" }] };
  const calls = [c.health(), c.prepare({ blockNumber: 1 }), c.warm(req),
    c.quote({ to: "b", data: "0x" }), c.simulatePrepared(prepared),
    c.strictSimulate({ blockNumber: 1, from: "a", to: "b", data: "0x" }), c.reset()];
  req.prewarmCalls[0]!.from = "mutated";
  assert.equal(f.requests.length, 1);
  for (let i = 0; i < calls.length; i++) { f.reply(i); await calls[i]; await tick(); }
  assert.deepEqual(f.requests.map(r => r.op), ["health", "prepare", "warm", "quote", "simulate", "strictSimulate", "reset"]);
  assert.equal(f.requests[2]!.prewarmCalls[0].from, "a");
  assert.equal(new Set(f.requests.map(r => r.requestId)).size, 7);
  assert.equal(new Set(f.requests.map(r => r.epoch)).size, 1);
  assert.equal(typeof f.requests[0]!.epoch, "string");
  c.stop(); f.close(); await c.closeAndDrain();
});

test("queued and pre-aborted requests cancel with zero I/O, leaving active healthy", async () => {
  const f = new Fixture(); const c = new FixtureClient(f);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(c.health({ signal: abort.signal }), /abort/i);
  assert.equal(c.starts, 0);
  const active = c.health(); const queued = new AbortController();
  const rejected = assert.rejects(c.reset({ signal: queued.signal }), /abort/i);
  queued.abort(); await rejected;
  await assert.rejects(c.health({ deadlineAtMs: Date.now() - 1 }), /deadline|time/i);
  assert.equal(f.requests.length, 1); assert.equal(f.kills, 0);
  f.reply(); await active;
  c.stop(); f.close(); await c.closeAndDrain();
});

test("active cancellation poisons epoch, rejects queue and drains actual close, not exit", async () => {
  const f = new Fixture(); const c = new FixtureClient(f);
  const abort = new AbortController();
  const active = assert.rejects(c.health({ signal: abort.signal }), /abort/i);
  const queued = assert.rejects(c.health(), /abort/i);
  abort.abort(); await Promise.all([active, queued]);
  assert.equal(f.kills, 1); assert.equal(f.requests.length, 1);
  f.reply(); // A late result cannot resurrect this epoch.
  await assert.rejects(c.health(), /abort/i); assert.equal(c.starts, 1);
  let drained = false; const drain = c.closeAndDrain().then(() => { drained = true; });
  f.child.emit("exit", null, "SIGTERM"); await tick(); assert.equal(drained, false);
  f.child.emit("close", null, "SIGTERM"); await tick(); assert.equal(drained, false);
  f.child.stdin!.destroy(); f.stdout.destroy(); await drain;
  assert.equal(drained, true);
});

test("active timeout cannot shift its late response to queued work", async () => {
  const f = new Fixture(); const c = new FixtureClient(f, { timeoutMs: 20 });
  const a = assert.rejects(c.health(), /time/i); const b = assert.rejects(c.health(), /time/i);
  await Promise.all([a, b]); f.reply();
  assert.equal(f.requests.length, 1); assert.equal(f.kills, 1);
  await assert.rejects(c.health(), /time/i);
  f.close(); await c.closeAndDrain();
});

for (const bad of ["old-epoch", "unknown-id", "duplicate-id", "invalid-json"]) {
  test(`${bad} never resolves different work`, async () => {
    const f = new Fixture(); const c = new FixtureClient(f);
    const first = c.health();
    if (bad === "duplicate-id") { f.reply(); await first; }
    const failed = bad === "duplicate-id" ? c.health() : first;
    const rejection = assert.rejects(failed, /protocol|response/i);
    if (bad === "invalid-json") f.stdout.write("not JSON\n");
    else f.reply(0, bad === "old-epoch" ? { epoch: "old" } : bad === "unknown-id" ? { requestId: "9999" } : {});
    await rejection; assert.equal(f.kills, 1);
    f.close(); await c.closeAndDrain();
  });
}

test("typed fatal callback fires once before conversion/rejection, even if observer throws", async () => {
  const f = new Fixture(); const order: string[] = [];
  const c = new FixtureClient(f, { onFatal: reason => {
    assert.deepEqual(reason, { kind: "rpc-throttle", category: "http429", httpStatus: 429 });
    order.push("fatal"); throw new Error("observer");
  } });
  const failed = c.strictSimulate({ blockNumber: 1, from: "a", to: "b", data: "0x" })
    .catch(err => { order.push("catch"); assert.equal(err.fatal.kind, "rpc-throttle"); });
  f.reply(0, { ok: true, fatal: { kind: "rpc-throttle", category: "http429", httpStatus: 429 } });
  await failed; f.reply(0, { fatal: { kind: "rpc-throttle", category: "http429", httpStatus: 429 } });
  assert.deepEqual(order, ["fatal", "catch"]);
  await assert.rejects(c.reset(), /throttle/); f.close(); await c.closeAndDrain();
});

test("partial frames, ordinary revert text and reset domain errors", async () => {
  const f = new Fixture(); const c = new FixtureClient(f);
  const quoted = c.quote({ to: "b", data: "0x" });
  const r = f.requests[0]!;
  f.stdout.write(JSON.stringify({ epoch: r.epoch, requestId: r.requestId, ok: true,
    success: false, revertReason: "contract says 429", latencyMs: 0 }));
  let done = false; void quoted.then(() => { done = true; }); await tick(); assert.equal(done, false);
  f.stdout.write("\n"); assert.equal((await quoted).success, false);
  const reset = assert.rejects(c.reset(), /reset failed/); f.reply(1, { ok: false, error: "reset failed" }); await reset;
  assert.equal(f.kills, 0); c.stop(); f.close(); await c.closeAndDrain();
});

test("one-shot uses correlated prepare/simulate/reset, and propagates control", async () => {
  const f = new Fixture(); const c = new FixtureClient(f);
  const result = c.simulate({ ...prepared, blockNumber: 1 });
  for (let i = 0; i < 3; i++) { f.reply(i); await tick(); }
  assert.equal((await result).success, true);
  assert.deepEqual(f.requests.map(r => r.op), ["prepare", "simulate", "reset"]);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(c.simulate({ ...prepared, blockNumber: 1 }, { signal: abort.signal }), /abort/i);
  assert.equal(f.requests.length, 3); c.stop(); f.close(); await c.closeAndDrain();
});

for (const failure of ["spawn", "write", "exit", "stdout"]) {
  test(`${failure} failure is terminal and drainable`, async () => {
    const f = new Fixture(); const c = new FixtureClient(f); f.writesFail = failure === "write";
    const failed = assert.rejects(c.health());
    if (failure === "spawn") f.child.emit("error", new Error("spawn failed"));
    if (failure === "exit") f.child.emit("exit", 1, null);
    if (failure === "stdout") f.stdout.emit("error", new Error("pipe failed"));
    await failed; await assert.rejects(c.health()); assert.equal(c.starts, 1);
    f.close(); await c.closeAndDrain();
  });
}

test("stop is terminal before spawn; real owned child and pipes drain", async () => {
  const unopened = new RevmSimClient(); unopened.stop();
  await unopened.closeAndDrain(); await assert.rejects(unopened.health(), /stop|clos/i);
  class RealFixtureClient extends RevmSimClient {
    child?: ReturnType<typeof spawn>;
    protected spawnDaemon(): any {
      this.child = spawn(process.execPath, ["-e", `
        require('readline').createInterface({ input: process.stdin }).on('line', line => {
          const {epoch,requestId} = JSON.parse(line);
          process.stdout.write(JSON.stringify({epoch,requestId,ok:true,latencyMs:0})+'\\n');
        });
      `], { stdio: ["pipe", "pipe", "inherit"] });
      return this.child;
    }
  }
  const c = new RealFixtureClient({ executablePath: process.execPath });
  await c.health(); const child = c.child!;
  c.stop(); await c.closeAndDrain();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(child.stdin!.closed, true); assert.equal(child.stdout!.closed, true);
});

test("actual quote child: timeout A rejects B; late A is drained, never assigned to B", async () => {
  class LateClient extends RevmSimClient {
    child?: ReturnType<typeof spawn>;
    received = "";
    protected spawnDaemon(): any {
      this.child = spawn(process.execPath, ["-e", `
        process.on('SIGTERM', () => {});
        let count = 0;
        require('readline').createInterface({ input: process.stdin }).on('line', line => {
          const {epoch,requestId,op} = JSON.parse(line); count++;
          const reply = () => process.stdout.write(JSON.stringify({epoch,requestId,ok:true,
            output:op==='quote'?'late-response-to-A':'ready',count,latencyMs:0})+'\\n');
          if(op==='health') reply();
          else { setTimeout(reply, 80); setTimeout(() => process.exit(0), 150); }
        });
      `], { stdio: ["pipe", "pipe", "inherit"] });
      this.child.stdout!.on("data", chunk => { this.received += chunk.toString(); });
      return this.child;
    }
  }
  const c = new LateClient({ executablePath: process.execPath, timeoutMs: 2_000 });
  await c.health();
  const a = assert.rejects(c.quote({ to: "A", data: "0x" }, { deadlineAtMs: Date.now() + 40 }), /time/i);
  await delay(20);
  const b = assert.rejects(c.quote({ to: "B", data: "0x" }), /time/i);
  await Promise.all([a, b]);
  await c.closeAndDrain();
  const frames = c.received.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(frames[1]!.output, "late-response-to-A");
  assert.equal(frames[1]!.count, 2, "only health and A physically reached the child");
  assert.equal(frames.length, 2);
  assert.equal(c.child!.stdout!.closed, true);
  await assert.rejects(c.quote({ to: "C", data: "0x" }), /time/i);
});

test("queued deadline expires without interrupting longer-lived active request", async () => {
  const f = new Fixture(); const c = new FixtureClient(f, { timeoutMs: 2_000 });
  const active = c.health();
  await assert.rejects(c.health({ deadlineAtMs: Date.now() + 10 }), /time/i);
  assert.equal(f.requests.length, 1); assert.equal(f.kills, 0);
  f.reply(); await active; c.stop(); f.close(); await c.closeAndDrain();
});

test("all public methods accept cancellation before spawn", async () => {
  const f = new Fixture(); const c = new FixtureClient(f);
  const abort = new AbortController(); abort.abort(); const control = { signal: abort.signal };
  const ops = [c.health(control), c.reset(control), c.prepare({ blockNumber: 1 }, control),
    c.warm({ blockNumber: 1, prewarmCalls: [] }, control), c.quote({ to: "b", data: "0x" }, control),
    c.simulatePrepared(prepared, control), c.simulate({ ...prepared, blockNumber: 1 }, control),
    c.strictSimulate({ blockNumber: 1, from: "a", to: "b", data: "0x" }, control)];
  await Promise.all(ops.map(op => assert.rejects(op, /abort/i)));
  assert.equal(c.starts, 0); await c.closeAndDrain();
});

test("real spawn failure closes pipes and never restarts", async () => {
  const c = new RevmSimClient({ executablePath: process.cwd() }); // directory: EACCES
  await assert.rejects(c.health()); await c.closeAndDrain(); await assert.rejects(c.health());
});

for (const category of ["rpc-limit-code", "rpc-rate-limit", "rpc-quota"] as const) {
  test(`normalized ${category} is latched before every domain API`, async () => {
    const f = new Fixture(); const reasons: unknown[] = [];
    const c = new FixtureClient(f, { onFatal: reason => reasons.push(reason) });
    const failure = assert.rejects(c.warm({ blockNumber: 1, prewarmCalls: [] }), /throttle/);
    const fatal = { kind: "rpc-throttle", category, rpcCode: category === "rpc-limit-code" ? -32005 : -32000 };
    f.reply(0, { ok: false, fatal, error: "domain error must not mask fatal" }); await failure;
    await assert.rejects(c.health(), /throttle/); assert.deepEqual(reasons, [fatal]);
    f.close(); await c.closeAndDrain();
  });
}

test("unknown fatal category is a protocol failure, not accepted throttle evidence", async () => {
  const f = new Fixture(); const reasons: RevmFatalReason[] = [];
  const c = new FixtureClient(f, { onFatal: reason => reasons.push(reason) });
  const failure = assert.rejects(c.health(), /protocol/);
  f.reply(0, { fatal: { kind: "rpc-throttle", category: "untrusted", rpcCode: -32000 } });
  await failure; assert.deepEqual(reasons, [{ kind: "protocol-fault" }]); f.close(); await c.closeAndDrain();
});

for (const bad of ["missing-attestation", "wrong-attestation", "wrong-id", "wrong-epoch", "duplicate", "bad-json", "truncated-exit", "truncated-end"]) {
  test(`owner-visible fatal precedes rejection and gates queue: ${bad}`, async () => {
    const f = new Fixture(); const order: string[] = []; const reasons: RevmFatalReason[] = [];
    const c = new FixtureClient(f, { onFatal: reason => { order.push("fatal"); reasons.push(reason); } });
    if (bad === "duplicate") { const first = c.health(); f.reply(); await first; }
    const active = c.strictSimulate(pinnedRequest()).catch(e => { order.push("rejection"); return e; });
    const queued = assert.rejects(c.health(), RevmFatalError);
    const index = f.requests.length - 1;
    if (bad.startsWith("truncated")) {
      f.stdout.write('{"epoch":');
      if (bad === "truncated-exit") f.child.emit("exit", 1, null); else f.stdout.emit("end");
    } else if (bad === "bad-json") f.stdout.write("not-json\n");
    else if (bad === "duplicate") f.reply(0);
    else f.reply(index, bad === "missing-attestation" ? {} : bad === "wrong-attestation"
      ? { sourceAttestation: { ...attestation(), blockHash: PIN_PARENT } }
      : bad === "wrong-id" ? { requestId: "999" } : { epoch: "old" });
    assert.ok((await active) instanceof RevmFatalError); await queued;
    const kind = bad.endsWith("attestation") ? "source-fault" : "protocol-fault";
    assert.deepEqual(reasons, [{ kind }]); assert.deepEqual(order, ["fatal", "rejection"]);
    const count = f.requests.length; f.reply(index, { sourceAttestation: attestation() });
    await assert.rejects(c.health(), RevmFatalError); assert.equal(f.requests.length, count); assert.equal(reasons.length, 1);
    f.close(); await c.closeAndDrain();
  });
}

test("owned launcher group escalates and drains descendants without killing another child", { skip: process.platform === "win32" }, async () => {
  class LauncherFixture extends RevmSimClient {
    child?: ReturnType<typeof spawn>;
    protected spawnDaemon(command: string, _args: string[], detached: boolean): any {
      assert.equal(command, "cargo"); assert.equal(detached, true);
      const daemonCode = `
        process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
        require('readline').createInterface({input:process.stdin}).on('line', line => {
          const {epoch,requestId} = JSON.parse(line);
          process.stdout.write(JSON.stringify({epoch,requestId,ok:true,latencyMs:0})+'\\n');
        });`;
      this.child = spawn(process.execPath, ["-e", `
        process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
        require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(daemonCode)}], {stdio:'inherit'});
      `], { stdio: ["pipe", "pipe", "inherit"], detached });
      return this.child;
    }
  }
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const c = new LauncherFixture({ manifestPath: `/revm-sim-fixture-missing-${process.pid}/Cargo.toml`, timeoutMs: 2_000 });
  try {
    await c.health(); c.stop(); await c.closeAndDrain();
    assert.equal(c.child!.signalCode, "SIGKILL"); assert.equal(c.child!.stdout!.closed, true);
    assert.equal(other.exitCode, null); assert.equal(other.signalCode, null);
  } finally {
    const closed = once(other, "close"); other.kill(); await closed;
    await c.closeAndDrain();
  }
});

// Run after `cargo build --locked --offline`, explicitly pointing at that
// rebuilt binary. Normal unit runs do not choose/fallback to an existing binary.
type RpcWire = { id: number; method: string; params: any[] };
const word = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const quantity = (n: number) => `0x${n.toString(16)}`;
const branchHash = (height: number, branch = 1) => word(branch * 100_000 + height);
const header = (height = 300, branch = 1): Record<string, any> => ({
  number: quantity(height), hash: branchHash(height, branch), parentHash: branchHash(height - 1, branch),
  stateRoot: word(branch * 1_000 + height), timestamp: quantity(1_800_000_000), gasLimit: "0x1c9c380",
  gasUsed: "0x5208", baseFeePerGas: "0x1", miner: `0x${"cc".repeat(20)}`,
  mixHash: word(123), difficulty: "0x0", blobGasUsed: "0x0", excessBlobGas: "0x0",
  nonce: "0x0000000000000000", sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347", uncles: [],
  transactionsRoot: word(4), receiptsRoot: word(5), withdrawalsRoot: word(6), parentBeaconBlockRoot: word(7),
  requestsHash: word(8), logsBloom: `0x${"00".repeat(256)}`, extraData: "0x",
});
const returnCode = (n: number) => `0x60${n.toString(16).padStart(2, "0")}60005260206000f3`;
const storageCode = "0x60005460005260206000f3";
const blockhashCode = "0x6000354060005260206000f3";
const target = pinnedRequest().to;

// Actual daemon + deterministic loopback state. A numeric state/trace selector
// is poisoned by default, not silently made equivalent to the requested hash.
class PinnedRpcFixture {
  readonly calls: RpcWire[] = [];
  canonical = header();
  readonly headers = new Map<string, Record<string, any>>();
  readonly codes = new Map<string, string>();
  readonly storage = new Map<string, string>();
  chainId = "0x1";
  allowLegacy = false;
  trace: any = { error: { code: -32601, message: "method not supported" } };
  hook?: (call: RpcWire) => any;
  batchHook?: (calls: RpcWire[]) => any;
  holdMethod?: string;
  readonly server = createServer((req, res) => {
    let raw = ""; req.setEncoding("utf8"); req.on("data", c => raw += c);
    req.on("end", () => {
      const body: RpcWire | RpcWire[] = JSON.parse(raw);
      const calls = Array.isArray(body) ? body : [body];
      this.calls.push(...calls);
      if (calls.some(c => c.method === this.holdMethod)) return;
      const overridden = Array.isArray(body) ? this.batchHook?.(calls) : undefined;
      const response = overridden ?? (Array.isArray(body) ? calls.map(c => this.reply(c)) : this.reply(body));
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(response));
    });
  });
  url = "";
  constructor() {
    for (const branch of [1, 2]) for (let n = 0; n <= 301; n++) {
      const h = header(n, branch); this.headers.set(h.hash, h);
    }
    this.codes.set(branchHash(300), returnCode(42));
    this.codes.set(branchHash(300, 2), returnCode(43));
    this.codes.set(branchHash(301), returnCode(44));
  }
  reply(call: RpcWire): any {
    const overridden = this.hook?.(call);
    if (overridden !== undefined) return { jsonrpc: "2.0", id: call.id, ...overridden };
    const ok = (result: any) => ({ jsonrpc: "2.0", id: call.id, result });
    const err = (message: string) => ({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message } });
    if (call.method === "eth_chainId") return ok(this.chainId);
    if (call.method === "eth_getBlockByHash") return ok(this.headers.get(call.params[0]) ?? null);
    if (call.method === "eth_getBlockByNumber") return ok(this.canonical);
    const selector = call.params[call.method === "eth_getStorageAt" ? 2 : 1];
    const pin = typeof selector === "object" && selector !== null
      && selector.requireCanonical === true && this.headers.has(selector.blockHash);
    if (!pin && !this.allowLegacy) return err("numeric or invalid state selector forbidden");
    const hash = pin ? selector.blockHash : this.canonical.hash;
    if (call.method === "debug_traceCall") return { jsonrpc: "2.0", id: call.id, ...this.trace };
    if (call.method === "eth_getBalance" || call.method === "eth_getTransactionCount") return ok("0x0");
    if (call.method === "eth_getCode") return ok(call.params[0] === target ? (this.codes.get(hash) ?? "0x") : "0x");
    if (call.method === "eth_getStorageAt") return ok(this.storage.get(hash) ?? word(7));
    return err("unexpected fixture method");
  }
  async start() {
    this.server.listen(0, "127.0.0.1"); await once(this.server, "listening");
    const address = this.server.address(); assert.ok(address && typeof address === "object");
    this.url = `http://127.0.0.1:${address.port}`;
  }
  request() { return { ...pinnedRequest(), rpcUrl: this.url,
    blockNumber: Number(BigInt(this.canonical.number)), sourcePin: { chainId: 1,
      blockHash: this.canonical.hash as string, stateRoot: this.canonical.stateRoot as string } }; }
  stateCalls() { return this.calls.filter(c => ["eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getStorageAt"].includes(c.method)); }
  async close() { await new Promise<void>((resolve, reject) => this.server.close(err => err ? reject(err) : resolve())); }
}
class PinnedDirectClient extends RevmSimClient {
  readonly responses: Record<string, any>[] = [];
  protected spawnDaemon(command: string, args: string[], detached: boolean) {
    assert.equal(command, process.env.REVM_SIM_TEST_BINARY); assert.equal(detached, false);
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], detached,
      env: { ...process.env, MAINNET_RPC_URL: "", NO_PROXY: "127.0.0.1,localhost,*", no_proxy: "127.0.0.1,localhost,*",
        // Explicit inert proxy avoids platform auto-discovery; NO_PROXY bypasses
        // it for every request. Both possible destinations remain loopback.
        HTTP_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1", all_proxy: "http://127.0.0.1:1" } });
    // Observe the real daemon envelope before the production client's domain
    // conversion, so a rejected promise alone cannot hide published attestation.
    let buffered = "";
    child.stdout.on("data", chunk => {
      buffered += chunk.toString();
      let end: number;
      while ((end = buffered.indexOf("\n")) >= 0) {
        this.responses.push(JSON.parse(buffered.slice(0, end)));
        buffered = buffered.slice(end + 1);
      }
    });
    return child;
  }
}
async function pinnedFixture(run: (f: PinnedRpcFixture, c: PinnedDirectClient, fatal: RevmFatalReason[]) => Promise<void>,
  onFatal?: (reason: RevmFatalReason) => void) {
  const f = new PinnedRpcFixture(); await f.start(); const fatal: RevmFatalReason[] = [];
  const c = new PinnedDirectClient({ executablePath: process.env.REVM_SIM_TEST_BINARY,
    timeoutMs: 15_000, onFatal: r => { fatal.push(r); onFatal?.(r); } });
  try { await run(f, c, fatal); }
  catch (error) { console.error("loopback fixture last calls", f.calls.slice(-5)); throw error; }
  finally { await c.closeAndDrain(); await f.close(); }
}

if (process.env.REVM_SIM_TEST_BINARY) {
  test("pinned direct: same-pin warm reuse and changed-pin bytecode never leak", async () => pinnedFixture(async (f, c) => {
    const first = await c.strictSimulate(f.request()); assert.equal(first.output, word(42));
    assert.equal(first.sourceAttestation?.blockHash, f.canonical.hash);
    const count = f.stateCalls().length;
    assert.equal((await c.strictSimulate(f.request())).output, word(42));
    assert.equal(f.stateCalls().length, count, "same pin must remain warm");
    f.canonical = header(300, 2);
    assert.equal((await c.strictSimulate(f.request())).output, word(43));
    f.canonical = header(301);
    assert.equal((await c.strictSimulate(f.request())).output, word(44));
    assert.deepEqual(f.calls.filter(c => c.method === "eth_getCode" && c.params[0] === target)
      .map(c => c.params[1].blockHash), [branchHash(300), branchHash(300, 2), branchHash(301)]);
    await c.reset();
    assert.equal((await c.strictSimulate(f.request())).output, word(44));
    assert.equal(f.calls.filter(c => c.method === "eth_getCode" && c.params[0] === target).length, 4);
  }));

  for (const bad of ["chain", "missing-header", "hash", "number", "root", "parent", "timestamp", "gasLimit",
    "gasUsed", "baseFeePerGas", "miner", "mixHash", "difficulty", "blobGasUsed", "excessBlobGas",
    "nonce", "sha3Uncles", "uncles", "transactionsRoot", "receiptsRoot", "withdrawalsRoot",
    "parentBeaconBlockRoot", "requestsHash", "logsBloom", "extraData"]) {
    test(`pinned direct: rejects bad ${bad} before state I/O`, async () => pinnedFixture(async (f, c, fatal) => {
      const req = f.request(); const h = f.headers.get(req.sourcePin.blockHash)!;
      if (bad === "chain") f.chainId = "0x2";
      else if (bad === "missing-header") f.headers.delete(req.sourcePin.blockHash);
      else if (bad === "hash") h.hash = branchHash(300, 2);
      else if (bad === "number") h.number = "0x12d";
      else if (bad === "root") h.stateRoot = word(99);
      else if (bad === "parent") h.parentHash = "0x0";
      else delete h[bad];
      await assert.rejects(c.strictSimulate(req), /source-fault/);
      assert.equal(f.stateCalls().length, 0); assert.deepEqual(fatal, [{ kind: "source-fault" }]);
      const count = f.calls.length; await assert.rejects(c.health(), /source-fault/); assert.equal(f.calls.length, count);
    }));
  }
  for (const outcome of ["return", "revert"]) for (const stage of ["before", "during"]) {
    test(`pinned direct: reorg ${stage} rejects ${outcome}`, async () => pinnedFixture(async (f, c) => {
      if (outcome === "revert") f.codes.set(f.canonical.hash, "0x60006000fd");
      const req = f.request();
      if (stage === "before") f.canonical = header(300, 2);
      else f.hook = call => { if (call.method === "debug_traceCall") f.canonical = header(300, 2); };
      await assert.rejects(c.strictSimulate(req), /source-fault/);
      if (stage === "before") assert.equal(f.stateCalls().length, 0);
    }));
  }
  for (const trace of [
    { error: { code: -32601, message: "method not supported" } },
    { error: { code: -32602, message: "hash selector unsupported" } },
    { error: { code: 3, message: "hash is not currently canonical" } },
    { error: { code: "CALL_EXCEPTION", message: "hash is not currently canonical" } },
    { error: { code: -32000, message: "hash is not currently canonical", data: "0xdead" } },
    { error: { code: -32000, message: "execution reverted: hash is not currently canonical" } },
    { error: { code: 3, message: "hash is not currently canonical", data: {} } },
    { error: { code: "CALL_EXCEPTION", message: `header not found: ${branchHash(300)}`, data: {} } },
    { error: { code: -32000, message: "hash is not currently canonical", data: "0x" } },
    { error: { code: -32001, message: `header not found: ${branchHash(300)}`, data: "0x" } },
    { error: { code: -32001, message: `header not found: ${branchHash(300)}`, data: "0xdeadbeef" } },
    { error: { code: -32000, message: "execution reverted: hash is not currently canonical", data: {} } },
    { error: { code: -32001, message: `revert: header not found: ${branchHash(300)}`, data: {} } },
    { error: { code: -32001, message: `contract says header not found: ${branchHash(300)}`, data: {} } },
    { error: { code: -32001, message: "header not found: 0x1234", data: {} } },
    { error: { code: -32001, message: `header not found: ${branchHash(300)} extra text`, data: {} } },
    { error: { code: -32001, message: `header not found: 0x${"zz".repeat(32)}`, data: {} } },
    { result: null }, { result: { malformed: { storage: {} } } },
    { result: { [target]: { code: returnCode(99), balance: "bogus", nonce: "bogus", storage: { [word(0)]: word(99) } } } },
  ]) {
    test(`pinned direct: optional trace fallback/hints ${JSON.stringify(trace)}`, async () => pinnedFixture(async (f, c, fatal) => {
      f.trace = trace; f.codes.set(f.canonical.hash, storageCode);
      const r = await c.strictSimulate(f.request()); assert.equal(r.output, word(7)); assert.deepEqual(fatal, []);
      assert.ok(f.calls.some(c => c.method === "eth_getStorageAt"));
      for (const call of f.calls.filter(c => !["eth_chainId", "eth_getBlockByHash", "eth_getBlockByNumber"].includes(c.method))) {
        assert.deepEqual(call.params[call.method === "eth_getStorageAt" ? 2 : 1],
          { blockHash: f.canonical.hash, requireCanonical: true });
      }
    }));
  }
  for (const shape of ["item", "whole", "unknown-id"]) {
    test(`pinned direct: optional trace source-fault ${shape} latches before conversion`, async () => pinnedFixture(async (f, c, fatal) => {
      const error = { jsonrpc: "2.0", id: 999, error: { code: -32000, message: "hash is not currently canonical" } };
      f.trace = { error: error.error };
      if (shape !== "item") f.batchHook = calls => calls.every(c => c.method === "debug_traceCall")
        ? (shape === "whole" ? error : [error]) : undefined;
      await assert.rejects(c.strictSimulate(f.request()), e => { assert.deepEqual(fatal, [{ kind: "source-fault" }]); return e instanceof RevmFatalError; });
      const n = f.calls.length; await assert.rejects(c.health(), /source-fault/); await assert.rejects(c.strictSimulate(f.request()), /source-fault/);
      assert.equal(f.calls.length, n);
      assert.equal(f.calls.filter(c => c.method === "eth_getBlockByNumber").length, 1, "fatal cannot be cleared by post probe");
    }));
  }
  for (const diagnostic of ["metadata", "hash-suffix"] as const) {
    for (const shape of ["single", "item", "whole", "unknown-id"] as const) for (const warm of [false, true]) {
      test(`pinned direct: diagnostic bypass ${diagnostic}/${shape}/warm=${warm}`, async () => {
        const order: string[] = [];
        await pinnedFixture(async (f, c, fatal) => {
          if (shape === "single") {
            // Token-deal discovery uses a single trace call, unlike batched
            // optional prefetch. Its ordinary error must not mask source loss.
            f.codes.set(f.canonical.hash, storageCode); f.storage.set(f.canonical.hash, word(0));
          }
          if (warm) {
            assert.equal((await c.strictSimulate(f.request())).ok, true);
            const stateCount = f.stateCalls().length;
            await c.strictSimulate(f.request());
            assert.equal(f.stateCalls().length, stateCount, "control really reuses same-pin state");
          }
          const start = f.calls.length, envelopeStart = c.responses.length;
          const error = diagnostic === "metadata"
            ? { code: -32000, message: "hash is not currently canonical", data: {} }
            : { code: -32001, message: `header not found: ${f.canonical.hash}` };
          f.trace = { error };
          if (shape === "whole" || shape === "unknown-id") {
            f.batchHook = calls => calls.every(call => call.method === "debug_traceCall")
              ? (shape === "whole" ? { jsonrpc: "2.0", id: 999, error } : [{ jsonrpc: "2.0", id: 999, error }]) : undefined;
          }
          const req = { ...f.request(), ...(shape === "single"
            ? { tokenDeals: [{ token: target, to: pinnedRequest().from, amount: "100" }] } : {}) };
          const active = c.strictSimulate(req).catch(e => { order.push("active-rejection"); return e; });
          const queued = c.strictSimulate(f.request()).catch(e => { order.push("queued-rejection"); return e; });
          const [first, second] = await Promise.all([active, queued]);
          assert.deepEqual({ firstFatal: first instanceof RevmFatalError, queuedFatal: second instanceof RevmFatalError,
            fatal, order }, { firstFatal: true, queuedFatal: true, fatal: [{ kind: "source-fault" }],
            order: ["fatal", "active-rejection", "queued-rejection"] });
          const envelopes = c.responses.slice(envelopeStart);
          assert.equal(envelopes.length, 1, "queued request never reached the daemon");
          assert.equal(envelopes[0]!.ok, false);
          for (const field of ["sourceAttestation", "success", "strict", "output"]) assert.equal(field in envelopes[0]!, false);
          assert.equal(f.calls.slice(start).filter(call => call.method === "eth_chainId").length, 1);
          assert.equal(f.calls.slice(start).filter(call => call.method === "eth_getBlockByNumber").length, 1,
            "post probe cannot clear the earlier source fault");
          const physicalCount = f.calls.length;
          await assert.rejects(c.health(), /source-fault/);
          await assert.rejects(c.strictSimulate(f.request()), /source-fault/);
          assert.equal(f.calls.length, physicalCount); assert.equal(c.responses.length, envelopeStart + 1);
          assert.equal(fatal.length, 1);
        }, () => order.push("fatal"));
      });
    }
  }
  test("pinned direct: legal BLOCKHASH ancestry, branch isolation and invalid-range zero I/O", async () => pinnedFixture(async (f, c) => {
    for (const branch of [1, 2]) {
      f.canonical = header(300, branch); f.codes.set(f.canonical.hash, blockhashCode);
      const before = f.calls.length;
      for (const n of [300, 301, 43, 0]) {
        assert.equal((await c.strictSimulate({ ...f.request(), data: word(n) })).output, word(0));
      }
      assert.equal(f.calls.slice(before).filter(c => c.method === "eth_getBlockByHash" && c.params[0] !== f.canonical.hash).length, 0);
      for (const n of [299, 44, 150]) {
        assert.equal((await c.strictSimulate({ ...f.request(), data: word(n) })).output, branchHash(n, branch));
      }
      assert.equal(f.calls.slice(before).filter(c => c.method === "eth_getBlockByHash" && c.params[0] !== f.canonical.hash).length, 256);
    }
  }));
  for (const bad of ["hash", "number", "missing"]) {
    test(`pinned direct: broken ancestry ${bad} rejected`, async () => pinnedFixture(async (f, c) => {
      f.codes.set(f.canonical.hash, blockhashCode); const h = f.headers.get(branchHash(299))!;
      if (bad === "missing") f.headers.delete(h.hash); else h[bad] = bad === "hash" ? branchHash(299, 2) : "0x12a";
      await assert.rejects(c.strictSimulate({ ...f.request(), data: word(299) }), /source-fault/);
    }));
  }
  test("pinned direct: attests reverted execution and optional root, never legacy", async () => pinnedFixture(async (f, c) => {
    f.codes.set(f.canonical.hash, "0x60006000fd");
    const req = f.request(); const r = await c.strictSimulate({ ...req, sourcePin: { chainId: 1, blockHash: req.sourcePin.blockHash } });
    assert.equal(r.success, false); assert.equal(r.sourceAttestation?.stateRoot, f.canonical.stateRoot);
    f.allowLegacy = true; const { sourcePin, ...legacy } = f.request();
    const unpinned = await c.strictSimulate(legacy); assert.equal(unpinned.sourceAttestation, undefined);
  }));
  test("pinned direct: reviewed fork boundaries select Osaka gas cap and BPO blob fee", async () => pinnedFixture(async (f, c) => {
    const schedule = ETHEREUM_BLOCK_ACTIVITY_PROFILE;
    for (const [time, fee, capped] of [
      [schedule.pragueTime, 28, false], [schedule.osakaTime - 1n, 28, false],
      [schedule.osakaTime, 28, true], [schedule.bpo1Time - 1n, 28, true],
      [schedule.bpo1Time, 7, true], [schedule.bpo2Time - 1n, 7, true], [schedule.bpo2Time, 4, true],
    ] as const) {
      f.canonical = { ...header(), timestamp: quantity(Number(time)), excessBlobGas: quantity(16_777_216) };
      f.headers.set(f.canonical.hash, f.canonical);
      f.codes.set(f.canonical.hash, "0x4a60005260206000f3"); // BLOBBASEFEE
      await c.reset();
      assert.equal((await c.strictSimulate(f.request())).output, word(fee));
      const highGas = c.strictSimulate({ ...f.request(), gasLimit: 16_777_217 });
      if (capped) await assert.rejects(highGas, /gas|Gas/); else assert.equal((await highGas).success, true);
    }
  }));
  for (const patch of [{ timestamp: quantity(Number(ETHEREUM_BLOCK_ACTIVITY_PROFILE.pragueTime - 1n)) },
    { excessBlobGas: "0xffffffffffffffff" }, { blobGasUsed: "0x1" },
    { blobGasUsed: quantity(22 * 131_072) }, { gasUsed: "0xffffffff" },
    { gasLimit: "0x00" }, { difficulty: "0x1" }, { nonce: "0x0000000000000001" },
    { stateRoot: "0x12" }]) {
    test(`pinned direct: malformed/profile-invalid header ${JSON.stringify(patch)}`, async () => pinnedFixture(async (f, c) => {
      const req = f.request(); Object.assign(f.headers.get(f.canonical.hash)!, patch);
      await assert.rejects(c.strictSimulate(req), /source-fault/); assert.equal(f.stateCalls().length, 0);
    }));
  }
  test("pinned direct: state cache/endpoint/prepared overlays remain isolated", async () => pinnedFixture(async (f, c) => {
    f.codes.set(f.canonical.hash, storageCode); f.allowLegacy = true;
    await c.prepare({ blockNumber: 300, rpcUrl: f.url, prewarm: [target],
      funded: [`0x${"00".repeat(20)}`],
      stateOverrides: [{ address: target, slot: word(0), value: word(99) }] });
    assert.equal((await c.quote({ to: target, data: "0x" })).output, word(99));
    f.allowLegacy = false;
    assert.equal((await c.strictSimulate(f.request())).output, word(7));
    const count = f.stateCalls().length;
    assert.equal((await c.strictSimulate(f.request())).output, word(7));
    assert.equal(f.stateCalls().length, count);
    f.canonical = header(300, 2); f.codes.set(f.canonical.hash, storageCode); f.storage.set(f.canonical.hash, word(8));
    assert.equal((await c.strictSimulate(f.request())).output, word(8));
    const other = new PinnedRpcFixture(); await other.start();
    try {
      other.canonical = header(300, 2); other.codes.set(other.canonical.hash, storageCode); other.storage.set(other.canonical.hash, word(9));
      assert.equal((await c.strictSimulate(other.request())).output, word(9));
      assert.ok(other.stateCalls().some(c => c.method === "eth_getStorageAt"));
    } finally { await other.close(); }
    f.allowLegacy = true;
    assert.equal((await c.quote({ to: target, data: "0x" })).output, word(99), "strict cannot mutate legacy prepared overlay");
  }));
  test("pinned direct: token-deal secondary reads and trace access keys remain pinned", async () => pinnedFixture(async (f, c) => {
    // A synthetic ledger uses a non-mapping slot. Generic discovery must take
    // trace keys then read/verify actual pinned state, never trace values.
    f.codes.set(f.canonical.hash, storageCode); f.storage.set(f.canonical.hash, word(0));
    f.trace = { result: { [target]: { code: returnCode(99), storage: { [word(0)]: word(99) } } } };
    const req = { ...f.request(), tokenDeals: [{ token: target, to: pinnedRequest().from, amount: "100" }],
      observeTokens: [target], observeAccounts: [pinnedRequest().from] };
    const r = await c.strictSimulate(req); assert.equal(r.output, word(100));
    assert.deepEqual(r.strict?.tokenDeltas.map(d => d.delta), ["0"]);
    assert.ok(f.calls.some(c => c.method === "eth_getStorageAt" && c.params[1] === "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"));
    assert.ok(f.calls.some(c => c.method === "debug_traceCall" && c.params[0].data.startsWith("0x70a08231")));
    for (const call of f.stateCalls().concat(f.calls.filter(c => c.method === "debug_traceCall"))) {
      assert.deepEqual(call.params[call.method === "eth_getStorageAt" ? 2 : 1],
        { blockHash: f.canonical.hash, requireCanonical: true });
    }
    // Request-local deal writes never enter even the same-pin shared cache.
    assert.equal((await c.strictSimulate(f.request())).output, word(0));
  }));
  test("pinned direct: discovered mapping hints cannot cross pins", async () => pinnedFixture(async (f, c) => {
    // balanceOf(account): keccak256(account, baseSlot) -> SLOAD. No real token ABI
    // behavior is claimed by this minimal synthetic fixture.
    const mappingCode = (base: number) => `0x60043560005260${base.toString(16).padStart(2, "0")}60205260406000205460005260206000f3`;
    const data = `0x70a08231${"0".repeat(24)}${pinnedRequest().from.slice(2)}`;
    f.codes.set(f.canonical.hash, mappingCode(3)); f.storage.set(f.canonical.hash, word(0));
    const deal = { token: target, to: pinnedRequest().from, amount: "100" };
    assert.equal((await c.strictSimulate({ ...f.request(), data, tokenDeals: [deal] })).output, word(100));
    f.canonical = header(300, 2); f.codes.set(f.canonical.hash, mappingCode(4)); f.storage.set(f.canonical.hash, word(0));
    const before = f.calls.length;
    assert.equal((await c.strictSimulate({ ...f.request(), data, tokenDeals: [deal] })).output, word(100));
    const probes = f.calls.slice(before).filter(c => c.method === "eth_getStorageAt").map(c => c.params[1]);
    // First is balanceOf(base4), then the generic base0 probe, not a carried
    // base3 hint. Compare with an independently fresh client on identical pin.
    const fresh = new PinnedDirectClient({ executablePath: process.env.REVM_SIM_TEST_BINARY });
    const freshStart = f.calls.length;
    try { await fresh.strictSimulate({ ...f.request(), data, tokenDeals: [deal] }); }
    finally { await fresh.closeAndDrain(); }
    assert.deepEqual(probes, f.calls.slice(freshStart).filter(c => c.method === "eth_getStorageAt").map(c => c.params[1]));
  }));
  for (const method of ["eth_getBalance", "eth_getTransactionCount", "eth_getCode", "eth_getStorageAt"]) {
    test(`pinned direct: malformed ${method} is fatal even in warm/prefetch`, async () => pinnedFixture(async (f, c) => {
      f.codes.set(f.canonical.hash, storageCode);
      f.trace = { result: { [target]: { storage: { [word(0)]: word(7) } } } };
      f.hook = call => call.method === method && call.params[0] === target ? { result: "0xgg" } : undefined;
      await assert.rejects(c.strictSimulate(f.request()), /source-fault/);
      const count = f.calls.length; await assert.rejects(c.health(), /source-fault/); assert.equal(f.calls.length, count);
    }));
  }
  test("pinned direct: malformed delegated bytecode is a typed source failure, not child panic", async () => pinnedFixture(async (f, c, fatal) => {
    f.codes.set(f.canonical.hash, "0xef0100");
    await assert.rejects(c.strictSimulate(f.request()), RevmFatalError);
    assert.deepEqual(fatal, [{ kind: "source-fault" }]);
  }));
  for (const stage of ["eth_chainId", "eth_getBlockByHash", "eth_getBalance", "debug_traceCall"]) {
    test(`pinned direct: quota at ${stage} retains terminal callback before rejection`, async () => pinnedFixture(async (f, c, fatal) => {
      f.hook = call => call.method === stage ? { error: { code: -32000, message: "account quota exhausted" } } : undefined;
      await assert.rejects(c.strictSimulate(f.request()), e => { assert.deepEqual(fatal, [{ kind: "rpc-throttle", category: "rpc-quota", rpcCode: -32000 }]); return e instanceof RevmFatalError; });
      const count = f.calls.length; await assert.rejects(c.health(), /throttle/); assert.equal(f.calls.length, count);
    }));
  }
  for (const stage of ["eth_getBlockByHash", "eth_getStorageAt", "debug_traceCall"]) {
    test(`pinned direct: deadline at ${stage} rejects queue and drains actual child`, async () => pinnedFixture(async (f, c, fatal) => {
      await c.health(); f.codes.set(f.canonical.hash, storageCode); f.holdMethod = stage;
      const active = assert.rejects(c.strictSimulate(f.request(), { deadlineAtMs: Date.now() + 200 }), /deadline/);
      const queued = assert.rejects(c.strictSimulate(f.request()), /deadline/);
      await Promise.all([active, queued]); await c.closeAndDrain();
      assert.equal(f.calls.filter(call => call.method === stage).length, 1);
      const count = f.calls.length; await assert.rejects(c.health(), /deadline/); assert.equal(f.calls.length, count); assert.deepEqual(fatal, []);
    }));
  }
  for (const [message, batch] of [
    ["account quota exhausted", false],
    ["compute units depleted", true],
    ["quota limit exceeded", true],
  ] as const) {
    test(`direct daemon loopback quota: ${message}`, async () => {
      let physicalRequests = 0;
      const server = createServer((req, res) => {
        physicalRequests++;
        req.resume();
        req.on("end", () => {
          // A whole-batch error, or an unknown-ID item: both must latch before
          // batch selection and the warm helper's optional error conversion.
          const error = { jsonrpc: "2.0", id: 999, error: { code: -32000, message } };
          res.writeHead(200, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify(batch ? [error] : error));
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const rpcUrl = `http://127.0.0.1:${address.port}`;
      const order: string[] = [];
      const fatalReasons: RevmFatalReason[] = [];
      class LoopbackClient extends RevmSimClient {
        protected spawnDaemon(command: string, args: string[], detached: boolean) {
          assert.equal(command, process.env.REVM_SIM_TEST_BINARY);
          assert.equal(detached, false);
          // Keep this actual binary fixture strictly local regardless of the
          // developer shell's endpoint/proxy configuration; no global changes.
          return spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], detached,
            env: { ...process.env, MAINNET_RPC_URL: "", NO_PROXY: "*", no_proxy: "*",
              HTTP_PROXY: "", http_proxy: "", HTTPS_PROXY: "", https_proxy: "",
              ALL_PROXY: "", all_proxy: "" } });
        }
      }
      const client = new LoopbackClient({ executablePath: process.env.REVM_SIM_TEST_BINARY,
        onFatal: reason => { order.push("fatal"); fatalReasons.push(reason); } });
      try {
        assert.equal((await client.health()).ok, true);
        const first = await client.warm({ blockNumber: 1, rpcUrl, prewarmCalls: [] })
          .catch(err => { order.push("rejection"); return err; });
        const laterHealth = await client.health().catch(err => err);
        const laterWarm = await client.warm({ blockNumber: 2, rpcUrl, prewarmCalls: [] }).catch(err => err);
        // Keep the combined receipt in the assertion: a red run exposes the
        // exact extra physical request and missing fatal notification, not just
        // a missing error type.
        assert.deepEqual({ physicalRequests, fatalCallbacks: fatalReasons.length, order,
          firstRejected: first instanceof RevmFatalError,
          laterHealthRejected: laterHealth instanceof RevmFatalError,
          laterWarmRejected: laterWarm instanceof RevmFatalError }, {
          physicalRequests: 1, fatalCallbacks: 1, order: ["fatal", "rejection"],
          firstRejected: true, laterHealthRejected: true, laterWarmRejected: true,
        });
        assert.deepEqual(fatalReasons, [{ kind: "rpc-throttle", category: "rpc-quota", rpcCode: -32000 }]);
      } finally {
        await client.closeAndDrain();
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      }
    });
  }
  test("rebuilt direct daemon: real health/reset envelope and closeAndDrain, zero RPC", async () => {
    class DirectClient extends RevmSimClient {
      child?: ReturnType<typeof spawn>;
      protected spawnDaemon(command: string, args: string[], detached: boolean) {
        assert.equal(command, process.env.REVM_SIM_TEST_BINARY); assert.equal(detached, false);
        const child = super.spawnDaemon(command, args, detached); this.child = child; return child;
      }
    }
    const c = new DirectClient({ executablePath: process.env.REVM_SIM_TEST_BINARY });
    try {
      assert.deepEqual(await c.health(), { ok: true, engine: "revm", implemented: true });
      await c.reset(); assert.equal((await c.health()).ok, true);
    } finally { await c.closeAndDrain(); }
    assert.ok(c.child!.exitCode !== null || c.child!.signalCode !== null);
    assert.equal(c.child!.stdin!.closed, true); assert.equal(c.child!.stdout!.closed, true);
    await assert.rejects(c.health(), /stop/i);
  });
}
