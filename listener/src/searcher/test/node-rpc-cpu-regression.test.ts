import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { AbiCoder, keccak256, toBeHex } from "ethers";
import { NodeStrictClient } from "../simulator/node-strict-client.js";
import { createNodeFundingCache } from "../simulator/node-input-funding.js";
import { RethTransportScheduler } from "../reth-transport-scheduler.js";

const ABI = AbiCoder.defaultAbiCoder();
const A = "0x" + "11".repeat(20), T = "0x" + "22".repeat(20), O = "0x" + "33".repeat(20);
const H = "0x" + "aa".repeat(32), H2 = "0x" + "dd".repeat(32);
const S = "0x" + "bb".repeat(32), P = "0x" + "cc".repeat(32);
const CODE = { code: "0x6000", keccak256: keccak256("0x6000") };
const slot = keccak256(ABI.encode(["address", "uint256"], [A, 3]));
const witnessSlot = keccak256(ABI.encode(["address", "uint256"], [T, 3]));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function mockNode(before?: (method: string, params: any[], count: number) => Promise<void>) {
  const counts: Record<string, number> = {};
  let balance = 77n, code = CODE.code, failCode = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const q = JSON.parse(Buffer.concat(chunks).toString()), { method, params } = q;
    const count = counts[method] = (counts[method] ?? 0) + 1;
    try {
      await before?.(method, params, count);
      let result: unknown;
      if (method === "eth_getBlockByHash") result = { number: "0x64", hash: params[0], parentHash: P, stateRoot: S };
      else if (method === "eth_chainId") result = "0x1";
      else if (method === "eth_getCode") {
        result = failCode ? "0x0" : code;
        failCode = false;
      } else if (method === "eth_call" || method === "debug_traceCall") {
        assert.equal(params[0].to, T);
        assert.equal(params[1].requireCanonical, true);
        assert.equal(params[0].data.slice(0, 10), "0x70a08231");
        const account = String(ABI.decode(["address"], "0x" + params[0].data.slice(10))[0]).toLowerCase();
        assert(account === A || account === T);
        const key = account === A ? slot : witnessSlot, value = account === A ? balance : 19n;
        if (method === "debug_traceCall") {
          assert.deepEqual(params[2], { tracer: "prestateTracer",
            tracerConfig: { diffMode: false, disableCode: true, disableStorage: false }, timeout: "5s" });
          result = { [T]: { storage: { [key]: toBeHex(value, 32) } } };
        } else result = params[2]?.[T]?.stateDiff?.[key] ?? toBeHex(value, 32);
      } else throw new Error(`unexpected ${method}`);
      if (!res.destroyed) res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
    } catch { if (!res.destroyed) { res.statusCode = 500; res.end("{}"); } }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, counts,
    balance(value: bigint) { balance = value; }, code(value: string) { code = value; }, failNextCode() { failCode = true; },
    async close() { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); } };
}
function request(url: string, amount = 10, hash = H) {
  return { rpcUrl: url, blockNumber: 100, sourcePin: { blockHash: hash, chainId: 1, stateRoot: S },
    from: A, to: A, data: "0x", callerMode: "impersonated-call-frame" as const, transactionOrigin: O,
    trialPrefix: { executor: A, calldata: "0x", inputToken: T, inputAmount: String(amount), executorRuntimeCode: { ...CODE } }, inputStateOnly: true as const };
}
function client(extra: Partial<ConstructorParameters<typeof NodeStrictClient>[0]> = {}) {
  return new NodeStrictClient({ timeoutMs: 5000, executor: A,
    scheduler: new RethTransportScheduler({ capacity: 8, producerReserved: 1 }), ...extra });
}

