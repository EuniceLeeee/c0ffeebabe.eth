import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { inspect } from "node:util";
import { erc20TransferAdapter } from "../../adapters/erc20.js";
import { register } from "../../adapters/registry.js";
import { compilePlan } from "../../shared/compiler/compiler.js";
import { bytesToHex } from "../../shared/compiler/encoder.js";
import { buildExecuteCalldata } from "../../shared/executor/botvm-executor.js";
import { StateCallAbortedError } from "../../shared/state/state-backend.js";
import type { BlockScanObservedHeader } from "../blockscan-observed-header.js";
import { isRpcThrottleError } from "../rpc-throttle-guard.js";
import { EthSimulateV1Simulator } from "../simulator/eth-simulate-v1.js";
import type { ResolvedPlan } from "../solver/solver.js";

const hash = (c: string): string => `0x${c.repeat(64)}`;
const addr = (c: string): string => `0x${c.repeat(40)}`;
const hex = (n: bigint | number): string => `0x${n.toString(16)}`;
const word = (n: bigint): string => `0x${n.toString(16).padStart(64, "0")}`;
const owner = addr("1"), executor = addr("2"), token = addr("3");
const source = { number: 100, hash: hash("a"), generation: 7 };
const header: BlockScanObservedHeader = { number: 100, hash: source.hash, parentHash: hash("b"),
  timestamp: 1_800_000_000, baseFeePerGas: 1_000_000_000n,
  gasUsed: 60_000_000n, gasLimit: 60_000_000n, transactionHashes: [] };
const target = { number: "0x65", time: hex(header.timestamp + 12),
  gasLimit: hex(header.gasLimit), baseFeePerGas: hex(1_125_000_000n) };
register(erc20TransferAdapter);
const plan: ResolvedPlan = { root: { adapterId: "erc20-transfer", target: token,
  tokenIn: token, tokenOut: token, amount: 17n, params: { to: owner }, children: [] },
  netProfit: 999n, profitToken: token, flashAmount: 17n, templateName: "local transport fixture" };
const originalPlan = structuredClone(plan);
const script = compilePlan(plan.root, executor);
assert(script.length > 0);
const calldata = buildExecuteCalldata(script), scriptHex = bytesToHex(script);
const result = (post = 125n) => [{ number: target.number, parentHash: source.hash,
  timestamp: target.time, gasLimit: target.gasLimit, baseFeePerGas: target.baseFeePerGas,
  // Deliberately different from main gas: block/helper totals must never become EV gas.
  gasUsed: "0xf0000", calls: [
    { status: "0x1", gasUsed: "0x12345", returnData: "0x", logs: [] },
    { status: "0x1", gasUsed: "0x23456", returnData: word(post), logs: [] },
  ] }];
type RpcRequest = { jsonrpc: string; id: number; method: string; params: unknown[] };
const envelope = (request: RpcRequest, value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
const rpcError = (request: RpcRequest, code: unknown, message = "fixture-secret") =>
  ({ jsonrpc: "2.0", id: request.id, error: { code, message, data: "fixture-secret" } });
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const requests: RpcRequest[] = [];
let interrupted = 0;
let reply: (request: RpcRequest, response: ServerResponse) => void;
const reset = (value: unknown = result()): void => {
  reply = (request, response) => response.end(JSON.stringify(envelope(request,
    request.method === "eth_call" ? word(100n) : value)));
};
reset();
const server = createServer((request, response) => {
  response.on("close", () => { if (!response.writableFinished) interrupted++; });
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcRequest;
    requests.push(payload);
    reply(payload, response);
  });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const secret = "fixture-secret";
const url = `http://fixture:${secret}@127.0.0.1:${address.port}/${secret}`;
const simulator = new EthSimulateV1Simulator(url, executor, owner);
const context = () => ({ source, header, signal: new AbortController().signal, deadlineAtMs: Date.now() + 5_000 });
const sanitized = (error: unknown): error is Error => {
  assert(error instanceof Error);
  assert(!inspect(error, { depth: 10 }).includes(secret));
  assert(!JSON.stringify(error).includes(secret));
  assert(!String(error).includes(url));
  assert.equal(error.cause, undefined);
  assert.notEqual((error as { kind?: string }).kind, "revert");
  assert.notEqual((error as { code?: string }).code, "TRANSACTION_REVERTED");
  return true;
};
const waitUntil = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!condition()) { assert(Date.now() < deadline, "local request did not settle"); await delay(5); }
};

