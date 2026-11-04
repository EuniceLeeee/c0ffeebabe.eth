import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { createBlockScanActivityTransport } from "../blockscan-activity-transport.js";
import { RethTransportScheduler, RethTransientReadError } from "../reth-transport-scheduler.js";
import { isRpcThrottleError } from "../rpc-throttle-guard.js";
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";

for (const scheduled of [false, true]) test(`trace/light queues stay separate while trace waits (scheduled=${scheduled})`, { timeout: 5000 }, async () => {
  const batches: string[][] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body), calls = Array.isArray(payload) ? payload : [payload];
    batches.push(calls.map((call: any) => call.method));
    if (calls.some((call: any) => call.method.startsWith("debug_trace"))) await slow;
    const replies = calls.map((call: any) => ({ jsonrpc: "2.0", id: call.id,
      result: call.method === "eth_chainId" ? "0x1" : call.method === "eth_getLogs" ? [] : "0x1" }));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = createBlockScanActivityTransport(`http://127.0.0.1:${(server.address() as any).port}`, scheduled ? {
    scheduler: new RethTransportScheduler({ capacity: 3, producerReserved: 1 }), signal: new AbortController().signal,
  } : undefined);
  try {
    let tracesDone = false;
    const traces = Promise.all([transport.send("debug_traceBlockByHash", ["one", {}]),
      transport.send("debug_traceBlockByHash", ["two", {}])]).then(() => { tracesDone = true; });
    const lights = Promise.all([transport.send("eth_getBalance", ["one", "latest"]),
      transport.send("eth_getBalance", ["two", "latest"]), transport.getLogs({ fromBlock: 1, toBlock: 1 })]);
    await lights;
    assert.equal(tracesDone, false, "light batch must not wait for trace batch");
    release(); await traces;
    assert(batches.some(batch => batch.filter(m => m === "debug_traceBlockByHash").length === 2));
    assert(batches.some(batch => batch.filter(m => m === "eth_getBalance").length === 2));
    assert(batches.every(batch => !batch.includes("debug_traceBlockByHash") ||
      !batch.some(m => m === "eth_getBalance" || m === "eth_getLogs")));
  } finally {
    release(); transport.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

type RpcCall = { id: number; jsonrpc: string; method: string; params: any[] };
const ok = (call: RpcCall) => ({ jsonrpc: "2.0", id: call.id,
  result: call.method === "eth_getLogs" ? [] : call.method === "eth_call" ? "0x" + "11".padStart(64, "0") : "0x1" });
const failure = (call: RpcCall, code: number, message: string, data?: string) =>
  ({ jsonrpc: "2.0", id: call.id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!check()) { assert(Date.now() < deadline, "condition did not settle"); await delay(2); }
};
const fixture = async (run: (f: {
  transport: ReturnType<typeof createBlockScanActivityTransport>; scheduler: RethTransportScheduler;
  abort: AbortController; url: string; calls: RpcCall[][];
  state: { active: number; peak: number; responder: (calls: RpcCall[]) => Promise<{ status?: number; body?: unknown }> };
}) => Promise<void>, options: { timeout?: number; delay?: number; retries?: number } = {}) => {
  const calls: RpcCall[][] = [];
  const state = { active: 0, peak: 0, responder: async (batch: RpcCall[]) => ({ body: batch.map(ok) }) as
    (calls: RpcCall[]) => Promise<{ status?: number; body?: unknown }> };
  const server = createServer(async (request, response) => {
    let text = ""; for await (const part of request) text += part;
    const raw = JSON.parse(text), batch = Array.isArray(raw) ? raw : [raw];
    calls.push(batch); state.peak = Math.max(state.peak, ++state.active);
    response.once("close", () => { state.active--; });
    const result = await state.responder(batch);
    if (response.destroyed) return;
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body ?? batch.map(ok)));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1,
    transportTimeoutMs: options.timeout ?? 1_000, retryDelayMs: options.delay ?? 5,
    maxRetryDelayMs: options.delay ?? 5, maxRetriesAtOne: options.retries ?? 2 });
  const abort = new AbortController();
  const transport = createBlockScanActivityTransport(url, { scheduler, signal: abort.signal });
  try {
    await transport.send("eth_chainId", []);
    await run({ transport, scheduler, abort, url, calls, state });
  } finally {
    transport.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await until(() => scheduler.snapshot().activeTotal === 0);
    assert(Object.values(scheduler.snapshot().queuedByLane).every(count => count === 0), "queued permit leak");
  }
};

