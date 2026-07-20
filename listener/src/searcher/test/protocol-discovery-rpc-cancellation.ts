import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { ethers } from "ethers";
import { createPinnedProtocolDiscoveryContext } from "../protocol-instance-discovery.js";

const HANG_DATA = "0x12345678";
const REVERT_DATA = "0xdeadbeef";
const TX_HASH = `0x${"ab".repeat(32)}`;
let activeResponses = 0;
let abortedResponses = 0;

const rawLog = {
  address: "0x0000000000000000000000000000000000000001",
  topics: [`0x${"12".repeat(32)}`],
  data: "0x",
  transactionHash: TX_HASH,
  blockNumber: "0x1",
};

const server = createServer((request, response) => {
  activeResponses++;
  trackResponse(response);
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      method: string;
      params: Array<{ data?: string }>;
    };
    if (parsed.method === "eth_getLogs") {
      respond(response, { jsonrpc: "2.0", id: parsed.id, result: [rawLog] });
      return;
    }
    if (parsed.method === "eth_getTransactionReceipt") {
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        result: { status: "0x1", logs: [rawLog] },
      });
      return;
    }
    if (parsed.params[0]?.data === REVERT_DATA) {
      respond(response, {
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: 3, message: "execution reverted", data: REVERT_DATA },
      });
      return;
    }
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
const network = ethers.Network.from(1);
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${address.port}`, network, {
  staticNetwork: network,
});
const context = createPinnedProtocolDiscoveryContext({
  provider,
  blockNumber: 1,
  fromBlock: 1,
  rpcTimeoutMs: 60,
  graphTokens: [],
});

try {
  const startedAt = Date.now();
  await assert.rejects(
    context.backend.call({
      to: "0x0000000000000000000000000000000000000001",
      data: HANG_DATA,
    }),
    /protocol discovery eth_call timed out after 60ms/,
  );
  assert(Date.now() - startedAt < 500, "timeout must not wait for the late response");
  await waitUntil(() => abortedResponses === 1 && activeResponses === 0, 500);

  await assert.rejects(
    context.backend.call({
      to: "0x0000000000000000000000000000000000000001",
      data: REVERT_DATA,
    }),
    (error: unknown) => {
      const value = error as { data?: unknown; info?: { error?: { data?: unknown } } };
      return value.data === REVERT_DATA || value.info?.error?.data === REVERT_DATA;
    },
    "cancellable discovery transport must preserve JSON-RPC revert data",
  );

  const logs = await context.backend.getLogs({ topics: [], fromBlock: 1, toBlock: 1 });
  assert.equal(logs[0]?.blockNumber, 1, "raw log block quantity must normalize to a number");
  const receipt = await context.backend.getTransactionReceipt(TX_HASH);
  assert.equal(receipt?.status, 1, "raw receipt status quantity must normalize to a number");
  assert.equal(receipt?.logs[0]?.blockNumber, 1, "receipt logs must use the same normalization");
} finally {
  provider.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

console.log("protocol-discovery-rpc-cancellation PASS");

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
