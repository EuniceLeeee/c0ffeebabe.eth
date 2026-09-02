/**
 * Deterministic PinnedRethQuoteBackend tests against a local HTTP stub:
 * coalescing, per-item revert data, transport-level single-call fallback and
 * per-item deadline rejection. No real reth or anvil involved.
 */

import { createHash } from "node:crypto";
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
import { PinnedRethQuoteBackend } from "../pinned-reth-quote-backend.js";

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
  failNextBatch: boolean;
  failAllBatches: boolean;
  holdResponses: boolean;
  activeBatches: number;
  maxActiveBatches: number;
}

function startStub(): Promise<{ server: Server; state: StubState; port: number }> {
  const state: StubState = {
    batches: [],
    singles: [],
    failNextBatch: false,
    failAllBatches: false,
    holdResponses: false,
    activeBatches: 0,
    maxActiveBatches: 0,
  };
  const server = createServer((req, res) => {
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
        if (state.holdResponses) {
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
