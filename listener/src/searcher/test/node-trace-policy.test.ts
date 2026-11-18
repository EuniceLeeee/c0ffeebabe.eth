import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { AbiCoder, Interface, keccak256, toBeHex, toUtf8Bytes } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { RevmStrictError, type StrictSimulateRequest } from "../revm-sim-client.js";
import { NodeInputFunding, createNodeFundingCache, type PinnedNodeRpc } from "../simulator/node-input-funding.js";
import { NodeStrictClient } from "../simulator/node-strict-client.js";
import { HOP_DIAGNOSTIC_SLOT } from "../simulator/direct-revert-hop.js";
import { createNodeSimulateV1Rpc, nodeSimulateV1Environment, simulateNodeProgramV1,
  simulateNodeTopLevelV1 } from "../simulator/node-simulate-v1.js";

const ABI = AbiCoder.defaultAbiCoder(), A = "0x" + "11".repeat(20), T = "0x" + "22".repeat(20);
const O = "0x" + "33".repeat(20), U = "0x" + "44".repeat(20), H = "0x" + "aa".repeat(32);
const H2 = "0x" + "dd".repeat(32), P = "0x" + "bb".repeat(32), S = "0x" + "cc".repeat(32);
const PIN = { blockHash: H, requireCanonical: true };
const HEADER = { number: "0x64", hash: H, parentHash: P, stateRoot: S, timestamp: "0x3e8", gasLimit: "0x2625a00" };
const CODE = { code: "0x6000", keccak256: keccak256("0x6000") };
const ENV = nodeSimulateV1Environment(HEADER), TAG = keccak256(toUtf8Bytes("mev.node-program-quote.receipt.v2"));
const ERROR = new Interface(["error RuntimeHopFailed(uint256 hop,address target,bytes32 flowHash,bytes reason,bytes32 proof)"]);
const CANONICAL = buildSubscriptCalldata(runtimeProgramScript(new RuntimeAmountProgram().constant(0, 10n).bytes()));
const receipt = (...values: bigint[]) => ABI.encode(["bytes32", ...values.map(() => "uint256")], [TAG, ...values]);
const success = (returnData = "0x", logs: unknown[] = []) => ({ status: "0x1", returnData, gasUsed: "0x5208", logs });
const reverted = () => ({ status: "0x0", returnData: "0x1234", gasUsed: "0x5208", logs: [], error: { code: 3, message: "execution reverted" } });
const block = (calls: unknown[]) => [{ parentHash: H, number: ENV.blockOverrides.number, timestamp: ENV.blockOverrides.time,
  gasLimit: HEADER.gasLimit, baseFeePerGas: "0x0", calls }];
const slot = (owner: string, index = 3) => keccak256(ABI.encode(["address", "uint256"], [owner, index]));
const observationFailure = (e: unknown) => e instanceof RevmStrictError && e.kind === "observation";