test("scheduled activity and actual quote backend share the physical cap", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, scheduler, url, calls, state }) => {
    state.responder = async batch => { await delay(30); return { body: batch.map(ok) }; };
    const backend = new PinnedRethQuoteBackend(url, "0x" + "ab".repeat(32), {
      transportScheduler: scheduler, transportLane: "producer-bulk", maxBatchSize: 1,
      maxConcurrentBatches: 4, allowSingleCallFallback: false, deadlineAtMs: Date.now() + 3_000,
    });
    try {
      await Promise.all([
        ...[1, 2, 3, 4].map(n => backend.call({ to: "0x" + "11".repeat(20), data: `0x0${n}` })),
        transport.getLogs({ fromBlock: 1, toBlock: 1 }),
        transport.send("debug_traceBlockByHash", ["0x" + "ab".repeat(32), {}]),
      ]);
      assert.equal(state.peak, 2);
      assert(calls.some(batch => batch.some(call => call.method === "eth_call")));
      assert(calls.some(batch => batch.some(call => call.method === "debug_traceBlockByHash")));
      assert(calls.every(batch => !batch.some(call => call.method.startsWith("debug_trace")) ||
        !batch.some(call => call.method === "eth_getLogs")), "queues must stay separate");
    } finally { await backend.closeAndDrain(); }
  });
});

test("shared retry policy handles typed read failure without calling it a throttle", async () => {
  const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
  await scheduler.run("producer-bulk", new AbortController().signal, async lease => {
    const items = [{}], error = new RethTransientReadError("read failed");
    assert.equal(isRpcThrottleError(error), false);
    assert.equal(lease.load!.retry({ code: -32000, message: "Internal error" }, items, lease.load!.limits(1, 1)), false);
    assert.equal(lease.load!.retry(error, items, lease.load!.limits(1, 1)), true);
  });
});

test("network detection also waits for the shared physical permit", { timeout: 5_000 }, async () => {
  await fixture(async ({ scheduler, url, calls }) => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const blockers = [1, 2].map(() => scheduler.run("producer-bulk", new AbortController().signal, () => held));
    await until(() => scheduler.snapshot().activeTotal === 2);
    const before = calls.length;
    const fresh = createBlockScanActivityTransport(url, { scheduler, signal: new AbortController().signal });
    try {
      const read = fresh.send("debug_traceBlockByHash", ["one", {}]);
      await until(() => scheduler.snapshot().queuedByLane["producer-bulk"] > 0);
      assert.equal(calls.length, before, "neither chain detection nor trace may bypass the cap");
      release(); await Promise.all(blockers); await read;
      assert(calls.slice(before).flat().some(call => call.method === "eth_chainId"));
    } finally { release(); await Promise.all(blockers); fresh.destroy(); }
  });
});

test("only failed throttle items are split/retried and backoff releases the permit", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, calls, state, scheduler }) => {
    let first = true, backoffObserved = false;
    state.responder = async batch => {
      if (first && batch.some(call => call.method === "eth_getLogs")) {
        first = false;
        setTimeout(() => { backoffObserved = scheduler.snapshot().activeTotal === 0; }, 10);
        return { body: batch.map(call => call.params[0].blockHash === "good" ? ok(call) : failure(call, 429, "rate limit")) };
      }
      return { body: batch.map(ok) };
    };
    await Promise.all(["good", "bad1", "bad2", "bad3"].map(blockHash => transport.send("eth_getLogs", [{ blockHash }])));
    assert(backoffObserved);
    const count = (id: string) => calls.flat().filter(call => call.method === "eth_getLogs" && call.params[0].blockHash === id).length;
    assert.equal(count("good"), 1);
    assert.equal(count("bad1"), 2);
    const batches = calls.filter(batch => batch.some(call => call.method === "eth_getLogs"));
    assert(batches.slice(1).every(batch => batch.length < batches[0]!.length), "retry batches must shrink");
  }, { delay: 40 });
});

test("HTTP 429 uses the shared bounded retry budget", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, calls, state }) => {
    state.responder = async batch => batch.some(call => call.method === "eth_getLogs")
      ? { status: 429, body: { error: { code: 429, message: "too many requests" } } } : { body: batch.map(ok) };
    await assert.rejects(transport.send("eth_getLogs", [{ blockHash: "one" }]));
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs").length, 3);
  });
});

test("read-only Internal error retries in place and a successful sibling is not replayed", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, calls, state }) => {
    let errors = 0;
    state.responder = async batch => ({ body: batch.map(call => call.method === "eth_getLogs" &&
      call.params[0].blockHash === "bad" && errors++ < 1 ? failure(call, -32000, "Internal error") : ok(call)) });
    await Promise.all(["good", "bad"].map(blockHash => transport.send("eth_getLogs", [{ blockHash }])));
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs" && call.params[0].blockHash === "good").length, 1);
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs" && call.params[0].blockHash === "bad").length, 2);
  });
});

