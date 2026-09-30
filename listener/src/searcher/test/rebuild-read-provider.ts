import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ethers } from "ethers";
import { gzipSync } from "node:zlib";
import { createHook } from "node:async_hooks";
import { RebuildReadProvider } from "../rebuild-read-provider.js";

type Payload = { id: number; jsonrpc: string; method: string; params: unknown[] };
type Request = { payloads: Payload[]; response: ServerResponse; batched: boolean };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("test deadline")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function serve(handler: (request: Request) => void) {
  const errors: unknown[] = [];
  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Payload | Payload[];
        handler({ payloads: Array.isArray(body) ? body : [body], response, batched: Array.isArray(body) });
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      assert.deepEqual(errors, []);
    },
  };
}

function answer(request: Request, result: (payload: Payload) => unknown): void {
  // Reverse responses to ensure ethers, not array order, binds request IDs.
  const replies = request.payloads.map(payload => ({
    jsonrpc: "2.0", id: payload.id, result: result(payload),
  })).reverse();
  request.response.setHeader("content-type", "application/json");
  request.response.end(JSON.stringify(request.batched ? replies : replies[0]));
}

const pass = async <T>(operation: () => Promise<T>): Promise<T> => operation();
const network = ethers.Network.from(1);
const options = { staticNetwork: network, cacheTimeout: -1, requestTimeoutMs: 2_000 };
const address = "0x" + "12".repeat(20);

async function batchSizeConcurrencyAndParity(): Promise<void> {
  const reachedEight = deferred();
  const held: Request[] = [];
  const batches: number[] = [];
  let active = 0;
  let maximum = 0;
  let hold = true;
  const respond = (request: Request) => {
    answer(request, payload => {
      if (payload.method === "eth_call") {
        return (payload.params[0] as { data: string }).data;
      }
      if (payload.method === "eth_getCode") return "0x60016000";
      throw new Error(`unexpected method ${payload.method}`);
    });
    active--;
  };
  const server = await serve(request => {
    active++;
    maximum = Math.max(maximum, active);
    batches.push(request.payloads.length);
    if (hold) held.push(request);
    else respond(request);
    if (held.length === 8) reachedEight.resolve();
  });
  const provider = new RebuildReadProvider(pass, server.url, network, options);
  try {
    const expected = Array.from({ length: 160 }, (_, i) =>
      i % 4 === 0 ? "0x60016000" : ethers.toBeHex(i, 4));
    const pending = Promise.all(expected.map((value, i) => i % 4 === 0
      ? provider.getCode(ethers.getAddress(ethers.toBeHex(i + 1, 20)), 123)
      : provider.send("eth_call", [{ to: address, data: value }, "0x7b"])));
    await bounded(reachedEight.promise);
    assert.equal(batches.length, 8, "only eight HTTP batches may start before any response");
    hold = false;
    for (const request of held) respond(request);
    assert.deepEqual(await bounded(pending), expected);
    assert(batches.length > 8, "exercise queued HTTP batches, not only eight initial slots");
    assert(batches.every(size => size <= 8), "default batches must contain at most eight items");
    assert.equal(maximum, 8, "physical HTTP concurrency remains bounded");
  } finally {
    provider.destroy();
    await server.close();
  }
}

