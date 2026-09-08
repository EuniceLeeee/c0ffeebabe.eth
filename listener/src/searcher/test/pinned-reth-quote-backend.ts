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
} from "../../shared/state/state-backend.js";
import {
  PinnedRethQuoteBackend,
  type PinnedRethQuoteBackendOptions,
} from "../pinned-reth-quote-backend.js";

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
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
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
        state.maxActiveBatches = Math.max(
          state.maxActiveBatches,
          state.activeBatches,
        );
        maybeHold(() => {
          state.activeBatches--;
          reply(body.map((entry) => {
              const item = entry as { id?: unknown; params?: unknown[] };
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
      const single = body as { id?: unknown };
      state.singles.push(single);
      maybeHold(() =>
        reply({ jsonrpc: "2.0", id: single.id, result: RESULT }),
      );
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