test("Internal error retries are bounded, never apply to arbitrary RPC methods", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, calls, state }) => {
    state.responder = async batch => ({ body: batch.map(call => failure(call, -32603, "Internal error")) });
    await assert.rejects(transport.send("eth_getLogs", [{}]));
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs").length, 3);
    await assert.rejects(transport.send("eth_sendRawTransaction", ["0x"]));
    assert.equal(calls.flat().filter(call => call.method === "eth_sendRawTransaction").length, 1);
  });
});

test("quota, revert, canonical-source error and malformed responses do not retry", { timeout: 5_000 }, async () => {
  for (const kind of ["quota", "revert", "source", "malformed"]) {
    await fixture(async ({ transport, calls, state }) => {
      state.responder = async batch => ({ body: batch.map(call => kind === "quota" ? failure(call, 429, "monthly quota exhausted")
        : kind === "revert" ? failure(call, -32000, "Internal error", "0xdeadbeef")
        : kind === "source" ? failure(call, -32000, "hash is not currently canonical")
        : { jsonrpc: "2.0", id: call.id, result: [], error: { code: 429, message: "rate limit" } }) });
      await assert.rejects(transport.send("eth_getLogs", [{}]));
      assert.equal(calls.flat().filter(call => call.method === "eth_getLogs").length, 1, kind);
    });
  }
});

test("physical socket timeout retries under the same bound and releases all permits", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, calls, state }) => {
    state.responder = async batch => { if (batch.some(call => call.method === "eth_getLogs")) await delay(200); return { body: batch.map(ok) }; };
    await assert.rejects(transport.send("eth_getLogs", [{}]));
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs").length, 3);
  }, { timeout: 40 });
});

test("quota in a mixed envelope preserves successful siblings and prevents more retries", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, calls, state }) => {
    state.responder = async batch => ({ body: batch.map(call => call.params[0].blockHash === "good" ? ok(call)
      : call.params[0].blockHash === "quota" ? failure(call, 429, "monthly quota exhausted") : failure(call, 429, "rate limit")) });
    const result = await Promise.allSettled(["good", "quota", "limited"].map(blockHash => transport.send("eth_getLogs", [{ blockHash }])));
    assert.deepEqual(result.map(item => item.status), ["fulfilled", "rejected", "rejected"]);
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs").length, 3);
  });
});

test("abort during retry backoff prevents later wire requests", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, abort, calls, state }) => {
    state.responder = async batch => ({ body: batch.map(call => failure(call, 429, "rate limit")) });
    const result = transport.send("eth_getLogs", [{}]);
    const rejected = assert.rejects(result);
    await until(() => calls.flat().some(call => call.method === "eth_getLogs"));
    await delay(10); abort.abort(); await rejected; await delay(120);
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs").length, 1);
  }, { delay: 100 });
});

test("abort removes queued work and cancels an active socket", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, abort, calls, state, scheduler }) => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const blockerSignal = new AbortController();
    const blockers = [1, 2].map(() => scheduler.run("producer-bulk", blockerSignal.signal, () => held));
    await until(() => scheduler.snapshot().activeTotal === 2);
    const queued = assert.rejects(transport.send("eth_getLogs", [{}]));
    await until(() => scheduler.snapshot().queuedByLane["producer-bulk"] > 0);
    abort.abort(); await queued; release(); await Promise.all(blockers);
    assert.equal(calls.flat().filter(call => call.method === "eth_getLogs").length, 0);
  });
  await fixture(async ({ transport, abort, state, calls }) => {
    state.responder = async batch => { await delay(150); return { body: batch.map(ok) }; };
    const active = assert.rejects(transport.send("eth_getLogs", [{}]));
    await until(() => calls.flat().some(call => call.method === "eth_getLogs"));
    abort.abort(); await active; await until(() => state.active === 0);
  });
});