type Layout = {
  storage: (owner: string) => Record<string, string>;
  balance: (owner: string, overrides: Record<string, string>) => bigint;
};
function fundingModel(layout?: Layout) {
  let index = 3, pin = PIN;
  const counts: Record<string, number> = {}, writes: Record<string, string>[] = [];
  const actual = layout ?? {
    storage: (owner: string) => ({ [slot(owner, index)]: toBeHex(owner === A ? 77n : 19n, 32) }),
    balance: (owner: string, overrides: Record<string, string>) => BigInt(overrides[slot(owner, index)] ?? (owner === A ? 77n : 19n)),
  };
  const rpc: PinnedNodeRpc = async (method, params: readonly any[]) => {
    counts[method] = (counts[method] ?? 0) + 1;
    assert(!method.startsWith("debug_") && !method.startsWith("trace_"), "physical trace RPC forbidden by test node");
    if (method === "eth_getStorageAt") {
      assert.equal(params[0], T); assert.deepEqual(params[2], pin);
      const words = { ...actual.storage(A), ...actual.storage(T) };
      assert(Object.hasOwn(words, params[1]), "read only an actually nominated storage key");
      return words[params[1]];
    }
    assert.equal(params[0].to, T); assert.deepEqual(params[1], pin);
    assert.equal(params[0].gasPrice, "0x0");
    assert.equal(params[0].data.slice(0, 10), "0x70a08231");
    const owner = String(ABI.decode(["address"], "0x" + params[0].data.slice(10))[0]).toLowerCase();
    assert(owner === A || owner === T);
    if (method === "eth_createAccessList") {
      assert.equal(params.length, 2); assert.equal(params[0].accessList, undefined);
      return { accessList: [{ address: T, storageKeys: Object.keys(actual.storage(owner)) }], gasUsed: "0x6208" };
    }
    assert.equal(method, "eth_call");
    const diff = params[2]?.[T]?.stateDiff ?? {};
    if (params[2] !== undefined) {
      assert.deepEqual(Object.keys(params[2]), [T]); assert.deepEqual(Object.keys(params[2][T]), ["stateDiff"]);
      assert.equal(Object.keys(diff).length, 1); writes.push(diff);
    }
    return toBeHex(actual.balance(owner, diff), 32);
  };
  return { rpc, counts, writes, changeSource() { index = 7; pin = { blockHash: H2, requireCanonical: true }; return pin; } };
}
const fund = (rpc: PinnedNodeRpc, pin: unknown = PIN, cache = createNodeFundingCache()) =>
  new NodeInputFunding(rpc, pin, cache, undefined, undefined, "forbid");

test("trace-forbidden cold funding observes access-list keys and re-proves a new source instead of trusting its hint", async () => {
  const model = fundingModel(), cache = createNodeFundingCache();
  const first = await fund(model.rpc, PIN, cache).prepare([{ token: T, to: A, amount: "100" }]);
  assert.deepEqual(first.overrides, { [T]: { stateDiff: { [slot(A)]: toBeHex(177n, 32) } } });
  assert.deepEqual(model.counts, { eth_call: 6, eth_createAccessList: 2, eth_getStorageAt: 2 });
  const changed = await fund(model.rpc, model.changeSource(), cache).prepare([{ token: T, to: A, amount: "20" }]);
  assert.deepEqual(changed.overrides[T]!.stateDiff, { [slot(A, 7)]: toBeHex(97n, 32) });
  assert.equal(cache.slots.get(`${T}:${A}`), slot(A, 7));
  assert.deepEqual(model.counts, { eth_call: 12, eth_createAccessList: 4, eth_getStorageAt: 4 });
});

test("access-list funding retains packed metadata and separately proves the distinct witness", async () => {
  const mask = (1n << 128n) - 1n, flags = 7n << 200n;
  const model = fundingModel({
    storage: owner => ({ [slot(owner)]: toBeHex(flags | (owner === A ? 0n : 19n), 32) }),
    balance: (owner, writes) => BigInt(writes[slot(owner)] ?? (flags | (owner === A ? 0n : 19n))) & mask,
  });
  const result = await fund(model.rpc).prepare([{ token: T, to: A, amount: "100" }]);
  assert.deepEqual(result.overrides[T]!.stateDiff, { [slot(A)]: toBeHex(flags | 100n, 32) });
  assert.equal(model.counts.eth_createAccessList, 2);
  assert(model.writes.some(write => BigInt(Object.values(write)[0]!) >> 200n === 7n));
});

test("access-list funding does not admit shared, shifted, ambiguous, or witness-changing balance layouts", async () => {
  const shared = toBeHex(8, 32), extra = toBeHex(9, 32);
  const cases: Layout[] = [
    { storage: () => ({ [shared]: toBeHex(77, 32) }), balance: (_owner, w) => BigInt(w[shared] ?? 77) },
    { storage: owner => ({ [slot(owner)]: toBeHex((owner === A ? 77n : 19n) << 8n, 32) }),
      balance: (owner, w) => BigInt(w[slot(owner)] ?? ((owner === A ? 77n : 19n) << 8n)) >> 8n },
    { storage: owner => owner === A ? { [slot(A)]: toBeHex(77, 32), [extra]: toBeHex(77, 32) } : { [slot(T)]: toBeHex(19, 32) },
      balance: (owner, w) => owner === A ? BigInt(w[slot(A)] ?? w[extra] ?? 77) : 19n },
    { storage: owner => ({ [slot(owner)]: toBeHex(owner === A ? 77 : 19, 32) }),
      balance: (owner, w) => BigInt(w[slot(A)] ?? (owner === A ? 77 : 19)) },
  ];
  for (const layout of cases) {
    const model = fundingModel(layout), cache = createNodeFundingCache();
    await assert.rejects(fund(model.rpc, PIN, cache).prepare([{ token: T, to: A, amount: "1" }]), /unsupported|ambiguous/);
    assert.equal(cache.slots.size, 0); assert.equal(model.counts.debug_traceCall, undefined);
  }
});

