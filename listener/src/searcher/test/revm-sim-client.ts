import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RevmFatalError, RevmSimClient, type RevmFatalReason } from "../revm-sim-client.js";

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
  const f = new Fixture(); let callbacks = 0;
  const c = new FixtureClient(f, { onFatal: () => callbacks++ });
  const failure = assert.rejects(c.health(), /protocol/);
  f.reply(0, { fatal: { kind: "rpc-throttle", category: "untrusted", rpcCode: -32000 } });
  await failure; assert.equal(callbacks, 0); f.close(); await c.closeAndDrain();
});

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
if (process.env.REVM_SIM_TEST_BINARY) {
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
