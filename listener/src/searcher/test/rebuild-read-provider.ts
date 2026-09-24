import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ethers } from "ethers";
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
const options = { staticNetwork: network, cacheTimeout: -1 };
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

async function networkDetectionDoesNotDeadlock(): Promise<void> {
  const methods: string[] = [];
  const server = await serve(request => answer(request, payload => {
    methods.push(payload.method);
    if (payload.method === "eth_chainId") return "0x1";
    if (payload.method === "eth_getCode") return "0x6000";
    throw new Error(`unexpected method ${payload.method}`);
  }));
  const provider = new RebuildReadProvider(pass, server.url);
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

await batchSizeConcurrencyAndParity();
await fatalQueueFence();
await failureReleasesSlots();
await queuedRequestsRemainFifo();
await networkDetectionDoesNotDeadlock();
await callerBoundedTransportRetainsConcurrency();
await destroyRejectsQueue();
console.log("rebuild-read-provider PASS (batch limit, HTTP concurrency, parity, fatal fence, failure release, FIFO, network detection, caller-bound override, shutdown)");
