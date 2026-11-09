import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { AbiCoder, Interface, keccak256, toBeHex } from "ethers";
import { NodeInputFunding, createNodeFundingCache } from "../simulator/node-input-funding.js";
import { NodeStrictClient } from "../simulator/node-strict-client.js";
import { applyNodeStateDiff, nodeNestedHalt } from "../simulator/node-trace-simulation.js";
import { buildNodeProgramQuote, isCanonicalNodeRuntimeCall } from "../simulator/node-program-quote.js";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";

const ABI = AbiCoder.defaultAbiCoder();
const A = "0x" + "11".repeat(20), T = "0x" + "22".repeat(20), O = "0x" + "33".repeat(20);
const H = "0x" + "aa".repeat(32), S = "0x" + "bb".repeat(32), P = "0x" + "cc".repeat(32);
const slot = (i: number) => keccak256(ABI.encode(["address", "uint256"], [A, i]));

function balanceRpc(index = 3, starting = 77n) {
  let calls = 0, current = index;
  return { get calls() { return calls; }, change(i: number) { current = i; },
    rpc: async (method: string, params: readonly any[]) => {
      assert.equal(method, "eth_call"); assert.deepEqual(params[1], { blockHash: H, requireCanonical: true }); calls++;
      assert.equal(params[0].to, T);
      const writes = params[2]?.[T]?.stateDiff;
      return writes?.[slot(current)] ?? toBeHex(starting, 32);
    } };
}
test("node funding discovers one direct balance slot, retains inventory and caches only proved source facts", async () => {
  const r = balanceRpc(), cache = createNodeFundingCache(), completed = new Map();
  const f = new NodeInputFunding(r.rpc, { blockHash: H, requireCanonical: true }, cache, completed);
  const first = await f.prepare([{ token: T, to: A, amount: "100" }]);
  assert.deepEqual(first.overrides, { [T]: { stateDiff: { [slot(3)]: toBeHex(177n, 32) } } });
  assert.equal(r.calls, 4);
  const reused = await new NodeInputFunding(r.rpc, { blockHash: H, requireCanonical: true }, cache, completed)
    .prepare([{ token: T, to: A, amount: "20" }]);
  assert.equal(reused.expected[0]!.balance, 97n); assert.equal(r.calls, 4);
  // A new source keeps only a hint, never an old balance or a proof. A changed
  // layout must be rediscovered, even when token and holder are identical.
  r.change(7);
  const changed = await new NodeInputFunding(r.rpc, { blockHash: H, requireCanonical: true }, cache)
    .prepare([{ token: T, to: A, amount: "20" }]);
  assert.deepEqual(changed.overrides[T]!.stateDiff, { [slot(7)]: toBeHex(97n, 32) });
  assert.equal(r.calls, 9);
});
test("node funding rejects nonlinear balances, duplicate deals, overflow and cancellation; no transfer or allowance writes", async () => {
  const r = balanceRpc();
  await assert.rejects(new NodeInputFunding(async (...args) => toBeHex(BigInt(await r.rpc(...args)) / 2n, 32), { blockHash: H, requireCanonical: true })
    .prepare([{ token: T, to: A, amount: "1" }]), /unsupported balance layout/);
  const f = new NodeInputFunding(r.rpc, { blockHash: H, requireCanonical: true });
  await assert.rejects(f.prepare([{ token: T, to: A, amount: "1" }, { token: T, to: A, amount: "2" }]), /duplicate/);
  await assert.rejects(f.prepare([{ token: T, to: A, amount: ((1n << 256n) - 1n).toString() }]), /overflow/);
  const cache = createNodeFundingCache();
  await assert.rejects(new NodeInputFunding(async () => { throw new Error("cancelled"); }, H, cache)
    .prepare([{ token: T, to: A, amount: "1" }]), /cancelled/);
  assert.equal(cache.slots.size, 0);
});
test("node state diff clears changed-to-zero slots and preserves prior writes; deleted accounts reject", () => {
  const a = toBeHex(1n, 32), b = toBeHex(2n, 32), c = toBeHex(3n, 32);
  const overrides = { [T]: { stateDiff: { [a]: b, [c]: c } } };
  applyNodeStateDiff(overrides, { pre: { [T]: { storage: { [a]: b } } }, post: { [T]: { storage: {} } } });
  assert.deepEqual(overrides[T].stateDiff, { [a]: toBeHex(0, 32), [c]: c });
  assert.throws(() => applyNodeStateDiff({}, { pre: { [T]: {} }, post: {} }), /deletion/);
  assert.throws(() => applyNodeStateDiff({}, { pre: {}, post: { [T]: { storage: { "0x01": b } } } }), /slot/);
});
test("terminal receipts require exact tag, owner-generated key, target, flow and complete observations", () => {
  const p = new RuntimeAmountProgram().constant(0, 10n);
  const call = buildSubscriptCalldata(runtimeProgramScript(p.bytes()));
  assert(isCanonicalNodeRuntimeCall(call)); assert(!isCanonicalNodeRuntimeCall("0x"));
  const q = buildNodeProgramQuote({ executor: A, calls: [{ to: A, data: call }], observations: [{ kind: "token", token: T, account: A }], terminalRevert: true });
  const reason = ABI.encode(["bytes32", "uint256", "uint256"], [keccak256(new TextEncoder().encode("mev.node-program-quote.receipt.v2")), 50n, 60n]);
  const proof = keccak256(ABI.encode(["bytes32", "uint256", "address", "bytes32", "bytes32"], [q.key, 0n, q.recorder, q.flowHash, keccak256(reason)]));
  const error = new Interface(["error RuntimeHopFailed(uint256,address,bytes32,bytes,bytes32)"]);
  const data = error.encodeErrorResult("RuntimeHopFailed", [0n, q.recorder, q.flowHash, reason, proof]);
  assert.deepEqual(q.decode(data), { before: [50n], after: [60n] });
  assert.throws(() => q.decode(error.encodeErrorResult("RuntimeHopFailed", [0n, T, q.flowHash, reason, proof])), /authentication/);
  assert.throws(() => q.decode(data + "00"), /receipt/);
  assert.throws(() => q.read(reason.slice(0, -64)), /shape/);
});

