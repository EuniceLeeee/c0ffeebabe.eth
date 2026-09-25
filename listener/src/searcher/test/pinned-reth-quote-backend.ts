/**
 * Deterministic PinnedRethQuoteBackend tests against a local HTTP stub:
 * coalescing, per-item revert data, transport-level single-call fallback and
 * per-item deadline rejection. No real reth or anvil involved.
 */

import { createHash } from "node:crypto";
import check from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isStateCallAbortedError,
  postJsonRpc,
  StateCallAbortedError,
  type StateCallControl,
} from "../../shared/state/state-backend.js";
import {
  PinnedRethQuoteBackend,
  type PinnedRethQuoteBackendOptions,
} from "../pinned-reth-quote-backend.js";
import { RethTransportScheduler } from "../reth-transport-scheduler.js";
import { isRpcThrottleError } from "../rpc-throttle-guard.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const HASH =
  "0x" + "ab".repeat(32);
const OK_A = "0x00000000000000000000000000000000000000a1";
const OK_B = "0x00000000000000000000000000000000000000b2";
const REVERT = "0x00000000000000000000000000000000000000c3";
const REVERT_DATA = "0xdeadbeef";
const RESULT = "0x" + "11".padStart(64, "0");
const SOURCE_ERROR = { code: -32000, message: "hash is not currently canonical" };

interface StubState {
  batches: Array<Array<Record<string, unknown>>>;
  singles: Array<Record<string, unknown>>;
  requestSockets: object[];
  failNextBatch: boolean;
  failAllBatches: boolean;
  holdResponses: boolean;
  pauseResponses: boolean;
  heldResponses: Array<{ send: () => void; closed: () => boolean }>;
  activeBatches: number;
  maxActiveBatches: number;
  rpcError?: { code: number | string; message: string; data?: unknown };
  rpcErrorHash?: string;
  httpStatus?: number;
  batchErrorEnvelope?: boolean;
  rawResponse?: string;
  replyBatch?: (items: Array<Record<string, unknown>>) => { status: number; body: unknown };
}

function startStub(): Promise<{ server: Server; state: StubState; port: number }> {
  const state: StubState = {
    batches: [],
    singles: [],
    requestSockets: [],
    failNextBatch: false,
    failAllBatches: false,
    holdResponses: false,
    pauseResponses: false,
    heldResponses: [],
    activeBatches: 0,
    maxActiveBatches: 0,
  };
  const server = createServer((req, res) => {
    state.requestSockets.push(req.socket);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      const reply = (payload: unknown): void => {
        try {
          res.writeHead(state.httpStatus ?? 200, { "content-type": state.rawResponse === undefined
            ? "application/json" : "text/plain" });
          res.end(state.rawResponse ?? JSON.stringify(payload));
        } catch {
          // Client may abort the request mid-flight; ignore the write error.
        }
      };
      const maybeHold = (send: () => void): void => {
        if (state.pauseResponses) {
          state.heldResponses.push({ send, closed: () => res.destroyed });
        } else if (state.holdResponses) {
          setTimeout(send, 250);
        } else {
          send();
        }
      };
      const injectedError = (item: { params?: unknown[] }): unknown => {
        const tx = item.params?.[0] as { to?: unknown } | undefined;
        const pin = item.params?.[1] as { blockHash?: unknown } | undefined;
        return tx?.to === REVERT &&
          (state.rpcErrorHash === undefined || pin?.blockHash === state.rpcErrorHash)
          ? state.rpcError : undefined;
      };
      if (Array.isArray(body)) {
        if (state.failNextBatch || state.failAllBatches) {
          if (state.failNextBatch) state.failNextBatch = false;
          state.batches.push(body);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        state.batches.push(body);
        state.activeBatches++;
        let active = true;
        const settled = (): void => { if (active) { active = false; state.activeBatches--; } };
        res.once("close", settled);
        state.maxActiveBatches = Math.max(
          state.maxActiveBatches,
          state.activeBatches,
        );
        maybeHold(() => {
          settled();
          if (state.replyBatch) {
            const response = state.replyBatch(body);
            res.writeHead(response.status, { "content-type": "application/json" });
            res.end(JSON.stringify(response.body));
            return;
          }
          if (state.batchErrorEnvelope) {
            reply({ jsonrpc: "2.0", id: null, error: state.rpcError });
            return;
          }
          reply(body.map((entry) => {
              const item = entry as { id?: unknown; params?: unknown[] };
              const error = injectedError(item);
              if (error) return { jsonrpc: "2.0", id: item.id, error };
              const tx = Array.isArray(item.params)
                ? item.params[0] as { to?: unknown }
                : null;
              if (tx?.to === REVERT) {
                return {
                  jsonrpc: "2.0",
                  id: item.id,
                  error: {
                    code: 3,
                    message: "execution reverted",
                    data: REVERT_DATA,
                  },
                };
              }
              return { jsonrpc: "2.0", id: item.id, result: RESULT };
            }));
        });
        return;
      }
      const single = body as { id?: unknown; params?: unknown[] };
      state.singles.push(single);
      maybeHold(() => {
        const error = injectedError(single);
        reply(error ? { jsonrpc: "2.0", id: single.id, error }
          : { jsonrpc: "2.0", id: single.id, result: RESULT });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address !== null && typeof address === "object", "stub address");
      resolve({ server, state, port: address.port });
    });
  });
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const observe = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> => promise.then(
  (value) => ({ status: "fulfilled", value }),
  (reason) => ({ status: "rejected", reason }),
);
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await nextTurn();
  }
}
function aborted(result: PromiseSettledResult<string>, kind?: string): void {
  check.equal(result.status, "rejected", "cancelled caller received a result");
  if (result.status !== "rejected") return;
  check.ok(isStateCallAbortedError(result.reason), "cancellation lost its typed error");
  if (kind) check.equal(result.reason.kind, kind);
}

