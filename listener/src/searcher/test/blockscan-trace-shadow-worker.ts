import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { createWorkerBlockScanShadowTraceReader, resolveShadowTraceProjection } from "../blockscan-trace-shadow-worker.js";
import { collectBlockTraceTouchedStateKeys } from "../blockscan-touched-state.js";
import { BlockScanShadowTraceError } from "../blockscan-trace-shadow.js";
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const anchor = { hash: hash(2), parentHash: hash(1), transactionHashes: [hash(3)] };
const frame = (target: string) => ({ type: "CALL", from: address(1), to: target, input: "0x12345678", gas: "0x100", gasUsed: "0x10", output: "0x" });
const control = (signal = new AbortController().signal) => ({ signal, deadlineAtMs: Date.now() + 5000, blockNumber: 2, anchor });
async function server(t: any, handler: Parameters<typeof createServer>[0]) {
  const s = createServer(handler as any); s.listen(0, "127.0.0.1"); await once(s, "listening");
  t.after(() => { s.closeAllConnections(); s.close(); });
  return `http://127.0.0.1:${(s.address() as any).port}`;
}
test("isolated trace projection preserves nested-call touched semantics and reuses transport", async t => {
  const traces = [{ txHash: hash(3), result: { ...frame(address(7)), calls: [frame(address(8)), frame(address(99))] } }];
  const ports = new Set();
  const url = await server(t, (req: any, res: any) => { ports.add(req.socket.remotePort); req.resume(); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: traces })); });
  const reader = createWorkerBlockScanShadowTraceReader(url, { knownStateKeys: [address(7), "pool:8"], dependencyAddresses: [address(8)] });
  t.after(() => reader.close());
  const resolver = (o: any) => o.target === address(8) ? ["pool:8"] : [];
  const expected = [...collectBlockTraceTouchedStateKeys(traces, 2, anchor, resolver)].filter(k => [address(7), "pool:8"].includes(k)).sort();
  for (let i = 0; i < 2; i++) {
    const projection = await reader(anchor.hash, control());
    assert.equal((projection as any).observations.length, 1, "irrelevant calldata stays off the main heap");
    assert.deepEqual([...(await resolveShadowTraceProjection(projection, 2, anchor.hash, resolver))].sort(), expected);
  }
  assert.equal(ports.size, 1, "persistent worker keeps its independent keepalive transport");
});
test("malformed anchor evidence and provider quota errors never become successful comparisons", async t => {
  let quota = false;
  const url = await server(t, (_req: any, res: any) => res.end(JSON.stringify(quota
    ? { jsonrpc: "2.0", id: 1, error: { code: 429, message: "Monthly capacity limit exceeded" } }
    : { jsonrpc: "2.0", id: 1, result: [] })));
  const reader = createWorkerBlockScanShadowTraceReader(url, { knownStateKeys: [], dependencyAddresses: [] });
  t.after(() => reader.close());
  await assert.rejects(reader(anchor.hash, control()), (e: any) => e instanceof BlockScanShadowTraceError && e.category === "classification");
  quota = true;
  await assert.rejects(reader(anchor.hash, control()), (e: any) => e instanceof BlockScanShadowTraceError && e.category === "quota");
});
test("blocked shadow RPC does not block the event loop and cancellation stops physical work", async t => {
  let arrived!: () => void; const seen = new Promise<void>(r => arrived = r);
  const url = await server(t, () => arrived());
  const reader = createWorkerBlockScanShadowTraceReader(url, { knownStateKeys: [], dependencyAddresses: [] });
  const abort = new AbortController();
  const pending = assert.rejects(reader(anchor.hash, control(abort.signal)), (e: any) => e.category === "aborted");
  await seen; await yieldTurn(); abort.abort(); await pending;
  reader.close();
  await assert.rejects(reader(anchor.hash, control()), (e: any) => e.category === "aborted");
});
test("family resolution yields between batches and honours cancellation without partial results", async () => {
  const observations = Array.from({ length: 80 }, () => ({ kind: "call", target: address(7), data: "0x12345678" }));
  const raw = { kind: "validated-trace-projection", blockNumber: 2, blockHash: anchor.hash, stateKeys: [], observations };
  let calls = 0; const abort = new AbortController();
  await assert.rejects(resolveShadowTraceProjection(raw, 2, anchor.hash, () => {
    calls++; if (calls === 16) abort.abort(); return ["pool"];
  }, abort.signal));
  assert.equal(calls, 16);
  await assert.rejects(resolveShadowTraceProjection(raw, 3, anchor.hash, () => []));
});