async function fatalQueueFence(): Promise<void> {
  const reachedEight = deferred();
  const requests: Request[] = [];
  const server = await serve(request => {
    requests.push(request);
    if (requests.length === 8) reachedEight.resolve();
  });
  const fatal = new Error("simulation fatal latch");
  let latched = false;
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (latched) throw fatal;
    const result = await operation();
    if (latched) throw fatal;
    return result;
  };
  const provider = new RebuildReadProvider(read, server.url, network, { ...options, batchMaxCount: 1 });
  try {
    const pending = Promise.allSettled(Array.from({ length: 24 }, (_, i) =>
      provider.send("eth_call", [{ to: address, data: ethers.toBeHex(i, 4) }, "0x7b"])));
    await bounded(reachedEight.promise);
    assert(requests.every(request => request.payloads.length === 1), "explicit batchMaxCount overrides default");
    latched = true;
    for (const request of requests) answer(request, () => "0x");
    const results = await bounded(pending);
    assert.equal(requests.length, 8, "queued requests must not send after fatal latch");
    assert(results.every(result => result.status === "rejected" && result.reason === fatal));
    await assert.rejects(provider.getCode(address, 123), error => error === fatal);
    await assert.rejects(provider.getStorage(address, 0, 123), error => error === fatal);
    await assert.rejects(provider.getBlock(123), error => error === fatal);
    await assert.rejects(provider.getLogs({ fromBlock: 123, toBlock: 123 }), error => error === fatal);
    assert.equal(requests.length, 8);
  } finally {
    provider.destroy();
    await server.close();
  }
}

async function failureReleasesSlots(): Promise<void> {
  let received = 0;
  const server = await serve(request => {
    received++;
    if (received <= 8) request.response.writeHead(503).end("unavailable");
    else answer(request, payload => (payload.params[0] as { data: string }).data);
  });
  const provider = new RebuildReadProvider(pass, server.url, network, { ...options, batchMaxCount: 1 });
  try {
    const results = await bounded(Promise.allSettled(Array.from({ length: 24 }, (_, i) =>
      provider.send("eth_call", [{ to: address, data: ethers.toBeHex(i, 4) }, "0x7b"]))));
    assert.equal(received, 24, "transport failures release slots for all queued requests");
    assert.equal(results.filter(result => result.status === "rejected").length, 8);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 16);
    for (const result of results.filter(result => result.status === "rejected")) {
      assert(ethers.isError(result.reason, "SERVER_ERROR"), "preserve ethers transport error");
    }
  } finally {
    provider.destroy();
    await server.close();
  }
}

async function queuedRequestsRemainFifo(): Promise<void> {
  const requests: Request[] = [];
  const arrived = Array.from({ length: 24 }, () => deferred());
  const server = await serve(request => {
    requests.push(request);
    arrived[requests.length - 1].resolve();
  });
  const provider = new RebuildReadProvider(pass, server.url, network, { ...options, batchMaxCount: 1 });
  try {
    const pending = Promise.all(Array.from({ length: 24 }, (_, i) =>
      provider.send("eth_call", [{ to: address, data: ethers.toBeHex(i, 4) }, "0x7b"])));
    await bounded(arrived[7].promise);
    // Keep seven slots occupied. Free the eighth one at a time, so every
    // subsequent arrival observes the order in which queue slots are granted.
    answer(requests[0], () => "0x");
    for (let i = 8; i < 24; i++) {
      await bounded(arrived[i].promise);
      assert.equal((requests[i].payloads[0].params[0] as { data: string }).data, ethers.toBeHex(i, 4));
      answer(requests[i], () => "0x");
    }
    for (const request of requests.slice(1, 8)) answer(request, () => "0x");
    await bounded(pending);
  } finally {
    provider.destroy();
    await server.close();
  }
}

async function networkDetectionDoesNotDeadlock(requestTimeoutMs?: number): Promise<void> {
  const methods: string[] = [];
  const server = await serve(request => answer(request, payload => {
    methods.push(payload.method);
    if (payload.method === "eth_chainId") return "0x1";
    if (payload.method === "eth_getCode") return "0x6000";
    throw new Error(`unexpected method ${payload.method}`);
  }));
  const provider = new RebuildReadProvider(pass, server.url, undefined, { requestTimeoutMs });
  try {
    assert.deepEqual(await bounded(Promise.all(Array.from({ length: 80 }, (_, i) =>
      provider.getCode(ethers.getAddress(ethers.toBeHex(i + 1, 20)), 123)))), Array(80).fill("0x6000"));
    assert(methods.includes("eth_chainId"));
    assert.equal(methods.filter(method => method === "eth_getCode").length, 80);
  } finally {
    provider.destroy();
    await server.close();
  }
}