async function mockNode(handle: (method: string, params: any[]) => Promise<any>) {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    try { const q = JSON.parse(Buffer.concat(chunks).toString()); const result = await handle(q.method, q.params);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const a = server.address() as { port: number };
  return { url: `http://127.0.0.1:${a.port}`, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
function preparedRequest(url: string) {
  return { rpcUrl: url, blockNumber: 100, sourcePin: { blockHash: H, chainId: 1, stateRoot: S },
    from: A, to: A, data: "0x", callerMode: "impersonated-call-frame" as const, transactionOrigin: O,
    trialPrefix: { executor: A, calldata: "0x", inputToken: T, inputAmount: "10", executorRuntimeCode: { code: "0x6000", keccak256: keccak256("0x6000") } }, inputStateOnly: true as const };
}
test("pinned node cancellation does not poison later header/code/funding requests; mismatch fails before execution", async () => {
  let headers = 0, code = "0x6000", calls = 0;
  const funding = balanceRpc();
  const server = await mockNode(async (method, params) => {
    if (method === "eth_getBlockByHash") { if (++headers === 1) await new Promise(r => setTimeout(r, 100)); return { number: "0x64", hash: H, parentHash: P, stateRoot: S }; }
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getCode") { assert.deepEqual(params[1], { blockHash: H, requireCanonical: true }); return code; }
    calls++; return funding.rpc(method, params);
  });
  const client = new NodeStrictClient({ timeoutMs: 5000, executor: A });
  try {
    const controller = new AbortController();
    const first = client.strictSimulate(preparedRequest(server.url), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(first);
    const next = await client.strictSimulate(preparedRequest(server.url));
    assert.equal(next.strict?.outcome?.kind, "InputPrepared");
    assert(headers >= 2);
    code = "0x6001"; const different = new NodeStrictClient({ timeoutMs: 5000, executor: A });
    const before = calls;
    await assert.rejects(different.strictSimulate(preparedRequest(server.url)), /differs at source/);
    assert.equal(calls, before); await different.closeAndDrain();
    await assert.rejects(client.strictSimulate({ ...preparedRequest(server.url), blockNumber: 101 }), /source-fault/);
  } finally { await client.closeAndDrain(); await server.close(); }
});

test("wrapped OOG/invalid remains incomplete, never deterministic revert evidence", () => {
  assert.equal(nodeNestedHalt({ error: "execution reverted", calls: [{ error: "execution reverted" }] }), null);
  assert.match(nodeNestedHalt({ error: "execution reverted", calls: [{ calls: [{ error: "out of gas" }] }] })!, /did not complete/);
  assert.match(nodeNestedHalt({ error: "execution reverted", calls: {} })!, /incomplete/);
});

test("legacy frame checks factory code and every execution mode checks origin code before dispatch", async () => {
  let originCode = "0x6001", executorCode = "0x6000", dispatched = 0;
  const server = await mockNode(async (method, params) => {
    if (method === "eth_getBlockByHash") return { number: "0x64", hash: H, parentHash: P, stateRoot: S };
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getCode") return params[0] === A ? executorCode : originCode;
    dispatched++; throw new Error("execution must not start");
  });
  const request = { rpcUrl: server.url, blockNumber: 100, sourcePin: { blockHash: H, chainId: 1, stateRoot: S },
    from: A, to: T, data: "0x12345678", callerMode: "impersonated-call-frame" as const, transactionOrigin: O };
  const options = { timeoutMs: 5000, executor: A, executorRuntimeCode: { code: "0x6000", keccak256: keccak256("0x6000") } };
  try {
    let client = new NodeStrictClient(options);
    await assert.rejects(client.strictSimulate(request), /origin must/); await client.closeAndDrain();
    originCode = "0x"; executorCode = "0x6002"; client = new NodeStrictClient(options);
    await assert.rejects(client.strictSimulate(request), /differs at source/); await client.closeAndDrain();
    executorCode = "0x6000"; client = new NodeStrictClient(options);
    await assert.rejects(client.strictSimulate({ ...request, callerMode: "top-level" }), /origin must/); await client.closeAndDrain();
    assert.equal(dispatched, 0);
  } finally { await server.close(); }
});