test("malformed, truncated, failed and foreign access-list evidence cannot fund or fall back to trace", async () => {
  const good = () => ({ accessList: [{ address: T, storageKeys: [slot(A)] }], gasUsed: "0x6208" });
  const bad = [null, {}, { ...good(), error: "execution reverted" }, { ...good(), error: null },
    { ...good(), truncated: true }, { ...good(), incomplete: true },
    { ...good(), accessList: [{ ...good().accessList[0], truncated: true }] },
    { ...good(), gasUsed: "0x0" }, { ...good(), gasUsed: "0x0300" }, { ...good(), gasUsed: "0x30d41" },
    { ...good(), accessList: [{ address: T, storageKeys: [slot(A), slot(A).toUpperCase().replace("0X", "0x")] }] },
    { ...good(), accessList: [{ address: T, storageKeys: ["0x1"] }] },
    { ...good(), accessList: [good().accessList[0], good().accessList[0]] },
    { ...good(), accessList: Array.from({ length: 129 }, () => good().accessList[0]) },
    { ...good(), accessList: [{ address: U, storageKeys: [slot(A)] }] },
  ];
  for (const result of bad) {
    const model = fundingModel(), cache = createNodeFundingCache();
    await assert.rejects(fund(async (method, params) => method === "eth_createAccessList" ? result : model.rpc(method, params), PIN, cache)
      .prepare([{ token: T, to: A, amount: "1" }]));
    assert.equal(cache.slots.size, 0); assert.equal(model.counts.debug_traceCall, undefined);
  }
});

test("unsupported access lists, corrupt storage and cancelled reads remain incomplete without guessed funding", async () => {
  for (const mode of ["access-list-failure", "storage-failure", "storage-corrupt"] as const) {
    const model = fundingModel(), cache = createNodeFundingCache(), failure = new Error(mode);
    const rpc: PinnedNodeRpc = async (method, params) => {
      if (mode === "access-list-failure" && method === "eth_createAccessList" || mode === "storage-failure" && method === "eth_getStorageAt") throw failure;
      if (mode === "storage-corrupt" && method === "eth_getStorageAt") return "0x1";
      return model.rpc(method, params);
    };
    await assert.rejects(fund(rpc, PIN, cache).prepare([{ token: T, to: A, amount: "1" }]),
      error => mode === "storage-corrupt" ? error instanceof Error && /balance unavailable/.test(error.message) : error === failure);
    assert.equal(cache.slots.size, 0); assert.equal(model.counts.debug_traceCall, undefined);
  }
});

async function mockServer(handler: PinnedNodeRpc) {
  const counts: Record<string, number> = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const q = JSON.parse(Buffer.concat(chunks).toString()); counts[q.method] = (counts[q.method] ?? 0) + 1;
    try {
      assert(!q.method.startsWith("debug_") && !q.method.startsWith("trace_"), "poisoned physical trace method");
      const result = await handler(q.method, q.params);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
    } catch (error) {
      const e = error as { data?: string; code?: number };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id,
        error: { code: e.code ?? -32001, message: e.code === 3 ? "execution reverted" : "mock transport unavailable", ...(e.data ? { data: e.data } : {}) } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, counts,
    async close() { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); } };
}
function request(url: string): StrictSimulateRequest {
  return { rpcUrl: url, blockNumber: 100, sourcePin: { blockHash: H, chainId: 1, stateRoot: S },
    from: A, to: A, data: CANONICAL, callerMode: "impersonated-call-frame", transactionOrigin: O,
    tokenDeals: [{ token: T, to: A, amount: "10" }], observeTokenBalances: [{ token: T, account: A }, { token: U, account: A }] };
}
function mockAuthenticatedTerminal(params: readonly any[]) {
  const overrides = params[2], recorder = Object.keys(overrides).find(address => address !== A && address !== T)!;
  const key = overrides[A].stateDiff[HOP_DIAGNOSTIC_SLOT], flow = keccak256(toUtf8Bytes(JSON.stringify([{ to: A, data: CANONICAL }])));
  const reason = receipt(87n, 13n, 77n, 43n);
  const proof = keccak256(ABI.encode(["bytes32", "uint256", "address", "bytes32", "bytes32"], [key, 0n, recorder, flow, keccak256(reason)]));
  return ERROR.encodeErrorResult("RuntimeHopFailed", [0n, recorder, flow, reason, proof]);
}

