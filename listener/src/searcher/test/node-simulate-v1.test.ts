import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { AbiCoder, keccak256, toBeHex, toUtf8Bytes } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript } from "../../adapters/runtime-amount-program.js";
import { buildSubscriptCalldata } from "../../shared/executor/botvm-program-entry.js";
import { NodeInputFunding, type PinnedNodeRpc } from "../simulator/node-input-funding.js";
import { buildNodeProgramQuote } from "../simulator/node-program-quote.js";
import { NodeStrictClient } from "../simulator/node-strict-client.js";
import { createAcceptanceReadOnlyRpc } from "./protocol-json-acceptance-context.js";
import { getEthersCallRpcError } from "../rpc-throttle-guard.js";
import { createNodeSimulateV1Rpc, nodeSimulateV1Environment, NodeSimulateV1CallRevert,
  simulateNodeProgramV1, simulateNodeTopLevelV1 } from "../simulator/node-simulate-v1.js";

const ABI = AbiCoder.defaultAbiCoder(), A = "0x" + "11".repeat(20), T = "0x" + "22".repeat(20), O = "0x" + "33".repeat(20);
const H = "0x" + "aa".repeat(32), P = "0x" + "bb".repeat(32), S = "0x" + "cc".repeat(32);
const header = { number: "0x64", hash: H, parentHash: P, stateRoot: S, timestamp: "0x3e8", gasLimit: "0x2625a00" };
const pin = { blockHash: H, requireCanonical: true }, env = nodeSimulateV1Environment(header);
const tag = keccak256(toUtf8Bytes("mev.node-program-quote.receipt.v2"));
const receipt = (...values: bigint[]) => ABI.encode(["bytes32", ...values.map(() => "uint256")], [tag, ...values]);
const canonical = buildSubscriptCalldata(runtimeProgramScript(new RuntimeAmountProgram().constant(0, 10n).bytes()));
const success = (returnData = "0x", logs: unknown[] = []) => ({ status: "0x1", returnData, gasUsed: "0x5208", logs });
const reverted = (returnData = "0x", code = 3) => ({ status: "0x0", returnData, gasUsed: "0x5208", logs: [], error: { code, message: "execution reverted" } });
const block = (calls: unknown[]) => [{ parentHash: H, number: env.blockOverrides.number, timestamp: env.blockOverrides.time,
  gasLimit: header.gasLimit, baseFeePerGas: "0x0", calls }];

test("V1 environment separates base identity from virtual execution context", () => {
  assert.equal(env.base.number, 100); assert.equal(env.blockOverrides.number, "0x65");
  assert.equal(env.blockOverrides.time, "0x3f4"); assert.equal(env.blockOverrides.baseFeePerGas, "0x0");
  assert(Object.isFrozen(env) && Object.isFrozen(env.base) && Object.isFrozen(env.blockOverrides));
  for (const bad of [{ hash: "0x1" }, { stateRoot: "0x" }, { number: -1 }, { gasLimit: "0x0" }, { timestamp: Number.MAX_SAFE_INTEGER }])
    assert.throws(() => nodeSimulateV1Environment({ ...header, ...bad }));
});

test("eth_call and trace share V1 environment; canonical code reads retain base state", async () => {
  const seen: { method: string; params: readonly any[] }[] = [];
  const rpc = createNodeSimulateV1Rpc(async (method, params: readonly any[]) => {
    seen.push({ method, params });
    if (method === "eth_getBlockByNumber") return header;
    if (method === "eth_getCode") return "0x6000";
    if (method === "debug_traceCall") { assert.deepEqual(params[2].blockOverrides, env.blockOverrides); return { okay: true }; }
    assert.equal(method, "eth_simulateV1"); assert.equal(params[1], "0x64");
    assert.deepEqual(params[0].blockStateCalls[0].blockOverrides, env.blockOverrides);
    assert.deepEqual(params[0].blockStateCalls[0].stateOverrides, { [T]: { balance: "0x1" } });
    return block([success(toBeHex(23, 32))]);
  }, header);
  assert.equal(await rpc("eth_call", [{ to: T, data: "0x12345678" }, pin, { [T]: { balance: "0x1" } }]), toBeHex(23, 32));
  assert.equal(await rpc("eth_getCode", [T, pin]), "0x6000");
  await rpc("debug_traceCall", [{ from: O, to: A, data: canonical }, pin, { tracer: "callTracer" }]);
  assert.equal(seen.filter(x => x.method === "eth_getBlockByNumber").length, 4);
  assert.equal(seen.filter(x => x.method === "eth_call").length, 0);
  await assert.rejects(rpc("eth_call", [{ to: T }, "latest"]), /source/);
  await assert.rejects(rpc("debug_traceCall", [{ to: T }, pin, { blockOverrides: { number: "0x64" } }]), /environment/);
});

