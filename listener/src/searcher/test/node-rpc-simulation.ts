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
const BALANCE = new Interface(["function balanceOf(address) view returns(uint256)"]);
const PIN = { blockHash: H, requireCanonical: true };
type FundingLayout = {
  storage(account: string): Record<string, string>;
  balance(account: string, writes: Readonly<Record<string, string>>): bigint;
  foreign?: Record<string, unknown>;
};
function fundingRpc(layout: FundingLayout) {
  let calls = 0, traces = 0;
  const writes: { account: string; stateDiff: Record<string, string> }[] = [];
  return { get calls() { return calls; }, get traces() { return traces; }, writes,
    rpc: async (method: string, params: readonly any[]) => {
      assert.deepEqual(params[1], PIN); assert.equal(params[0].to, T); assert.equal(params[0].gas, "0x30d40");
      const account = String(BALANCE.decodeFunctionData("balanceOf", params[0].data)[0]).toLowerCase();
      assert(account === A || account === T, "only the target and distinct token-address witness are read");
      if (method === "debug_traceCall") {
        traces++;
        assert.deepEqual(params[2], { tracer: "prestateTracer",
          tracerConfig: { diffMode: false, disableCode: true, disableStorage: false }, timeout: "5s" });
        return { ...layout.foreign, [T]: { storage: layout.storage(account) } };
      }
      assert.equal(method, "eth_call"); calls++;
      const stateDiff = params[2]?.[T]?.stateDiff ?? {};
      if (params[2] !== undefined) {
        assert.deepEqual(Object.keys(params[2]), [T]);
        assert.deepEqual(Object.keys(params[2][T]), ["stateDiff"]);
        assert.equal(Object.keys(stateDiff).length, 1, "prove one slot at a time; never rewrite the trace read set");
        writes.push({ account, stateDiff });
      }
      return toBeHex(layout.balance(account, stateDiff), 32);
    } };
}