test("mock RPC transport: strict canonical success funds a cold source and decodes authenticated balances with zero trace requests", async () => {
  const funding = fundingModel();
  const server = await mockServer(async (method, params: readonly any[]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByHash") return HEADER;
    if (method === "eth_getCode") return params[0] === A ? CODE.code : "0x";
    if (method === "eth_call" && params[0].to === A) throw { code: 3, data: mockAuthenticatedTerminal(params) };
    return funding.rpc(method, params);
  });
  const client = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: CODE, tracePolicy: "forbid" });
  try {
    const result = await client.strictSimulate(request(server.url));
    assert.equal(result.success, true); assert.equal(result.strict?.outcome.kind, "Success");
    assert.deepEqual(result.strict?.tokenDeltas, [{ token: T, account: A, delta: "-10" }, { token: U, account: A, delta: "30" }]);
    assert.equal(server.counts.eth_createAccessList, 2); assert.equal(server.counts.eth_getStorageAt, 2);
    assert.equal(server.counts.eth_call, 7); assert.equal(server.counts.debug_traceCall, undefined);
  } finally { await client.closeAndDrain(); await server.close(); }
});

test("mock RPC transport: revert bytes and broken receipts cannot become successful negative controls when trace is forbidden", async () => {
  for (const mode of ["revert", "malformed-receipt", "rpc-error"] as const) {
    const server = await mockServer(async (method, params: readonly any[]) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByHash") return HEADER;
      if (method === "eth_getCode") return params[0] === A ? CODE.code : "0x";
      assert.equal(method, "eth_call");
      if (mode === "rpc-error") throw new Error("resource-limited");
      throw { code: 3, data: mode === "revert" ? "0x" : "0x1234" };
    });
    const client = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: CODE, tracePolicy: "forbid" });
    try {
      await assert.rejects(client.strictSimulate({ ...request(server.url), tokenDeals: [] }),
        mode === "rpc-error" ? /RPC failed/ : observationFailure);
      assert.equal(server.counts.debug_traceCall, undefined);
    } finally { await client.closeAndDrain(); await server.close(); }
  }
});

test("mock RPC transport: unsupported eth_call logs and direct calls fail before funding or trace dispatch", async () => {
  const server = await mockServer(async (method, params: readonly any[]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByHash") return HEADER;
    if (method === "eth_getCode") return params[0] === A ? CODE.code : "0x";
    throw new Error("execution must not dispatch");
  });
  const client = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: CODE, tracePolicy: "forbid" });
  try {
    for (const change of [{ observeLogs: true }, { to: T, data: "0x12345678" },
      { callerMode: "top-level" as const }])
      await assert.rejects(client.strictSimulate({ ...request(server.url), ...change }), observationFailure);
    assert.equal(server.counts.eth_createAccessList, undefined); assert.equal(server.counts.debug_traceCall, undefined);
  } finally { await client.closeAndDrain(); await server.close(); }
});

test("V1 mapper refuses both forbidden trace RPCs and access lists from a different execution environment", async () => {
  let dispatched = 0;
  const rpc = createNodeSimulateV1Rpc(async () => { dispatched++; throw new Error("unexpected transport"); }, HEADER, "forbid");
  for (const method of ["debug_traceCall", "debug_traceBlockByHash", "trace_call", "eth_createAccessList"])
    await assert.rejects(rpc(method, [{ to: T }, PIN]), observationFailure);
  assert.equal(dispatched, 0);
});