try {
  for (const post of [125n, 100n, 80n]) {
    reset(result(post));
    const control = context();
    assert.deepEqual(await simulator.simulate(plan, control), {
      success: post > 100n, profitToken: token, grossProfit: post - 100n,
      gasUsed: post > 100n ? 0x12345n : 0n, netProfit: post - 100n, calldata, scriptHex,
    });
    assert.equal(getEventListeners(control.signal, "abort").length, 0);
  }
  assert.deepEqual(plan, originalPlan);
  const pin = { blockHash: source.hash, requireCanonical: true };
  const observer = { from: addr("0"), to: token,
    data: `0x70a08231${executor.slice(2).padStart(64, "0")}`, gasPrice: "0x0" };
  assert.deepEqual(requests.slice(0, 2), [
    { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ ...observer, gas: target.gasLimit }, pin] },
    { jsonrpc: "2.0", id: 2, method: "eth_simulateV1", params: [{
      blockStateCalls: [{ blockOverrides: target,
        stateOverrides: { [owner]: { balance: hex(10_000n * 10n ** 18n) } },
        calls: [{ from: owner, to: executor, data: calldata, value: "0x0", gas: "0x1000000",
          gasPrice: target.baseFeePerGas }, { ...observer, gas: hex(header.gasLimit - 0x1000000n) }],
      }], validation: false, traceTransfers: false, returnFullTransactions: false,
    }, pin] },
  ]);

  // Concrete fee expectations cover full/target/empty parent blocks and 1-wei rounding.
  for (const [gasUsed, baseFee, nextFee] of [
    [30_000_000n, 1_000_000_000n, 1_000_000_000n],
    [0n, 1_000_000_000n, 875_000_000n], [30_000_001n, 1n, 2n],
  ]) {
    const raw = result(); raw[0]!.baseFeePerGas = hex(nextFee); reset(raw);
    await simulator.simulate(plan, { ...context(), header: { ...header, gasUsed, baseFeePerGas: baseFee } });
    const sent = requests.at(-1)!.params[0] as { blockStateCalls: Array<{ blockOverrides: typeof target;
      calls: Array<{ gasPrice: string }> }> };
    assert.equal(sent.blockStateCalls[0]!.blockOverrides.baseFeePerGas, hex(nextFee));
    assert.equal(sent.blockStateCalls[0]!.calls[0]!.gasPrice, hex(nextFee));
  }

  const reverted = result();
  Object.assign(reverted[0]!.calls[0]!, { status: "0x0", error: { code: 3, message: secret, data: secret } });
  reset(reverted);
  const failure = await simulator.simulate(plan, context());
  assert.equal(failure.success, false);
  assert.equal(failure.failure?.kind, "revert");
  assert.equal(failure.failure?.code, "TRANSACTION_REVERTED");
  assert(failure.failure?.cause instanceof Error);
  assert.equal((failure.failure.cause as Error & { code: string }).code, "TRANSACTION_REVERTED");
  assert(!inspect(failure, { depth: 10 }).includes(secret));
  assert.deepEqual(Object.keys(failure).sort(), ["success", "profitToken", "grossProfit", "gasUsed",
    "netProfit", "calldata", "scriptHex", "revertReason", "failure"].sort());
  assert.equal(failure.grossProfit, 0n); assert.equal(failure.gasUsed, 0n);
  assert.equal(failure.netProfit, 0n); assert.equal(failure.calldata, calldata);
  assert.equal(failure.scriptHex, scriptHex);

  const malformed: unknown[] = [null, [], [...result(), ...result()]];
  for (const patch of [{ parentHash: hash("c") }, { parentHash: hash("0") }, { parentHash: undefined },
    { number: "0x66" }, { timestamp: "0x1" },
    { gasLimit: "0x1" }, { baseFeePerGas: "0x0" }, { calls: [] }, { calls: [result()[0]!.calls[0]] }]) {
    malformed.push([{ ...result()[0], ...patch }]);
  }
  for (const index of [0, 1]) {
    for (const patch of [{ status: undefined }, { status: "0x2" }, { status: 1 }, { status: "0x01" },
      { gasUsed: undefined }, { gasUsed: "0x00" }, { gasUsed: "0x0" }, { gasUsed: "0x100000000" },
      { returnData: "0xz" }, { returnData: "0x1" }, { error: null },
      { status: "0x0" }, { status: "0x0", error: { code: "3", message: secret } },
      { status: "0x0", error: { code: -32000, message: secret } },
      { status: "0x0", error: { code: -32005, message: `rate limit ${secret}` } }]) {
      const raw = result(); Object.assign(raw[0]!.calls[index]!, patch); malformed.push(raw);
    }
  }
  for (const value of ["0x", "0x01", `${word(1n)}00`]) {
    const raw = result(); raw[0]!.calls[1]!.returnData = value; malformed.push(raw);
  }
  // Balance-read failure, even with a confirmed main revert, is infrastructure failure.
  const badPost = structuredClone(reverted);
  Object.assign(badPost[0]!.calls[1]!, { status: "0x0", error: { code: 3, message: secret } });
  malformed.push(badPost);
  for (const raw of malformed) {
    reset(raw); const before = requests.length;
    await assert.rejects(simulator.simulate(plan, context()), sanitized);
    assert.equal(requests.length, before + 2);
  }

  // Every first/second-stage transport or envelope failure stops without retry/fallback.
  for (const stage of [1, 2]) {
    for (const variant of ["http429", "http429revert", "http503", "rpc429", "rpcLimit", "rpcRevert",
      "unsupported", "wrongId", "wrongVersion", "both", "missing", "badError", "json", "null", "short"]) {
      const before = requests.length;
      reply = (req, res) => {
        if (req.id !== stage) { res.end(JSON.stringify(envelope(req, word(100n)))); return; }
        const ok = envelope(req, stage === 1 ? word(100n) : result());
        if (variant.startsWith("http")) {
          res.writeHead(variant === "http503" ? 503 : 429, secret);
          res.end(variant === "http429revert" ? JSON.stringify(rpcError(req, 3)) : secret); return;
        }
        const body = variant === "rpc429" ? rpcError(req, 429) :
          variant === "rpcLimit" ? rpcError(req, -32005, `rate limit ${secret}`) :
          variant === "rpcRevert" ? rpcError(req, 3) :
          variant === "unsupported" ? rpcError(req, -32601) :
          variant === "wrongId" ? { ...ok, id: 42 } :
          variant === "wrongVersion" ? { ...ok, jsonrpc: "1.0" } :
          variant === "both" ? { ...ok, error: { code: 3, message: secret } } :
          variant === "missing" ? { jsonrpc: "2.0", id: req.id } :
          variant === "badError" ? rpcError(req, "3") :
          envelope(req, variant === "null" ? null : "0x01");
        res.end(variant === "json" ? secret : JSON.stringify(body));
      };
      await assert.rejects(simulator.simulate(plan, context()), error => {
        sanitized(error);
        assert.equal(isRpcThrottleError(error), ["http429", "http429revert", "rpc429", "rpcLimit"].includes(variant));
        if (variant.startsWith("http")) assert.equal((error as { statusCode: number }).statusCode, variant === "http503" ? 503 : 429);
        if (variant === "http429revert") assert.equal((error as { rpcCode: number }).rpcCode, 3);
        if (variant === "unsupported") assert.equal((error as { code: number }).code, -32601);
        if (variant === "rpcRevert") assert.equal((error as { code: number }).code, 3);
        return true;
      });
      assert.equal(requests.length, before + stage);
    }
  }

  const noRequests = requests.length;
  for (const patch of [{ source: { ...source, generation: -1 } }, { source: { ...source, generation: 0.5 } },
    { source: { ...source, hash: hash("c") } }, { source: { ...source, number: 101 } },
    { source: { ...source, hash: "bad" } }, { deadlineAtMs: Infinity },
    { header: { ...header, baseFeePerGas: null } }, { header: { ...header, baseFeePerGas: 0n } },
    { header: { ...header, gasUsed: -1n } }, { header: { ...header, gasUsed: header.gasLimit + 1n } },
    { header: { ...header, gasLimit: 0x1000000n } }, { header: { ...header, timestamp: NaN } }]) {
    await assert.rejects(simulator.simulate(plan, { ...context(), ...patch }), sanitized);
  }
  const aborted = new AbortController(); aborted.abort(new Error(secret));
  await assert.rejects(simulator.simulate(plan, { ...context(), signal: aborted.signal }), sanitized);
  await assert.rejects(simulator.simulate(plan, { ...context(), deadlineAtMs: Date.now() - 1 }), sanitized);
  assert.equal(requests.length, noRequests);

  for (const stage of [1, 2]) {
    for (const kind of ["signal", "deadline"]) {
      const before = requests.length, closed = interrupted, caller = new AbortController();
      reply = (req, res) => {
        if (req.id !== stage) res.end(JSON.stringify(envelope(req, word(100n))));
        else if (kind === "signal") caller.abort(new Error(secret));
        // Intentionally leave the selected local response hanging.
      };
      const promise = simulator.simulate(plan, { ...context(), signal: caller.signal,
        deadlineAtMs: Date.now() + (kind === "deadline" ? 100 : 5_000) });
      await assert.rejects(promise, error => {
        sanitized(error); assert(error instanceof StateCallAbortedError); assert.equal(error.kind, kind); return true;
      });
      await waitUntil(() => interrupted > closed);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
      assert.equal(requests.length, before + stage);
    }
  }
  const count = requests.length;
  await delay(100);
  assert.equal(requests.length, count, "no delayed retry or fallback");
  assert(requests.every(req => req.method === "eth_call" || req.method === "eth_simulateV1"));
  await assert.rejects(new EthSimulateV1Simulator(`invalid:${secret}`, executor, owner).simulate(plan, context()), sanitized);
  console.log("eth-simulate-v1: PASS (local HTTP, exact requests/results, fees, reverts, malformed data, cancellation, no fallback)");
} finally {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}