/** Isolated local transport for each case, including failure-safe backend/socket cleanup. */
async function pendingCase(name: string, test: (fixture: {
  state: StubState;
  rpcUrl: string;
  items: () => Array<Record<string, unknown>>;
  backend: (options?: PinnedRethQuoteBackendOptions, hash?: string) => PinnedRethQuoteBackend;
  release: () => void;
}) => Promise<void>): Promise<void> {
  const { server, state, port } = await startStub();
  const backends: PinnedRethQuoteBackend[] = [];
  const release = (): void => state.heldResponses.splice(0).forEach(({ send }) => send());
  try {
    await test({
      state,
      rpcUrl: `http://127.0.0.1:${port}`,
      items: () => [...state.batches.flat(), ...state.singles],
      backend(options = {}, hash = HASH) {
        const backend = new PinnedRethQuoteBackend(`http://127.0.0.1:${port}`, hash, {
          deadlineAtMs: Date.now() + 4000, allowSingleCallFallback: false, ...options,
        });
        backends.push(backend);
        return backend;
      },
      release,
    });
    console.log(`[pinned-reth-quote-backend] ${name}: PASS`);
  } finally {
    await Promise.allSettled(backends.map((backend) => backend.closeAndDrain()));
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function pendingCallTests(): Promise<void> {
  const failures: unknown[] = [];
  const testCase = async (...args: Parameters<typeof pendingCase>): Promise<void> => {
    try { await pendingCase(...args); }
    catch (error) { failures.push(error); console.error(`[pinned-reth-quote-backend] ${args[0]}: FAIL`, error); }
  };
  const request = { to: OK_A, data: "0xcafe" };
  for (const failure of ["source", "http429", "plaintext429", "rpc429"] as const) {
   for (const lane of ["exact", "producer-bulk"] as const) {
    await testCase(`${lane} ${failure} cancels active and queued work once; successor survives`,
      async ({ state, backend, items, release }) => {
        const scheduler = new RethTransportScheduler({ capacity: 3, producerReserved: 1 });
        const notifications: Error[] = [];
        const throttleNotifications: Error[] = [];
        const markers: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => { markers.push(args); };
        try {
          const client = backend({
            transportLane: lane, transportScheduler: scheduler,
            maxBatchSize: 4, maxConcurrentBatches: 4, allowSingleCallFallback: true,
            scopeLabel: "credential-canary-must-not-be-logged",
            onSourceUnavailable(error) { notifications.push(error); },
            onRpcThrottle(error) { throttleNotifications.push(error); },
          });
          check.equal(await client.call(request), RESULT);
          await client.drain();
          const batchesBefore = state.batches.length;
          state.rpcError = failure === "rpc429" ? { code: 429, message: "RPC throttled" } : SOURCE_ERROR;
          state.rpcErrorHash = HASH;
          const http429 = failure === "http429" || failure === "plaintext429";
          if (http429) state.httpStatus = 429;
          if (failure === "plaintext429") state.rawResponse = "response-body-canary https://private.invalid/secret";
          state.pauseResponses = true;
          const requests = Array.from({ length: 64 }, (_, index) => ({
            to: index % 4 >= 2 ? REVERT : OK_B,
            data: `0x${index.toString(16).padStart(4, "0")}`,
          }));
          const calls = [...requests, ...requests.slice(0, 5)].map((req) => observe(client.call(req)));
          const activeCount = lane === "exact" ? 2 : 3;
          await until(() => state.heldResponses.length === activeCount, "source transports held");
          check.ok(client.stats().pendingItems > 0);
          check.ok(scheduler.snapshot().queuedByLane[lane] > 0);
          state.heldResponses.shift()!.send(); // Success entries precede two source errors.
          const settled = await Promise.all(calls);
          await client.drain(); // Fatal detection itself must close the scope.
          check.equal(notifications.length, failure === "source" ? 1 : 0);
          check.equal(throttleNotifications.length, failure === "source" ? 0 : 1);
          const sourceError = [...notifications, ...throttleNotifications][0]!;
          check.equal(sourceError.message, http429 ? "JSON-RPC HTTP 429" : state.rpcError.message);
          if (http429) {
            check.equal((sourceError as Error & { statusCode: unknown }).statusCode, 429);
          } else {
            check.equal((sourceError as Error & { code: unknown }).code, state.rpcError.code);
          }
          for (const result of settled) {
            aborted(result, "signal");
            if (result.status === "rejected") check.equal(result.reason.cause, sourceError);
          }
          const stats = client.stats();
          check.deepEqual([stats.pendingItems, stats.liveItems, stats.inFlightBatches, stats.activeTransports], [0, 0, 0, 0]);
          check.equal(scheduler.snapshot().activeTotal, 0);
          check.equal(scheduler.snapshot().queuedByLane[lane], 0);
          check.equal(stats.batchesSent, batchesBefore + activeCount, "queued permit issued another RPC after source error");
          check.equal(stats.singleCallFallbacks, 0);
          check.equal(state.singles.length, 0);
          await until(() => state.heldResponses.every(({ closed }) => closed()), "sibling sockets closed");
          release();
          state.pauseResponses = false;
          const itemCount = items().length;
          for (let retry = 0; retry < 3; retry++) {
            aborted(await observe(client.call(requests[2]!)));
            aborted(await observe(client.call(request)));
            aborted(await observe(client.callCached(request)!));
          }
          await client.closeAndDrain();
          await nextTurn();
          check.equal(items().length, itemCount, "drained backend sent another transport");
          check.equal(notifications.length + throttleNotifications.length, 1);
          check.equal(markers.length, 1);
          check.ok(JSON.stringify(markers).includes(failure === "source" ? "source-unavailable" : "rpc-throttle"));
          check.equal(JSON.stringify(markers).includes("HTTP 429"), failure !== "source");
          check.ok(!JSON.stringify(markers).includes("credential-canary"));
          check.ok(!JSON.stringify(markers).includes("response-body-canary"));
          check.ok(!String(sourceError).includes("response-body-canary"));
          check.ok(!JSON.stringify(markers).includes("http"));
          const successorHash = "0x" + "cd".repeat(32);
          state.httpStatus = 200;
          state.rawResponse = undefined;
          const successor = backend({ transportScheduler: scheduler,
            onSourceUnavailable(error) { notifications.push(error); },
            onRpcThrottle(error) { throttleNotifications.push(error); } }, successorHash);
          check.equal(await successor.call(request), RESULT);
          await successor.drain();
          check.deepEqual(state.batches.at(-1)![0]!.params, [request,
            { blockHash: successorHash, requireCanonical: true }]);
          check.equal(notifications.length + throttleNotifications.length, 1);
        } finally {
          console.warn = originalWarn;
        }
      });
   }
  }

  for (const rpcError of [
    { ...SOURCE_ERROR, code: 3, data: REVERT_DATA },
    { ...SOURCE_ERROR, code: 3 },
    { ...SOURCE_ERROR, data: REVERT_DATA },
    { ...SOURCE_ERROR, data: { data: REVERT_DATA } },
    { ...SOURCE_ERROR, code: "-32000" },
    { ...SOURCE_ERROR, message: `execution reverted: ${SOURCE_ERROR.message}` },
    { ...SOURCE_ERROR, message: `${SOURCE_ERROR.message} ` },
    { code: 3, message: "execution reverted: HTTP 429 Too Many Requests rate limit", data: REVERT_DATA },
    { code: 3, message: "HTTP 429 Too Many Requests" },
    { code: "CALL_EXCEPTION", message: "execution reverted: HTTP 429 rate limit", data: REVERT_DATA },
    { code: "CALL_EXCEPTION", message: "execution reverted: rate limit" },
    { code: -32000, message: "execution reverted: rate limit", data: REVERT_DATA },
    { code: -32000, message: "execution reverted: HTTP 429 Too Many Requests", data: "0x" },
    { code: -32000, message: "execution reverted: value 429 is invalid", data: REVERT_DATA },
    { code: -32000, message: "429" },
  ]) {
    await testCase(`non-source RPC error preserves per-item behavior: ${JSON.stringify(rpcError)}`,
      async ({ state, backend, items }) => {
        state.rpcError = rpcError;
        let notifications = 0;
        const client = backend({ allowSingleCallFallback: true,
          onSourceUnavailable() { notifications++; }, onRpcThrottle() { notifications++; } });
        check.equal(isRpcThrottleError(rpcError), false);
        check.equal(isRpcThrottleError(new Error("outer", { cause: rpcError })), false);
        const bad = { to: REVERT, data: "0xfade" };
        for (let retry = 0; retry < 2; retry++) {
          const [good, failed] = await Promise.all([observe(client.call(request)), observe(client.call(bad))]);
          check.deepEqual(good, { status: "fulfilled", value: RESULT });
          check.equal(failed.status, "rejected");
          if (failed.status === "rejected") {
            check.equal(isStateCallAbortedError(failed.reason), false);
            check.equal(failed.reason.code, rpcError.code);
            check.equal(failed.reason.message, rpcError.message);
            check.deepEqual(failed.reason.data, "data" in rpcError ? rpcError.data : undefined);
          }
          await client.drain();
          check.equal(client.callCached(bad), undefined);
        }
        check.equal(items().length, 3, "normal error must remain retryable and success memoized");
        check.equal(notifications, 0);
        check.equal(state.singles.length, 0);
      });
  }

  for (const failure of ["source", "rpc429", "http429", "plaintext429"] as const) {
   await testCase(`${failure} in single-call fallback aborts siblings even if callback throws`,
    async ({ state, backend }) => {
      state.failNextBatch = true;
      state.rpcError = failure === "rpc429" ? { code: 429, message: "RPC throttled" } : SOURCE_ERROR;
      if (failure === "http429" || failure === "plaintext429") state.httpStatus = 429;
      if (failure === "plaintext429") state.rawResponse = "request rejected";
      const notifications: Error[] = [];
      const onFailure = (error: Error): void => { notifications.push(error); throw new Error("observer failed"); };
      const client = backend({ maxBatchSize: 2, maxConcurrentBatches: 1,
        allowSingleCallFallback: true,
        onSourceUnavailable: onFailure, onRpcThrottle: onFailure });
      const calls = Array.from({ length: 12 }, (_, index) => observe(client.call({
        to: REVERT, data: `0x${index.toString(16).padStart(2, "0")}`,
      })));
      const settled = await Promise.all(calls);
      await client.drain();
      check.equal(notifications.length, 1);
      for (const result of settled) {
        aborted(result);
        if (result.status === "rejected") check.equal(result.reason.cause, notifications[0]);
      }
      check.equal(state.batches.length, 1);
      check.equal(client.stats().singleCallFallbacks, 2, "only original HTTP failure may trigger fallback");
      check.equal(client.stats().activeTransports, 0);
      const singles = state.singles.length;
      aborted(await observe(client.call({ to: REVERT, data: "0xff" })));
      await client.closeAndDrain();
      check.equal(state.singles.length, singles);
    });
  }

  await testCase("source failure still closes backend without an observer", async ({ state, backend }) => {
    state.rpcError = { ...SOURCE_ERROR, data: null };
    const client = backend();
    const result = await observe(client.call({ to: REVERT, data: "0xfa" }));
    aborted(result);
    if (result.status === "rejected") check.equal(result.reason.cause.message, SOURCE_ERROR.message);
    await client.drain();
    check.equal(client.stats().activeTransports, 0);
    aborted(await observe(client.call(request)));
    check.equal(state.batches.length, 1);
  });

  await testCase("HTTP 200 whole-batch RPC 429 never falls back", async ({ state, backend }) => {
    state.rpcError = { code: 429, message: "RPC throttled" };
    state.batchErrorEnvelope = true;
    const notifications: Error[] = [];
    const client = backend({ allowSingleCallFallback: true,
      onRpcThrottle(error) { notifications.push(error); } });
    const settled = await Promise.all([observe(client.call(request)), observe(client.call({ ...request, to: OK_B }))]);
    settled.forEach((result) => aborted(result));
    await client.drain();
    check.equal(notifications.length, 1);
    check.equal(client.stats().singleCallFallbacks, 0);
    check.equal(state.batches.length, 1);
    check.equal(state.singles.length, 0);
  });

  for (const statusCode of [429, 500, 200]) {
    await testCase(`invalid JSON HTTP ${statusCode} preserves status or rejects without body/URL`,
      async ({ state, rpcUrl }) => {
        state.httpStatus = statusCode;
        state.rawResponse = "<html>response-body-canary https://private.invalid/secret</html>";
        const response = await observe(postJsonRpc(rpcUrl + "/endpoint-canary", {
          jsonrpc: "2.0", id: 1, method: "eth_call", params: [request],
        }, new AbortController().signal));
        if (statusCode === 200) {
          check.equal(response.status, "rejected");
          if (response.status === "rejected") {
            check.ok(response.reason instanceof SyntaxError);
            check.equal(response.reason.message, "JSON-RPC response contained invalid JSON");
            check.ok(!String(response.reason.stack).includes("canary"));
            check.equal(response.reason.cause, undefined);
          }
        } else {
          check.equal(response.status, "fulfilled");
          if (response.status === "fulfilled") {
            check.equal(response.value.statusCode, statusCode);
            check.equal(response.value.body, null);
            check.ok(!JSON.stringify(response.value).includes("canary"));
          }
        }
      });
  }

  for (const statusCode of [500, 200]) {
    for (const allowSingleCallFallback of [false, true]) {
      await testCase(`invalid JSON HTTP ${statusCode} retains ordinary fallback=${allowSingleCallFallback} policy`,
        async ({ state, backend }) => {
          state.httpStatus = statusCode;
          state.rawResponse = "<html>response-body-canary https://private.invalid/secret</html>";
          let notifications = 0;
          const client = backend({ allowSingleCallFallback,
            onRpcThrottle() { notifications++; }, onSourceUnavailable() { notifications++; } });
          const result = await observe(client.call(request));
          check.equal(result.status, "rejected");
          if (result.status === "rejected") {
            check.equal(isStateCallAbortedError(result.reason), false);
            check.match(result.reason.message, statusCode === 500 ? /HTTP 500/ : /invalid JSON/);
            check.ok(!String(result.reason.stack).includes("response-body-canary"));
            check.ok(!String(result.reason.stack).includes("private.invalid"));
          }
          await client.drain();
          check.equal(client.stats().singleCallFallbacks, allowSingleCallFallback ? 1 : 0);
          check.equal(state.singles.length, allowSingleCallFallback ? 1 : 0);
          check.equal(notifications, 0);
          state.httpStatus = 200;
          state.rawResponse = undefined;
          check.equal(await client.call(request), RESULT, "ordinary failure must remain retryable");
        });
    }
  }

  for (const count of [1, 5]) {
    await testCase(`non-closing drain settles ${count} queued calls and preserves phase reuse`,
      async ({ state, backend, items, release }) => {
        state.pauseResponses = true;
        const client = backend({ transportLane: "producer-bulk", maxBatchSize: 4, maxConcurrentBatches: 1 });
        const requests = Array.from({ length: count }, (_, index) => ({ ...request, data: `0x${index.toString(16).padStart(2, "0")}` }));
        check.equal(client.callCached(requests[0]!), undefined, "cold cache lookup must not issue a request");
        check.equal(client.stats().totalCalls, 0);
        const calls = requests.map((req) => observe(client.call(req)));
        check.equal(client.stats().pendingItems, 1, "fixture must leave a partial batch before setImmediate");
        const pendingStats = client.stats();
        check.equal(client.callCached(requests[0]!), undefined, "cache-only lookup must not join pending work");
        check.deepEqual(client.stats(), pendingStats);
        let drained = false;
        const draining = client.drain().then(() => { drained = true; });
        for (let batch = 0; batch < Math.ceil(count / 4); batch++) {
          await until(() => state.heldResponses.length === 1, "phase transport held");
          check.ok(client.stats().activeTransports > 0);
          await nextTurn();
          check.equal(drained, false, "drain returned before the held transport settled");
          release();
        }
        await draining;
        check.deepEqual(await Promise.all(calls), requests.map(() => ({ status: "fulfilled", value: RESULT })));
        const idle = (): void => {
          const stats = client.stats();
          check.deepEqual([stats.pendingItems, stats.liveItems, stats.inFlightBatches, stats.activeTransports], [0, 0, 0, 0]);
          check.equal(stats.lane, "producer-bulk");
        };
        idle();
        state.pauseResponses = false;
        const beforeCacheHits = client.stats();
        check.deepEqual(await Promise.all(requests.map((req) => client.callCached(req))), requests.map(() => RESULT));
        check.equal(client.stats().memoHits, beforeCacheHits.memoHits + count);
        check.equal(client.stats().totalCalls, beforeCacheHits.totalCalls, "memo-only hits must not issue logical calls");
        check.equal(client.callCached(requests[0]!, {}, `0x${"cd".repeat(32)}`), undefined,
          "cross-stage wrong source hash must miss without RPC or a cache hit");
        check.equal(client.stats().memoHits, beforeCacheHits.memoHits + count);
        check.equal(await client.callCached(requests[0]!, {}, `0x${"AB".repeat(32)}`), RESULT,
          "cross-stage source hash comparison is case normalized");
        check.deepEqual(await Promise.all(requests.map((req) => client.call(req))), requests.map(() => RESULT));
        check.equal(items().length, count, "second-phase successes must use the original memo");
        for (const miss of [{ ...request, data: "0xbeef" }, { ...requests[0]!, to: OK_B }, { ...requests[0]!, from: OK_A }]) {
          check.equal(client.callCached(miss), undefined, "cache-only identity mismatch must remain a miss");
        }
        check.equal(await client.call({ ...request, data: "0xbeef" }), RESULT);
        await client.drain();
        check.equal(items().length, count + 1, "second-phase distinct key must reach transport");
        idle();
        state.pauseResponses = true;
        const closing = observe(client.call({ ...request, data: "0xdead" }));
        await until(() => state.heldResponses.length === 1, "final pass transport held");
        await client.closeAndDrain();
        aborted(await closing);
        idle();
        aborted(await observe(client.call(requests[0]!)));
        aborted(await observe(client.callCached(requests[0]!)!));
      });
  }

  for (const mode of ["signal", "deadline"] as const) {
    await testCase(`phase ${mode} cancellation drains without memoizing late replies`,
      async ({ state, backend, items, release }) => {
        const client = backend();
        check.equal(await client.call(request), RESULT);
        await client.drain();
        state.pauseResponses = true;
        const caller = new AbortController();
        const req = { ...request, to: OK_B };
        const control = mode === "signal" ? { signal: caller.signal } : { deadlineAtMs: Date.now() + 100 };
        const cancelled = observe(client.call(req, control));
        await until(() => state.heldResponses.length === 1, "cancelled phase transport");
        if (mode === "signal") caller.abort(new Error("phase ended"));
        aborted(await cancelled, mode);
        await client.drain();
        const stats = client.stats();
        check.deepEqual([stats.pendingItems, stats.liveItems, stats.inFlightBatches, stats.activeTransports], [0, 0, 0, 0]);
        await until(state.heldResponses[0]!.closed, "cancelled phase HTTP envelope closed");
        release(); // A noncooperative late success must not become the next phase's memo.
        state.pauseResponses = false;
        check.equal(client.callCached(req), undefined, "cancelled phase installed a cache-only hit");
        aborted(await observe(client.callCached(req, control)!), mode);
        check.equal(await client.call(request), RESULT);
        aborted(await observe(client.call(req, control)), mode);
        check.equal(items().length, 2, "invalid old phase controls launched new work");
        check.equal(await client.call(req, { deadlineAtMs: Date.now() + 1000 }), RESULT);
        await client.drain();
        check.equal(items().length, 3, "cancelled result was memoized or original success was lost");
      });
  }

  await testCase("drained memo cannot cross a new source hash", async ({ backend, items }) => {
    const original = backend();
    check.equal(await original.call(request), RESULT);
    await original.drain();
    const newHash = `0x${"cd".repeat(32)}`;
    const next = backend({}, newHash);
    check.equal(next.callCached(request), undefined, "new source must not see the drained memo");
    check.equal(await next.call(request), RESULT);
    await next.drain();
    check.equal(await original.call(request), RESULT);
    check.equal(items().length, 2);
    check.deepEqual(items().map((item) => (item.params as unknown[])[1]), [
      { blockHash: HASH, requireCanonical: true }, { blockHash: newHash, requireCanonical: true },
    ]);
  });

  await testCase("five cold duplicates share one physical item", async ({ state, backend, items, release }) => {
    state.pauseResponses = true;
    const client = backend();
    const calls = [observe(client.call(request)), observe(client.call(request))];
    await until(() => state.heldResponses.length === 1, "first duplicate transport");
    calls.push(...Array.from({ length: 3 }, () => observe(client.call(request))));
    await nextTurn();
    release();
    check.deepEqual(await Promise.all(calls), Array.from({ length: 5 }, () => ({ status: "fulfilled", value: RESULT })));
    check.equal(items().length, 1, "cold/in-flight duplicate eth_call amplification");
    check.equal(items()[0]!.method, "eth_call");
  });

  await testCase("canonical target/data/from/hash identity isolation", async ({ state, backend, items, release }) => {
    state.pauseResponses = true;
    const client = backend();
    const otherHash = `0x${"cd".repeat(32)}`;
    const requests = [request, { ...request, to: OK_B }, { ...request, data: "0xbeef" },
      { ...request, from: OK_A }, { ...request, from: OK_B }];
    const calls = requests.map((req) => observe(client.call(req)));
    calls.push(observe(backend({}, otherHash).call(request)));
    await until(() => state.heldResponses.length === 2, "two pinned scopes");
    release();
    check.ok((await Promise.all(calls)).every((result) => result.status === "fulfilled"));
    const wireIdentities = items().map((item) => {
      const [tx, pin] = item.params as [{ to: string; data: string; from?: string },
        { blockHash: string; requireCanonical: boolean }];
      check.equal(pin.requireCanonical, true);
      return JSON.stringify([tx.to, tx.data, tx.from ?? null, pin.blockHash]);
    });
    check.deepEqual(wireIdentities.sort(), [
      ...requests.map((req) => JSON.stringify([req.to, req.data, "from" in req ? req.from : null, HASH])),
      JSON.stringify([request.to, request.data, null, otherHash]),
    ].sort());
  });

  for (const mode of ["abort", "deadline"] as const) {
    for (const first of [true, false]) {
      await testCase(`${mode} of ${first ? "initiating" : "joining"} waiter is isolated`,
        async ({ state, backend, items, release }) => {
          state.pauseResponses = true;
          const client = backend();
          const controller = new AbortController();
          const control = mode === "abort" ? { signal: controller.signal }
            : { deadlineAtMs: Date.now() + 80 };
          let healthySettled = false;
          const healthy = () => observe(client.call(request)).then((result) => {
            healthySettled = true;
            return result;
          });
          const short = () => observe(client.call(request, control));
          const [shortResult, healthyResult] = first ? [short(), healthy()] : (() => {
            const survivor = healthy();
            return [short(), survivor];
          })();
          await until(() => state.heldResponses.length === 1, "shared waiter transport");
          if (mode === "abort") controller.abort(new Error("one caller stopped"));
          aborted(await shortResult!, mode === "abort" ? "signal" : "deadline");
          check.equal(healthySettled, false, "short waiter settled the healthy waiter");
          check.equal(state.heldResponses[0]!.closed(), false, "one waiter aborted shared transport");
          release();
          check.deepEqual(await healthyResult, { status: "fulfilled", value: RESULT });
          check.equal(items().length, 1, "independent healthy waiter used a duplicate item");
          check.equal(await client.call(request), RESULT, "healthy completion was not memoized");
          check.equal(items().length, 1);
        });
    }
  }

  for (const inFlight of [false, true]) {
    await testCase(`all waiters abort ${inFlight ? "in flight" : "before dispatch"}; immediate retry survives`,
      async ({ state, backend, items, release }) => {
        state.pauseResponses = true;
        const client = backend();
        const controllers = [new AbortController(), new AbortController()];
        const abandoned = controllers.map((controller) => observe(client.call(request, { signal: controller.signal })));
        if (inFlight) await until(() => state.heldResponses.length === 1, "abandoned transport");
        const oldReply = state.heldResponses[0];
        controllers.forEach((controller) => controller.abort(new Error("all callers stopped")));
        // Launch before the old request's rejection handlers run. They must not
        // remove the replacement group or install an abandoned memo result.
        const replacement = observe(client.call(request));
        (await Promise.all(abandoned)).forEach((result) => aborted(result, "signal"));
        await until(() => items().length >= (inFlight ? 2 : 1), "fresh same-key retry");
        if (oldReply) await until(oldReply.closed, "abandoned transport actually aborted");
        const follower = observe(client.call(request));
        await nextTurn();
        release();
        check.deepEqual(await Promise.all([replacement, follower]), [
          { status: "fulfilled", value: RESULT }, { status: "fulfilled", value: RESULT },
        ]);
        check.equal(items().length, inFlight ? 2 : 1, "old failure erased replacement or prevented joining it");
        check.equal(await client.call(request), RESULT);
        check.equal(items().length, inFlight ? 2 : 1, "replacement memo was lost");
      });
  }

  for (const transportFailure of [false, true]) {
    await testCase(`${transportFailure ? "transport" : "domain"} failure is shared but never memoized`,
      async ({ state, backend, items }) => {
        const client = backend();
        const req = transportFailure ? request : { ...request, to: REVERT };
        state.failNextBatch = transportFailure;
        const failed = await Promise.all([observe(client.call(req)), observe(client.call(req))]);
        for (const result of failed) {
          check.equal(result.status, "rejected");
          if (!transportFailure && result.status === "rejected") check.equal(result.reason.data, REVERT_DATA);
        }
        check.equal(items().length, 1, "failure did not share a physical item");
        await client.drain();
        check.equal(client.callCached(req), undefined, "failed phase must not create a cache-only hit");
        const retried = await Promise.all([observe(client.call(req)), observe(client.call(req))]);
        await client.drain();
        check.ok(retried.every((result) => result.status === (transportFailure ? "fulfilled" : "rejected")));
        check.equal(items().length, 2, "failure was memoized or retry duplicated");
        check.equal(state.singles.length, 0, "failure test unexpectedly used fallback");
      });
  }

  for (const mode of ["close", "scope-abort"] as const) {
    await testCase(`${mode} rejects all shared waiters and drains`, async ({ state, backend, items }) => {
      state.pauseResponses = true;
      const controller = new AbortController();
      const client = backend({ signal: controller.signal });
      const pending = Array.from({ length: 5 }, () => observe(client.call(request)));
      await until(() => state.heldResponses.length === 1, "scope-owned group");
      if (mode === "scope-abort") controller.abort(new Error("scope ended"));
      else await client.closeAndDrain();
      (await Promise.all(pending)).forEach((result) => aborted(result));
      await client.closeAndDrain();
      const stats = client.stats();
      check.deepEqual([stats.liveItems, stats.pendingItems, stats.inFlightBatches, stats.activeTransports], [0, 0, 0, 0]);
      check.equal(items().length, 1);
      aborted(await observe(client.call(request)));
    });
  }

  for (const mode of ["close", "scope-abort", "caller-abort", "caller-deadline"] as const) {
    await testCase(`warm memo respects ${mode}`, async ({ backend, items }) => {
      const parent = new AbortController();
      const caller = new AbortController();
      const client = backend({ signal: parent.signal });
      check.equal(await client.call(request), RESULT);
      check.equal(await client.call(request), RESULT);
      await client.drain();
      if (mode === "close") await client.closeAndDrain();
      if (mode === "scope-abort") parent.abort(new Error("new head superseded the drained source"));
      if (mode === "caller-abort") caller.abort(new Error("caller ended"));
      const control = mode === "caller-deadline" ? { deadlineAtMs: Date.now() - 1 }
        : { signal: caller.signal };
      aborted(await observe(client.callCached(request, control)!), mode === "caller-deadline" ? "deadline" : "signal");
      aborted(await observe(client.call(request, control)), mode === "caller-deadline" ? "deadline" : "signal");
      if (mode.startsWith("caller-")) check.equal(await client.call(request), RESULT, "caller cancelled a healthy memo");
      check.equal(items().length, 1, "memo rejection launched a new transport");
    });
  }
  await testCase("abandoned key does not cancel another key in the same batch", async ({ state, backend, items, release }) => {
    state.pauseResponses = true;
    const client = backend();
    const controller = new AbortController();
    const abandoned = [observe(client.call(request, { signal: controller.signal })),
      observe(client.call(request, { signal: controller.signal }))];
    const healthy = observe(client.call({ ...request, to: OK_B }));
    await until(() => state.heldResponses.length === 1, "mixed-key batch");
    controller.abort(new Error("one key no longer needed"));
    (await Promise.all(abandoned)).forEach((result) => aborted(result));
    await nextTurn();
    check.equal(state.heldResponses[0]!.closed(), false, "cancelled key destroyed healthy batch sibling");
    release();
    check.deepEqual(await healthy, { status: "fulfilled", value: RESULT });
    check.equal(items().length, 2);
    state.pauseResponses = false;
    check.equal(await client.call(request), RESULT);
    check.equal(items().length, 3, "abandoned item's late success was memoized");
  });
  if (failures.length) throw new AggregateError(failures, "pending-call coalescing regressions");
}

async function adaptiveRetryTests(): Promise<void> {
  const limited = { code: 429, message: "Your app has exceeded its compute units per second capacity" };
  const results = (items: Array<Record<string, unknown>>) => items.map(item =>
    ({ jsonrpc: "2.0", id: item.id, result: RESULT }));
  for (const mode of ["cancel", "deadline", "live", "source", "quota", "unhandled"] as const) {
    for (const reverse of [false, true]) {
      await pendingCase(`adaptive mixed ${mode} response reverse=${reverse} preserves sibling and fatal boundaries`, async ({ state, backend, release }) => {
        const scheduler = new RethTransportScheduler({ capacity: 5, producerReserved: 1, retryDelayMs: 5 });
        let notices = 0;
        const b = backend({ retryRpcThrottle: mode !== "unhandled", maxBatchSize: 4, maxConcurrentBatches: 4,
          transportScheduler: scheduler, onRpcThrottle: () => { notices++; }, onSourceUnavailable: () => { notices++; } });
        const first = { to: OK_A, data: "0xcafe", from: OK_B };
        const second = { to: OK_B, data: "0xbeef", from: OK_A };
        const error = mode === "source" ? SOURCE_ERROR : mode === "quota"
          ? { code: 429, message: "Monthly compute units quota exhausted" } : limited;
        state.pauseResponses = true;
        state.replyBatch = items => {
          const body = items.map(item => state.batches.length === 1 &&
            (item.params as [{ to: string }])[0].to === second.to
            ? { jsonrpc: "2.0", id: item.id, error }
            : { jsonrpc: "2.0", id: item.id, result: RESULT });
          return { status: 200, body: reverse ? body.reverse() : body };
        };
        const controller = new AbortController();
        const healthy = observe(b.call(first));
        const sibling = observe(b.call(second, mode === "deadline"
          ? { deadlineAtMs: Date.now() + 100 } : { signal: controller.signal }));
        await until(() => state.heldResponses.length === 1, "mixed response held on wire");
        if (mode !== "live") {
          if (mode !== "deadline") controller.abort(new Error("sibling no longer needed"));
          aborted(await sibling, mode === "deadline" ? "deadline" : "signal");
        }
        state.pauseResponses = false;
        release();
        const healthyResult = await healthy;
        const fatal = mode === "source" || mode === "quota" || mode === "unhandled";
        if (fatal) check.equal(healthyResult.status, "rejected");
        else check.deepEqual(healthyResult, { status: "fulfilled", value: RESULT });
        if (mode === "live") check.deepEqual(await sibling, { status: "fulfilled", value: RESULT });
        await b.drain();
        check.equal(notices, fatal ? 1 : 0);
        check.equal(state.batches.length, mode === "live" ? 2 : 1);
        check.deepEqual(state.batches[0]!.map(item => item.params), [first, second].map(req =>
          [req, { blockHash: HASH, requireCanonical: true }]));
        if (mode === "live") check.deepEqual(state.batches[1], [state.batches[0]![1]]);
        check.equal(b.stats().throttleRetries, mode === "live" ? 1 : 0);
        check.equal(b.stats().timeoutRetries, 0);
        check.equal(scheduler.snapshot().reductionVersion, mode === "live" ? 1 : 0,
          "abandoned recoverable errors and fatal errors must not lower shared load");
        check.equal(b.stats().currentConcurrentBatchLimit, mode === "live" ? 2 : 4);
        check.equal(b.stats().currentBatchSizeLimit, mode === "live" ? 2 : 4);
        check.equal(state.singles.length, 0);
        check.equal(b.stats().pendingItems, 0);
        check.equal(b.stats().liveItems, 0);
        check.equal(b.stats().activeTransports, 0);
        check.equal(scheduler.snapshot().activeTotal, 0);
        check.deepEqual(scheduler.snapshot().queuedByLane,
          { "producer-critical": 0, "producer-bulk": 0, exact: 0, discovery: 0 });
      });
    }
  }
  await pendingCase("adaptive mixed response retries only throttled item, preserving pin and sender", async ({ state, backend }) => {
    const b = backend({ retryRpcThrottle: true, maxConcurrentBatches: 4 });
    state.replyBatch = items => ({ status: 200, body: items.map(item => state.batches.length === 1 && item.id === 2
      ? { jsonrpc: "2.0", id: item.id, error: limited }
      : { jsonrpc: "2.0", id: item.id, result: RESULT }) });
    const first = { to: OK_A, data: "0xcafe", from: OK_B };
    const second = { to: OK_B, data: "0xbeef", from: OK_A };
    const warnings: string[] = [], warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); warn(...args); };
    try {
      check.deepEqual(await Promise.all([b.call(first), b.call(second)]), [RESULT, RESULT]);
    } finally { console.warn = warn; }
    check.ok(warnings.some(line => /^\[pinned-reth-quote-backend\] rpc-throttle-retry status=429 concurrency=\d+->\d+ retry_at_one=[0-3]\/3 delay_ms=(1000|2000|4000) items=\d+$/.test(line)),
      "handled 429 marker must remain compatible with the historical fatal guard");
    await b.drain();
    check.equal(state.batches.length, 2);
    check.deepEqual(state.batches[1], [state.batches[0]![1]]);
    check.deepEqual(state.batches[1]![0]!.params, [second, { blockHash: HASH, requireCanonical: true }]);
    check.equal(b.stats().currentConcurrentBatchLimit, 2);
    check.equal(b.stats().throttleRetries, 1);
    check.equal(await b.call(first), RESULT);
    check.equal(state.batches.length, 2);
    check.equal(state.singles.length, 0);
  });
  await pendingCase("adaptive HTTP and whole-envelope RPC limits recover through reduced pump", async ({ state, backend }) => {
    const b = backend({ retryRpcThrottle: true, maxConcurrentBatches: 4, deadlineAtMs: Date.now() + 10_000 });
    const limits: number[] = [], times: number[] = [];
    state.replyBatch = items => {
      limits.push(b.stats().currentConcurrentBatchLimit); times.push(Date.now());
      return state.batches.length <= 2
        ? { status: state.batches.length === 1 ? 429 : 200, body: { error: limited } }
        : { status: 200, body: results(items) };
    };
    check.equal(await b.call({ to: OK_A, data: "0xcafe" }), RESULT);
    check.deepEqual(limits, [4, 2, 1]);
    check.ok(times[1]! - times[0]! >= 900 && times[2]! - times[1]! >= 900);
    check.equal(state.singles.length, 0);
  });
  await pendingCase("adaptive concurrent failures reduce later physical dispatch without consuming floor retries", async ({ state, backend, release }) => {
    state.pauseResponses = true;
    const scheduler = new RethTransportScheduler({ capacity: 5, producerReserved: 1 });
    const b = backend({ retryRpcThrottle: true, maxBatchSize: 1, maxConcurrentBatches: 4,
      transportScheduler: scheduler, deadlineAtMs: Date.now() + 10_000 });
    state.replyBatch = items => ({ status: 200, body: state.pauseResponses
      ? items.map(item => ({ id: item.id, error: limited })) : results(items) });
    const work = Promise.all(Array.from({ length: 8 }, (_, i) => b.call({ to: OK_A, data: `0x${i.toString(16).padStart(2, "0")}` })));
    await until(() => state.heldResponses.length === 4, "four initial physical batches");
    release();
    await until(() => b.stats().throttleRetries === 4, "initial failure wave queued");
    check.equal(state.batches.length, 4);
    check.equal(b.stats().currentConcurrentBatchLimit, 2, "one shared tier per original in-flight failure wave");
    state.maxActiveBatches = 0; state.pauseResponses = false; state.holdResponses = true;
    check.deepEqual(await work, Array(8).fill(RESULT));
    await b.drain();
    check.equal(state.maxActiveBatches, 1);
    check.equal(state.singles.length, 0);
    check.equal(scheduler.snapshot().activeTotal, 0);
  });
  await pendingCase("adaptive backoff also bars batches already waiting for a shared permit", async ({ state, backend }) => {
    const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1 });
    const b = backend({ retryRpcThrottle: true, maxBatchSize: 1, maxConcurrentBatches: 4, transportScheduler: scheduler });
    const times: number[] = [];
    state.replyBatch = items => {
      times.push(Date.now());
      return { status: 200, body: state.batches.length === 1
        ? items.map(item => ({ id: item.id, error: limited })) : results(items) };
    };
    check.deepEqual(await Promise.all(Array.from({ length: 4 }, (_, i) =>
      b.call({ to: OK_A, data: `0x${i.toString(16).padStart(2, "0")}` }))), Array(4).fill(RESULT));
    await b.drain();
    check.ok(times[1]! - times[0]! >= 900, "scheduler-queued work bypassed cooldown");
    check.equal(state.batches.length, 5);
    check.equal(scheduler.snapshot().activeTotal, 0);
  });
  await pendingCase("adaptive floor stops after three retries, not infinite or single-call fallback", async ({ state, backend }) => {
    const notified: Error[] = [];
    state.replyBatch = items => ({ status: 200, body: items.map(item => ({ id: item.id, error: limited })) });
    const b = backend({ retryRpcThrottle: true, maxConcurrentBatches: 4, allowSingleCallFallback: true,
      deadlineAtMs: Date.now() + 20_000, onRpcThrottle: error => { notified.push(error); } });
    await check.rejects(b.call({ to: OK_A, data: "0xcafe" }), isRpcThrottleError);
    await b.closeAndDrain();
    check.equal(state.batches.length, 6); // at four, at two, then initial + three retries at one
    check.equal(b.stats().throttleRetries, 5);
    check.equal(notified.length, 1);
    check.equal(state.singles.length, 0);
    check.equal(b.stats().liveItems, 0);
    check.equal(b.stats().activeTransports, 0);
  });
  for (const reason of ["caller", "deadline", "scope"] as const) {
    await pendingCase(`adaptive ${reason} cancellation during backoff drains without another request`, async ({ state, backend }) => {
      const controller = new AbortController();
      state.replyBatch = () => ({ status: 429, body: { error: limited } });
      const b = backend({ retryRpcThrottle: true, maxConcurrentBatches: 4 });
      const work = observe(b.call({ to: OK_A, data: "0xcafe" }, reason === "deadline"
        ? { deadlineAtMs: Date.now() + 300 } : { signal: controller.signal }));
      await until(() => b.stats().throttleRetries === 1, "retry queued");
      if (reason === "caller") controller.abort();
      if (reason === "scope") await b.closeAndDrain();
      aborted(await work, reason === "deadline" ? "deadline" : "signal");
      await b.closeAndDrain();
      check.equal(state.batches.length, 1);
      check.equal(b.stats().liveItems, 0);
      check.equal(b.stats().pendingItems, 0);
    });
  }
  for (const revert of [{ code: 3 }, { code: "CALL_EXCEPTION" }, { code: -32000, data: "0x1234" }]) {
    await pendingCase(`adaptive HTTP429 keeps nested revert exclusions ${revert.code}`, async ({ state, backend }) => {
      let stops = 0;
      const b = backend({ retryRpcThrottle: true, onRpcThrottle: () => { stops++; } });
      state.replyBatch = items => state.batches.length === 1
        ? { status: 429, body: { error: { ...revert, message: "execution reverted: account quota exhausted" } } }
        : { status: 200, body: results(items) };
      check.equal(await b.call({ to: OK_A, data: "0xcafe" }), RESULT);
      check.equal(state.batches.length, 2);
      check.equal(b.stats().throttleRetries, 1);
      check.equal(stops, 0);
    });
  }
  for (const kind of ["quota", "source", "revert"] as const) {
    await pendingCase(`adaptive ${kind} is not retried`, async ({ state, backend }) => {
      const scheduler = new RethTransportScheduler({ capacity: 5, producerReserved: 1 });
      const b = backend({ retryRpcThrottle: true, transportScheduler: scheduler });
      state.replyBatch = items => ({ status: kind === "quota" ? 429 : 200, body: kind === "quota"
        ? { error: { code: 429, message: "Monthly compute units quota exhausted" } }
        : items.map(item => ({ id: item.id, error: kind === "source" ? SOURCE_ERROR
          : { code: 3, message: "execution reverted: HTTP429 quota exhausted", data: REVERT_DATA } })) });
      await check.rejects(b.call({ to: OK_A, data: "0xcafe" }));
      await b.closeAndDrain();
      check.equal(state.batches.length, 1);
      check.equal(b.stats().throttleRetries, 0);
      check.equal(b.stats().timeoutRetries, 0);
      check.equal(scheduler.snapshot().reductionVersion, 0);
    });
  }
}