test("V1 malformed source, result, status and gas never become a quote", async () => {
  const mutate = [
    (r: any) => { r[0].parentHash = S; }, (r: any) => { r[0].number = "0x64"; },
    (r: any) => { r[0].timestamp = "0x3e8"; }, (r: any) => { r[0].baseFeePerGas = "0x1"; },
    (r: any) => { r[0].calls.push(success()); }, (r: any) => { r[0].calls[0].status = "0x2"; },
    (r: any) => { r[0].calls[0].gasUsed = "0x0"; }, (r: any) => { r[0].calls[0].returnData = "0x1"; },
    (r: any) => { r[0].calls[0].error = { code: 3, message: "revert" }; },
    (r: any) => { r[0].prevRandao = H; },
  ];
  for (const change of mutate) {
    const rpc = createNodeSimulateV1Rpc(async method => {
      if (method === "eth_getBlockByNumber") return header;
      const r = block([success(toBeHex(7, 32))]); change(r); return r;
    }, header);
    await assert.rejects(rpc("eth_call", [{ to: T }, pin]));
  }
});

test("canonical source changes before or after V1 invalidate the result", async () => {
  for (const changedAt of [1, 2]) {
    let reads = 0, executions = 0;
    const rpc = createNodeSimulateV1Rpc(async method => {
      if (method === "eth_getBlockByNumber") return ++reads === changedAt ? { ...header, stateRoot: H } : header;
      executions++; return block([success(toBeHex(7, 32))]);
    }, header);
    await assert.rejects(rpc("eth_call", [{ to: T }, pin]), /source-fault/);
    assert.equal(executions, changedAt - 1);
  }
});

test("V1 call revert preserves bytes; other EVM failures remain infrastructure errors", async () => {
  for (const code of [3, -32015]) {
    const rpc = createNodeSimulateV1Rpc(async method => method === "eth_getBlockByNumber" ? header : block([reverted("0x1234", code)]), header);
    await assert.rejects(rpc("eth_call", [{ to: T }, pin]), error => code === 3
      ? error instanceof NodeSimulateV1CallRevert && error.data === "0x1234" && error.code === 3
      : error instanceof Error && /did not complete/.test(error.message));
  }
});

test("V1 completed reverts normalize error.data without accepting conflicting bytes", async () => {
  for (const [returned, data, expected] of [
    ["0x", "0xdeadbeef", "0xdeadbeef"],
    ["0xDEADBEEF", "0xdeadbeef", "0xdeadbeef"],
    ["0x", "0x", "0x"],
    ["0x1234", "0xdeadbeef", undefined],
    ["0x", "0x1", undefined],
    ["0x", { data: "0xdeadbeef" }, undefined],
  ] as const) {
    const failed = reverted(returned);
    const rpc = createNodeSimulateV1Rpc(async method => method === "eth_getBlockByNumber" ? header
      : block([{ ...failed, error: { ...failed.error, data } }]), header);
    await assert.rejects(rpc("eth_call", [{ to: T }, pin]), error => expected === undefined
      ? error instanceof Error && /(?:invalid|conflicting) simulateV1 revert data/.test(error.message)
      : error instanceof NodeSimulateV1CallRevert && error.data === expected);
  }
});

