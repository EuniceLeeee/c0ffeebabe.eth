import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import {
  BlockScanTraceShadow, BlockScanShadowTraceError, createBlockScanShadowTraceReader,
  type BlockScanTraceShadowEvent, type BlockScanShadowTraceRead,
} from "../blockscan-trace-shadow.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const anchor = (n = 42, blockHash = hash(n)) => ({ hash: blockHash, parentHash: hash(n - 1), transactionHashes: [hash(1)] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(predicate(), "condition did not settle");
}
function setup(readTrace: BlockScanShadowTraceRead, extra: Partial<ConstructorParameters<typeof BlockScanTraceShadow>[0]> = {}) {
  const events: BlockScanTraceShadowEvent[] = [];
  const observer = new BlockScanTraceShadow({ chainId: 1, rootId: "ready-root-A", knownStateKeys: ["pool:a", "pool:b", "pool:clock"],
    perBlockRefreshStateKeys: ["pool:clock"], readTrace, classifyTrace: raw => raw as string[],
    onResult: event => { events.push(event); }, ...extra });
  return { observer, events };
}

test("pending trace never blocks begin or logs; late differences cannot mutate live keys", async () => {
  const response = deferred<unknown>();
  let requested = false;
  const { observer, events } = setup(async () => { requested = true; return response.promise; });
  const live = new Set(["pool:a"]);
  const ticket = observer.begin(42, anchor());
  assert(ticket);
  assert(requested, "trace is launched before begin returns");
  assert.equal(ticket.observeLogs(live), undefined);
  assert.deepEqual([...live], ["pool:a"]);
  assert.equal(events.length, 0);
  assert.equal(observer.snapshot().comparisonDenominator, 0);
  response.resolve(["POOL:B", "pool:clock", "unrelated-eoa"]);
  await until(() => events.some(event => event.status === "compared"));
  const result = events.find(event => event.status === "compared")!;
  assert.equal(result.status, "compared");
  assert.deepEqual(result.logStateKeys, ["pool:a"]);
  assert.deepEqual(result.traceStateKeys, ["pool:b", "pool:clock"]);
  assert.deepEqual(result.traceOnlyStateKeys, ["pool:b", "pool:clock"]);
  assert.deepEqual(result.coveredByEachBlockStateKeys, ["pool:clock"]);
  assert.deepEqual(result.missingRefreshStateKeys, ["pool:b"]);
  assert.deepEqual(result.oldRefreshStateKeys, ["pool:a", "pool:b", "pool:clock"]);
  assert.deepEqual(result.newRefreshStateKeys, ["pool:a", "pool:clock"]);
  assert.deepEqual([...live], ["pool:a"]);
  assert.equal(result.chainId, 1);
  assert.equal(result.rootId, "ready-root-A");
  assert.equal(result.blockNumber, 42);
  assert.equal(result.blockHash, hash(42));
  assert(Object.isFrozen(result.missingRefreshStateKeys));
  assert.equal(observer.snapshot().withMissingRefresh, 1);
  assert.equal(observer.snapshot().comparisonDenominator, 1);
  observer.close();
});

test("trace-first comparison remains asynchronous and freezes known keys, anchors and log inputs", async () => {
  const known = ["POOL:A", "POOL:CLOCK"];
  const every = ["POOL:CLOCK"];
  const observedAnchor = anchor();
  let classifiedHash: string | undefined;
  const { observer, events } = setup(async () => ["pool:clock"], { knownStateKeys: known,
    perBlockRefreshStateKeys: every, classifyTrace: (raw, number, pin) => {
      assert.equal(number, 42); classifiedHash = pin.hash; assert(Object.isFrozen(pin.transactionHashes)); return raw as string[];
    } });
  known.push("pool:b"); every.length = 0;
  const ticket = observer.begin(42, observedAnchor)!;
  observedAnchor.hash = hash(999); observedAnchor.transactionHashes.push(hash(2));
  await tick();
  const live = new Set(["POOL:A", "pool:b"]);
  ticket.observeLogs(live);
  live.clear();
  assert.equal(events.length, 0, "observeLogs cannot synchronously invoke the callback");
  await until(() => events.length > 0);
  const event = events[0]!;
  assert.equal(event.status, "compared");
  assert.equal(classifiedHash, hash(42));
  if (event.status !== "compared") throw new Error("missing comparison");
  assert.deepEqual(event.logStateKeys, ["pool:a"]);
  assert.deepEqual(event.newRefreshStateKeys, ["pool:a", "pool:clock"]);
  assert.deepEqual(event.missingRefreshStateKeys, []);
  assert.deepEqual(event.coveredByEachBlockStateKeys, ["pool:clock"]);
  assert.equal(event.equalRefresh, true);
  observer.close();
});