async function callerBoundedTransportRetainsConcurrency(): Promise<void> {
  const reachedTen = deferred();
  const requests: Request[] = [];
  const server = await serve(request => {
    requests.push(request);
    if (requests.length === 10) reachedTen.resolve();
  });
  const provider = new RebuildReadProvider(pass, server.url, network, {
    ...options,
    batchMaxCount: 1,
    maxPhysicalRequests: Infinity,
  });
  try {
    const pending = Promise.all(Array.from({ length: 10 }, (_, i) =>
      provider.send("debug_traceBlockByNumber", [ethers.toBeHex(i), {}])));
    await bounded(reachedTen.promise);
    assert.equal(requests.length, 10, "dedicated caller keeps its own concurrency bound");
    assert(requests.every(request => request.payloads.length === 1), "trace transport retains unbatched HTTP");
    for (const request of requests) answer(request, payload => payload.params[0]);
    assert.deepEqual(await bounded(pending), Array.from({ length: 10 }, (_, i) => ethers.toBeHex(i)));
  } finally {
    provider.destroy();
    await server.close();
  }
  for (const maxPhysicalRequests of [0, -1, 1.5, NaN, -Infinity]) {
    assert.throws(() => new RebuildReadProvider(pass, server.url, network, { maxPhysicalRequests }),
      /maxPhysicalRequests must be a positive integer or Infinity/);
  }
}

async function destroyRejectsQueue(): Promise<void> {
  const reachedEight = deferred();
  const requests: Request[] = [];
  const server = await serve(request => {
    requests.push(request);
    if (requests.length === 8) reachedEight.resolve();
  });
  const provider = new RebuildReadProvider(pass, server.url, network, { ...options, batchMaxCount: 1 });
  try {
    const requestsPending = Array.from({ length: 24 }, (_, i) =>
      provider.send("eth_call", [{ to: address, data: ethers.toBeHex(i, 4) }, "0x7b"]));
    const allPending = Promise.allSettled(requestsPending);
    await bounded(reachedEight.promise);
    provider.destroy();
    const queued = await bounded(Promise.allSettled(requestsPending.slice(8)));
    assert(queued.every(result => result.status === "rejected" &&
      ethers.isError(result.reason, "UNSUPPORTED_OPERATION")), "shutdown promptly rejects queued batches");
    assert.equal(requests.length, 8);
    await assert.rejects(provider.send("eth_call", [{ to: address, data: "0x" }, "0x7b"]));
    for (const request of requests) answer(request, () => "0x");
    const results = await bounded(allPending);
    assert(results.every(result => result.status === "rejected"));
    assert.equal(requests.length, 8, "shutdown must not send queued or new requests");
  } finally {
    provider.destroy();
    await server.close();
  }
}

async function totalTimeoutStopsStreamingAndReleasesSlot(): Promise<void> {
  const closed = deferred();
  let received = 0;
  const server = await serve(request => {
    received++;
    if (received > 1) { answer(request, () => []); return; }
    request.response.writeHead(200, { "content-type": "application/json" });
    request.response.write("[");
    // Bytes keep arriving, so an idle timeout never fires.
    const timer = setInterval(() => request.response.write(" "), 20);
    request.response.on("close", () => { clearInterval(timer); closed.resolve(); });
  });
  const provider = new RebuildReadProvider(pass, server.url, network, {
    ...options, batchMaxCount: 1, maxPhysicalRequests: 1, requestTimeoutMs: 150,
  });
  try {
    const started = performance.now();
    const first = provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]);
    const timedOut = assert.rejects(first, error => ethers.isError(error, "TIMEOUT"));
    const second = provider.send("eth_getLogs", [{ fromBlock: "0x3", toBlock: "0x4" }]);
    await bounded(timedOut);
    await bounded(closed.promise);
    assert(performance.now() - started < 2_000, "stream must be aborted, not left running");
    assert.deepEqual(await bounded(second), []);
    assert.equal(received, 2, "queued request proceeds without implicit retry");
  } finally {
    provider.destroy();
    await server.close();
  }
}