test("acceptance mapper keeps caller, pin, read guard and all V1 requests inside its budget", async () => {
  for (const limit of [2, 3]) {
    const seen: any[] = [];
    const options = { url: "https://archive.invalid", source: { number: 100, hash: H },
      control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 }, maxRequests: limit,
      mapCall: (send: PinnedNodeRpc, params: readonly unknown[]) => createNodeSimulateV1Rpc(send, header)("eth_call", params),
      fetch: (async (_url: any, init: any) => {
        const q = JSON.parse(init.body); seen.push(q);
        if (q.method === "eth_simulateV1") {
          assert.equal(q.params[1], "0x64");
          const b = q.params[0].blockStateCalls[0];
          assert.deepEqual(b.blockOverrides, env.blockOverrides);
          assert.deepEqual(b.stateOverrides, {});
          assert.equal(b.calls[0].from, O); assert.equal(b.calls[0].to, T);
        } else assert.equal(q.method, "eth_getBlockByNumber");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id,
          result: q.method === "eth_getBlockByNumber" ? header : block([success(toBeHex(23, 32))]) }));
      }) as typeof fetch };
    const rpc = createAcceptanceReadOnlyRpc(options);
    options.mapCall = async () => { throw new Error("mutated mapCall"); };
    const params = [{ to: T, from: O, data: "0x12345678" }, pin];
    await assert.rejects(rpc.request("eth_sendRawTransaction", ["0x"]));
    await assert.rejects(rpc.request("eth_call", [...params, { [T]: { balance: "0x1" } }]));
    await assert.rejects(rpc.request("eth_call", [params[0], "latest"]));
    assert.equal(seen.length, 0);
    if (limit === 2) await assert.rejects(rpc.request("eth_call", params), /budget/);
    else assert.equal(await rpc.request("eth_call", params), toBeHex(23, 32));
    assert.equal(seen.length, limit); assert.equal(rpc.counters().directRpcReads, limit);
    assert.equal(rpc.counters().failures.length, limit === 2 ? 1 : 0);
  }
});

test("acceptance mapper exposes only completed V1 reverts as CALL_EXCEPTION", async () => {
  for (const code of [3, -32015, 429]) {
    const rpc = createAcceptanceReadOnlyRpc({ url: "https://archive.invalid", source: { number: 100, hash: H },
      control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 }, maxRequests: 3,
      mapCall: (send, params) => createNodeSimulateV1Rpc(send, header)("eth_call", params),
      fetch: (async (_url: any, init: any) => {
        const q = JSON.parse(init.body);
        if (code === 429 && q.method === "eth_simulateV1") return new Response(JSON.stringify({
          jsonrpc: "2.0", id: q.id, error: { code, message: "quota https://archive.invalid/private-token" },
        }));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id,
          result: q.method === "eth_getBlockByNumber" ? header : block([reverted("0x", code)]) }));
      }) as typeof fetch });
    await assert.rejects(rpc.request("eth_call", [{ to: T, from: O, data: "0x12345678" }, pin]), failure => {
      if (code === 3) {
        assert.equal((failure as any).code, "CALL_EXCEPTION"); assert.equal((failure as any).data, "0x");
        assert.deepEqual(getEthersCallRpcError(failure), { code: 3, message: "execution reverted", data: "0x" });
      } else {
        assert.notEqual((failure as any).code, "CALL_EXCEPTION");
        assert.match(String(failure), code === 429 ? /quota/ : /did not complete/);
      }
      return true;
    });
    assert.equal(rpc.counters().directRpcReads, 3);
    const failures = rpc.counters().failures;
    assert.equal(failures.length, 1, "mapped diagnostics must not duplicate a transport failure");
    assert.equal(failures[0]!.method, code === 429 ? "eth_simulateV1" : "eth_call");
    if (code === 3) assert.equal(failures[0]!.code, 3);
    assert(!JSON.stringify(failures).includes("private-token"));
  }
});