test("same-source parallel amounts share one header, code and funding proof while preserving each balance", async t => {
  const server = await mockNode(), c = client();
  try {
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) => c.strictSimulate(request(server.url, i + 1))));
    results.forEach((result, i) => {
      assert.equal(result.strict?.outcome.kind, "InputPrepared");
      const outcome = result.strict!.outcome;
      if (outcome.kind === "InputPrepared") assert.deepEqual(outcome.stateOverrides, {
        [T]: { stateDiff: { [slot]: toBeHex(78n + BigInt(i), 32) } },
      });
    });
    assert.deepEqual(server.counts, { eth_getBlockByHash: 1, eth_chainId: 1, eth_getCode: 1, eth_call: 6, debug_traceCall: 2 });
    t.diagnostic(`32 concurrent inputs: ${JSON.stringify(server.counts)}`);
  } finally { await c.closeAndDrain(); await server.close(); }
});

for (const heldMethod of ["eth_getBlockByHash", "eth_getCode", "eth_call", "debug_traceCall"]) {
  test(`one cancelled waiter does not cancel another quote's ${heldMethod}`, async () => {
    const entered = deferred(), release = deferred();
    const server = await mockNode(async (method, _params, count) => {
      if (method === heldMethod && count === 1) { entered.resolve(); await release.promise; }
    });
    const c = client(), abort = new AbortController();
    try {
      const first = c.strictSimulate(request(server.url), { signal: abort.signal });
      const failed = assert.rejects(first, /first cancelled/);
      await entered.promise;
      const second = c.strictSimulate(request(server.url, 20));
      await turn(); await turn();
      abort.abort(new Error("first cancelled")); await failed;
      release.resolve();
      assert.equal((await second).strict?.outcome.kind, "InputPrepared");
      assert.deepEqual(server.counts, { eth_getBlockByHash: 1, eth_chainId: 1, eth_getCode: 1, eth_call: 6, debug_traceCall: 2 });
    } finally { release.resolve(); await c.closeAndDrain(); await server.close(); }
  });
}

test("independent deadlines detach one waiter without shortening the surviving quote", async () => {
  const entered = deferred(), release = deferred();
  const server = await mockNode(async (method, _params, count) => {
    if (method === "eth_getBlockByHash" && count === 1) { entered.resolve(); await release.promise; }
  });
  const c = client();
  try {
    const first = c.strictSimulate(request(server.url), { deadlineAtMs: Date.now() + 80 });
    const failed = assert.rejects(first, /deadline/);
    await entered.promise;
    const second = c.strictSimulate(request(server.url, 20));
    await failed;
    release.resolve();
    assert.equal((await second).strict?.outcome.kind, "InputPrepared");
    assert.equal(server.counts.eth_getBlockByHash, 1);
  } finally { release.resolve(); await c.closeAndDrain(); await server.close(); }
});

test("a later waiter keeps its full default timeout after the original quote expires", async () => {
  const entered = deferred(), release = deferred();
  const server = await mockNode(async (method, _params, count) => {
    if (method === "eth_getBlockByHash" && count === 1) { entered.resolve(); await release.promise; }
  });
  const c = client({ timeoutMs: 300 });
  try {
    const first = c.strictSimulate(request(server.url));
    const failed = assert.rejects(first, /deadline/);
    await entered.promise;
    await delay(150);
    const second = c.strictSimulate(request(server.url, 20)).then(value => ({ value }), error => ({ error }));
    await failed;
    await delay(30);
    release.resolve();
    const result = await second;
    assert(!("error" in result), "the later waiter must retain its own timeout budget");
    assert.equal(result.value.strict?.outcome.kind, "InputPrepared");
    assert.equal(server.counts.eth_getBlockByHash, 1);
  } finally { release.resolve(); await c.closeAndDrain(); await server.close(); }
});

for (const heldMethod of ["eth_getBlockByHash", "debug_traceCall"]) {
test(`all waiters cancelling removes abandoned ${heldMethod} and permits a clean same-source retry`, async () => {
  const entered = deferred(), release = deferred();
  const server = await mockNode(async (method, _params, count) => {
    if (method === heldMethod && count === 1) { entered.resolve(); await release.promise; }
  });
  const c = client(), a = new AbortController(), b = new AbortController();
  try {
    const first = c.strictSimulate(request(server.url), { signal: a.signal });
    const second = c.strictSimulate(request(server.url), { signal: b.signal });
    const settled = Promise.allSettled([first, second]);
    await entered.promise; a.abort(); b.abort();
    assert((await settled).every(result => result.status === "rejected"));
    assert.equal((await c.strictSimulate(request(server.url))).strict?.outcome.kind, "InputPrepared");
    release.resolve();
    assert.equal(server.counts.eth_getBlockByHash, heldMethod === "eth_getBlockByHash" ? 2 : 1);
    assert.equal(server.counts.eth_call, heldMethod === "eth_getBlockByHash" ? 6 : 8);
    assert.equal(server.counts.debug_traceCall, heldMethod === "eth_getBlockByHash" ? 2 : 3);
  } finally { release.resolve(); await c.closeAndDrain(); await server.close(); }
});
}