async function sharedTimeoutTests(): Promise<void> {
  const response = (items: Array<Record<string, unknown>>) => ({ status: 200,
    body: items.map(item => ({ jsonrpc: "2.0", id: item.id, result: RESULT })) });
  const empty = (scheduler: RethTransportScheduler): void => {
    check.equal(scheduler.snapshot().activeTotal, 0);
    check.deepEqual(scheduler.snapshot().queuedByLane, { "producer-critical": 0, "producer-bulk": 0, exact: 0, discovery: 0 });
  };
  for (const kind of ["http429", "rpc429"] as const) {
    await pendingCase(`single ${kind} remains fatal with retryRpcThrottle=true`, async ({ state, backend }) => {
      const scheduler = new RethTransportScheduler({ capacity: 5, producerReserved: 1, retryDelayMs: 5 });
      let notices = 0;
      const client = backend({ transportScheduler: scheduler, retryRpcThrottle: true, onRpcThrottle: () => { notices++; } });
      if (kind === "http429") state.httpStatus = 429;
      state.rpcError = { code: 429, message: "rate limited" };
      const internal = client as unknown as { rpcSingle(method: string, params: readonly unknown[], label: string, control: StateCallControl): Promise<unknown> };
      await check.rejects(internal.rpcSingle("eth_call", [{ to: REVERT, data: "0x01" }, { blockHash: HASH, requireCanonical: true }], REVERT, {}), isRpcThrottleError);
      await client.closeAndDrain(); check.equal(state.singles.length, 1);
      check.equal(notices, 1); check.equal(client.stats().throttleRetries, 0);
      check.equal(scheduler.snapshot().reductionVersion, 0); empty(scheduler);
    });
  }
  await pendingCase("shared wire timeout rebatches old peers and new generation through run-only wrapper", async ({ state, backend }) => {
    const scheduler = new RethTransportScheduler({ capacity: 4, producerReserved: 3, transportTimeoutMs: 80, retryDelayMs: 30 });
    const wrapper: Pick<RethTransportScheduler, "run"> = { run: (lane, signal, work) => scheduler.run(lane, signal, work) };
    const options = { maxBatchSize: 4, maxConcurrentBatches: 4, transportScheduler: wrapper };
    const first = backend(options), peer = backend(options);
    state.pauseResponses = true;
    const requests = Array.from({ length: 4 }, (_, i) => ({ to: OK_A, from: OK_B, data: `0x10${i}0` }));
    const firstWork = observe(Promise.all(requests.map(req => first.call(req))));
    await until(() => state.heldResponses.length === 1, "first physical batch held");
    const cancel = new AbortController();
    const peerWork = Array.from({ length: 8 }, (_, i) => observe(peer.call({ to: OK_B, data: `0x20${i}0` }, i === 0 ? { signal: cancel.signal } : {})));
    await until(() => scheduler.snapshot().queuedByLane.exact === 2, "old peer envelopes queued");
    cancel.abort(new Error("cancel queued item"));
    await until(() => first.stats().timeoutRetries === 1, "physical timeout reported");
    check.equal(scheduler.snapshot().capacity, 2);
    check.equal(scheduler.snapshot().reductionVersion, 1);
    check.equal(state.batches.length, 1, "failure did not bar queued sends before release");
    state.pauseResponses = false;
    check.equal((await firstWork).status, "fulfilled");
    const peers = await Promise.all(peerWork);
    aborted(peers[0]!); check.ok(peers.slice(1).every(item => item.status === "fulfilled"));
    await Promise.all([first.drain(), peer.drain()]);
    check.equal(first.stats().currentBatchSizeLimit, 2); check.equal(peer.stats().currentConcurrentBatchLimit, 2);
    check.ok(state.batches.slice(1).every(batch => batch.length <= 2));
    check.equal(state.batches.slice(1).flat().some(item => (item.params as any[])[0].data === "0x2000"), false);
    for (const original of state.batches[0]!) {
      check.equal(state.batches.slice(1).flat().filter(item => JSON.stringify(item) === JSON.stringify(original)).length, 1,
        "retry changed physical id/params/hash or repeated a successful item");
    }
    const successorHash = `0x${"cd".repeat(32)}`, start = state.batches.length;
    const successor = backend(options, successorHash);
    check.deepEqual(await Promise.all(requests.map(req => successor.call(req))), Array(4).fill(RESULT));
    await successor.drain();
    check.ok(state.batches.slice(start).every(batch => batch.length <= 2));
    for (const item of state.batches.slice(start).flat()) check.deepEqual((item.params as any[])[1], { blockHash: successorHash, requireCanonical: true });
    check.equal(successor.stats().currentConcurrentBatchLimit, 2);
    check.equal(state.singles.length, 0); empty(scheduler);
  });
  await pendingCase("tiny preassembled envelopes cannot bypass reduced owner limit under large shared cap", async ({ state, backend }) => {
    const scheduler = new RethTransportScheduler({ capacity: 20, producerReserved: 1, retryDelayMs: 20 });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let load!: NonNullable<import("../reth-transport-scheduler.js").RethTransportLease["load"]>;
    const holders = Array.from({ length: 19 }, () => scheduler.run("exact", new AbortController().signal, async lease => {
      load = lease.load!; await held;
    }));
    const client = backend({ maxBatchSize: 1, maxConcurrentBatches: 4, transportScheduler: scheduler });
    const work = observe(Promise.all(Array.from({ length: 8 }, (_, i) => client.call({ to: OK_A, data: `0x30${i}0` }))));
    try {
      await until(() => scheduler.snapshot().queuedByLane.exact === 4, "four preassembled owner envelopes");
      check.equal(load.retry(new StateCallAbortedError("simulated physical failure of a held permit", "timeout"), [{}], load.limits(1, 4)), true);
      state.holdResponses = true; state.replyBatch = response;
      release(); await Promise.all(holders);
      check.equal((await work).status, "fulfilled"); await client.drain();
      check.equal(scheduler.snapshot().capacity, 10);
      check.equal(state.maxActiveBatches, 2, "old scheduled limit bypassed per-owner reduction");
      check.equal(state.batches.length, 8); empty(scheduler);
    } finally { release(); await Promise.allSettled(holders); }
  });
  for (const single of [false, true]) {
    await pendingCase(`permit waiting is not wire timeout (single=${single})`, async ({ state, backend }) => {
      const scheduler = new RethTransportScheduler({ capacity: 2, producerReserved: 1, transportTimeoutMs: 40, retryDelayMs: 5 });
      let release!: () => void;
      const blocker = scheduler.run("exact", new AbortController().signal, () => new Promise<void>(resolve => { release = resolve; }));
      const client = backend({ transportScheduler: scheduler });
      const internal = client as unknown as { rpcSingle(method: string, params: readonly unknown[], label: string, control: StateCallControl): Promise<unknown> };
      const work = observe(single ? internal.rpcSingle("eth_getCode", [OK_A, { blockHash: HASH, requireCanonical: true }], OK_A, {})
        : client.call({ to: OK_A, data: "0xabcd" }));
      try {
        await until(() => scheduler.snapshot().queuedByLane.exact === 1, "request waiting for permit");
        await new Promise(resolve => setTimeout(resolve, 90));
        check.equal(state.batches.length + state.singles.length, 0);
        check.equal(client.stats().timeoutRetries, 0); check.equal(scheduler.snapshot().reductionVersion, 0);
        release(); await blocker;
        check.deepEqual(await work, { status: "fulfilled", value: RESULT }); await client.drain(); empty(scheduler);
      } finally { release(); await blocker; }
    });
    await pendingCase(`physical timeout exhaustion retains typed error and no fallback (single=${single})`, async ({ state, backend }) => {
      const scheduler = new RethTransportScheduler({ capacity: 3, producerReserved: 1, transportTimeoutMs: 25, retryDelayMs: 5 });
      const client = backend({ maxConcurrentBatches: 1, allowSingleCallFallback: true, transportScheduler: scheduler });
      state.pauseResponses = true;
      const internal = client as unknown as { rpcSingle(method: string, params: readonly unknown[], label: string, control: StateCallControl): Promise<unknown> };
      const result = await observe(single ? internal.rpcSingle("eth_getCode", [OK_A, { blockHash: HASH, requireCanonical: true }], OK_A, {})
        : client.call({ to: OK_A, data: "0xabcd" }));
      check.equal(result.status, "rejected");
      if (result.status === "rejected") {
        check.ok(isStateCallAbortedError(result.reason)); check.equal(result.reason.kind, "timeout");
      }
      await client.closeAndDrain();
      check.equal(client.stats().timeoutRetries, 3);
      check.equal(state.batches.length, single ? 0 : 4); check.equal(state.singles.length, single ? 4 : 0);
      check.equal(client.stats().singleCallFallbacks, 0); empty(scheduler);
    });
  }
  for (const mode of ["caller", "deadline", "scope", "head", "timeout-reason"] as const) {
    await pendingCase(`logical ${mode} cannot reduce load or retry`, async ({ state, backend }) => {
      const scheduler = new RethTransportScheduler({ capacity: 5, producerReserved: 1, transportTimeoutMs: 150, retryDelayMs: 5 });
      const caller = new AbortController(), scope = new AbortController();
      const client = backend({ transportScheduler: scheduler, signal: scope.signal, retryRpcThrottle: true });
      state.pauseResponses = true;
      const work = observe(client.call({ to: OK_A, data: "0xabcd" }, mode === "deadline"
        ? { deadlineAtMs: Date.now() + 50 } : { signal: caller.signal }));
      await until(() => state.heldResponses.length === 1, "logical cancellation wire active");
      if (mode === "caller") caller.abort();
      if (mode === "scope") await client.closeAndDrain();
      if (mode === "head") scope.abort(new Error("head superseded"));
      if (mode === "timeout-reason") caller.abort(new StateCallAbortedError("caller logical timeout", "timeout"));
      aborted(await work); await client.closeAndDrain();
      check.equal(state.batches.length, 1); check.equal(client.stats().timeoutRetries, 0);
      check.equal(scheduler.snapshot().reductionVersion, 0); empty(scheduler);
    });
  }
  await pendingCase("old fake scheduler without load remains compatible", async ({ backend }) => {
    const fake: Pick<RethTransportScheduler, "run"> = { run: (_lane, _signal, work) => work({
      queueWaitMs: 0, activeTotal: 1, activeByLane: { "producer-critical": 0, "producer-bulk": 0, exact: 1, discovery: 0 },
    }) };
    const client = backend({ transportScheduler: fake });
    check.equal(await client.call({ to: OK_A, data: "0x01" }), RESULT); await client.drain();
  });
}