test("input funding traces both accounts and proves isolated writes using the same virtual context", async () => {
  const slot = (account: string) => keccak256(ABI.encode(["address", "uint256"], [account, 9000]));
  const accountOf = (data: string) => String(ABI.decode(["address"], "0x" + data.slice(10))[0]).toLowerCase();
  let calls = 0, traces = 0, fences = 0;
  const tracedAccounts: string[] = [], probedAccounts: string[] = [];
  const rpc = createNodeSimulateV1Rpc(async (method, params: readonly any[]) => {
    if (method === "eth_getBlockByNumber") { assert.deepEqual(params, ["0x64", false]); fences++; return header; }
    if (method === "debug_traceCall") {
      traces++;
      assert.deepEqual(params[1], pin);
      assert.deepEqual(params[2], { tracer: "prestateTracer",
        tracerConfig: { diffMode: false, disableCode: true, disableStorage: false }, timeout: "5s", blockOverrides: env.blockOverrides });
      assert.equal(params[0].to, T); assert.equal(params[0].gas, "0x30d40");
      const account = accountOf(params[0].data); tracedAccounts.push(account);
      return { [T]: { storage: { [slot(account)]: toBeHex(account === A ? 77 : 19, 32) } } };
    }
    assert.equal(method, "eth_simulateV1"); calls++;
    assert.equal(params[1], "0x64");
    const b = params[0].blockStateCalls[0]; assert.deepEqual(b.blockOverrides, env.blockOverrides);
    assert.equal(b.calls.length, 1); assert.equal(b.calls[0].to, T); assert.equal(b.calls[0].gas, "0x30d40");
    const account = accountOf(b.calls[0].data), writes = b.stateOverrides[T]?.stateDiff;
    if (writes) {
      probedAccounts.push(account); assert.deepEqual(Object.keys(writes), [slot(A)]);
      assert.equal(BigInt(writes[slot(A)]) >> 255n, 1n);
    }
    return block([success(writes?.[slot(account)] ?? toBeHex(account === A ? 77 : 19, 32))]);
  }, header);
  const funded = await new NodeInputFunding(rpc, pin).prepare([{ token: T, to: A, amount: "10" }]);
  assert.equal(funded.expected[0]!.balance, 87n); assert.equal(calls, 6); assert.equal(traces, 2); assert.equal(fences, 16);
  assert.deepEqual(tracedAccounts, [A, T]); assert.deepEqual(probedAccounts, [A, T, A, T]);
  assert.deepEqual(funded.overrides, { [T]: { stateDiff: { [slot(A)]: toBeHex(87, 32) } } });
});

test("V1 funds a zero low-bit balance while preserving packed metadata and the virtual source", async () => {
  const mask = (1n << 255n) - 1n, flag = 1n << 255n;
  const slot = (account: string) => keccak256(ABI.encode(["address", "uint256"], [account, 9000]));
  const accountOf = (data: string) => String(ABI.decode(["address"], "0x" + data.slice(10))[0]).toLowerCase();
  let traces = 0, simulations = 0;
  const rpc = createNodeSimulateV1Rpc(async (method, params: readonly any[]) => {
    if (method === "eth_getBlockByNumber") { assert.deepEqual(params, ["0x64", false]); return header; }
    if (method === "debug_traceCall") {
      traces++; assert.deepEqual(params[1], pin); assert.deepEqual(params[2].blockOverrides, env.blockOverrides);
      const account = accountOf(params[0].data);
      return { [T]: { storage: { [slot(account)]: toBeHex(account === A ? 0n : flag | 19n, 32) } } };
    }
    assert.equal(method, "eth_simulateV1"); simulations++;
    assert.equal(params[1], "0x64");
    const b = params[0].blockStateCalls[0];
    assert.deepEqual(b.blockOverrides, env.blockOverrides); assert.equal(b.calls.length, 1);
    const account = accountOf(b.calls[0].data), writes = b.stateOverrides[T]?.stateDiff;
    if (writes) assert.deepEqual(Object.keys(writes), [slot(A)]);
    const stored = BigInt(writes?.[slot(account)] ?? (account === A ? 0n : flag | 19n));
    return block([success(toBeHex(stored & mask, 32))]);
  }, header);
  const funded = await new NodeInputFunding(rpc, pin).prepare([{ token: T, to: A, amount: "100" }]);
  assert.equal(funded.expected[0]!.balance, 100n);
  assert.deepEqual(funded.overrides, { [T]: { stateDiff: { [slot(A)]: toBeHex(100n, 32) } } });
  assert.equal(traces, 2); assert(simulations > 0);
});