function v1Input(rpc: PinnedNodeRpc) {
  return { rpc, header: HEADER, from: A, origin: O, calls: [{ to: A, data: CANONICAL }],
    observations: [{ kind: "token" as const, token: T, account: A }], overrides: {}, gas: 1_000_000,
    codeAt: async () => "0x", tracePolicy: "forbid" as const };
}
test("trace-forbidden V1 canonical success keeps actual logs and balances without a trace witness", async () => {
  let traces = 0;
  const event = { address: T, topics: [H], data: "0x" };
  const result = await simulateNodeProgramV1(v1Input(async method => {
    if (method.startsWith("debug_") || method.startsWith("trace_")) { traces++; throw new Error("trace poisoned"); }
    if (method === "eth_getBlockByNumber") return HEADER;
    assert.equal(method, "eth_simulateV1"); return block([success("0x", [event]), success(receipt(70n, 90n))]);
  }));
  assert.deepEqual(result.before, [70n]); assert.deepEqual(result.after, [90n]);
  assert.deepEqual(result.logs, [event]); assert.equal(traces, 0);
});
test("trace-forbidden V1 failure and unknown return/prefix do not borrow trace or count as completed reverts", async () => {
  let traces = 0, executions = 0;
  const input = v1Input(async method => {
    if (method.startsWith("debug_") || method.startsWith("trace_")) { traces++; throw new Error("trace poisoned"); }
    if (method === "eth_getBlockByNumber") return HEADER;
    assert.equal(method, "eth_simulateV1"); executions++; return block([reverted(), success()]);
  });
  await assert.rejects(simulateNodeProgramV1(input), observationFailure);
  await assert.rejects(simulateNodeProgramV1({ ...input, calls: [{ to: T, data: "0x12345678" }] }), observationFailure);
  await assert.rejects(simulateNodeProgramV1({ ...input, calls: [...input.calls, ...input.calls], baselineAfterPrefix: true }), observationFailure);
  assert.equal(executions, 2); assert.equal(traces, 0);
});
test("trace-forbidden V1 top-level success remains usable while a failed child stays incomplete", async () => {
  for (const fail of [false, true]) {
    let traces = 0;
    const input = { ...v1Input(async method => {
      if (method.startsWith("debug_") || method.startsWith("trace_")) { traces++; throw new Error("trace poisoned"); }
      if (method === "eth_getBlockByNumber") return HEADER;
      assert.equal(method, "eth_simulateV1");
      return block([success(toBeHex(70, 32)), fail ? reverted() : success(toBeHex(123, 32)), success(toBeHex(90, 32))]);
    }), calls: [{ to: T, data: "0x12345678" }] };
    if (fail) await assert.rejects(simulateNodeTopLevelV1(input), observationFailure);
    else {
      const result = await simulateNodeTopLevelV1(input);
      assert.deepEqual(result.before, [70n]); assert.deepEqual(result.after, [90n]); assert.equal(result.output, toBeHex(123, 32));
    }
    assert.equal(traces, 0);
  }
});
test("strict V1 trace-forbidden funding cannot reuse N access keys as a virtual N+1 proof", async () => {
  const server = await mockServer(async (method, params: readonly any[]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByHash" || method === "eth_getBlockByNumber") return HEADER;
    if (method === "eth_getCode") return params[0] === A ? CODE.code : "0x";
    if (method === "eth_createAccessList") {
      assert.deepEqual(params[1], PIN);
      const owner = String(ABI.decode(["address"], "0x" + params[0].data.slice(10))[0]).toLowerCase();
      return { accessList: [{ address: T, storageKeys: [slot(owner)] }], gasUsed: "0x6208" };
    }
    if (method === "eth_getStorageAt") return toBeHex(params[1] === slot(A) ? 77n : 19n, 32);
    assert.equal(method, "eth_simulateV1");
    const input = params[0].blockStateCalls[0];
    assert.deepEqual(input.blockOverrides, ENV.blockOverrides);
    // At virtual N+1 the getter ignores every nominated base-state word.
    // Matching the original N balance does not prove any funding write.
    const owner = String(ABI.decode(["address"], "0x" + input.calls[0].data.slice(10))[0]).toLowerCase();
    return block([success(toBeHex(owner === A ? 77n : 19n, 32))]);
  });
  const client = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: CODE,
    simulationMethod: "eth_simulateV1", tracePolicy: "forbid" });
  try {
    await assert.rejects(client.strictSimulate(request(server.url)), error => observationFailure(error) && /unsupported balance layout/.test(String(error)));
    assert.equal(server.counts.eth_createAccessList, 2); assert(server.counts.eth_simulateV1! >= 3);
    assert.equal(server.counts.eth_call, undefined); assert.equal(server.counts.debug_traceCall, undefined);
  } finally { await client.closeAndDrain(); await server.close(); }
});