async function totalTimeoutCoversBatchAndThrottleWait(): Promise<void> {
  for (const throttled of [false, true]) {
    let received = 0;
    const closed = deferred();
    const server = await serve(request => {
      received++;
      if (received > 1) { answer(request, () => []); return; }
      assert.equal(request.payloads.length, 4);
      if (throttled) { request.response.writeHead(429, { "retry-after": "500" }).end(); return; }
      request.response.writeHead(200, { "content-type": "application/json" });
      request.response.write("[");
      const timer = setInterval(() => request.response.write(" "), 20);
      request.response.on("close", () => { clearInterval(timer); closed.resolve(); });
    });
    const provider = new RebuildReadProvider(pass, server.url, network, { ...options, requestTimeoutMs: 150 });
    try {
      const started = performance.now();
      const results = await bounded(Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
        provider.send("eth_getLogs", [{ fromBlock: ethers.toQuantity(i), toBlock: ethers.toQuantity(i) }]))));
      assert(results.every(result => result.status === "rejected" && ethers.isError(result.reason, "TIMEOUT")));
      assert(performance.now() - started < 450, "throttle delay cannot extend the absolute deadline");
      if (!throttled) await bounded(closed.promise);
      else await new Promise(resolve => setTimeout(resolve, 550));
      assert.equal(received, 1, "cancelled backoff cannot dispatch a late retry");
      assert.deepEqual(await bounded(provider.send("eth_getLogs", [{ fromBlock: "0x5", toBlock: "0x5" }])), []);
    } finally { provider.destroy(); await server.close(); }
  }
}

async function noHeadersTimeoutAndDestroyCloseSocket(): Promise<void> {
  for (const destroy of [false, true]) {
    const arrived = deferred(), closed = deferred();
    const server = await serve(request => {
      request.response.on("close", () => closed.resolve());
      arrived.resolve(); // Deliberately never send response headers.
    });
    const provider = new RebuildReadProvider(pass, server.url, network, {
      ...options, batchMaxCount: 1, requestTimeoutMs: destroy ? 2_000 : 150,
    });
    try {
      const started = performance.now();
      const pending = assert.rejects(provider.send("trace_block", ["0x1"]), error =>
        ethers.isError(error, destroy ? "UNSUPPORTED_OPERATION" : "TIMEOUT"));
      await bounded(arrived.promise);
      if (destroy) provider.destroy();
      await bounded(pending);
      await bounded(closed.promise);
      assert(performance.now() - started < 1_000, "no-header socket must close promptly");
    } finally { provider.destroy(); await server.close(); }
  }
}

async function boundedTransportRetainsGzipRedirectAndRpcErrors(): Promise<void> {
  let received = 0;
  const server = await serve(request => {
    received++;
    if (received === 1) { request.response.writeHead(302, { location: server.url + "/redirected" }).end(); return; }
    const replies = request.payloads.map(payload => payload.method === "eth_call"
      ? { jsonrpc: "2.0", id: payload.id, error: { code: 3, message: "execution reverted", data: "0xdeadbeef" } }
      : { jsonrpc: "2.0", id: payload.id, result: [] });
    request.response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    request.response.end(gzipSync(JSON.stringify(request.batched ? replies : replies[0])));
  });
  const provider = new RebuildReadProvider(pass, server.url, network, { ...options, batchMaxCount: 1 });
  try {
    // ethers intentionally refuses POST redirects; use its preserved status behavior.
    await assert.rejects(provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }]), error =>
      ethers.isError(error, "SERVER_ERROR"));
    assert.equal(received, 1, "POST redirect must not dispatch another request");
    assert.deepEqual(await bounded(provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x1" }])), []);
    await assert.rejects(provider.call({ to: address, data: "0x", blockTag: 123 }), error =>
      ethers.isError(error, "CALL_EXCEPTION") && error.data === "0xdeadbeef");
  } finally { provider.destroy(); await server.close(); }
  for (const requestTimeoutMs of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new RebuildReadProvider(pass, server.url, network, { requestTimeoutMs }), /requestTimeoutMs/);
  }
}