test("quota/rejection/classifier failures are isolated and never expose provider error text", async () => {
  for (const example of [
    { read: async () => { throw Object.assign(new Error("monthly quota exhausted https://rpc/private-secret"), { code: 429 }); }, category: "quota" },
    { read: async () => { throw new Error("https://rpc/private-secret"); }, category: "transport" },
    { read: async () => ["pool:a"], category: "classification" },
  ]) {
    const { observer, events } = setup(example.read, example.category === "classification" ? {
      classifyTrace: () => { throw new Error("provider private-secret"); },
    } : {});
    const live = new Set(["pool:a"]);
    observer.begin(42, anchor())!.observeLogs(live);
    await until(() => events.length > 0);
    assert.equal(events[0]!.status, "error");
    assert.equal(events[0]!.status === "error" && events[0]!.category, example.category);
    assert(!JSON.stringify(events).includes("private-secret"));
    assert.deepEqual([...live], ["pool:a"]);
    assert.equal(observer.snapshot().comparisonDenominator, 0);
    observer.close();
  }
});

test("same hash deduplicates; saturation skips instead of queuing; another fork compares separately", async () => {
  const response = deferred<unknown>();
  let requests = 0;
  const { observer, events } = setup(async () => { requests++; return requests === 1 ? response.promise : []; });
  observer.begin(42, anchor())!.observeLogs(["pool:a"]);
  assert.equal(observer.begin(42, anchor()), undefined);
  assert.equal(observer.begin(43, anchor(43)), undefined);
  response.resolve([]);
  await until(() => observer.snapshot().compared === 1);
  assert.equal(observer.begin(42, anchor()), undefined);
  observer.begin(42, anchor(42, hash(142)))!.observeLogs([]);
  await until(() => observer.snapshot().compared === 2);
  assert.equal(requests, 2);
  assert.equal(observer.snapshot().duplicates, 2);
  assert.equal(observer.snapshot().capacitySkips, 1);
  assert.equal(observer.snapshot().comparisonDenominator, 2);
  assert.equal(events.filter(event => event.status === "compared").length, 2);
  observer.close();
});

test("completed dedup is bounded and independent observers bind separate roots", async () => {
  let requests = 0;
  const read: BlockScanShadowTraceRead = async () => { requests++; return []; };
  const { observer } = setup(read, { maxRemembered: 1 });
  for (const n of [42, 43, 42]) {
    const compared = observer.snapshot().compared;
    observer.begin(n, anchor(n))!.observeLogs([]);
    await until(() => observer.snapshot().compared > compared);
    assert.equal(observer.snapshot().remembered, 1);
  }
  const next = setup(read, { rootId: "ready-root-B" });
  next.observer.begin(42, anchor())!.observeLogs([]);
  await until(() => next.observer.snapshot().compared === 1);
  assert.equal(requests, 4);
  assert.equal(next.events[0]!.rootId, "ready-root-B");
  observer.close(); next.observer.close();
});

test("timeout aborts a request, never compares, and does not release an uncooperative physical slot", async () => {
  const response = deferred<unknown>();
  let signal!: AbortSignal;
  const { observer, events } = setup((_hash, control) => { signal = control.signal; return response.promise; }, { timeoutMs: 15 });
  observer.begin(42, anchor())!.observeLogs([]);
  await until(() => events.some(event => event.status === "error"));
  assert(signal.aborted);
  assert.equal(observer.snapshot().timeouts, 1);
  assert.equal(observer.snapshot().active, 0);
  assert.equal(observer.snapshot().tracesInFlight, 1);
  assert.equal(observer.begin(43, anchor(43)), undefined);
  response.resolve(["pool:b"]);
  await until(() => observer.snapshot().tracesInFlight === 0);
  assert.equal(observer.snapshot().compared, 0);
  assert.equal(observer.snapshot().capacitySkips, 1);
  observer.close();
});