function balanceRpc(index = 3, starting = 77n) {
  let current = index;
  const key = (account: string) => keccak256(ABI.encode(["address", "uint256"], [account, current]));
  const balance = (account: string) => account === A ? starting : 19n;
  const model = fundingRpc({
    storage: account => ({ [key(account)]: toBeHex(balance(account), 32) }),
    balance: (account, writes) => BigInt(writes[key(account)] ?? balance(account)),
  });
  return { get calls() { return model.calls; }, get traces() { return model.traces; }, writes: model.writes,
    change(i: number) { current = i; }, rpc: model.rpc };
}
test("node funding traces one direct account balance, retains inventory and caches only proved source facts", async () => {
  const r = balanceRpc(), cache = createNodeFundingCache(), completed = new Map();
  const f = new NodeInputFunding(r.rpc, PIN, cache, completed);
  const first = await f.prepare([{ token: T, to: A, amount: "100" }]);
  assert.deepEqual(first.overrides, { [T]: { stateDiff: { [slot(3)]: toBeHex(177n, 32) } } });
  assert.equal(r.calls, 6); assert.equal(r.traces, 2);
  const probes = r.writes.filter(w => w.account === A).map(w => BigInt(Object.values(w.stateDiff)[0]!));
  assert.equal(new Set(probes).size, 2); assert(probes.every(value => value >> 255n === 1n));
  const reused = await new NodeInputFunding(r.rpc, PIN, cache, completed)
    .prepare([{ token: T, to: A, amount: "20" }]);
  assert.equal(reused.expected[0]!.balance, 97n); assert.equal(r.calls, 6); assert.equal(r.traces, 2);
  // A new source keeps only a hint, never an old balance or a proof. A changed
  // layout must be rediscovered, even when token and holder are identical.
  r.change(7);
  const changed = await new NodeInputFunding(r.rpc, PIN, cache)
    .prepare([{ token: T, to: A, amount: "20" }]);
  assert.deepEqual(changed.overrides[T]!.stateDiff, { [slot(7)]: toBeHex(97n, 32) });
  assert.equal(r.calls, 12); assert.equal(r.traces, 4);
});
test("node funding rejects duplicate deals, overflow and cancellation; no transfer or allowance writes", async () => {
  const r = balanceRpc();
  const f = new NodeInputFunding(r.rpc, PIN);
  await assert.rejects(f.prepare([{ token: T, to: A, amount: "1" }, { token: T, to: A, amount: "2" }]), /duplicate/);
  await assert.rejects(f.prepare([{ token: T, to: A, amount: ((1n << 256n) - 1n).toString() }]), /overflow/);
  const cache = createNodeFundingCache();
  await assert.rejects(new NodeInputFunding(async () => { throw new Error("cancelled"); }, H, cache)
    .prepare([{ token: T, to: A, amount: "1" }]), /cancelled/);
  assert.equal(cache.slots.size, 0);
});
test("trace discovery supports namespaced storage and never substitutes the same pool's balance key", async () => {
  const namespace = keccak256(new TextEncoder().encode("funding-test.namespaced.balances"));
  const key = (account: string) => keccak256(ABI.encode(["address", "bytes32"], [account, namespace]));
  const proxySlot = keccak256(new TextEncoder().encode("funding-test.proxy-implementation"));
  const cache = createNodeFundingCache(); cache.slots.set(`${T}:${A}`, key(O));
  const r = fundingRpc({
    storage: account => ({ [proxySlot]: toBeHex(BigInt(O), 32), [key(account)]: toBeHex(account === A ? 77 : 19, 32) }),
    balance: (account, writes) => BigInt(writes[key(account)] ?? (account === A ? 77 : 19)),
    foreign: { [O]: { storage: { [key(O)]: toBeHex(77, 32) } } },
  });
  const result = await new NodeInputFunding(r.rpc, PIN, cache).prepare([{ token: T, to: A, amount: "100" }]);
  assert.deepEqual(result.overrides, { [T]: { stateDiff: { [key(A)]: toBeHex(177, 32) } } });
  assert.notEqual(key(A), key(O)); assert.equal(cache.slots.get(`${T}:${A}`), key(A));
  assert(r.writes.every(write => Object.keys(write.stateDiff)[0] === key(A)));
  assert.equal(r.calls, 6); assert.equal(r.traces, 2);
});
test("trace discovery rejects shared scalars and does not fund a foreign storage ledger", async () => {
  for (const kind of ["shared", "foreign"] as const) {
    const shared = toBeHex(47, 32);
    const r = fundingRpc({
      storage: () => kind === "shared" ? { [shared]: toBeHex(77, 32) } : {},
      balance: (_account, writes) => BigInt(writes[shared] ?? 77),
      ...(kind === "foreign" ? { foreign: { [O]: { storage: { [shared]: toBeHex(77, 32) } } } } : {}),
    });
    await assert.rejects(new NodeInputFunding(r.rpc, PIN).prepare([{ token: T, to: A, amount: "1" }]), /unsupported balance layout/);
    assert.equal(r.writes.length, 0); assert.equal(r.calls, 2); assert.equal(r.traces, 2);
  }
});
test("trace proof learns packed low-bit balances and preserves source flags and zero balances", async () => {
  const target = slot(9000), witness = slot(9001);
  for (const width of [255n, 128n]) for (const starting of [0n, 77n]) for (const flagged of [false, true]) {
    const mask = (1n << width) - 1n, flags = flagged ? 1n << width : 0n;
    const word = flags | starting, witnessWord = (1n << 255n) | 19n;
    const r = fundingRpc({
      storage: account => ({ [account === A ? target : witness]: toBeHex(account === A ? word : witnessWord, 32) }),
      balance: (account, writes) => BigInt(writes[account === A ? target : witness] ?? (account === A ? word : witnessWord)) & mask,
    });
    const completed = new Map(), f = new NodeInputFunding(r.rpc, PIN, createNodeFundingCache(), completed);
    const prepared = await f.prepare([{ token: T, to: A, amount: "100" }]);
    assert.deepEqual(prepared.overrides, { [T]: { stateDiff: { [target]: toBeHex(flags | (starting + 100n), 32) } } });
    assert.equal(prepared.expected[0]!.balance, starting + 100n);
    assert.deepEqual(completed.get(`${T}:${A}`), { slot: target, balance: starting, mask, word });
    assert.equal(r.calls, flagged ? 7 : 8); assert.equal(r.traces, 2);
    const calls = r.calls;
    const boundary = await f.prepare([{ token: T, to: A, amount: (mask - starting).toString() }]);
    assert.equal(boundary.overrides[T]!.stateDiff[target], toBeHex(flags | mask, 32));
    await assert.rejects(f.prepare([{ token: T, to: A, amount: (mask - starting + 1n).toString() }]), /funding overflow/);
    assert.equal(r.calls, calls, "same-source amount changes reuse the complete field proof");
    assert.equal(r.traces, 2);
  }
});
test("packed balance proofs retain masks across same-source reuse and reprove source layout changes", async () => {
  let width = 255n, flags = 0n, index = 9100;
  const key = (account: string) => keccak256(ABI.encode(["address", "uint256"], [account, index]));
  const r = fundingRpc({
    storage: account => ({ [key(account)]: toBeHex(account === A ? flags | 77n : 19n, 32) }),
    balance: (account, writes) => BigInt(writes[key(account)] ?? (account === A ? flags | 77n : 19n)) & ((1n << width) - 1n),
  });
  const cache = createNodeFundingCache(), completed = new Map();
  const first = await new NodeInputFunding(r.rpc, PIN, cache, completed).prepare([{ token: T, to: A, amount: "100" }]);
  assert.equal(first.overrides[T]!.stateDiff[key(A)], toBeHex(177, 32));
  assert.equal(r.calls, 8); assert.equal(r.traces, 2);
  const reused = await new NodeInputFunding(r.rpc, PIN, cache, completed).prepare([{ token: T, to: A, amount: "20" }]);
  assert.equal(reused.expected[0]!.balance, 97n); assert.equal(r.calls, 8); assert.equal(r.traces, 2);
  width = 128n; flags = 0x55n << 128n; index = 9101;
  const changed = await new NodeInputFunding(r.rpc, PIN, cache).prepare([{ token: T, to: A, amount: "20" }]);
  assert.equal(changed.overrides[T]!.stateDiff[key(A)], toBeHex(flags | 97n, 32));
  assert.equal(cache.slots.get(`${T}:${A}`), key(A));
  assert.equal(r.calls, 15); assert.equal(r.traces, 4);
});
test("trace proof rejects scaled, shifted and noncontiguous fields instead of treating storage as token amounts", async () => {
  const target = slot(9000), witness = slot(9001);
  for (const kind of ["scaled", "shifted", "noncontiguous"] as const) for (const starting of [0n, 77n]) {
    const stored = kind === "scaled" ? starting * 2n : kind === "shifted" ? starting << 8n : starting;
    const r = fundingRpc({
      storage: account => ({ [account === A ? target : witness]: toBeHex(account === A ? stored : 19n, 32) }),
      balance: (account, writes) => {
        if (account === T) return BigInt(writes[witness] ?? 19n);
        const value = BigInt(writes[target] ?? stored);
        return kind === "scaled" ? value / 2n : kind === "shifted" ? value >> 8n : value & ((1n << 255n) | 0xffffn);
      },
    });
    await assert.rejects(new NodeInputFunding(r.rpc, PIN).prepare([{ token: T, to: A, amount: "1" }]), /unsupported balance layout/);
  }
});
test("an isolated candidate must preserve the distinct witness balance", async () => {
  const target = slot(8000), witness = slot(8001);
  const r = fundingRpc({
    storage: account => ({ [account === A ? target : witness]: toBeHex(account === A ? 77 : 19, 32) }),
    balance: (account, writes) => account === A ? BigInt(writes[target] ?? 77) : writes[target] === undefined ? 19n : 20n,
  });
  await assert.rejects(new NodeInputFunding(r.rpc, PIN).prepare([{ token: T, to: A, amount: "1" }]), /unsupported balance layout/);
  assert(r.writes.some(write => write.account === T), "target-only sentinel equality is insufficient");
});
test("two independently passing balance slots remain ambiguous even with a cached hint", async () => {
  const first = slot(8000), second = slot(8001), witness = slot(8002), cache = createNodeFundingCache();
  cache.slots.set(`${T}:${A}`, second);
  const r = fundingRpc({
    storage: account => account === A ? { [first]: toBeHex(77, 32), [second]: toBeHex(77, 32) } : { [witness]: toBeHex(19, 32) },
    balance: (account, writes) => account === T ? 19n : BigInt(writes[first] ?? 77) + BigInt(writes[second] ?? 77) - 77n,
  });
  await assert.rejects(new NodeInputFunding(r.rpc, PIN, cache).prepare([{ token: T, to: A, amount: "1" }]), /ambiguous balance layout/);
  assert.equal(cache.slots.size, 0);
});
test("two independently passing packed slots are not collapsed into one funding proof", async () => {
  const first = slot(8000), second = slot(8001), witness = slot(8002), mask = (1n << 128n) - 1n;
  const r = fundingRpc({
    storage: account => account === A ? { [first]: toBeHex(0, 32), [second]: toBeHex(0, 32) } : { [witness]: toBeHex(19, 32) },
    balance: (account, writes) => account === T ? 19n : (BigInt(writes[first] ?? 0) & mask) + (BigInt(writes[second] ?? 0) & mask),
  });
  const cache = createNodeFundingCache();
  await assert.rejects(new NodeInputFunding(r.rpc, PIN, cache).prepare([{ token: T, to: A, amount: "1" }]), /ambiguous balance layout/);
  assert.equal(cache.slots.size, 0);
});
test("packed-field discovery propagates failed RPC without retaining a slot hint", async () => {
  const target = slot(9000), witness = slot(9001), mask = (1n << 255n) - 1n;
  const r = fundingRpc({
    storage: account => ({ [account === A ? target : witness]: toBeHex(0, 32) }),
    balance: (account, writes) => BigInt(writes[account === A ? target : witness] ?? 0) & mask,
  });
  const cache = createNodeFundingCache(), failure = new Error("masked proof cancelled");
  const rpc = async (method: string, params: readonly any[]) => {
    if (method === "eth_call" && params[2]?.[T]?.stateDiff?.[target] === toBeHex((1n << 256n) - 1n, 32)) throw failure;
    return r.rpc(method, params);
  };
  await assert.rejects(new NodeInputFunding(rpc, PIN, cache).prepare([{ token: T, to: A, amount: "1" }]), error => error === failure);
  assert.equal(cache.slots.size, 0);
});
test("invalid and oversized prestate responses cannot nominate a balance slot", async () => {
  const key = slot(8000);
  const invalid = [null, [], { pre: {}, post: {} }, { badAddress: {} }, { [T]: null },
    { [T]: { storage: [] } }, { [T]: { storage: { "0x01": toBeHex(77, 32) } } },
    { [T]: { storage: { [key]: "0x4d" } } },
    { [T]: { storage: { [key]: toBeHex(77, 32), [key.toUpperCase()]: toBeHex(77, 32) } } },
    { [T]: {}, [T.toUpperCase()]: {} },
    { [T]: { storage: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [toBeHex(i, 32), toBeHex(77, 32)])) } },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [toBeHex(i + 1, 20), {}])),
  ];
  for (const response of invalid) {
    const r = balanceRpc(), cache = createNodeFundingCache();
    const rpc = async (method: string, params: readonly unknown[]) => method === "debug_traceCall" ? response : r.rpc(method, params);
    await assert.rejects(new NodeInputFunding(rpc, PIN, cache).prepare([{ token: T, to: A, amount: "1" }]), /prestate|trace.*limit/);
    assert.equal(cache.slots.size, 0); assert.equal(r.writes.length, 0);
  }
});
test("trace capability, cancellation and isolated-read errors propagate without guessed fallback", async () => {
  for (const failure of [Object.assign(new Error("prestateTracer unavailable"), { code: -32601 }),
    new Error("funding trace cancelled"), Object.assign(new Error("isolated read reverted"), { data: "0x" })]) {
    const r = balanceRpc(), cache = createNodeFundingCache();
    const rpc = async (method: string, params: readonly any[]) => {
      if (failure.message === "isolated read reverted" ? method === "eth_call" && params[2] !== undefined : method === "debug_traceCall")
        throw failure;
      return r.rpc(method, params);
    };
    await assert.rejects(new NodeInputFunding(rpc, PIN, cache).prepare([{ token: T, to: A, amount: "1" }]), error => error === failure);
    assert.equal(cache.slots.size, 0);
  }
  const r = balanceRpc(), failure = new Error("temporary trace cancellation"); let failed = false;
  const f = new NodeInputFunding(async (method, params) => {
    if (method === "debug_traceCall" && !failed) { failed = true; throw failure; }
    return r.rpc(method, params);
  }, PIN);
  await assert.rejects(f.prepare([{ token: T, to: A, amount: "1" }]), error => error === failure);
  assert.equal((await f.prepare([{ token: T, to: A, amount: "2" }])).expected[0]!.balance, 79n);
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

test("explicit source-owner provisioning marks legacy frame receipts and never replaces source attestation", async () => {
  const server = await mockNode(async (method) => {
    if (method === "eth_getBlockByHash") return { number: "0x64", hash: H, parentHash: P, stateRoot: S };
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getCode") return "0x";
    throw new Error("input preparation must not execute or fund anything");
  });
  const runtimeCode = { code: "0x6000", keccak256: keccak256("0x6000") };
  const request = { rpcUrl: server.url, blockNumber: 100, sourcePin: { blockHash: H, chainId: 1, stateRoot: S },
    from: A, to: T, data: "0x", callerMode: "impersonated-call-frame" as const, transactionOrigin: O,
    inputStateOnly: true as const };
  try {
    const unprovisioned = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: runtimeCode });
    await assert.rejects(unprovisioned.strictSimulate(request), /differs at source/); await unprovisioned.closeAndDrain();
    const client = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: runtimeCode, allowExecutorCodeOverride: true });
    const result = await client.strictSimulate(request); await client.closeAndDrain();
    assert.deepEqual(result.strict!.counterfactualExecutorCode, { address: A, keccak256: runtimeCode.keccak256 });
    assert.equal(result.sourceAttestation!.blockNumber, 100); assert.equal(result.sourceAttestation!.blockHash, H);
    assert.equal(result.sourceAttestation!.stateRoot, S);
  } finally { await server.close(); }
});

test("historical executor provisioning does not alter genuine top-level requests", async () => {
  let codeReads = 0;
  const server = await mockNode(async method => {
    if (method === "eth_getBlockByHash") return { number: "0x64", hash: H, parentHash: P, stateRoot: S };
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getCode") { codeReads++; return "0x"; }
    throw new Error("unexpected preparation RPC");
  });
  const client = new NodeStrictClient({ timeoutMs: 5000, executor: A,
    executorRuntimeCode: { code: "0x6000", keccak256: keccak256("0x6000") }, allowExecutorCodeOverride: true });
  try {
    const r = await client.strictSimulate({ rpcUrl: server.url, blockNumber: 100, sourcePin: { blockHash: H, chainId: 1, stateRoot: S },
      from: O, to: T, data: "0x", callerMode: "top-level", inputStateOnly: true });
    assert.equal(r.strict!.counterfactualExecutorCode, undefined);
    assert.equal(codeReads, 0, "ordinary top-level preparation must not read or provision the executor");
  } finally { await client.closeAndDrain(); await server.close(); }
});