async function latencyDiagnosticTests(): Promise<void> {
  const marker = "[searcher/quote-batch-timing] ";
  const capture = async (
    flag: string | undefined,
    throwOnLog: boolean,
    work: (records: Array<Record<string, unknown>>) => Promise<void>,
  ): Promise<void> => {
    const previousFlag = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    const previousLog = console.log;
    const records: Array<Record<string, unknown>> = [];
    if (flag === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = flag;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] !== "string" || !args[0].startsWith(marker)) {
        previousLog(...args);
        return;
      }
      records.push(JSON.parse(args[0].slice(marker.length)) as Record<string, unknown>);
      if (throwOnLog) throw new Error("diagnostic logger failure");
    };
    try {
      await work(records);
    } finally {
      console.log = previousLog;
      if (previousFlag === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
      else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = previousFlag;
    }
  };
  for (const flag of [undefined, "0", "1"]) {
    for (const throwOnLog of flag === "1" ? [false, true] : [false]) {
      await pendingCase(`wire timing flag=${flag ?? "unset"} logger-throws=${throwOnLog}`,
        async ({ state, backend, rpcUrl }) => capture(flag, throwOnLog, async records => {
          const client = backend({ transportLane: "producer-bulk", scopeLabel: "diagnostic test" });
          const request = { to: OK_A, data: "0xfacefeed" };
          const startedAtMs = Date.now();
          check.deepEqual(await Promise.all([
            client.call(request), client.call(request), client.call({ to: OK_B, data: "0xabcdef" }),
          ]), [RESULT, RESULT, RESULT]);
          await client.closeAndDrain();
          check.equal(state.batches.length, 1);
          check.equal(state.batches[0]!.length, 2);
          check.equal(state.singles.length, 0);
          const stats = client.stats();
          check.equal(stats.totalCalls, 2);
          check.equal(stats.memoHits, 1);
          check.equal(stats.batchesSent, 1);
          check.equal(stats.batchedItems, 2);
          check.equal(stats.batchFailures, 0);
          check.equal(stats.singleCallFallbacks, 0);
          check.equal(records.length, flag === "1" ? 1 : 0);
          if (flag !== "1") return;
          const row = records[0]!;
          check.deepEqual(Object.keys(row).sort(), ["sourceBlockHash", "lane", "scopeLabel", "method",
            "items", "startedAtMs", "wallMs", "status", "statusCode"].sort());
          check.equal(row.sourceBlockHash, HASH);
          check.equal(row.lane, "producer-bulk");
          check.equal(row.scopeLabel, "diagnostic test");
          check.equal(row.method, "eth_call");
          check.equal(row.items, 2);
          check.equal(row.status, "returned");
          check.equal(row.statusCode, 200);
          check.ok(typeof row.startedAtMs === "number" && row.startedAtMs >= startedAtMs);
          check.ok(typeof row.wallMs === "number" && row.wallMs >= 0);
          const serialized = JSON.stringify(records);
          for (const excluded of [rpcUrl, request.data, "0xabcdef", OK_A, OK_B, RESULT]) {
            check.ok(!serialized.includes(excluded), "timing must not expose RPC URL, call payload or returned body");
          }
        }));
    }
  }
  for (const throwOnLog of [false, true]) {
    await pendingCase(`wire timing preserves typed cancellation logger-throws=${throwOnLog}`,
      async ({ state, backend }) => capture("1", throwOnLog, async records => {
        state.pauseResponses = true;
        const scope = new AbortController();
        const client = backend({ signal: scope.signal });
        const pending = observe(client.call({ to: OK_A, data: "0xcafe" }));
        await until(() => state.heldResponses.length === 1, "diagnostic cancellation request reached wire");
        scope.abort(new Error("source superseded"));
        aborted(await pending);
        await client.closeAndDrain();
        check.equal(records.length, 1);
        check.equal(records[0]!.status, "transport-failed");
        check.equal(records[0]!.statusCode, null);
        check.equal(state.batches.length, 1);
        check.equal(state.singles.length, 0);
        check.equal(client.stats().totalCalls, 1);
        check.equal(client.stats().batchesSent, 1);
        check.equal(client.stats().timeoutRetries, 0);
        check.equal(client.stats().singleCallFallbacks, 0);
      }));
  }
}