test("missing logs and shutdown cancel detached work, and late results stay inert", async () => {
  const responses = [deferred<unknown>(), deferred<unknown>()];
  const signals: AbortSignal[] = [];
  const { observer, events } = setup((_hash, control) => {
    signals.push(control.signal); return responses[signals.length - 1]!.promise;
  }, { maxConcurrent: 2 });
  const first = observer.begin(42, anchor())!;
  first.failLogs();
  assert(signals[0]!.aborted);
  const second = observer.begin(43, anchor(43))!;
  second.observeLogs(["pool:a"]);
  assert.equal(observer.close(), undefined);
  assert(signals[1]!.aborted);
  assert.equal(observer.begin(44, anchor(44)), undefined);
  responses.forEach(response => response.resolve(["pool:b"]));
  await tick();
  assert.equal(observer.snapshot().compared, 0);
  assert.equal(observer.snapshot().logsFailed, 1);
  assert.equal(observer.snapshot().cancelled, 1);
  assert.equal(observer.snapshot().active, 0);
  assert.equal(observer.snapshot().tracesInFlight, 0);
  assert(events.some(event => event.status === "skipped" && event.reason === "logs-unavailable"));
  assert(events.some(event => event.status === "cancelled"));
  observer.close();
});

test("bad anchors, invalid log keys and throwing observers cannot escape into live code", async () => {
  const { observer, events } = setup(async () => []);
  assert.equal(observer.begin(42, { ...anchor(), transactionHashes: [hash(1), hash(1)] }), undefined);
  assert.equal(observer.begin(42, { ...anchor(), transactionHashes: new Array<string>(1) }), undefined);
  const ticket = observer.begin(43, anchor(43))!;
  assert.doesNotThrow(() => ticket.observeLogs([null as unknown as string]));
  await tick();
  assert.deepEqual(events.filter(event => event.status === "error").map(event => event.category), ["invalid-anchor", "invalid-anchor", "invalid-logs"]);
  const throwing = setup(async () => [], { onResult() { throw new Error("observer failure"); } });
  throwing.observer.begin(42, anchor())!.observeLogs([]);
  await until(() => throwing.observer.snapshot().callbackErrors === 1);
  assert.equal(throwing.observer.snapshot().compared, 1);
  const rejecting = setup(async () => [], { onResult: async () => { throw new Error("async observer failure"); } });
  rejecting.observer.begin(42, anchor())!.observeLogs([]);
  await until(() => rejecting.observer.snapshot().callbackErrors === 1);
  observer.close(); throwing.observer.close(); rejecting.observer.close();
});

