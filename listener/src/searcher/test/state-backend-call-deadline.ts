import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";

const HANG_DATA = "0x12345678";
const REVERT_DATA = "0xdeadbeef";
let requestsReceived = 0;
let activeResponses = 0;
let abortedResponses = 0;

const server = createServer((request, response) => {
  requestsReceived++;
  activeResponses++;
  trackResponse(response);

  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      params: Array<{ data?: string }>;
    };
    if (parsed.params[0]?.data === REVERT_DATA) {
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: 3, message: "execution reverted", data: REVERT_DATA },
      });
      return;
    }

    // A frozen implementation, which only rejects a wrapper Promise, receives
    // this response later. The corrected transport closes the socket first.
    const timer = setTimeout(() => {
      if (!response.destroyed) {
        respond(response, { jsonrpc: "2.0", id: parsed.id, result: "0x" });
      }
    }, 250);
    timer.unref();
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const backend = new AnvilStateBackend(
  "http://127.0.0.1:1",
  `http://127.0.0.1:${address.port}`,
  address.port,
);
const controlledCall = backend.call.bind(backend) as (
  req: { to: string; data: string; from?: string },
  control: { deadlineAtMs?: number; signal?: AbortSignal },
) => Promise<string>;

try {
  const startedAt = Date.now();
  await assert.rejects(
    controlledCall(
      { to: "0x0000000000000000000000000000000000000001", data: HANG_DATA },
      { deadlineAtMs: startedAt + 60 },
    ),
    (error: unknown) => isDeadlineCancellation(error),
    "deadline-bound eth_call must reject with a typed deadline cancellation",
  );
  assert(Date.now() - startedAt < 500, "deadline-bound eth_call must not wait for the late response");
  await waitUntil(() => abortedResponses === 1 && activeResponses === 0, 500);

  const beforeExpired = requestsReceived;
  await assert.rejects(
    controlledCall(
      { to: "0x0000000000000000000000000000000000000001", data: HANG_DATA },
      { deadlineAtMs: Date.now() - 1 },
    ),
    (error: unknown) => isDeadlineCancellation(error),
  );
  assert.equal(requestsReceived, beforeExpired, "a past absolute deadline must not start HTTP");

  await assert.rejects(
    controlledCall(
      { to: "0x0000000000000000000000000000000000000001", data: REVERT_DATA },
      { deadlineAtMs: Date.now() + 1_000 },
    ),
    (error: unknown) => {
      const value = error as { data?: unknown; info?: { error?: { data?: unknown } } };
      return value.data === REVERT_DATA || value.info?.error?.data === REVERT_DATA;
    },
    "raw cancellable transport must preserve JSON-RPC revert data",
  );
  await assert.rejects(
    backend.start(),
    /already owned by another process/,
    "backend startup must not attach to a foreign Anvil-compatible port",
  );
} finally {
  backend.provider.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

console.log("state-backend-call-deadline PASS");

function trackResponse(response: ServerResponse): void {
  let finished = false;
  response.once("finish", () => { finished = true; });
  response.once("close", () => {
    activeResponses--;
    if (!finished) abortedResponses++;
  });
}

function respond(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadlineAtMs = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadlineAtMs) {
      throw new Error(
        `transport did not close: active=${activeResponses} aborted=${abortedResponses}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isDeadlineCancellation(error: unknown): boolean {
  const value = error as { code?: unknown; kind?: unknown };
  return value?.code === "STATE_CALL_ABORTED" && value.kind === "deadline";
}