async function emptyAndMalformedGzipParity(): Promise<void> {
  let received = 0;
  const server = await serve(request => {
    received++;
    if (received === 1) {
      request.response.writeHead(429, { "content-encoding": "gzip", "retry-after": "20" }).end();
    } else if (received === 2) {
      answer(request, () => []);
    } else {
      request.response.writeHead(200, { "content-encoding": "gzip" }).end("not gzip");
    }
  });
  const provider = new RebuildReadProvider(pass, server.url, network, { ...options, batchMaxCount: 1 });
  try {
    assert.deepEqual(await bounded(provider.send("eth_getLogs", [])), []);
    assert.equal(received, 2, "empty gzip-marked 429 must retain retry handling");
    await assert.rejects(provider.send("eth_getLogs", []), error => ethers.isError(error, "SERVER_ERROR"));
  } finally { provider.destroy(); await server.close(); }
}

async function throttleTimersAreCancelled(): Promise<void> {
  for (const destroy of [false, true]) {
    const longTimers = new Set<number>();
    const sleeping = deferred();
    const hook = createHook({
      init(id, type, _trigger, resource) {
        // Exclude the HTTP server's repeating connection-cleanup interval.
        if (type === "Timeout" && Reflect.get(resource, "_idleTimeout") === 30_000 && Reflect.get(resource, "_repeat") === null) {
          longTimers.add(id);
          sleeping.resolve();
        }
      },
      destroy(id) { longTimers.delete(id); },
    }).enable();
    let received = 0;
    const server = await serve(request => {
      received++;
      request.response.writeHead(429, { "retry-after": "30000" }).end();
    });
    const provider = new RebuildReadProvider(pass, server.url, network, {
      ...options, requestTimeoutMs: destroy ? 2_000 : 150,
    });
    try {
      const pending = assert.rejects(provider.send("trace_block", ["0x1"]), error =>
        ethers.isError(error, destroy ? "UNSUPPORTED_OPERATION" : "TIMEOUT"));
      await bounded(sleeping.promise);
      if (destroy) provider.destroy();
      await bounded(pending);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(longTimers.size, 0, "deadline/destroy must clear the actual backoff timer");
      assert.equal(received, 1);
    } finally { hook.disable(); provider.destroy(); await server.close(); }
  }
}

async function throttleExhaustionAndVetoRetainPolicy(): Promise<void> {
  for (const veto of [false, true]) {
    let received = 0, callbacks = 0;
    const server = await serve(request => {
      received++;
      request.response.writeHead(429, { "retry-after": received === 3 ? "30000" : "20" }).end();
    });
    const connection = new ethers.FetchRequest(server.url);
    connection.setThrottleParams({ maxAttempts: 3 });
    connection.retryFunc = async (_req, response) => {
      callbacks++;
      assert.equal(response.headers["retry-after"], received === 3 ? "30000" : "20");
      return !veto;
    };
    const provider = new RebuildReadProvider(pass, connection, network, options);
    try {
      const started = performance.now();
      await assert.rejects(provider.send("trace_block", ["0x1"]), error => ethers.isError(error, "SERVER_ERROR"));
      assert.equal(received, veto ? 1 : 3);
      assert.equal(callbacks, received);
      assert(performance.now() - started < 1_000, "exhaustion must not sleep after the final response");
    } finally { provider.destroy(); await server.close(); }
  }
}

