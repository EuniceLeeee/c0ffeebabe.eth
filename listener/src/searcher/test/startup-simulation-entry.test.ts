import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createLiveSourceSimulationFactory } from "../main.js";

test("live source factory forbids trace by default and keeps explicit diagnostic allow", async t => {
  const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const source = { number: 101, hash: hash(101), generation: 1 };
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(body.method);
    const result = body.method === "eth_chainId" ? "0x1" : body.method === "eth_getBlockByHash"
      ? { number: "0x65", hash: source.hash, stateRoot: hash(200), parentHash: hash(100) }
      : body.method === "eth_getCode" ? "0x" : undefined;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(result === undefined
      ? { error: { code: -32601, message: "diagnostic trace endpoint deliberately unavailable" } }
      : { result }) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const previous = process.env.SEARCHER_SIMULATION_TRACE_POLICY;
  delete process.env.SEARCHER_SIMULATION_TRACE_POLICY;
  t.after(() => {
    if (previous === undefined) delete process.env.SEARCHER_SIMULATION_TRACE_POLICY;
    else process.env.SEARCHER_SIMULATION_TRACE_POLICY = previous;
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const tracePolicy of [undefined, "allow", "forbid"] as const) {
    methods.length = 0;
    const factory = createLiveSourceSimulationFactory({ rpcUrl: url, chainId: 1,
      timeoutMs: 2000, runtimeAbort: new AbortController(), onFatal() { assert.fail("ordinary unavailable observation is not source fatal"); },
      ...(tracePolicy === undefined ? {} : { tracePolicy }) });
    const work = factory({ source, control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 2000 } });
    try {
      await assert.rejects(work.transport.simulate({ source, request: { id: "noncanonical-diagnostic",
        kind: "effect-delta-simulation", call: { caller: { kind: "executor" },
          executionMode: "top-level", to: address(2), data: "0x" },
        overrideIntent: { caller: { kind: "executor" } }, observe: ["return-data"] },
        callerAuthority: { executor: address(1), transactionOrigin: address(3) } }));
      assert.equal(methods.some(method => method.startsWith("debug_") || method.startsWith("trace_")), tracePolicy === "allow",
        "only the explicit diagnostic setting may attempt a trace RPC");
    } finally { await work.closeAndDrain(); }
  }
});
