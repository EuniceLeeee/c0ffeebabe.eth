import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIssuedDiscoveryTransport,
  DiscoveryTransport,
  DiscoveryTransportError,
  HttpJsonRpcDiscoveryError,
  HttpJsonRpcDiscoveryPort,
  type UnderlyingRpcRequest,
} from "../src/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";

const request = {
  requestId: "request-1",
  provider: { provider: "rpc", backendEpoch: "epoch" },
  source: { chainId: "1", number: "10", hash: "hash", stateRoot: "state" },
  method: "eth_getLogs",
  params: {
    topic: "opaque-topic",
    manager: "opaque-manager",
    lookback: 50,
    chunk: 100,
  },
  requestCodec: "discovery-codec-v1",
  target: "opaque-target",
  manager: "opaque-manager",
  topic: "opaque-topic",
  lookback: 50,
  chunk: 100,
  phase: "nomination",
  workClassRef: "generated-work-class",
  ownerRef: "generated-owner",
};
const caller = {
  callerId: "discovery-test",
  authorityToken: "discovery-test-authority",
} as const;

test("abort reaches underlying request and physical permit is held until it settles", async () => {
  const scheduler = new WorkScheduler();
  const controller = new AbortController();
  let finish!: (value: unknown) => void;
  let underlyingSignal!: AbortSignal;
  const transport = new DiscoveryTransport({
    scheduler,
    caller,
    port: {
      request: async <T>({ signal }: UnderlyingRpcRequest): Promise<T> => {
        underlyingSignal = signal;
        return new Promise<T>((resolve) => {
          finish = (value) => resolve(value as T);
        });
      },
    },
  });
  const pending = transport.request({ ...request, signal: controller.signal });
  await Promise.resolve();
  controller.abort("stop");
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DiscoveryTransportError && error.code === "abort",
  );
  assert.equal(underlyingSignal.aborted, true);
  assert.equal(scheduler.snapshot().activeByResource.rpc, 1);
  finish({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().activeByResource.rpc, 0);
  scheduler.assertPermitConservation();
});

test("deadline and queue-full remain resource classifications, not discovery authority", async () => {
  const scheduler = new WorkScheduler({
    resources: { rpc: { capacity: 1 } },
    lanes: {
      "startup-RPC-fast": { queueCap: 1, concurrency: 1, resource: "rpc" },
    },
  });
  const transport = new DiscoveryTransport({
    scheduler,
    caller,
    port: {
      request: async <T>({ signal }: UnderlyingRpcRequest): Promise<T> =>
        new Promise<T>((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ aborted: true } as T),
            { once: true },
          );
        }),
    },
    defaultTimeoutMs: 2,
  });
  const first = transport.request(request);
  const second = transport.request({ ...request, requestId: "request-2" });
  const third = transport.request({ ...request, requestId: "request-3" });
  await assert.rejects(
    third,
    (error: unknown) =>
      error instanceof DiscoveryTransportError && error.code === "queue-full",
  );
  await assert.rejects(
    first,
    (error: unknown) =>
      error instanceof DiscoveryTransportError && error.code === "deadline",
  );
  await assert.rejects(second);
  await new Promise<void>((resolve) => setImmediate(resolve));
  scheduler.assertPermitConservation();
});

test("discovery requires the exact canonical envelope", async () => {
  const transport = new DiscoveryTransport({
    scheduler: new WorkScheduler(),
    caller,
    port: { request: async <T>() => ({ ok: true }) as T },
  });
  const missing = { ...request } as Record<string, unknown>;
  delete missing.requestCodec;
  await assert.rejects(
    transport.request(missing as never),
    /missing requestCodec/,
  );
  await assert.rejects(
    transport.request({ ...request, unexpected: true } as never),
    /unknown discovery envelope field/,
  );
});

test("discovery transport owner identity cannot be cloned or supplied by shape", () => {
  const transport = new DiscoveryTransport({
    scheduler: new WorkScheduler(),
    caller,
    port: { request: async <T>() => ({ ok: true }) as T },
  });
  assert.doesNotThrow(() => assertIssuedDiscoveryTransport(transport));
  assert.throws(() => assertIssuedDiscoveryTransport({ ...transport }), /not owner-issued/);
  assert.throws(() => assertIssuedDiscoveryTransport({ request: transport.request.bind(transport) }), /not owner-issued/);
});

test("the HTTP edge returns only an exact JSON-RPC result and preserves the request signal", async () => {
  let captured: RequestInit | undefined;
  const port = new HttpJsonRpcDiscoveryPort({
    endpoint: "http://127.0.0.1:8545",
    fetch: async (_input, init) => {
      captured = init;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { raw: "fact" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const controller = new AbortController();
  const value = await port.request<{ readonly raw: string }>({
    requestId: "rpc-request",
    provider: { provider: "reth", backendEpoch: "epoch" },
    source: request.source,
    method: "eth_getLogs",
    params: [{ blockHash: "0x" + "1".repeat(64) }],
    requestCodec: "ethereum-json-rpc-result.v1",
    target: null,
    manager: null,
    topic: null,
    lookback: 50,
    chunk: 1,
    deadlineAtMs: 100,
    signal: controller.signal,
  });
  assert.deepEqual(value, { raw: "fact" });
  assert.equal(captured?.signal, controller.signal);
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    id: "rpc-request",
    jsonrpc: "2.0",
    method: "eth_getLogs",
    params: [{ blockHash: "0x" + "1".repeat(64) }],
  });
});

test("the HTTP edge rejects mismatched, extra-field, and RPC error responses", async () => {
  const input: UnderlyingRpcRequest = {
    requestId: "rpc-request",
    provider: { provider: "reth", backendEpoch: "epoch" },
    source: request.source,
    method: "eth_getLogs",
    params: [],
    requestCodec: "ethereum-json-rpc-result.v1",
    target: null,
    manager: null,
    topic: null,
    lookback: 50,
    chunk: 1,
    deadlineAtMs: 100,
    signal: new AbortController().signal,
  };
  for (const response of [
    { jsonrpc: "2.0", id: "other", result: [] },
    { jsonrpc: "2.0", id: "rpc-request", result: [], forged: true },
  ]) {
    const port = new HttpJsonRpcDiscoveryPort({
      endpoint: "http://127.0.0.1:8545",
      fetch: async () => new Response(JSON.stringify(response), { status: 200 }),
    });
    await assert.rejects(
      port.request(input),
      (error: unknown) => error instanceof HttpJsonRpcDiscoveryError && error.code === "malformed-response",
    );
  }
  const rpc = new HttpJsonRpcDiscoveryPort({
    endpoint: "http://127.0.0.1:8545",
    fetch: async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "rpc-request",
      error: { code: -32000, message: "unavailable" },
    }), { status: 200 }),
  });
  await assert.rejects(
    rpc.request(input),
    (error: unknown) => error instanceof HttpJsonRpcDiscoveryError && error.code === "rpc",
  );
});