async function responseByteCeilings(): Promise<void> {
  const limit = 512;
  const closed = deferred();
  const server = await serve(request => {
    const payload = request.payloads[0];
    if (payload.method === "wireOverflow") {
      request.response.once("close", () => closed.resolve());
      request.response.write(Buffer.alloc(limit + 1, 0x20)); // no Content-Length; do not end
      return;
    }
    if (payload.method === "declaredOverflow") {
      request.response.writeHead(200, { "content-length": String(limit + 1) });
      request.response.flushHeaders(); return;
    }
    const requestedBytes = payload.method === "gzipOverflow" ? limit + 1 : limit;
    const envelope = { jsonrpc: "2.0", id: payload.id, result: "" };
    envelope.result = "x".repeat(requestedBytes - Buffer.byteLength(JSON.stringify(envelope)));
    const body = Buffer.from(JSON.stringify(envelope));
    if (payload.method.startsWith("gzip")) {
      request.response.setHeader("content-encoding", "gzip");
      request.response.end(gzipSync(body));
    } else request.response.end(body);
  });
  const isLimit = (error: unknown) => (error as { code?: string }).code === "RESPONSE_SIZE_LIMIT";
  const provider = new RebuildReadProvider(pass, server.url, network, {
    staticNetwork: network, batchMaxCount: 1, maxPhysicalRequests: 1,
    maxReceivedBytes: limit, maxDecompressedBytes: limit, // limits work without a custom timeout
  });
  try {
    await bounded(assert.rejects(provider.send("wireOverflow", []), isLimit));
    await bounded(closed.promise);
    await bounded(assert.rejects(provider.send("declaredOverflow", []), isLimit));
    await bounded(assert.rejects(provider.send("gzipOverflow", []), isLimit));
    for (const method of ["exact", "gzipExact"]) {
      assert.equal(typeof await bounded(provider.send(method, [])), "string", "boundary-sized replies pass and failures release the slot");
    }
  } finally { provider.destroy(); }
  const decompressedOnly = new RebuildReadProvider(pass, server.url, network, {
    staticNetwork: network, batchMaxCount: 1, maxDecompressedBytes: limit,
  });
  try { await bounded(assert.rejects(decompressedOnly.send("wireOverflow", []), isLimit)); }
  finally { decompressedOnly.destroy(); }
  const unlimited = new RebuildReadProvider(pass, server.url, network, options);
  try { assert.equal(typeof await bounded(unlimited.send("gzipOverflow", [])), "string", "omitted ceilings preserve old behavior"); }
  finally { unlimited.destroy(); await server.close(); }
  for (const name of ["maxReceivedBytes", "maxDecompressedBytes"]) {
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      assert.throws(() => new RebuildReadProvider(pass, undefined, network, { [name]: value }), /must be a positive integer/);
    }
  }
}

await responseByteCeilings();
await totalTimeoutStopsStreamingAndReleasesSlot();
await totalTimeoutCoversBatchAndThrottleWait();
await noHeadersTimeoutAndDestroyCloseSocket();
await boundedTransportRetainsGzipRedirectAndRpcErrors();
await emptyAndMalformedGzipParity();
await throttleTimersAreCancelled();
await throttleExhaustionAndVetoRetainPolicy();
await batchSizeConcurrencyAndParity();
await fatalQueueFence();
await failureReleasesSlots();
await queuedRequestsRemainFifo();
await networkDetectionDoesNotDeadlock();
await networkDetectionDoesNotDeadlock(2_000);
await callerBoundedTransportRetainsConcurrency();
await destroyRejectsQueue();
console.log("rebuild-read-provider PASS (total deadline, socket cancellation, batch timeout, retry cancellation, gzip, RPC errors, concurrency, parity, fatal fence, FIFO, shutdown)");