test("a source change during funding trace prevents any counterfactual balance write", async () => {
  const slot = keccak256(ABI.encode(["address", "uint256"], [A, 9000]));
  let changed = false, calls = 0, traces = 0;
  const rpc = createNodeSimulateV1Rpc(async (method, params: readonly any[]) => {
    if (method === "eth_getBlockByNumber") return changed ? { ...header, stateRoot: H } : header;
    if (method === "debug_traceCall") {
      assert.deepEqual(params[1], pin); assert.deepEqual(params[2].blockOverrides, env.blockOverrides);
      traces++; changed = true;
      return { [T]: { storage: { [slot]: toBeHex(77, 32) } } };
    }
    assert.equal(method, "eth_simulateV1"); calls++;
    assert.deepEqual(params[0].blockStateCalls[0].stateOverrides, {});
    return block([success(toBeHex(77, 32))]);
  }, header);
  await assert.rejects(new NodeInputFunding(rpc, pin).prepare([{ token: T, to: A, amount: "10" }]), /source-fault/);
  assert.equal(calls, 2); assert.equal(traces, 1);
});

test("persistent recorder decodes independently measured balances and actual return words", () => {
  const q = buildNodeProgramQuote({ executor: A, calls: [{ to: T, data: "0x12345678" }],
    observations: [{ kind: "token", token: T, account: A }], persistent: true, terminalRevert: false, outputWords: 2 });
  assert.deepEqual(q.read(receipt(70n, 123n, 456n, 90n)), { before: [70n], after: [90n], output: toBeHex(123, 32) + toBeHex(456, 32).slice(2) });
  assert.throws(() => q.read(receipt(70n, 90n)), /shape/);
  assert.throws(() => buildNodeProgramQuote({ executor: A, calls: [{ to: A, data: canonical }], observations: [],
    persistent: true, terminalRevert: true }), /bounds/);
});

function programInput(rpc: (method: string, params: readonly any[]) => Promise<any>, data = canonical, to = A) {
  return { rpc, header, from: A, origin: O, calls: [{ to, data }],
    observations: [{ kind: "token" as const, token: T, account: A }], overrides: {}, gas: 1_000_000,
    codeAt: async () => "0x" };
}
test("canonical execution reads actual V1 recorder values without a second quote or trace", async () => {
  let traces = 0;
  const r = await simulateNodeProgramV1(programInput(async (method, params) => {
    if (method === "eth_getBlockByNumber") return header;
    if (method === "debug_traceCall") { traces++; throw new Error("unexpected trace"); }
    assert.equal(method, "eth_simulateV1"); const b = params[0].blockStateCalls[0];
    assert.equal(b.calls[0].from, O); assert.equal(b.calls[0].to, A);
    assert.equal(b.calls[1].from, A); assert.equal(b.calls[1].data, "0x00000002");
    assert.deepEqual(b.stateOverrides[b.calls[1].to].state, {});
    return block([success(), success(receipt(77n, 97n))]);
  }));
  assert.deepEqual(r.before, [77n]); assert.deepEqual(r.after, [97n]); assert.equal(r.output, "0x"); assert.equal(traces, 0);
});