async function serverFor(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/credential-do-not-log`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
const control = (duration = 2000) => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + duration });
const hasCategory = (category: string) => (error: unknown) => {
  assert(error instanceof BlockScanShadowTraceError);
  assert.equal(error.category, category);
  assert(!error.message.includes("credential"));
  assert(!error.message.includes("private-secret"));
  assert.equal(error.cause, undefined);
  return true;
};

test("independent HTTP reader issues one exact block-hash trace and returns its result", async () => {
  let requests = 0, payload: unknown;
  const server = await serverFor(async (request, response) => {
    requests++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ["trace-result"] }));
  });
  const reader = createBlockScanShadowTraceReader(server.url);
  try {
    assert.deepEqual(await reader(hash(42), control()), ["trace-result"]);
    assert.deepEqual(payload, { jsonrpc: "2.0", id: 1, method: "debug_traceBlockByHash",
      params: [hash(42), { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }] });
    assert.equal(requests, 1);
  } finally { reader.close(); await server.close(); }
});

test("HTTP reader isolates quota, malformed replies and oversized bodies without retries or error disclosure", async () => {
  for (const example of [
    { status: 429, body: { jsonrpc: "2.0", id: 1, error: { code: 429, message: "monthly quota exhausted private-secret" } }, category: "quota" },
    { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: 429, message: "rate limit private-secret" } }, category: "throttle" },
    { status: 503, body: { error: "private-secret" }, category: "http" },
    { status: 200, body: { jsonrpc: "2.0", id: 9, result: [] }, category: "malformed-response" },
    { status: 200, body: { jsonrpc: "2.0", id: 1, result: "x".repeat(256) }, category: "response-too-large" },
  ]) {
    let requests = 0;
    const server = await serverFor((_request, response) => {
      requests++; response.writeHead(example.status); response.end(JSON.stringify(example.body));
    });
    const reader = createBlockScanShadowTraceReader(server.url, { maxResponseBytes: 200 });
    try {
      await assert.rejects(reader(hash(42), control()), hasCategory(example.category));
      assert.equal(requests, 1);
    } finally { reader.close(); await server.close(); }
  }
});

test("HTTP deadline and shutdown physically close requests and never retry", async () => {
  for (const shutdown of [false, true]) {
    let requests = 0, disconnected = false;
    const server = await serverFor((_request, response) => {
      requests++;
      response.once("close", () => { disconnected = true; });
      // Intentionally never respond.
    });
    const reader = createBlockScanShadowTraceReader(server.url, { timeoutMs: 80 });
    try {
      const pending = reader(hash(42), control());
      const rejected = assert.rejects(pending, hasCategory(shutdown ? "aborted" : "timeout"));
      if (shutdown) { await until(() => requests === 1); reader.close(); }
      await rejected;
      await until(() => disconnected);
      assert.equal(requests, 1);
      reader.close();
      await assert.rejects(reader(hash(43), control()), hasCategory("aborted"));
    } finally { reader.close(); await server.close(); }
  }
});

test("private HTTP sockets honor configured observer concurrency without a hidden queue", async () => {
  for (const maxConcurrent of [2, 4]) {
    const pending: ServerResponse[] = [];
    let active = 0, maximumActive = 0;
    const server = await serverFor((request, response) => {
      request.resume();
      active++; maximumActive = Math.max(maximumActive, active);
      response.once("finish", () => { active--; });
      pending.push(response);
    });
    const reader = createBlockScanShadowTraceReader(server.url);
    const { observer } = setup(reader, { maxConcurrent });
    try {
      for (let i = 0; i < maxConcurrent; i++) observer.begin(42 + i, anchor(42 + i))!.observeLogs([]);
      assert.equal(observer.begin(99, anchor(99)), undefined);
      // No server response is released until every admitted trace reaches it.
      // A one-socket agent cannot satisfy this even though admission says four.
      await until(() => pending.length === maxConcurrent);
      assert.equal(maximumActive, maxConcurrent);
      assert.equal(observer.snapshot().capacitySkips, 1);
      for (const response of pending) response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
      await until(() => observer.snapshot().compared === maxConcurrent);
      assert.equal(pending.length, maxConcurrent);
      assert.equal(observer.snapshot().tracesInFlight, 0);
    } finally { observer.close(); reader.close(); await server.close(); }
  }
});

test("default HTTP transport honors a caller deadline above thirty seconds", async t => {
  const server = await serverFor((request, _response) => { request.resume(); });
  const reader = createBlockScanShadowTraceReader(server.url);
  const scheduled: number[] = [];
  const original = globalThis.setTimeout;
  const timer = t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void,
    ms?: number, ...args: unknown[]) => {
    scheduled.push(ms ?? 0);
    return original(callback, ms, ...args);
  }) as typeof setTimeout);
  try {
    const pending = reader(hash(42), control(60_000));
    const rejected = assert.rejects(pending, hasCategory("aborted"));
    assert(scheduled[0]! > 30_000 && scheduled[0]! <= 60_000,
      `the caller deadline was shortened to ${scheduled[0]}`);
    timer.mock.restore();
    reader.close();
    await rejected;
  } finally { timer.mock.restore(); reader.close(); await server.close(); }
});
