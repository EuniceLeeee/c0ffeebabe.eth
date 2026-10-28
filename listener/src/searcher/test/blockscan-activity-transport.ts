import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBlockScanActivityTransport } from "../blockscan-activity-transport.js";

test("trace and light reads batch separately and light completes while traces remain pending", { timeout: 5000 }, async () => {
  const batches: string[][] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body), calls = Array.isArray(payload) ? payload : [payload];
    batches.push(calls.map((call: any) => call.method));
    if (calls.some((call: any) => call.method.startsWith("debug_trace"))) await slow;
    const replies = calls.map((call: any) => ({ jsonrpc: "2.0", id: call.id,
      result: call.method === "eth_chainId" ? "0x1" : call.method === "eth_getLogs" ? [] : "0x1" }));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = createBlockScanActivityTransport(`http://127.0.0.1:${(server.address() as any).port}`);
  try {
    let tracesDone = false;
    const traces = Promise.all([transport.send("debug_traceBlockByHash", ["one", {}]),
      transport.send("debug_traceBlockByHash", ["two", {}])]).then(() => { tracesDone = true; });
    const lights = Promise.all([transport.send("eth_getBalance", ["one", "latest"]),
      transport.send("eth_getBalance", ["two", "latest"]), transport.getLogs({ fromBlock: 1, toBlock: 1 })]);
    await lights;
    assert.equal(tracesDone, false, "light batch must not wait for trace batch");
    release(); await traces;
    assert(batches.some(batch => batch.filter(m => m === "debug_traceBlockByHash").length === 2));
    assert(batches.some(batch => batch.filter(m => m === "eth_getBalance").length === 2));
    assert(batches.every(batch => !batch.includes("debug_traceBlockByHash") ||
      !batch.some(m => m === "eth_getBalance" || m === "eth_getLogs")));
  } finally {
    release(); transport.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
