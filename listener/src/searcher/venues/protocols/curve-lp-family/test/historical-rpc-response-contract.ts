import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { historicalRpcResponse } from "./historical-rpc-response.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";

const source = { number: 26202387, hash: ethers.id("rpc-fidelity-contract"), generation: 1 }, executor = ethers.toBeHex(3701, 20);
const request: AdapterRequest = { id: "g-amp", kind: "eth-call", required: false, to: ethers.toBeHex(3702, 20), data: ethers.id("A_precise()").slice(0, 10), completion: "return-or-revert-data" };
const payload = { jsonrpc: "2.0", id: 73, method: "eth_call", params: [{ to: request.to, data: request.data }, { blockHash: source.hash, requireCanonical: true }] } satisfies ethers.JsonRpcPayload;
const body = (error: unknown) => ({ jsonrpc: "2.0", id: payload.id, error });
async function central(error: unknown, status = 200) {
  const runtime = createStrictCentralAdapterRuntime({ executor, generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
    provider: { async call() { return historicalRpcResponse(payload, status, body(error)); } } as never });
  const issued = runtime.scheduler.issueExecutor({ source, generation: source.generation, callerAuthority: { executor } } as never);
  return (await issued.executor.execute({ source, requests: [request] } as never))[0]!;
}
test("real HTTP200 code3 without data is preserved as an optional call revert by the actual central runtime", async () => {
  const error = { code: 3, message: "execution reverted" };
  let caught: any; try { historicalRpcResponse(payload, 200, body(error)); } catch (e) { caught = e; }
  assert.equal(caught.code, "CALL_EXCEPTION"); assert.deepEqual(caught.info.error, error); assert.deepEqual(caught.info.payload, payload); assert.equal(caught.data, null);
  const row = await central(error); assert(row.ok); assert.equal(row.completion, "reverted-as-declared"); assert.equal(row.data, "0x");
});
test("revert payload remains exact, including nonempty return data", async () => {
  for (const error of [{ code: 3, message: "execution reverted", data: "0xbeef" }, { code: -32000, message: "execution reverted", data: "0x1234" }]) {
    const row = await central(error); assert(row.ok); assert.equal(row.completion, "reverted-as-declared"); assert.equal(row.data, error.data);
  }
});
for (const error of [{ code: 429, message: "too many requests", data: "0x" }, { code: -32005, message: "compute capacity exceeded", data: "0x" }, { code: -32000, message: "unknown node failure", data: "0x" }])
  test(`original node error ${error.code}/${error.message} with 0x data remains transport failure`, async () => {
    let caught: any; try { historicalRpcResponse(payload, 200, body(error)); } catch (e) { caught = e; }
    assert.deepEqual(caught.info.error, error); const row = await central(error); assert(!row.ok); assert.equal(row.failure, "rpc");
  });
test("HTTP failure cannot be turned into an EVM revert even with a code3-looking JSON body", async () => {
  for (const status of [429, 500, 503]) { const row = await central({ code: 3, message: "execution reverted", data: "0x" }, status); assert(!row.ok); assert.equal(row.failure, "rpc"); }
});
test("malformed/mismatched response fails closed; success is returned without interpretation", () => {
  assert.equal(historicalRpcResponse(payload, 200, { jsonrpc: "2.0", id: payload.id, result: "0x42" }), "0x42");
  assert.throws(() => historicalRpcResponse(payload, 200, { jsonrpc: "2.0", id: 74, result: "0x" }));
  assert.throws(() => historicalRpcResponse(payload, 200, { jsonrpc: "2.0", id: payload.id }));
});