test("wrapped OOG in negative V1 controls remains an incomplete nested halt", async () => {
  for (const nested of [false, true]) for (const errorData of [false, true]) {
    const r = await simulateNodeProgramV1(programInput(async (method, params) => {
      if (method === "eth_getBlockByNumber") return header;
      if (method === "eth_simulateV1") {
        const failed = reverted(errorData ? "0x" : "0xdeadbeef");
        return block([{ ...failed, error: { ...failed.error, ...(errorData ? { data: "0xdeadbeef" } : {}) } }, reverted()]);
      }
      assert.equal(method, "debug_traceCall"); assert.deepEqual(params[2].blockOverrides, env.blockOverrides);
      return { ...params[0], input: params[0].data, output: "0xdeadbeef", error: "execution reverted", gasUsed: "0x5208", calls: [{}, {},
        { from: A, to: A, input: canonical, output: "0x1234", error: "execution reverted", gasUsed: "0x5000",
          calls: nested ? [{ error: "out of gas" }] : [] }] };
    }));
    assert.equal(r.failure?.index, 0); assert.equal(r.output, "0x1234");
    if (nested) assert.match(r.failure!.nestedHalt!, /did not complete/); else assert.equal(r.failure?.nestedHalt, null);
  }
});

test("V1 error.data still requires the exact outer revert trace witness", async () => {
  await assert.rejects(simulateNodeProgramV1(programInput(async (method, params) => {
    if (method === "eth_getBlockByNumber") return header;
    if (method === "eth_simulateV1") {
      const failed = reverted();
      return block([{ ...failed, error: { ...failed.error, data: "0xdeadbeef" } }, reverted()]);
    }
    assert.equal(method, "debug_traceCall");
    return { ...params[0], input: params[0].data, output: "0xabcdef", error: "execution reverted", gasUsed: "0x5208", calls: [{}, {},
      { from: A, to: A, input: canonical, output: "0x1234", error: "execution reverted", gasUsed: "0x5000" }] };
  })), /revert trace mismatch/);
});

test("direct return words come from V1 and mismatch with trace is rejected", async () => {
  for (const tampered of [false, true]) {
    let traces = 0;
    const run = simulateNodeProgramV1(programInput(async (method, params) => {
      if (method === "eth_getBlockByNumber") return header;
      const o = method === "debug_traceCall" ? params[2].stateOverrides : params[0].blockStateCalls[0].stateOverrides;
      const recorder = Object.keys(o).find(a => a !== A)!;
      if (method === "eth_simulateV1") {
        const data = params[0].blockStateCalls[0].calls[0].data as string;
        assert(!data.includes(toBeHex(123, 32).slice(2)), "expected return must not be inserted in execution program");
        return block([success(), success(receipt(70n, tampered ? 124n : 123n, 90n))]);
      }
      assert.equal(method, "debug_traceCall"); const captured = ++traces > 1;
      const measured = captured ? receipt(70n, 123n, 90n) : receipt(70n, 90n);
      return { ...params[0], input: params[0].data, output: "0x", gasUsed: "0x5208", calls: [{}, {},
        { from: A, to: T, input: "0x12345678", output: toBeHex(123, 32), gasUsed: "0x5000" },
        ...(captured ? [{}] : []), {}, {},
        { from: A, to: recorder, input: "0x00000002", output: measured, gasUsed: "0x100" }] };
    }, "0x12345678", T));
    if (tampered) await assert.rejects(run, /return or effects trace mismatch/);
    else assert.equal((await run).output, toBeHex(123, 32));
  }
});