for (const stage of ["queued", "inflight", "backoff"] as const) {
  for (const kind of ["signal", "deadline"] as const) {
    test(`controlled ${kind} during ${stage} cancels I/O and leaves unrelated work live`, { timeout: 5_000 }, async () => {
      await fixture(async ({ transport, scheduler, calls, state, abort }) => {
        const caller = new AbortController();
        const control = { signal: caller.signal, ...(kind === "deadline" ? { deadlineAtMs: Date.now() + 80 } : {}) };
        const count = () => calls.flat().filter(call => call.method === "eth_getBlockByNumber").length;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const blockers = stage === "queued" ? [1, 2].map(() => scheduler.run("producer-bulk", new AbortController().signal, () => held)) : [];
        if (blockers.length) await until(() => scheduler.snapshot().activeTotal === 2);
        state.responder = async batch => {
          if (batch.some(call => call.method === "eth_getBlockByNumber")) {
            if (stage === "inflight") await delay(250);
            if (stage === "backoff") return { body: batch.map(call => failure(call, 429, "rate limit")) };
          }
          return { body: batch.map(ok) };
        };
        try {
          const rejected = assert.rejects(transport.sendWithControl("eth_getBlockByNumber", ["0x1", true], control),
            (error: unknown) => error instanceof StateCallAbortedError && error.kind === kind);
          if (stage === "queued") await until(() => scheduler.snapshot().queuedByLane["producer-bulk"] === 1);
          else await until(() => count() === 1 && (stage !== "backoff" || scheduler.snapshot().activeTotal === 0));
          if (kind === "signal") caller.abort(new Error("caller reason must not leak"));
          await rejected;
          if (stage === "inflight") await until(() => state.active === 0);
          assert.equal(scheduler.snapshot().queuedByLane["producer-bulk"], 0);
          assert.equal(getEventListeners(caller.signal, "abort").length, 0, "caller listener must be removed");
          release(); await Promise.all(blockers);
          await until(() => scheduler.snapshot().activeTotal === 0);
          await delay(140);
          assert.equal(count(), stage === "queued" ? 0 : 1, "no retry or late dispatch after scope cancellation");
          assert.equal(abort.signal.aborted, false, "one scope cannot abort the runtime");
          assert.equal(await transport.sendWithControl("eth_chainId", [], {}), "0x1");
          assert.equal(await transport.send("eth_chainId", []), "0x1", "ethers queue stays live");
        } finally { release(); await Promise.all(blockers); }
      }, { delay: 120 });
    });
  }
}

test("controlled calls bind runtime cancellation and reject invalid or already expired controls without I/O", { timeout: 5_000 }, async () => {
  await fixture(async ({ transport, scheduler, abort, calls, state }) => {
    const caller = new AbortController(); caller.abort();
    const before = calls.length;
    for (const control of [{ signal: caller.signal }, { deadlineAtMs: Date.now() - 1 },
      { deadlineAtMs: NaN }, { deadlineAtMs: Infinity }]) {
      await assert.rejects(transport.sendWithControl("eth_getBlockByNumber", ["0x1", true], control));
    }
    assert.equal(calls.length, before);
    assert.equal(scheduler.snapshot().activeTotal, 0);
    state.responder = async batch => { await delay(200); return { body: batch.map(ok) }; };
    const rejected = assert.rejects(transport.sendWithControl("eth_getBlockByNumber", ["0x1", true], {}),
      (error: unknown) => error instanceof StateCallAbortedError && error.kind === "signal");
    await until(() => calls.length > before);
    abort.abort(); await rejected; await until(() => state.active === 0);
  });
});

test("controlled reads use the same retry classification and terminal quota boundaries", { timeout: 5_000 }, async () => {
  for (const kind of ["internal", "http429", "quota", "revert", "source", "malformed"] as const) {
    await fixture(async ({ transport, calls, state }) => {
      let attempts = 0;
      state.responder = async batch => {
        attempts++;
        if (kind === "internal" && attempts > 1) return { body: batch.map(ok) };
        return kind === "http429" ? { status: 429, body: { error: { code: 429, message: "rate limit" } } }
          : { body: batch.map(call => kind === "internal" ? failure(call, -32000, "Internal error")
            : kind === "quota" ? failure(call, 429, "monthly quota exhausted")
            : kind === "revert" ? failure(call, -32000, "Internal error", "0xdeadbeef")
            : kind === "source" ? failure(call, -32000, "hash is not currently canonical")
            : { jsonrpc: "2.0", id: call.id, result: [], error: { code: 429, message: "rate limit" } }) };
      };
      const caller = new AbortController();
      const result = transport.sendWithControl("eth_getBlockByNumber", ["0x1", true],
        { signal: caller.signal, deadlineAtMs: Date.now() + 2_000 });
      if (kind === "internal") assert.equal(await result, "0x1");
      else await assert.rejects(result);
      assert.equal(calls.flat().filter(call => call.method === "eth_getBlockByNumber").length,
        kind === "internal" ? 2 : kind === "http429" ? 3 : 1, kind);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    });
  }
});