test("mock RPC transport: strict V1 without counterfactual funding returns actual observations under trace-forbid", async () => {
  const event = { address: T, topics: [H], data: "0x" };
  const server = await mockServer(async (method, params: readonly any[]) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getBlockByHash" || method === "eth_getBlockByNumber") return HEADER;
    if (method === "eth_getCode") return params[0] === A ? CODE.code : "0x";
    assert.equal(method, "eth_simulateV1");
    return block([success("0x", [event]), success(receipt(70n, 90n))]);
  });
  const client = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: CODE,
    simulationMethod: "eth_simulateV1", tracePolicy: "forbid" });
  try {
    const result = await client.strictSimulate({ ...request(server.url), tokenDeals: [],
      observeTokenBalances: [{ token: T, account: A }], observeLogs: true });
    assert.equal(result.success, true); assert.equal(result.strict?.outcome.kind, "Success");
    assert.deepEqual(result.strict?.tokenDeltas, [{ token: T, account: A, delta: "20" }]);
    assert.deepEqual(result.strict?.logs, [event]);
    assert.equal(server.counts.eth_simulateV1, 1); assert.equal(server.counts.debug_traceCall, undefined);
  } finally { await client.closeAndDrain(); await server.close(); }
});

test("V1 trace-free funding uses N only for candidates and proves both isolated sentinels at N+1", async () => {
  const seen: string[] = [], owners: string[] = [];
  const raw: PinnedNodeRpc = async (method, params: readonly any[]) => {
    seen.push(method);
    assert(!method.startsWith("debug_") && !method.startsWith("trace_") && method !== "eth_call");
    if (method === "eth_getBlockByNumber") return HEADER;
    if (method === "eth_createAccessList") {
      assert.deepEqual(params[1], PIN);
      const owner = String(ABI.decode(["address"], "0x" + params[0].data.slice(10))[0]).toLowerCase();
      return { accessList: [{ address: T, storageKeys: [slot(owner)] }], gasUsed: "0x6208" };
    }
    if (method === "eth_getStorageAt") {
      assert.deepEqual(params[2], PIN); return toBeHex(params[1] === slot(A) ? 77n : 19n, 32);
    }
    assert.equal(method, "eth_simulateV1");
    assert.equal(params[1], "0x64");
    const input = params[0].blockStateCalls[0];
    assert.deepEqual(input.blockOverrides, ENV.blockOverrides);
    assert.equal(input.calls.length, 1);
    const owner = String(ABI.decode(["address"], "0x" + input.calls[0].data.slice(10))[0]).toLowerCase();
    const writes = input.stateOverrides[T]?.stateDiff;
    if (writes) { owners.push(owner); assert.deepEqual(Object.keys(writes), [slot(A)]); }
    return block([success(writes?.[slot(owner)] ?? toBeHex(owner === A ? 77n : 19n, 32))]);
  };
  const rpc = createNodeSimulateV1Rpc(raw, HEADER, "forbid");
  const result = await new NodeInputFunding(rpc, PIN, undefined, undefined, undefined, "forbid", raw)
    .prepare([{ token: T, to: A, amount: "10" }]);
  assert.deepEqual(result.overrides, { [T]: { stateDiff: { [slot(A)]: toBeHex(87n, 32) } } });
  assert.deepEqual(owners, [A, T, A, T]);
  assert.equal(seen.filter(method => method === "eth_simulateV1").length, 6);
  assert.equal(seen.filter(method => method === "eth_createAccessList").length, 2);
});