test("empty direct return retains exact balance, log and trace cross-checks", async () => {
  for (const tampered of ["none", "balance", "logs", "return"]) {
    let traces = 0;
    const run = simulateNodeProgramV1(programInput(async (method, params) => {
      if (method === "eth_getBlockByNumber") return header;
      if (method === "eth_simulateV1") return block([
        success("0x", tampered === "logs" ? [{ address: T, topics: [H], data: "0x" }] : []),
        success(receipt(70n, tampered === "balance" ? 91n : 90n)),
      ]);
      assert.equal(method, "debug_traceCall");
      const recorder = Object.keys(params[2].stateOverrides).find(a => a !== A)!;
      const output = ++traces === 2 && tampered === "return" ? "0x01" : "0x";
      return { ...params[0], input: params[0].data, output: "0x", gasUsed: "0x5208", calls: [{}, {},
        { from: A, to: T, input: "0x12345678", output, gasUsed: "0x5000" }, {}, {},
        { from: A, to: recorder, input: "0x00000002", output: receipt(70n, 90n), gasUsed: "0x100" }] };
    }, "0x12345678", T));
    if (tampered === "none") {
      const result = await run;
      assert.equal(result.output, "0x"); assert.deepEqual(result.before, [70n]); assert.deepEqual(result.after, [90n]);
    } else await assert.rejects(run, /return or effects trace mismatch/);
    assert.equal(traces, 2);
  }
});

test("unknown or unaligned direct return shapes fail explicitly", async () => {
  for (const output of ["0x12", "0x" + "01".repeat(512)]) {
    const run = simulateNodeProgramV1(programInput(async (method, params) => {
      if (method === "eth_getBlockByNumber") return header;
      assert.equal(method, "debug_traceCall"); const recorder = Object.keys(params[2].stateOverrides).find(a => a !== A)!;
      return { ...params[0], input: params[0].data, output: "0x", gasUsed: "0x5208", calls: [{}, {},
        { from: A, to: T, input: "0x12345678", output, gasUsed: "0x5000" }, {}, {},
        { from: A, to: recorder, input: "0x00000002", output: receipt(70n, 90n), gasUsed: "0x100" }] };
    }, "0x12345678", T));
    await assert.rejects(run, /complete words/);
  }
});

test("top-level V1 uses independent static probes and preserves the actual caller", async () => {
  const r = await simulateNodeTopLevelV1(programInput(async (method, params) => {
    if (method === "eth_getBlockByNumber") return header;
    assert.equal(method, "eth_simulateV1"); const b = params[0].blockStateCalls[0];
    assert.notEqual(b.calls[0].from, A); assert.equal(b.calls[1].from, A);
    assert.equal(b.calls[0].from, b.calls[2].from); assert.equal(b.calls[0].to, b.calls[2].to);
    assert.equal(b.calls[1].data, "0x12345678");
    return block([success(toBeHex(70, 32)), success(toBeHex(123, 32)), success(toBeHex(90, 32))]);
  }, "0x12345678", T));
  assert.deepEqual(r.before, [70n]); assert.deepEqual(r.after, [90n]); assert.equal(r.output, toBeHex(123, 32));
});

test("NodeStrictClient binds V1 environment to its independent actual balance deltas", async () => {
  const code = { code: "0x6000", keccak256: keccak256("0x6000") };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const q = JSON.parse(Buffer.concat(chunks).toString()); let result: unknown;
    try {
      if (q.method === "eth_getBlockByHash" || q.method === "eth_getBlockByNumber") result = header;
      else if (q.method === "eth_chainId") result = "0x1";
      else if (q.method === "eth_getCode") result = q.params[0] === A ? code.code : "0x";
      else { assert.equal(q.method, "eth_simulateV1"); result = block([success(), success(receipt(70n, 90n))]); }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
    } catch { res.statusCode = 500; res.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const c = new NodeStrictClient({ timeoutMs: 5000, executor: A, executorRuntimeCode: code, simulationMethod: "eth_simulateV1" });
  try {
    const r = await c.strictSimulate({ rpcUrl: `http://127.0.0.1:${port}`, blockNumber: 100,
      sourcePin: { blockHash: H, chainId: 1, stateRoot: S }, from: A, to: A, data: canonical,
      callerMode: "impersonated-call-frame", transactionOrigin: O, observeTokenBalances: [{ token: T, account: A }] });
    assert.equal(r.success, true); assert.deepEqual((r as any).executionObservation, env);
    assert.deepEqual(r.strict!.tokenDeltas, [{ token: T, account: A, delta: "20" }]);
  } finally { await c.closeAndDrain(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
});
