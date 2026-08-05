/**
 * Deterministic PinnedRethQuoteBackend tests against a local HTTP stub:
 * coalescing, per-item revert data, transport-level single-call fallback and
 * per-item deadline rejection. No real reth or anvil involved.
 */

import { createServer, type Server } from "node:http";
import { once } from "node:events";
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
}

function startStub(): Promise<{ server: Server; state: StubState; port: number }> {
  const state: StubState = { batches: [], singles: [], failNextBatch: false };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      const reply = (payload: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (Array.isArray(body)) {
        if (state.failNextBatch) {
          state.failNextBatch = false;
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        state.batches.push(body);
        reply(body.map((entry) => {
          const item = entry as { id?: unknown; params?: unknown[] };
          const tx = Array.isArray(item.params)
            ? item.params[0] as { to?: unknown }
            : null;
          if (tx?.to === REVERT) {
            return {
              jsonrpc: "2.0",
              id: item.id,
              error: { code: 3, message: "execution reverted", data: REVERT_DATA },
            };
          }
          return { jsonrpc: "2.0", id: item.id, result: RESULT };
        }));
        return;
      }
      const single = body as { id?: unknown };
      state.singles.push(single);
      reply({ jsonrpc: "2.0", id: single.id, result: RESULT });
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
  } finally {
    server.close();
    await once(server, "close").catch(() => undefined);
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