test("V1 funding cannot accept a candidate that changes the independent witness in the virtual environment", async () => {
  const raw: PinnedNodeRpc = async (method, params: readonly any[]) => {
    if (method === "eth_getBlockByNumber") return HEADER;
    if (method === "eth_createAccessList") {
      const owner = String(ABI.decode(["address"], "0x" + params[0].data.slice(10))[0]).toLowerCase();
      return { accessList: [{ address: T, storageKeys: [slot(owner)] }], gasUsed: "0x6208" };
    }
    if (method === "eth_getStorageAt") return toBeHex(params[1] === slot(A) ? 77n : 19n, 32);
    assert.equal(method, "eth_simulateV1");
    const input = params[0].blockStateCalls[0], writes = input.stateOverrides[T]?.stateDiff;
    assert.deepEqual(input.blockOverrides, ENV.blockOverrides);
    const owner = String(ABI.decode(["address"], "0x" + input.calls[0].data.slice(10))[0]).toLowerCase();
    return block([success(owner === A ? writes?.[slot(A)] ?? toBeHex(77n, 32) : toBeHex(writes ? 20n : 19n, 32))]);
  };
  await assert.rejects(new NodeInputFunding(createNodeSimulateV1Rpc(raw, HEADER, "forbid"), PIN,
    undefined, undefined, undefined, "forbid", raw).prepare([{ token: T, to: A, amount: "10" }]),
  error => observationFailure(error) && /unsupported/.test(String(error)));
});

test("V1 successful prefix observes only target logs after its authenticated in-transaction boundary", async () => {
  const prefix = { address: T, topics: [H], data: "0x01" }, target = { address: U, topics: [H2], data: "0x02" };
  let executions = 0;
  const input = v1Input(async (method, params: readonly any[]) => {
    if (method === "eth_getBlockByNumber") return HEADER;
    assert.equal(method, "eth_simulateV1"); executions++;
    const state = params[0].blockStateCalls[0].stateOverrides;
    const recorder = Object.keys(state).find(address => address !== A)!;
    const topic = state[recorder].code.match(/7f([0-9a-f]{64})60006000a100/)?.[1];
    assert(topic, "the synthetic transport observes the actual generated marker topic");
    return block([success("0x", [prefix, { address: recorder, topics: ["0x" + topic], data: "0x" }, target]),
      success(receipt(200n, 10n))]);
  });
  const result = await simulateNodeProgramV1({ ...input, calls: [...input.calls, ...input.calls], baselineAfterPrefix: true });
  assert.deepEqual(result.before, [200n]); assert.deepEqual(result.after, [10n]);
  assert.deepEqual(result.logs, [target]); assert.equal(executions, 1);
});

test("missing, duplicate and malformed prefix log markers stay incomplete with trace forbidden", async () => {
  for (const mode of ["missing", "duplicate", "wrong-topic", "wrong-data", "foreign-recorder"] as const) {
    const input = v1Input(async (method, params: readonly any[]) => {
      if (method === "eth_getBlockByNumber") return HEADER;
      assert.equal(method, "eth_simulateV1");
      const state = params[0].blockStateCalls[0].stateOverrides;
      const recorder = Object.keys(state).find(address => address !== A)!;
      const topic = "0x" + state[recorder].code.match(/7f([0-9a-f]{64})60006000a100/)[1];
      const marker = { address: mode === "foreign-recorder" ? T : recorder,
        topics: [mode === "wrong-topic" ? H : topic], data: mode === "wrong-data" ? "0x00" : "0x" };
      return block([success("0x", mode === "missing" ? [] : mode === "duplicate" ? [marker, marker] : [marker]),
        success(receipt(200n, 10n))]);
    });
    await assert.rejects(simulateNodeProgramV1({ ...input, calls: [...input.calls, ...input.calls], baselineAfterPrefix: true }),
      error => observationFailure(error) && /boundary/.test(String(error)));
  }
});