test("failed proofs do not poison retries and changing the source never reuses its proved balance", async () => {
  const server = await mockNode(), cache = createNodeFundingCache();
  const first = client({ fundingCache: cache });
  try {
    server.failNextCode();
    await assert.rejects(first.strictSimulate(request(server.url)), /invalid node code/);
    await first.strictSimulate(request(server.url));
    assert.equal(server.counts.eth_getCode, 2);
    await assert.rejects(first.strictSimulate(request(server.url, 1, H2)), /source-fault/);
    await first.closeAndDrain();
    server.balance(900n);
    const next = client({ fundingCache: cache });
    try {
      const priorCalls = server.counts.eth_call, priorTraces = server.counts.debug_traceCall;
      const outcome = (await next.strictSimulate(request(server.url, 5, H2))).strict!.outcome;
      assert.equal(outcome.kind, "InputPrepared");
      if (outcome.kind === "InputPrepared") assert.deepEqual(outcome.stateOverrides, {
        [T]: { stateDiff: { [slot]: toBeHex(905n, 32) } },
      });
      assert.equal(server.counts.eth_call - priorCalls, 6, "new source re-proves both sentinels and witness despite a slot hint");
      assert.equal(server.counts.debug_traceCall - priorTraces, 2, "new source retraces both target and witness despite a slot hint");
    } finally { await next.closeAndDrain(); }
  } finally { await first.closeAndDrain(); await server.close(); }
});

test("executor code cache compares primitive values instead of trusting mutable object identity", async () => {
  const server = await mockNode(), options = { ...CODE }, c = client({ executorRuntimeCode: options });
  try {
    await c.strictSimulate(request(server.url));
    options.code = "0x6001";
    await assert.rejects(c.strictSimulate(request(server.url)), /hash mismatch/);
    options.code = CODE.code;
    options.keccak256 = keccak256("0x6002");
    const changed = request(server.url); changed.trialPrefix.executorRuntimeCode.keccak256 = options.keccak256;
    await assert.rejects(c.strictSimulate(changed), /hash mismatch/);
    Object.assign(options, CODE);
    assert.equal((await c.strictSimulate(request(server.url))).strict?.outcome.kind, "InputPrepared");
  } finally { await c.closeAndDrain(); await server.close(); }
});

for (const heldMethod of ["eth_call", "debug_traceCall"]) {
test(`closing drains shared ${heldMethod} work and prevents new RPC dispatch`, async () => {
  const entered = deferred(), release = deferred();
  const server = await mockNode(async method => {
    if (method === heldMethod) { entered.resolve(); await release.promise; }
  });
  const scheduler = new RethTransportScheduler({ capacity: 8, producerReserved: 1 }), c = client({ scheduler });
  try {
    const pending = Array.from({ length: 8 }, () => c.strictSimulate(request(server.url)));
    const settled = Promise.allSettled(pending);
    await entered.promise;
    await c.closeAndDrain();
    assert((await settled).every(result => result.status === "rejected"));
    assert.equal(scheduler.snapshot().activeTotal, 0);
    assert.equal(Object.values(scheduler.snapshot().queuedByLane).reduce((sum, count) => sum + count, 0), 0);
    const before = { ...server.counts };
    await assert.rejects(c.strictSimulate(request(server.url)), /closed/);
    assert.deepEqual(server.counts, before);
  } finally { release.resolve(); await c.closeAndDrain(); await server.close(); }
});
}