async function run(): Promise<void> {
  const { server, state, port } = await startStub();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const tempDir = mkdtempSync(join(tmpdir(), "pinned-reth-cache-"));
  try {
    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH);
      const [a, b] = await Promise.all([
        backend.call({ to: OK_A, data: "0x01" }),
        backend.call({ to: OK_B, data: "0x02", from: "0x00000000000000000000000000000000000000d4" }),
      ]);
      assert(a === RESULT && b === RESULT, "coalesced call results");
      assert(state.batches.length === 1, "concurrent calls must form one batch");
      const batch = state.batches[0];
      assert(batch.length === 2, "batch carries both items");
      const withFrom = batch.find((entry) => {
        const item = entry as { params?: unknown[] };
        const tx = item.params?.[0] as { to?: unknown };
        return tx?.to === OK_B;
      }) as { params?: unknown[] } | undefined;
      const tx = withFrom?.params?.[0] as { from?: unknown } | undefined;
      assert(
        tx?.from === "0x00000000000000000000000000000000000000d4",
        "batch preserves per-item from",
      );
      console.log("[pinned-reth-quote-backend] coalescing: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH);
      let revertError: unknown = null;
      const good = backend.call({ to: OK_A, data: "0x01" });
      const bad = backend.call({ to: REVERT, data: "0x02" }).catch((error) => {
        revertError = error;
      });
      const [goodResult] = await Promise.all([good, bad]);
      assert(goodResult === RESULT, "non-reverting item resolves");
      assert(
        revertError !== null &&
          typeof revertError === "object" &&
          (revertError as { data?: unknown }).data === REVERT_DATA,
        "reverting item rejects with original revert data",
      );
      console.log("[pinned-reth-quote-backend] per-item revert data: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH);
      state.failNextBatch = true;
      const [a, b] = await Promise.all([
        backend.call({ to: OK_A, data: "0x01" }),
        backend.call({ to: OK_B, data: "0x02" }),
      ]);
      assert(a === RESULT && b === RESULT, "transport fallback results");
      assert(state.singles.length === 2, "failed batch falls back to one single call per item");
      console.log("[pinned-reth-quote-backend] transport fallback: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH);
      const batchesBefore = state.batches.length;
      const m1 = await backend.call({ to: OK_A, data: "0x01" });
      const m2 = await backend.call({ to: OK_A, data: "0x01" });
      assert(m1 === RESULT && m2 === RESULT, "memoized call results");
      assert(
        state.batches.length === batchesBefore + 1,
        "sequential duplicate calls must not issue a second request",
      );
      const stats = backend.stats();
      assert(stats.totalCalls === 1 && stats.memoHits === 1, "memo stats");
      console.log("[pinned-reth-quote-backend] call memoization: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH);
      const socketsBefore = state.requestSockets.length;
      await backend.call({ to: OK_A, data: "0x11" });
      await backend.call({ to: OK_A, data: "0x12" });
      await backend.closeAndDrain();
      const sockets = state.requestSockets.slice(socketsBefore);
      assert(sockets.length === 2, "keep-alive test issued two requests");
      assert(
        sockets[0] === sockets[1],
        "sequential JSON-RPC batches reuse one transport socket",
      );
      const stats = backend.stats();
      assert(
        stats.batchesOnReusedSocket >= 1 &&
          stats.batchesOnNewSocket + stats.batchesOnReusedSocket === 2,
        "keep-alive telemetry counts new and reused sockets",
      );
      console.log("[pinned-reth-quote-backend] transport keep-alive: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH);
      let error: unknown = null;
      await backend.call(
        { to: OK_A, data: "0x01" },
        { deadlineAtMs: Date.now() - 1 },
      ).catch((caught) => {
        error = caught;
      });
      assert(
        error !== null &&
          isStateCallAbortedError(error) &&
          (error as { kind?: string }).kind === "deadline",
        "expired deadline rejects with StateCallAbortedError",
      );
      const batchesBefore = state.batches.length;
      const singlesBefore = state.singles.length;
      await new Promise((resolve) => setImmediate(resolve));
      assert(
        state.batches.length === batchesBefore &&
          state.singles.length === singlesBefore,
        "expired item must not reach the transport",
      );
      console.log("[pinned-reth-quote-backend] deadline rejection: PASS");
    }

    {
      const controller = new AbortController();
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        signal: controller.signal,
      });
      state.holdResponses = true;
      const singlesBefore = state.singles.length;
      const socketsBefore = state.requestSockets.length;
      const pending = backend
        .call({ to: OK_A, data: "0x01" })
        .catch((error) => error);
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.abort(new Error("pass closed"));
      const error = await pending;
      assert(
        error !== null &&
          isStateCallAbortedError(error),
        "pass abort must reject the in-flight item",
      );
      await backend.closeAndDrain();
      const stats = backend.stats();
      assert(
        stats.liveItems === 0 &&
          stats.pendingItems === 0 &&
          stats.inFlightBatches === 0 &&
          stats.activeTransports === 0,
        "closeAndDrain must clear pending/live/in-flight transports",
      );
      assert(
        state.singles.length === singlesBefore,
        "pass abort must never trigger single-call fallback",
      );
      assert(stats.abortedBatches >= 1, "aborted batch must be counted");
      state.holdResponses = false;
      const abortedSocket = state.requestSockets[socketsBefore];
      const recovery = new PinnedRethQuoteBackend(rpcUrl, HASH);
      assert(
        await recovery.call({ to: OK_A, data: "0x21" }) === RESULT,
        "request after abort recovers",
      );
      await recovery.closeAndDrain();
      assert(
        state.requestSockets.at(-1) !== abortedSocket,
        "aborted transport socket is not returned to the keep-alive pool",
      );
      console.log("[pinned-reth-quote-backend] pass abort + drain: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        maxBatchSize: 128,
        maxConcurrentBatches: 4,
        transportLane: "producer-bulk",
        scopeLabel: "producer-bulk test",
        allowSingleCallFallback: false,
      });
      const batchesBefore = state.batches.length;
      state.holdResponses = true;
      const results = await Promise.all(Array.from({ length: 300 }, (_, index) =>
        backend.call({
          to: OK_A,
          data: `0x${(index + 1).toString(16).padStart(4, "0")}`,
        })
      ));
      assert(
        results.every((result) => result === RESULT),
        "producer-bulk concurrent batch results",
      );
      const batches = state.batches.slice(batchesBefore);
      assert(
        batches.length === 3 &&
          batches.map((batch) => batch.length).sort((a, b) => a - b)
            .join(",") === "44,128,128",
        "producer-bulk uses 128-item physical batches",
      );
      assert(
        state.maxActiveBatches >= 3 && state.maxActiveBatches <= 4,
        "producer-bulk honors concurrent batch bound",
      );
      const stats = backend.stats();
      assert(
        stats.lane === "producer-bulk" &&
          stats.allowSingleCallFallback === false &&
          stats.batchesSent === 3 &&
          stats.batchedItems === 300 &&
          stats.singleCallFallbacks === 0,
        "producer-bulk stats",
      );
      await backend.closeAndDrain();
      state.holdResponses = false;
      console.log("[pinned-reth-quote-backend] producer-bulk batching: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        maxBatchSize: 64,
        maxConcurrentBatches: 16,
        transportLane: "exact",
        scopeLabel: "wide exact test",
      });
      const batchesBefore = state.batches.length;
      state.maxActiveBatches = 0;
      state.holdResponses = true;
      const results = await Promise.all(Array.from({ length: 512 }, (_, index) =>
        backend.call({
          to: OK_A,
          data: `0x${(index + 1).toString(16).padStart(4, "0")}`,
        })
      ));
      assert(
        results.every((result) => result === RESULT),
        "wide exact concurrent batch results",
      );
      const batches = state.batches.slice(batchesBefore);
      const stats = backend.stats();
      assert(
        batches.length === 8 &&
          batches.every((batch) => batch.length === 64),
        "wide exact uses eight full 64-item batches",
      );
      assert(
        state.maxActiveBatches === 8 &&
          stats.peakInFlightBatches === 8 &&
          stats.maxBatchItemsSent === 64,
        "wide exact telemetry reports actual physical fan-out",
      );
      await backend.closeAndDrain();
      state.holdResponses = false;
      console.log("[pinned-reth-quote-backend] wide exact batching: PASS");
    }

    {
      const backend = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        maxBatchSize: 128,
        maxConcurrentBatches: 4,
        transportLane: "producer-bulk",
        scopeLabel: "producer-bulk failure test",
        allowSingleCallFallback: false,
      });
      state.failNextBatch = true;
      const singlesBefore = state.singles.length;
      const settled = await Promise.all([
        backend.call({ to: OK_A, data: "0x31" }).then(
          () => null,
          (error) => error,
        ),
        backend.call({ to: OK_B, data: "0x32" }).then(
          () => null,
          (error) => error,
        ),
      ]);
      assert(
        settled.every((error) => error instanceof Error),
        "producer-bulk failed batch rejects every item",
      );
      const stats = backend.stats();
      assert(
        stats.batchFailures === 1 &&
          stats.singleCallFallbacks === 0 &&
          state.singles.length === singlesBefore,
        "producer-bulk failure must not add single-call fallback requests",
      );
      await backend.closeAndDrain();
      console.log("[pinned-reth-quote-backend] producer-bulk failure policy: PASS");
    }

    {
      const cachePath = join(tempDir, "calls.jsonl");
      const request = { to: OK_A, data: "0xcafe" };
      const upstreamBefore = state.batches.length + state.singles.length;
      const first = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        persistentEthCallCachePath: cachePath,
      });
      assert(await first.call(request) === RESULT, "persistent first result");
      await first.closeAndDrain();
      const firstStats = first.stats();
      assert(
        firstStats.persistentCacheWrites === 1 &&
          firstStats.persistentCacheEntries === 1,
        "persistent first run writes one entry",
      );
      const upstreamAfterFirst = state.batches.length + state.singles.length;
      assert(
        upstreamAfterFirst === upstreamBefore + 1,
        "persistent first run reaches upstream",
      );

      const second = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        persistentEthCallCachePath: cachePath,
      });
      assert(await second.call(request) === RESULT, "persistent second result");
      await second.closeAndDrain();
      const secondStats = second.stats();
      assert(
        state.batches.length + state.singles.length === upstreamAfterFirst,
        "persistent second run makes zero upstream calls",
      );
      assert(
        secondStats.persistentCacheHits === 1 &&
          secondStats.persistentCacheWrites === 0,
        "persistent second run reports a durable hit",
      );

      let sourceMismatch: unknown = null;
      try {
        new PinnedRethQuoteBackend(rpcUrl, "0x" + "cd".repeat(32), {
          persistentEthCallCachePath: cachePath,
        });
      } catch (error) {
        sourceMismatch = error;
      }
      assert(
        sourceMismatch instanceof Error &&
          /different source hash/.test(sourceMismatch.message),
        "persistent cache rejects a different source hash",
      );

      const original = readFileSync(cachePath, "utf8");
      const corruptPath = join(tempDir, "corrupt.jsonl");
      writeFileSync(corruptPath, original, { mode: 0o600 });
      appendFileSync(corruptPath, '{"bad":true}\n');
      let corruption: unknown = null;
      try {
        new PinnedRethQuoteBackend(rpcUrl, HASH, {
          persistentEthCallCachePath: corruptPath,
        });
      } catch (error) {
        corruption = error;
      }
      assert(
        corruption instanceof Error &&
          /unexpected fields/.test(corruption.message),
        "persistent cache rejects a complete invalid row",
      );

      const conflictPath = join(tempDir, "conflict.jsonl");
      writeFileSync(conflictPath, original, { mode: 0o600 });
      const entry = JSON.parse(original.trimEnd().split("\n")[1]!) as
        Record<string, unknown>;
      entry.result = "0x" + "22".repeat(32);
      entry.entrySha256 = createHash("sha256").update(JSON.stringify([
        entry.schemaVersion,
        entry.profile,
        entry.sourceBlockHash,
        entry.target,
        entry.calldata,
        entry.caller,
        entry.key,
        entry.result,
      ])).digest("hex");
      appendFileSync(conflictPath, `${JSON.stringify(entry)}\n`);
      let conflict: unknown = null;
      try {
        new PinnedRethQuoteBackend(rpcUrl, HASH, {
          persistentEthCallCachePath: conflictPath,
        });
      } catch (error) {
        conflict = error;
      }
      assert(
        conflict instanceof Error &&
          /conflicting row/.test(conflict.message),
        "persistent cache rejects conflicting results",
      );

      const truncatedPath = join(tempDir, "truncated.jsonl");
      writeFileSync(truncatedPath, original, { mode: 0o600 });
      appendFileSync(truncatedPath, '{"partial"');
      const truncated = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        persistentEthCallCachePath: truncatedPath,
      });
      const upstreamBeforeTruncated =
        state.batches.length + state.singles.length;
      assert(
        await truncated.call(request) === RESULT,
        "truncated final row preserves complete entries",
      );
      const newRequest = { to: OK_B, data: "0xbeef" };
      assert(
        await truncated.call(newRequest) === RESULT,
        "truncated cache accepts a new upstream result after repair",
      );
      await truncated.closeAndDrain();
      assert(
        state.batches.length + state.singles.length ===
          upstreamBeforeTruncated + 1,
        "truncated final row permits hits and only one new upstream call",
      );
      const reopened = new PinnedRethQuoteBackend(rpcUrl, HASH, {
        persistentEthCallCachePath: truncatedPath,
      });
      const upstreamBeforeReopen =
        state.batches.length + state.singles.length;
      assert(await reopened.call(request) === RESULT, "reopened old result");
      assert(await reopened.call(newRequest) === RESULT, "reopened new result");
      await reopened.closeAndDrain();
      assert(
        state.batches.length + state.singles.length === upstreamBeforeReopen,
        "repaired cache remains valid and serves both rows",
      );
      console.log(
        "[pinned-reth-quote-backend] persistent replay cache: PASS",
      );
    }
    await pendingCallTests();
    await adaptiveRetryTests();
    await sharedTimeoutTests();
    await latencyDiagnosticTests();
  } finally {
    server.close();
    await once(server, "close").catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().then(
  () => {
    console.log("pinned-reth-quote-backend PASS");
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
